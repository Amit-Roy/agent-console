import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// first_token: send tap -> first reply token painted on this device (wait_ms = attachment uploads still in flight at the tap)
const KINDS = new Set([
  "open",
  "page",
  "cached",
  "refresh",
  "cancelled",
  "viewer_open",
  "viewer_tree",
  "viewer_module",
  "first_token",
  "cold",
]);
const STAGES = [
  "server_ms",
  "render_ms",
  "wait_ms",
  "prepare_ms",
  "roundtrip_ms",
  "decode_ms",
  "module_ms",
  "ttfb_ms",
  "dcl_ms",
  "ws_open_ms",
  "hello_ms",
];
const duration = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 300_000;
const size = (n: unknown, max: number) =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;

function validLatencyShape(sample: any) {
  if (!size(sample.width, 16384) || !sample.width || !size(sample.height, 16384) || !sample.height)
    return false;
  if (STAGES.some((stage) => sample[stage] != null && !duration(sample[stage]))) return false;
  if (sample.events != null && !size(sample.events, 100_000)) return false;
  return !["bytes", "wire_bytes"].some(
    (field) => sample[field] != null && !size(sample[field], 64 * 1024 * 1024),
  );
}

function latencyRow(
  sample: any,
  thread: (id: string) => { provider: string } | undefined,
  now: number,
): any[] | undefined {
  if (
    !sample ||
    !KINDS.has(sample.kind) ||
    typeof sample.thread !== "string" ||
    !duration(sample.total_ms)
  )
    return undefined;
  const owner =
    sample.thread === "viewer:repos" && sample.kind.startsWith("viewer_")
      ? { provider: "workspace" }
      : thread(sample.thread);
  if (!owner || !validLatencyShape(sample)) return undefined;
  return [
    now,
    sample.thread,
    owner.provider,
    sample.kind,
    sample.total_ms,
    sample.server_ms ?? null,
    sample.render_ms ?? null,
    sample.wait_ms ?? null,
    sample.events ?? null,
    sample.bytes ?? null,
    sample.wire_bytes ?? null,
    sample.prepare_ms ?? null,
    sample.roundtrip_ms ?? null,
    sample.decode_ms ?? null,
    sample.module_ms ?? null,
    sample.ttfb_ms ?? null,
    sample.dcl_ms ?? null,
    sample.ws_open_ms ?? null,
    sample.hello_ms ?? null,
    sample.width,
    sample.height,
    sample.touch === true ? 1 : 0,
    sample.hidden === true ? 1 : 0,
  ];
}

export const RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

// Local, bounded measurements only. Never accept arbitrary metadata, URLs, prompts or browser fingerprints.
export class LatencyStore {
  private db: DatabaseSync;
  private writes = 0;
  private maxSamples: number;
  constructor(file: string, maxSamples = 20_000) {
    this.maxSamples = maxSamples;
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS latency (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, thread TEXT NOT NULL, provider TEXT NOT NULL,
      kind TEXT NOT NULL, total_ms REAL NOT NULL, server_ms REAL, render_ms REAL, wait_ms REAL,
      events INTEGER, bytes INTEGER, wire_bytes INTEGER, prepare_ms REAL, roundtrip_ms REAL, decode_ms REAL, module_ms REAL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      touch INTEGER NOT NULL, hidden INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS latency_at ON latency(at);`);
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(latency)")
        .all()
        .map((c: any) => c.name),
    );
    for (const name of [
      "wire_bytes",
      "prepare_ms",
      "roundtrip_ms",
      "decode_ms",
      "module_ms",
      "ttfb_ms",
      "dcl_ms",
      "ws_open_ms",
      "hello_ms",
    ])
      if (!columns.has(name)) this.db.exec(`ALTER TABLE latency ADD COLUMN ${name} REAL`);
    this.prune();
  }
  record(
    samples: unknown,
    thread: (id: string) => { provider: string } | undefined,
    now = Date.now(),
  ) {
    if (!Array.isArray(samples) || samples.length > 20) return 0;
    const rows: any[][] = [];
    for (const sample of samples) {
      const row = latencyRow(sample, thread, now);
      if (row) rows.push(row);
    }
    if (!rows.length) return 0;
    const insert = this.db.prepare(
      "INSERT INTO latency(at,thread,provider,kind,total_ms,server_ms,render_ms,wait_ms,events,bytes,wire_bytes,prepare_ms,roundtrip_ms,decode_ms,module_ms,ttfb_ms,dcl_ms,ws_open_ms,hello_ms,width,height,touch,hidden) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) insert.run(...row);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.writes += rows.length;
    if (this.writes >= 100) {
      this.writes = 0;
      this.prune(now);
    }
    return rows.length;
  }
  private prune(now = Date.now()) {
    this.db.prepare("DELETE FROM latency WHERE at < ?").run(now - RETENTION_DAYS * DAY_MS);
    this.db
      .prepare(
        "DELETE FROM latency WHERE id <= (SELECT id FROM latency ORDER BY id DESC LIMIT 1 OFFSET ?)",
      )
      .run(this.maxSamples);
  }
  summary(now = Date.now()) {
    this.prune(now);
    const rows = this.db.prepare("SELECT * FROM latency ORDER BY total_ms").all() as any[];
    const groups = new Map<string, any[]>();
    const add = (key: string, row: any) => {
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    };
    for (const row of rows) {
      add(row.kind, row);
      if (!row.hidden) add(`${row.kind}/visible`, row);
      add(
        `${row.kind}/${row.provider}/${row.width <= 600 ? "mobile" : row.width <= 1024 ? "tablet" : "desktop"}/${row.hidden ? "background" : "visible"}`,
        row,
      );
    }
    // latest 20 foreground samples per kind: shows a fix (or a regression) that the retention-window pool hides
    for (const [key, group] of [...groups].filter(
      ([key]) => key.endsWith("/visible") && key.split("/").length === 2,
    ))
      groups.set(
        `${key}/recent`,
        [...group]
          .sort((a, b) => b.at - a.at || b.id - a.id)
          .slice(0, 20)
          .sort((a, b) => a.total_ms - b.total_ms),
      );
    const stats = (group: any[]) => ({
      count: group.length,
      median_ms: group[Math.floor((group.length - 1) * 0.5)].total_ms,
      p95_ms: group[Math.ceil(group.length * 0.95) - 1].total_ms,
      max_ms: group.at(-1).total_ms,
      mean_ms: Math.round(group.reduce((n, r) => n + r.total_ms, 0) / group.length),
    });
    // Viewer stages expose cold-module, transport, decode and drawing costs independently.
    // Missing stages stay absent, including on databases created before viewer measurements.
    const viewerStats = (group: any[]) => ({
      stages: Object.fromEntries(
        STAGES.flatMap((key) => {
          const values = group
            .filter((row) => row[key] != null)
            .map((row) => ({ total_ms: row[key] }))
            .sort((a, b) => a.total_ms - b.total_ms);
          return values.length ? [[key, stats(values)]] : [];
        }),
      ),
      counts: Object.fromEntries(
        ["events", "bytes", "wire_bytes"].flatMap((key) => {
          const values = group.filter((row) => row[key] != null).map((row) => row[key]);
          return values.length
            ? [
                [
                  key,
                  {
                    count: values.length,
                    total: values.reduce((a, b) => a + b, 0),
                    max: Math.max(...values),
                  },
                ],
              ]
            : [];
        }),
      ),
    });
    // The Run details table picks its own percentiles, so its two windows carry every sorted time (whole ms keep it small).
    const shown = (key: string) => /^[^/]+\/visible(\/recent)?$/.test(key);
    return {
      retention_days: RETENTION_DAYS,
      max_samples: this.maxSamples,
      count: rows.length,
      groups: Object.fromEntries(
        [...groups].map(([key, values]) => [
          key,
          {
            ...stats(values),
            ...(key.startsWith("viewer_") ? viewerStats(values) : {}),
            ...(shown(key) ? { samples_ms: values.map((r) => Math.round(r.total_ms)) } : {}),
          },
        ]),
      ),
      slowest: rows.slice(-10).reverse(),
      recent: this.db.prepare("SELECT * FROM latency ORDER BY id DESC LIMIT 20").all(),
    };
  }
  // Foreground samples of one kind in a window, for the dashboard's per-provider percentiles.
  samples(kind: string, from: number, to: number) {
    return this.db
      .prepare(
        "SELECT provider, total_ms FROM latency WHERE kind = ? AND hidden = 0 AND at BETWEEN ? AND ? ORDER BY total_ms",
      )
      .all(kind, from, to) as { provider: string; total_ms: number }[];
  }
  close() {
    this.db.close();
  }
}
