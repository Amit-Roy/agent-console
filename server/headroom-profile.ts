// Headroom memory profiling store, trigger policy and OTLP metrics decoder. Metadata only: numbers and
// allowlisted names/locations; never prompts, URLs or arbitrary attributes.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import protobuf from "protobufjs";

const DAY_MS = 86_400_000;
export const PROFILE_RETENTION_DAYS = 7;
const CAPS = { headroom_rss: 20_000, headroom_metric: 200_000, headroom_site: 100_000, headroom_snapshot: 500 };
const SAMPLE_GAP_MS = 60_000;
export const MAX_OTLP_BYTES = 1024 * 1024;
const MIB = 1024 * 1024;
const STEP_BYTES = 50 * MIB;
const PERIODIC_MS = 15 * 60_000;
const MIN_SNAPSHOT_GAP_MS = 60_000;

export const METRIC_ALLOWLIST: ReadonlySet<string> = new Set([
  "process.runtime.cpython.memory",
  "process.runtime.cpython.gc_count",
  "process.runtime.cpython.thread_count",
  "process.runtime.cpython.cpu_time",
  "headroom.malloc.arena_bytes",
  "headroom.malloc.in_use_bytes",
  "headroom.malloc.free_held_bytes",
  "headroom.tracemalloc.traced_bytes",
  "headroom.tracemalloc.peak_bytes",
  "headroom.alloc.bytes",
  "headroom.alloc.count",
]);
const LOCATION_PATTERN = /^[\w./-]{1,200}:\d+$/;
const ATTR_KEYS = ["type", "count"];

export type SnapshotTrigger = "step" | "periodic" | "breaker";
export type Smaps = { anon: number | null; fileBacked: number | null };
export type MetricRow = { name: string; attr: string | null; value: number };
export type SiteRow = { location: string; bytes: number; count: number };
export type DecodedOtlp = { pid: number; metrics: MetricRow[]; sites: SiteRow[] };

export class HeadroomProfileStore {
  private db: DatabaseSync;
  private writes = 0;
  private caps: typeof CAPS;
  constructor(file: string, caps: Partial<typeof CAPS> = {}) {
    this.caps = { ...CAPS, ...caps };
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS headroom_rss (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, pid INTEGER NOT NULL, rss REAL NOT NULL, anon REAL, file_backed REAL);
      CREATE INDEX IF NOT EXISTS headroom_rss_at ON headroom_rss(at);
      CREATE TABLE IF NOT EXISTS headroom_metric (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, pid INTEGER NOT NULL, name TEXT NOT NULL, attr TEXT, value REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS headroom_metric_at ON headroom_metric(at);
      CREATE TABLE IF NOT EXISTS headroom_site (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, pid INTEGER NOT NULL, location TEXT NOT NULL, bytes REAL NOT NULL, count REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS headroom_site_at ON headroom_site(at);
      CREATE TABLE IF NOT EXISTS headroom_snapshot (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, pid INTEGER NOT NULL, trigger TEXT NOT NULL CHECK (trigger IN ('step','periodic','breaker')), rss REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS headroom_snapshot_at ON headroom_snapshot(at);`);
    this.prune();
  }

  /** Downsampled to at most one row per minute per pid. Returns whether a row was stored. */
  recordSample(pid: number, sample: { rssBytes: number; time: number }, smaps?: Smaps | null) {
    if (!Number.isFinite(pid) || !Number.isFinite(sample.rssBytes) || !Number.isFinite(sample.time))
      return false;
    const last = this.db.prepare("SELECT MAX(at) AS at FROM headroom_rss WHERE pid=?").get(pid) as any;
    if (last?.at != null && sample.time - last.at < SAMPLE_GAP_MS) return false;
    this.db
      .prepare("INSERT INTO headroom_rss(at,pid,rss,anon,file_backed) VALUES(?,?,?,?,?)")
      .run(sample.time, pid, sample.rssBytes, smaps?.anon ?? null, smaps?.fileBacked ?? null);
    this.touch(1, sample.time);
    return true;
  }

  recordSnapshot(pid: number, trigger: SnapshotTrigger, rss: number, at: number) {
    if (!["step", "periodic", "breaker"].includes(trigger) || !Number.isFinite(rss)) return false;
    this.db
      .prepare("INSERT INTO headroom_snapshot(at,pid,trigger,rss) VALUES(?,?,?,?)")
      .run(at, pid, trigger, rss);
    this.touch(1, at);
    return true;
  }

  recordMetrics(pid: number, rows: MetricRow[], at: number) {
    const insert = this.db.prepare(
      "INSERT INTO headroom_metric(at,pid,name,attr,value) VALUES(?,?,?,?,?)",
    );
    const kept = rows.filter((row) => METRIC_ALLOWLIST.has(row.name) && Number.isFinite(row.value));
    this.inTransaction(() => kept.forEach((row) => insert.run(at, pid, row.name, row.attr, row.value)));
    this.touch(kept.length, at);
    return kept.length;
  }

  recordSites(pid: number, rows: SiteRow[], at: number) {
    const insert = this.db.prepare(
      "INSERT INTO headroom_site(at,pid,location,bytes,count) VALUES(?,?,?,?,?)",
    );
    const kept = rows.filter(
      (row) => LOCATION_PATTERN.test(row.location) && Number.isFinite(row.bytes) && Number.isFinite(row.count),
    );
    this.inTransaction(() => kept.forEach((row) => insert.run(at, pid, row.location, row.bytes, row.count)));
    this.touch(kept.length, at);
    return kept.length;
  }

  query(rangeMs: number, now = Date.now()) {
    const since = now - rangeMs;
    const rss = (
      this.db
        .prepare("SELECT at,pid,rss,anon,file_backed FROM headroom_rss WHERE at>=? ORDER BY at")
        .all(since) as any[]
    ).map((r) => ({ at: r.at, pid: r.pid, rss: r.rss, anon: r.anon, fileBacked: r.file_backed }));
    const snapshots = (
      this.db
        .prepare("SELECT at,pid,trigger,rss FROM headroom_snapshot WHERE at>=? ORDER BY at")
        .all(since) as any[]
    ).map((r) => ({ at: r.at, pid: r.pid, trigger: r.trigger, rss: r.rss }));
    const metrics: Record<string, { at: number; attr: string | null; value: number }[]> = {};
    for (const r of this.db
      .prepare("SELECT at,name,attr,value FROM headroom_metric WHERE at>=? ORDER BY at")
      .all(since) as any[])
      (metrics[r.name] ??= []).push({ at: r.at, attr: r.attr, value: r.value });
    return { rss, snapshots, metrics, sites: this.latestSites(since) };
  }

  private latestSites(since: number) {
    const latest = this.db
      .prepare("SELECT at,pid FROM headroom_site WHERE at>=? ORDER BY at DESC, id DESC LIMIT 1")
      .get(since) as any;
    if (!latest) return { at: null as number | null, rows: [] as any[] };
    const batch = (at: number) =>
      this.db.prepare("SELECT location,bytes,count FROM headroom_site WHERE pid=? AND at=?").all(latest.pid, at) as any[];
    const before = this.db
      .prepare("SELECT MAX(at) AS at FROM headroom_site WHERE pid=? AND at<?")
      .get(latest.pid, latest.at) as any;
    const prior = new Map<string, number>();
    if (before?.at != null) for (const r of batch(before.at)) prior.set(r.location, r.bytes);
    const rows = batch(latest.at).map((r) => ({
      location: r.location,
      bytes: r.bytes,
      count: r.count,
      deltaBytes: prior.has(r.location) ? r.bytes - prior.get(r.location)! : null,
    }));
    return { at: latest.at as number, rows };
  }

  private inTransaction(work: () => void) {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private touch(count: number, now: number) {
    this.writes += count;
    if (this.writes < 100) return;
    this.writes = 0;
    this.prune(now);
  }

  prune(now = Date.now()) {
    for (const [table, cap] of Object.entries(this.caps)) {
      this.db.prepare(`DELETE FROM ${table} WHERE at < ?`).run(now - PROFILE_RETENTION_DAYS * DAY_MS);
      this.db
        .prepare(`DELETE FROM ${table} WHERE id <= (SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?)`)
        .run(cap);
    }
  }
}

/** Decides when an RSS reading deserves a heap snapshot. Single-process baseline; a new pid resets it. */
export class ProfileTrigger {
  private pid: number | undefined;
  private lastRss = 0;
  private lastSnapshotAt = 0;
  private lastPeriodicAt = 0;
  tick(pid: number, rssBytes: number, now: number): SnapshotTrigger | null {
    if (pid !== this.pid) {
      this.reset(pid, rssBytes, now);
      return null;
    }
    if (now - this.lastSnapshotAt < MIN_SNAPSHOT_GAP_MS) return null;
    const trigger = this.pick(rssBytes, now);
    if (trigger) this.mark(rssBytes, now);
    return trigger;
  }
  breaker(pid: number, rssBytes: number, now: number): SnapshotTrigger {
    if (pid !== this.pid) this.reset(pid, rssBytes, now);
    this.mark(rssBytes, now);
    return "breaker";
  }
  private pick(rssBytes: number, now: number): SnapshotTrigger | null {
    if (rssBytes >= this.lastRss + STEP_BYTES) return "step";
    if (now - this.lastPeriodicAt >= PERIODIC_MS) return "periodic";
    return null;
  }
  private reset(pid: number, rssBytes: number, now: number) {
    this.pid = pid;
    this.lastRss = rssBytes;
    this.lastSnapshotAt = now;
    this.lastPeriodicAt = now;
  }
  private mark(rssBytes: number, now: number) {
    this.lastRss = rssBytes;
    this.lastSnapshotAt = now;
    this.lastPeriodicAt = now;
  }
}

const kibOf = (text: string, field: string) => {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(text);
  return match ? Number(match[1]) * 1024 : null;
};

export function parseSmapsRollup(text: string): Smaps {
  const rss = kibOf(text, "Rss");
  const anon = kibOf(text, "Rss_Anon") ?? kibOf(text, "Anonymous");
  const file = kibOf(text, "Rss_File");
  const derived = rss != null && anon != null ? Math.max(0, rss - anon) : null;
  return { anon, fileBacked: file ?? derived };
}

export function readSmapsRollup(pid: number): Smaps | null {
  try {
    return parseSmapsRollup(fs.readFileSync(`/proc/${Math.trunc(pid)}/smaps_rollup`, "utf8"));
  } catch {
    return null;
  }
}

// Subset of opentelemetry-proto metrics/v1 (field numbers match upstream; unknown fields are skipped).
const OTLP_PROTO = `
syntax = "proto3";
package otlp;
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message Resource { repeated KeyValue attributes = 1; }
message ScopeMetrics { repeated Metric metrics = 2; }
message Metric { string name = 1; oneof data { Gauge gauge = 5; Sum sum = 7; } }
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; }
message NumberDataPoint { repeated KeyValue attributes = 7; oneof value { double as_double = 4; sfixed64 as_int = 6; } }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; } }
`;
export const REQUEST_TYPE = protobuf.parse(OTLP_PROTO).root.lookupType("otlp.ExportMetricsServiceRequest");

export class OtlpDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpDecodeError";
  }
}

const anyValue = (value: any): string | number | boolean | undefined =>
  value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? value?.boolValue;

const attrMap = (attributes: any[] | undefined) =>
  new Map<string, string | number | boolean | undefined>(
    (attributes ?? []).map((kv) => [kv.key, anyValue(kv.value)]),
  );

const pointValue = (point: any): number | null => {
  const value = point.asDouble ?? point.asInt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const attrLabel = (attrs: Map<string, unknown>) => {
  const parts = ATTR_KEYS.filter((key) => attrs.has(key) && attrs.get(key) !== undefined).map(
    (key) => `${key}=${String(attrs.get(key)).slice(0, 64)}`,
  );
  return parts.length ? parts.join(",") : null;
};

function collectPoint(name: string, point: any, out: DecodedOtlp, sites: Map<string, SiteRow>) {
  const value = pointValue(point);
  if (value == null) return;
  const attrs = attrMap(point.attributes);
  const location = attrs.get("code.location");
  if (typeof location === "string" && (name === "headroom.alloc.bytes" || name === "headroom.alloc.count")) {
    if (!LOCATION_PATTERN.test(location)) return;
    const site = sites.get(location) ?? { location, bytes: 0, count: 0 };
    if (name === "headroom.alloc.bytes") site.bytes = value;
    else site.count = value;
    sites.set(location, site);
    return;
  }
  out.metrics.push({ name, attr: attrLabel(attrs), value });
}

export function decodeOtlpMetrics(body: Uint8Array): DecodedOtlp {
  if (body.length > MAX_OTLP_BYTES) throw new OtlpDecodeError("OTLP body too large");
  let request: any;
  try {
    request = REQUEST_TYPE.toObject(REQUEST_TYPE.decode(body), { longs: Number });
  } catch (error) {
    throw new OtlpDecodeError(`Invalid OTLP protobuf: ${(error as Error).message}`);
  }
  const out: DecodedOtlp = { pid: 0, metrics: [], sites: [] };
  const sites = new Map<string, SiteRow>();
  for (const resource of request.resourceMetrics ?? []) {
    const pid = Number(attrMap(resource.resource?.attributes).get("process.pid"));
    if (Number.isInteger(pid) && pid > 0) out.pid = pid;
    for (const scope of resource.scopeMetrics ?? [])
      for (const metric of scope.metrics ?? []) {
        if (!METRIC_ALLOWLIST.has(metric.name)) continue;
        const points = metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? [];
        for (const point of points) collectPoint(metric.name, point, out, sites);
      }
  }
  out.sites = [...sites.values()];
  return out;
}

export function ingestOtlp(store: HeadroomProfileStore, body: Uint8Array, now = Date.now()) {
  const decoded = decodeOtlpMetrics(body);
  const metrics = store.recordMetrics(decoded.pid, decoded.metrics, now);
  const sites = store.recordSites(decoded.pid, decoded.sites, now);
  return { pid: decoded.pid, metrics, sites };
}
