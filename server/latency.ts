import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const KINDS = new Set(['open', 'page', 'cached', 'refresh', 'cancelled']);
const duration = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 300_000;
const size = (n: unknown, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;

// Local, bounded measurements only. Never accept arbitrary metadata, URLs, prompts or browser fingerprints.
export class LatencyStore {
  private db: DatabaseSync;
  private writes = 0;
  private maxSamples: number;
  constructor(file: string, maxSamples = 20_000) {
    this.maxSamples = maxSamples;
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS latency (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, thread TEXT NOT NULL, provider TEXT NOT NULL,
      kind TEXT NOT NULL, total_ms REAL NOT NULL, server_ms REAL, render_ms REAL, wait_ms REAL,
      events INTEGER, bytes INTEGER, wire_bytes INTEGER, prepare_ms REAL, roundtrip_ms REAL, decode_ms REAL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      touch INTEGER NOT NULL, hidden INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS latency_at ON latency(at);`);
    const columns = new Set(this.db.prepare("PRAGMA table_info(latency)").all().map((c: any) => c.name));
    for (const name of ["wire_bytes", "prepare_ms", "roundtrip_ms", "decode_ms"]) if (!columns.has(name)) this.db.exec(`ALTER TABLE latency ADD COLUMN ${name} REAL`);
    this.prune();
  }
  record(samples: unknown, thread: (id: string) => {provider: string} | undefined, now = Date.now()) {
    if (!Array.isArray(samples) || samples.length > 20) return 0;
    const rows: any[][] = [];
    for (const s of samples) {
      if (!s || !KINDS.has(s.kind) || typeof s.thread !== 'string' || !duration(s.total_ms)) continue;
      const t = thread(s.thread);
      if (!t || !size(s.width, 16384) || !s.width || !size(s.height, 16384) || !s.height) continue;
      if (['server_ms','render_ms','wait_ms','prepare_ms','roundtrip_ms','decode_ms'].some(k => s[k] != null && !duration(s[k]))) continue;
      if (s.events != null && !size(s.events, 100_000) || ['bytes','wire_bytes'].some(k => s[k] != null && !size(s[k], 64 * 1024 * 1024))) continue;
      rows.push([now,s.thread,t.provider,s.kind,s.total_ms,s.server_ms??null,s.render_ms??null,s.wait_ms??null,s.events??null,s.bytes??null,s.wire_bytes??null,s.prepare_ms??null,s.roundtrip_ms??null,s.decode_ms??null,s.width,s.height,s.touch===true?1:0,s.hidden===true?1:0]);
    }
    if (!rows.length) return 0;
    const insert = this.db.prepare('INSERT INTO latency(at,thread,provider,kind,total_ms,server_ms,render_ms,wait_ms,events,bytes,wire_bytes,prepare_ms,roundtrip_ms,decode_ms,width,height,touch,hidden) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    this.db.exec('BEGIN');
    try {
      for (const row of rows) insert.run(...row);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.writes += rows.length;
    if (this.writes >= 100) { this.writes = 0; this.prune(now); }
    return rows.length;
  }
  private prune(now = Date.now()) {
    this.db.prepare('DELETE FROM latency WHERE at < ?').run(now - 14 * 86400_000);
    this.db.prepare('DELETE FROM latency WHERE id <= (SELECT id FROM latency ORDER BY id DESC LIMIT 1 OFFSET ?)').run(this.maxSamples);
  }
  summary(now = Date.now()) {
    this.prune(now);
    const rows = this.db.prepare('SELECT * FROM latency ORDER BY total_ms').all() as any[];
    const groups = new Map<string, any[]>();
    const add = (key: string, row: any) => { const group = groups.get(key) || []; group.push(row); groups.set(key, group); };
    for (const row of rows) {
      add(row.kind, row);
      if (!row.hidden) add(`${row.kind}/visible`, row);
      add(`${row.kind}/${row.provider}/${row.width <= 600 ? 'mobile' : row.width <= 1024 ? 'tablet' : 'desktop'}/${row.hidden ? 'background' : 'visible'}`, row);
    }
    const stats = (group: any[]) => ({ count: group.length, median_ms: group[Math.floor((group.length-1)*.5)].total_ms, p95_ms: group[Math.ceil(group.length*.95)-1].total_ms, max_ms: group.at(-1).total_ms, mean_ms: Math.round(group.reduce((n,r)=>n+r.total_ms,0)/group.length) });
    return { retention_days: 14, max_samples: this.maxSamples, count: rows.length, groups: Object.fromEntries([...groups].map(([key, values])=>[key, stats(values)])), slowest: rows.slice(-10).reverse(), recent: this.db.prepare('SELECT * FROM latency ORDER BY id DESC LIMIT 20').all() };
  }
  close() { this.db.close(); }
}
