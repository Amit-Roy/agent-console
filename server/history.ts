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
};

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

export const DEFAULT_MIN_SNAPSHOT_BYTES = 8 * 1024 * 1024;

// Derived local snapshots are trusted artifacts, not content proofs. Exact file metadata
// and a checksum reject stale/accidentally corrupt snapshots; the JSONL remains authoritative.
// The checksum does not authenticate artifacts against another local writer.
// In-memory growth retains the existing append-only log assumption.
export class HistoryIndex {
  private files = new Map<string, OffsetIndex>();
  private cacheDirectory?: string;
  private minSnapshotBytes: number;
  // Provisional cutoff, not a measured crossover: small logs scan quickly, so the cache is skipped.
  constructor(cacheDirectory?: string, options: { minSnapshotBytes?: number } = {}) {
    this.cacheDirectory = cacheDirectory;
    this.minSnapshotBytes = options.minSnapshotBytes ?? DEFAULT_MIN_SNAPSHOT_BYTES;
  }
  private snapshotPath(file: string) {
    const canonical = fs.realpathSync(file);
    const digest = createHash("sha256").update(canonical).digest("hex");
    return path.join(this.cacheDirectory!, `${digest}.json`);
  }
  private restore(
    file: string,
    source: number,
    state: ReturnType<typeof fileState>,
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
      if (fileState(source).fingerprint !== state.fingerprint) return;
      return { ...state, offsets: snapshot.offsets, persisted: state.fingerprint };
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
      fs.renameSync(temporary, destination);
      index.persisted = index.fingerprint;
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
    this.files.delete(file);
    if (!this.cacheDirectory) return;
    try {
      fs.rmSync(this.snapshotPath(file), { force: true });
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
  private extend(file: string, descriptor: number) {
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
      index = this.restore(file, descriptor, state);
      if (!index) {
        // A writer may have changed the source while the optional snapshot was read.
        state = fileState(descriptor);
        index = { ...state, size: 0, offsets: [0] };
      }
    }
    if (index.size < state.size) this.scan(descriptor, index, state.size);
    index.fingerprint = state.fingerprint;
    this.files.delete(file);
    this.files.set(file, index);
    if (this.files.size > 64) this.files.delete(this.files.keys().next().value!);
    return index;
  }
  private withFile<T>(
    file: string,
    empty: T,
    callback: (descriptor: number, offsets: number[]) => T,
    persist = false,
  ): T {
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, "r");
    } catch {
      return empty;
    }
    try {
      const index = this.extend(file, descriptor);
      const result = callback(descriptor, index.offsets);
      if (persist) this.persist(file, descriptor, index);
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
  // Lines written so far: live events carry it so a cached view can later ask for only what follows.
  count(file: string) {
    return this.withFile(file, 0, (_, offsets) => offsets.length - 1);
  }
  // Everything after line `since`, or null when the gap is wider than `limit` (or the log shrank): the caller sends a full page instead.
  after(file: string, since: number, limit: number) {
    return this.withFile(
      file,
      null,
      (descriptor, offsets) => {
        const total = offsets.length - 1;
        if (since > total || total - since > limit) return null;
        return {
          ...this.lines(descriptor, offsets, since, total),
          start: since,
          end: total,
          total,
        };
      },
      true,
    );
  }
  read(file: string, before: number | undefined, limit: number) {
    return this.withFile(
      file,
      { events: [] as any[], start: 0, end: 0, total: 0, bytes: 0 },
      (descriptor, offsets) => {
        const total = offsets.length - 1;
        const end = Math.max(0, Math.min(before ?? total, total));
        const candidate = Math.max(0, end - limit - 150);
        let start = Math.max(0, end - limit);
        let scanned = 0;
        const header = Buffer.alloc(256);
        for (let i = Math.min(start, end - 1); i >= candidate; i--) {
          const size = offsets[i + 1] - offsets[i];
          const headerBytes = fs.readSync(
            descriptor,
            header,
            0,
            Math.min(size, header.length),
            offsets[i],
          );
          scanned += headerBytes;
          // Logs put type first. Inspect that tiny header instead of parsing discarded megabyte tool results.
          let type = header
            .subarray(0, headerBytes)
            .toString("utf8")
            .match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/)?.[1];
          if (!type) {
            const line = Buffer.alloc(size);
            fs.readSync(descriptor, line, 0, size, offsets[i]);
            scanned += size;
            type = JSON.parse(line.toString("utf8")).type;
          }
          if (type === "user_input") {
            start = i;
            break;
          }
        }
        const { events, bytes } = this.lines(descriptor, offsets, start, end);
        return { events, start, end, total, bytes: bytes + scanned };
      },
      true,
    );
  }
}
