import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Lines of a JSONL buffer that contain any needle, in file order. Decoding and splitting whole logs costs seconds at boot;
// a native byte search finds the few init and result lines among megabytes of tool output.
export function linesWith(buf: Buffer, needles: string[]): string[] {
  const starts = new Set<number>();
  for (const needle of needles) {
    for (let at = buf.indexOf(needle); at !== -1; ) {
      const start = buf.lastIndexOf(10, at) + 1;
      starts.add(start);
      const end = buf.indexOf(10, at);
      if (end === -1) break;
      at = buf.indexOf(needle, end);
    }
  }
  return [...starts]
    .sort((a, b) => a - b)
    .map((start) => {
      const end = buf.indexOf(10, start);
      return buf.toString("utf8", start, end === -1 ? buf.length : end);
    });
}

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_OFFSETS = 1_000_000;
type OffsetIndex = {
  identity: string;
  size: number;
  fingerprint: string;
  offsets: number[];
  persisted?: string;
  views: Map<number, View>;
  projection?: string; // key of the projection the cached views came from
  dirty: boolean; // views changed since the sidecar was written
  viewTimer?: NodeJS.Timeout;
};

// A projected (wire) history line kept so warm pages skip reading, decoding and parsing multi-MB lines.
type View = { owner: Map<number, View>; line: number; value: any; size: number; type: unknown };
export type Projection = (line: number, parsed: any) => any;
// `key` identifies the projection's output contract: persisted views are only reused when it matches.
export type HistoryProjection = { key: string; project: Projection };
export type ProjectedItem = { line: number; value: any; size: number };
export const VIEW_MIN_LINE_BYTES = 16 * 1024;
export const VIEW_MAX_WIRE_BYTES = 64 * 1024;
export const VIEW_BUDGET_BYTES = 32 * 1024 * 1024;
export const VIEW_SIDECAR_VERSION = 1;
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
const VIEW_PERSIST_DELAY_MS = 1000;
type SidecarView = { line: number; from: number; to: number; value: any };

function fileState(descriptor: number) {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  return {
    identity: `${stat.dev}:${stat.ino}`,
    size: Number(stat.size),
    fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
  };
}

function validOffsets(offsets: unknown, size: number): offsets is number[] {
  if (!Array.isArray(offsets) || !offsets.length || offsets.length > MAX_SNAPSHOT_OFFSETS)
    return false;
  if (offsets[0] !== 0) return false;
  return offsets.every(
    (offset, position) =>
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset <= size &&
      (position === 0 || offset > offsets[position - 1]),
  );
}

function snapshotChecksum(fingerprint: string, offsets: number[]) {
  return createHash("sha256")
    .update(JSON.stringify({ version: SNAPSHOT_VERSION, fingerprint, offsets }))
    .digest("hex");
}

function sidecarChecksum(fingerprint: string, projection: string, views: SidecarView[]) {
  return createHash("sha256")
    .update(JSON.stringify({ version: VIEW_SIDECAR_VERSION, fingerprint, projection, views }))
    .digest("hex");
}

function viewMatches(offsets: number[], view: SidecarView) {
  return (
    Number.isSafeInteger(view?.line) &&
    view.line >= 0 &&
    view.line + 1 < offsets.length &&
    offsets[view.line] === view.from &&
    offsets[view.line + 1] === view.to &&
    view.to - view.from >= VIEW_MIN_LINE_BYTES
  );
}

export const DEFAULT_MIN_SNAPSHOT_BYTES = 8 * 1024 * 1024;

// Derived local snapshots are trusted artifacts, not content proofs. Exact file metadata
// and a checksum reject stale/accidentally corrupt snapshots; the JSONL remains authoritative.
// The checksum does not authenticate artifacts against another local writer.
// In-memory growth retains the existing append-only log assumption.
export class HistoryIndex {
  private files = new Map<string, OffsetIndex>();
  private cacheDirectory?: string;
  private minSnapshotBytes: number;
  private viewBudget: number;
  private viewBytes = 0;
  private viewLru = new Set<View>();
  private generation = 0;
  // Provisional cutoff, not a measured crossover: small logs scan quickly, so the cache is skipped.
  constructor(
    cacheDirectory?: string,
    options: { minSnapshotBytes?: number; viewBudgetBytes?: number } = {},
  ) {
    this.cacheDirectory = cacheDirectory;
    this.minSnapshotBytes = options.minSnapshotBytes ?? DEFAULT_MIN_SNAPSHOT_BYTES;
    this.viewBudget = options.viewBudgetBytes ?? VIEW_BUDGET_BYTES;
  }
  private dropViews(index: OffsetIndex | undefined) {
    if (!index) return;
    clearTimeout(index.viewTimer);
    index.viewTimer = undefined;
    index.dirty = false;
    for (const view of index.views.values()) {
      this.viewLru.delete(view);
      this.viewBytes -= view.size;
    }
    index.views.clear();
  }
  invalidateViews() {
    this.generation++;
    for (const index of this.files.values()) this.dropViews(index);
    if (!this.cacheDirectory) return;
    try {
      for (const name of fs.readdirSync(this.cacheDirectory))
        if (name.endsWith(".views.json"))
          fs.rmSync(path.join(this.cacheDirectory, name), { force: true });
    } catch {
      /* Optional cache. */
    }
  }
  // Writes every pending view sidecar now instead of waiting for its timer (tests, shutdown).
  flushViews() {
    for (const [file, index] of this.files) {
      if (!index.viewTimer) continue;
      clearTimeout(index.viewTimer);
      index.viewTimer = undefined;
      this.writeViews(file, index);
    }
  }
  viewStats() {
    return { entries: this.viewLru.size, bytes: this.viewBytes };
  }
  private viewHit(index: OffsetIndex, line: number) {
    const view = index.views.get(line);
    if (view) {
      this.viewLru.delete(view);
      this.viewLru.add(view);
    }
    return view;
  }
  private keepView(index: OffsetIndex, view: View, rawBytes: number) {
    if (rawBytes < VIEW_MIN_LINE_BYTES || view.size > VIEW_MAX_WIRE_BYTES) return;
    index.views.set(view.line, view);
    index.dirty = true;
    this.viewLru.add(view);
    this.viewBytes += view.size;
    while (this.viewBytes > this.viewBudget) {
      const oldest: View = this.viewLru.values().next().value!;
      this.viewLru.delete(oldest);
      oldest.owner.delete(oldest.line);
      this.viewBytes -= oldest.size;
    }
  }
  private cachePath(file: string, suffix: string) {
    const canonical = fs.realpathSync(file);
    const digest = createHash("sha256").update(canonical).digest("hex");
    return path.join(this.cacheDirectory!, `${digest}${suffix}`);
  }
  private snapshotPath(file: string) {
    return this.cachePath(file, ".json");
  }
  private sidecarPath(file: string) {
    return this.cachePath(file, ".views.json");
  }
  private validSidecarViews(sidecar: any, index: OffsetIndex, projection: string) {
    if (sidecar?.version !== VIEW_SIDECAR_VERSION || sidecar.fingerprint !== index.fingerprint)
      return;
    if (sidecar.projection !== projection || !Array.isArray(sidecar.views)) return;
    const views: SidecarView[] = sidecar.views;
    if (sidecar.checksum !== sidecarChecksum(index.fingerprint, projection, views)) return;
    if (new Set(views.map((view) => view?.line)).size !== views.length) return;
    return views.every((view) => viewMatches(index.offsets, view)) ? views : undefined;
  }
  // Optional: any mismatch drops the whole sidecar and views are rebuilt from the transcript.
  private loadViews(file: string, index: OffsetIndex, projection: string) {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        this.sidecarPath(file),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      if (fs.fstatSync(descriptor).size > MAX_SIDECAR_BYTES) return;
      const views = this.validSidecarViews(
        JSON.parse(fs.readFileSync(descriptor, "utf8")),
        index,
        projection,
      );
      if (!views) return;
      index.projection = projection;
      for (const { line, from, to: lineEnd, value } of views) {
        const size = value == null ? 0 : JSON.stringify(value).length;
        this.keepView(
          index,
          { owner: index.views, line, value, size, type: undefined },
          lineEnd - from,
        );
      }
      index.dirty = false;
    } catch {
      this.dropViews(index);
    } finally {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          /* Optional cache. */
        }
      }
    }
  }
  private scheduleViews(file: string, index: OffsetIndex) {
    if (!this.cacheDirectory || !index.dirty || index.viewTimer) return;
    if (index.size < this.minSnapshotBytes) return;
    const generation = this.generation;
    index.viewTimer = setTimeout(() => {
      index.viewTimer = undefined;
      if (generation === this.generation) this.writeViews(file, index);
    }, VIEW_PERSIST_DELAY_MS);
    index.viewTimer.unref();
  }
  private encodeViews(index: OffsetIndex) {
    const { offsets, fingerprint } = index;
    const projection = index.projection!;
    const views: SidecarView[] = [...index.views.values()]
      .sort((first, second) => first.line - second.line)
      .map((view) => ({
        line: view.line,
        from: offsets[view.line],
        to: offsets[view.line + 1],
        value: view.value ?? null,
      }));
    const encoded = JSON.stringify({
      version: VIEW_SIDECAR_VERSION,
      fingerprint,
      projection,
      views,
      checksum: sidecarChecksum(fingerprint, projection, views),
    });
    return Buffer.byteLength(encoded) > MAX_SIDECAR_BYTES ? undefined : encoded;
  }
  private unchanged(descriptor: number, index: OffsetIndex) {
    const now = fileState(descriptor);
    return now.fingerprint === index.fingerprint && now.size === index.size;
  }
  private writeViews(file: string, index: OffsetIndex) {
    if (!this.cacheDirectory || this.files.get(file) !== index) return;
    if (!index.dirty || !index.projection || index.size < this.minSnapshotBytes) return;
    if (index.persisted !== index.fingerprint) return;
    let descriptor: number | undefined;
    let temporary: string | undefined;
    try {
      descriptor = fs.openSync(file, "r");
      if (!this.unchanged(descriptor, index)) return;
      const encoded = this.encodeViews(index);
      if (!encoded) return;
      fs.mkdirSync(this.cacheDirectory, { recursive: true, mode: 0o700 });
      const destination = this.sidecarPath(file);
      temporary = `${destination}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" });
      if (!this.unchanged(descriptor, index)) return;
      fs.renameSync(temporary, destination);
      index.dirty = false;
    } catch {
      // Optional cache: never surface write errors.
    } finally {
      for (const cleanup of [
        () => descriptor !== undefined && fs.closeSync(descriptor),
        () => temporary && fs.rmSync(temporary, { force: true }),
      ]) {
        try {
          cleanup();
        } catch {
          /* Best-effort cleanup. */
        }
      }
    }
  }
  private restore(
    file: string,
    source: number,
    state: ReturnType<typeof fileState>,
    projection?: string,
  ): OffsetIndex | undefined {
    if (!this.cacheDirectory || state.size < this.minSnapshotBytes) return;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        this.snapshotPath(file),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const size = fs.fstatSync(descriptor).size;
      if (size > MAX_SNAPSHOT_BYTES) return;
      const buffer = Buffer.alloc(size + 1);
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (count !== size) return;
      const snapshot = JSON.parse(buffer.toString("utf8", 0, count));
      if (snapshot.version !== SNAPSHOT_VERSION || snapshot.fingerprint !== state.fingerprint)
        return;
      if (!validOffsets(snapshot.offsets, state.size)) return;
      if (snapshot.checksum !== snapshotChecksum(state.fingerprint, snapshot.offsets)) return;
      const restored: OffsetIndex = {
        ...state,
        offsets: snapshot.offsets,
        persisted: state.fingerprint,
        views: new Map(),
        dirty: false,
      };
      if (projection) this.loadViews(file, restored, projection);
      if (fileState(source).fingerprint !== state.fingerprint) {
        this.dropViews(restored);
        return;
      }
      return restored;
    } catch {
      // Cache absence, permissions and malformed data all fall back to scanning JSONL.
    } finally {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          /* Optional cache. */
        }
      }
    }
  }
  private persist(file: string, descriptor: number, index: OffsetIndex) {
    if (!this.cacheDirectory || index.size < this.minSnapshotBytes) return;
    if (index.persisted === index.fingerprint) return;
    if (index.offsets.length > MAX_SNAPSHOT_OFFSETS) return;
    let temporary: string | undefined;
    try {
      const before = fileState(descriptor);
      if (before.fingerprint !== index.fingerprint || before.size !== index.size) return;
      const encoded = JSON.stringify({
        version: SNAPSHOT_VERSION,
        fingerprint: index.fingerprint,
        offsets: index.offsets,
        checksum: snapshotChecksum(index.fingerprint, index.offsets),
      });
      if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES) return;
      fs.mkdirSync(this.cacheDirectory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.cacheDirectory, 0o700);
      const destination = this.snapshotPath(file);
      temporary = `${destination}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" });
      if (fileState(descriptor).fingerprint !== index.fingerprint) return;
      fs.rmSync(this.sidecarPath(file), { force: true }); // views belong to the replaced snapshot's fingerprint
      fs.renameSync(temporary, destination);
      index.persisted = index.fingerprint;
      index.dirty = index.views.size > 0;
    } catch {
      // Persistence is optional and must never prevent loading a conversation.
    } finally {
      if (temporary) {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          /* Best-effort cleanup. */
        }
      }
    }
  }
  // Call before deleting the source so its canonical cache key is still available.
  forget(file: string) {
    this.dropViews(this.files.get(file));
    this.files.delete(file);
    if (!this.cacheDirectory) return;
    try {
      fs.rmSync(this.snapshotPath(file), { force: true });
      fs.rmSync(this.sidecarPath(file), { force: true });
    } catch {
      /* Optional cache. */
    }
  }
  private scan(descriptor: number, index: OffsetIndex, size: number) {
    const chunk = Buffer.alloc(64 * 1024);
    let position = index.size;
    while (position < size) {
      const count = fs.readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position,
      );
      if (!count) break;
      for (
        let offset = chunk.indexOf(10);
        offset !== -1 && offset < count;
        offset = chunk.indexOf(10, offset + 1)
      )
        index.offsets.push(position + offset + 1);
      position += count;
    }
    index.size = position;
  }
  private extend(file: string, descriptor: number, projection?: string) {
    let state = fileState(descriptor);
    let index = this.files.get(file);
    if (
      index &&
      (index.identity !== state.identity ||
        index.size > state.size ||
        (index.size === state.size && index.fingerprint !== state.fingerprint))
    )
      index = undefined;
    if (!index) {
      this.dropViews(this.files.get(file));
      index = this.restore(file, descriptor, state, projection);
      if (!index) {
        // A writer may have changed the source while the optional snapshot was read.
        state = fileState(descriptor);
        index = { ...state, size: 0, offsets: [0], views: new Map(), dirty: false };
      }
    }
    if (index.size < state.size) this.scan(descriptor, index, state.size);
    index.fingerprint = state.fingerprint;
    this.files.delete(file);
    this.files.set(file, index);
    if (this.files.size > 64) {
      const oldest = this.files.keys().next().value!;
      this.dropViews(this.files.get(oldest));
      this.files.delete(oldest);
    }
    return index;
  }
  private withFile<T>(
    file: string,
    empty: T,
    callback: (descriptor: number, index: OffsetIndex) => T,
    persist = false,
    projection?: string,
  ): T {
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, "r");
    } catch {
      return empty;
    }
    try {
      const index = this.extend(file, descriptor, projection);
      const result = callback(descriptor, index);
      if (persist) {
        this.persist(file, descriptor, index);
        this.scheduleViews(file, index);
      }
      return result;
    } finally {
      fs.closeSync(descriptor);
    }
  }
  private lines(descriptor: number, offsets: number[], start: number, end: number) {
    const buf = Buffer.alloc(offsets[end] - offsets[start]);
    fs.readSync(descriptor, buf, 0, buf.length, offsets[start]);
    return {
      events: buf
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
      bytes: buf.length,
    };
  }
  // Projected lines in [start, end): cached views are reused, only contiguous runs of uncached lines are read and parsed.
  private projectedLines(
    descriptor: number,
    index: OffsetIndex,
    start: number,
    end: number,
    { key, project }: HistoryProjection,
  ) {
    if (index.projection !== key) {
      this.dropViews(index);
      index.projection = key;
    }
    const slots: ({ value: any; size: number } | undefined)[] = [];
    for (let line = start; line < end; line++) slots.push(this.viewHit(index, line));
    let bytes = 0;
    for (let first = 0; first < slots.length; first++) {
      if (slots[first]) continue;
      let stop = first;
      while (stop < slots.length && !slots[stop]) stop++;
      bytes += this.readRun(descriptor, index, start, [first, stop], slots, project);
      first = stop;
    }
    const items: ProjectedItem[] = [];
    slots.forEach((slot, offset) => {
      if (slot?.value != null)
        items.push({ line: start + offset, value: slot.value, size: slot.size });
    });
    return { items, events: items.map((item) => item.value), bytes };
  }
  private readRun(
    descriptor: number,
    index: OffsetIndex,
    start: number,
    [from, stop]: [number, number],
    slots: ({ value: any; size: number } | undefined)[],
    project: Projection,
  ) {
    const { offsets } = index;
    const base = offsets[start + from];
    const buf = Buffer.alloc(offsets[start + stop] - base);
    fs.readSync(descriptor, buf, 0, buf.length, base);
    for (let slot = from; slot < stop; slot++) {
      const line = start + slot;
      const text = buf.toString("utf8", offsets[line] - base, offsets[line + 1] - base);
      if (!text.trim()) {
        slots[slot] = { value: null, size: 0 };
        continue;
      }
      const parsed = JSON.parse(text);
      const value = project(line, parsed);
      const size = value == null ? 0 : JSON.stringify(value).length;
      slots[slot] = { value, size };
      const view: View = { owner: index.views, line, value, size, type: parsed?.type };
      this.keepView(index, view, offsets[line + 1] - offsets[line]);
    }
    return buf.length;
  }
  // Lines written so far: live events carry it so a cached view can later ask for only what follows.
  count(file: string) {
    return this.withFile(file, 0, (_, index) => index.offsets.length - 1);
  }
  // Everything after line `since`, or null when the gap is wider than `limit` (or the log shrank): the caller sends a full page instead.
  after(file: string, since: number, limit: number, projection?: HistoryProjection) {
    return this.withFile(
      file,
      null,
      (descriptor, index) => {
        const { offsets } = index;
        const total = offsets.length - 1;
        if (since > total || total - since > limit) return null;
        return {
          ...(projection
            ? this.projectedLines(descriptor, index, since, total, projection)
            : this.lines(descriptor, offsets, since, total)),
          start: since,
          end: total,
          total,
        };
      },
      true,
      projection?.key,
    );
  }
  // Type of line `line`: from its cached view, else the tiny header (logs put type first), else a full parse.
  private lineType(descriptor: number, index: OffsetIndex, line: number, cached: View | undefined) {
    if (cached && cached.type !== undefined) return { type: cached.type, scanned: 0 }; // restored views carry no type
    const { offsets } = index;
    const size = offsets[line + 1] - offsets[line];
    const header = Buffer.alloc(Math.min(size, 256));
    const headerBytes = fs.readSync(descriptor, header, 0, header.length, offsets[line]);
    const type = header
      .subarray(0, headerBytes)
      .toString("utf8")
      .match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/)?.[1];
    if (type) return { type, scanned: headerBytes };
    const whole = Buffer.alloc(size);
    fs.readSync(descriptor, whole, 0, size, offsets[line]);
    return { type: JSON.parse(whole.toString("utf8")).type, scanned: headerBytes + size };
  }
  read(file: string, before: number | undefined, limit: number, projection?: HistoryProjection) {
    return this.withFile(
      file,
      {
        events: [] as any[],
        ...(projection ? { items: [] as ProjectedItem[] } : {}),
        start: 0,
        end: 0,
        total: 0,
        bytes: 0,
      },
      (descriptor, index) => {
        const { offsets } = index;
        const total = offsets.length - 1;
        const end = Math.max(0, Math.min(before ?? total, total));
        const candidate = Math.max(0, end - limit - 150);
        let start = Math.max(0, end - limit);
        let scanned = 0;
        for (let i = Math.min(start, end - 1); i >= candidate; i--) {
          const cached = projection ? this.viewHit(index, i) : undefined;
          const found = this.lineType(descriptor, index, i, cached);
          scanned += found.scanned;
          if (found.type === "user_input") {
            start = i;
            break;
          }
        }
        const page = projection
          ? this.projectedLines(descriptor, index, start, end, projection)
          : this.lines(descriptor, offsets, start, end);
        const { bytes, ...fields } = page; // keep the key order of the unprojected reply
        return { ...fields, start, end, total, bytes: bytes + scanned };
      },
      true,
      projection?.key,
    );
  }
}
