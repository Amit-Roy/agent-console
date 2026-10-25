import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPrCreate, parsePrRef, prsFromResult } from "./session-prs.ts";

const MAX_TEXT = 128_000;
const MAX_LINE = 8 * 1024 * 1024;
const bounded = (value: unknown, fallback: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.floor(value)))
    : fallback;
const SYNC_WAIT_MS = 3000;
const BACKGROUND_START_MS = 500;
const BACKGROUND_EVERY_MS = 60_000;
/** Names of the history tools themselves: `session_search`, `mcp__agent_console__session_search`, `agent_console:session_read`. */
const ECHO_TOOL = /(?:^|[^a-z0-9])session_(?:search|read)$/i;
const isEchoName = (name: unknown) => typeof name === "string" && ECHO_TOOL.test(name);
/** Already indexed rows: a tool call starts with its name; results carry the JSON shape session_search/session_read return. */
function isEchoRowText(text: string) {
  if (isEchoName(text.split("\n", 1)[0])) return true;
  if (!text.includes('"citation"')) return false;
  return (
    text.includes('"indexedSessions"') || (text.includes('"events"') && text.includes('"archived"'))
  );
}
const safeId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{1,200}$/.test(id);

type TextCollector = { parts: string[]; length: number };
const SECRET_KEY = /^(data|image|source|signature|api_key|token|authorization|password|secret)$/i;
function addText(collector: TextCollector, value: unknown) {
  if (typeof value === "string" && collector.length < MAX_TEXT) {
    const text = value.slice(0, MAX_TEXT - collector.length);
    collector.parts.push(text);
    collector.length += text.length;
  }
}
function addToolObject(collector: TextCollector, value: any, depth: number) {
  if (value.type === "image" || value.type === "image_url") return;
  for (const [key, child] of Object.entries(value))
    if (!SECRET_KEY.test(key)) addToolValue(collector, child, depth + 1);
}
function addToolValue(collector: TextCollector, value: any, depth = 0) {
  if (depth > 8 || collector.length >= MAX_TEXT) return;
  if (typeof value === "string") addText(collector, value);
  else if (Array.isArray(value)) for (const item of value) addToolValue(collector, item, depth + 1);
  else if (value && typeof value === "object") addToolObject(collector, value, depth);
}
// Returns "tool" when the block belongs to a tool call, otherwise undefined.
function addBlock(collector: TextCollector, block: any) {
  if (block?.type === "text") addText(collector, block.text);
  else if (block?.type === "tool_use") {
    addText(collector, block.name);
    addToolValue(collector, block.input);
    return "tool";
  } else if (block?.type === "tool_result") {
    addToolValue(collector, block.content);
    return "tool";
  }
  return undefined;
}

// Index displayed conversation content, not credentials, images, provider packets, or token accounting.
function eventText(event: any): { role: string; text: string } | null {
  if (!event || typeof event !== "object") return null;
  if (event.type === "user_input" && typeof event.text === "string")
    return { role: "user", text: event.text.slice(0, MAX_TEXT) };
  if (event.type !== "assistant" && event.type !== "user") return null;
  const collector: TextCollector = { parts: [], length: 0 };
  let role = event.type === "assistant" ? "assistant" : "user";
  const content = event.message?.content;
  if (typeof content === "string") addText(collector, content);
  else if (Array.isArray(content))
    for (const block of content) role = addBlock(collector, block) ?? role;
  const text = collector.parts.join("\n").trim();
  return text ? { role, text } : null;
}

export type SessionSearchHooks = {
  beforeRefresh?: () => Promise<void>;
  /** Pause the echo cleanup after this many batches (tests). */
  cleanupBatchLimit?: number;
};
const ECHO_BATCH_MS = 50;
const ECHO_PREFILTER = `(text LIKE '%session_search%' OR text LIKE '%session_read%' OR text LIKE '%"citation"%')`;
type EchoPhase = { key: string; table: string; read: string; remove: string };
/** Cleanup passes over rowid windows: `events` rows by id, then FTS rows by rowid (no stable link to events). */
const ECHO_PHASES: EchoPhase[] = [
  {
    key: "echo_events_last",
    table: "events",
    read: `SELECT id,text FROM events WHERE id>? AND id<=? AND role='tool' AND ${ECHO_PREFILTER}`,
    remove: "DELETE FROM events WHERE id IN",
  },
  {
    key: "echo_fts_last",
    table: "session_fts_content",
    read: `SELECT id,c1 AS text FROM session_fts_content WHERE id>? AND id<=? AND c4='tool' AND ${ECHO_PREFILTER.replaceAll("text", "c1")}`,
    remove: "DELETE FROM session_fts WHERE rowid IN",
  },
];
type LogScan = { bytes: number; lines: number; pending: Buffer; skipped: number };
export type SessionSearchInput = { query: string; provider?: string; limit?: number };
export type SessionReadInput = { thread: string; start?: number; limit?: number };

/** Persistent local FTS5/BM25 index of canonical logs, shared by all providers. Lines are 1-based. */
export class SessionSearch {
  private db: DatabaseSync;
  private pending: Promise<void> | undefined;
  private closed = false;
  private maintenance = false;
  /** Archive state lives in threads.json, not the logs, so it is refreshed on every sync rather than indexed. */
  private archived = new Set<string>();
  private dataDir: string;
  private hooks: SessionSearchHooks;
  private loggedError = "";
  private echoPending = false;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private cleanupWindow = 1000;
  private settleCleaned: () => void = () => {};
  private cleanedPromise: Promise<void> = new Promise((resolve) => {
    this.settleCleaned = resolve;
  });
  /** Echo-cleanup progress, exposed for tests and measurements. */
  cleanupStats = { batches: 0, longestBatchMs: 0 };
  private timers: NodeJS.Timeout[] = [];
  constructor(dataDir: string, hooks: SessionSearchHooks = {}) {
    this.dataDir = dataDir;
    this.hooks = hooks;
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "session-search.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        thread TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0, lines INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0, mtime REAL NOT NULL DEFAULT 0,
        inode TEXT NOT NULL DEFAULT '', tail TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, thread TEXT NOT NULL, line INTEGER NOT NULL,
        role TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(thread,line)
      );
      CREATE INDEX IF NOT EXISTS events_thread_line ON events(thread,line);
      CREATE TABLE IF NOT EXISTS pr_calls (thread TEXT NOT NULL, tool_id TEXT NOT NULL, PRIMARY KEY(thread,tool_id));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS echo_calls (thread TEXT NOT NULL, tool_id TEXT NOT NULL, PRIMARY KEY(thread,tool_id));
      CREATE TABLE IF NOT EXISTS prs (
        thread TEXT NOT NULL, line INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
        PRIMARY KEY(thread,repo,number)
      );
      CREATE INDEX IF NOT EXISTS prs_number ON prs(number);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(title,text,thread UNINDEXED,line UNINDEXED,role UNINDEXED, tokenize='unicode61 remove_diacritics 2');`);
    // Logs indexed before PR tracking have no prs rows: drop them once so the next sync rebuilds from the logs.
    this.db.function("is_echo", { deterministic: true }, (text) =>
      isEchoRowText(String(text)) ? 1 : 0,
    );
    const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
    if (version < 1) {
      this.db.exec(
        "DELETE FROM session_fts; DELETE FROM events; DELETE FROM sessions; PRAGMA user_version=2;",
      );
    } else if (version < 2) {
      this.echoPending = true;
      this.scheduleCleanup();
    }
    this.scheduleBackground();
  }

  /** Resolves when the echo cleanup has finished or the index was closed. */
  whenCleaned() {
    return this.cleanedPromise;
  }

  private scheduleCleanup() {
    if (this.closed || this.maintenance || this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => this.cleanupStep(), 0);
  }

  private metaValue(key: string) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? Number(row.value) : 0;
  }

  /** One small, time-bounded batch of the user_version 2 migration; yields to the event loop between batches. */
  private cleanupStep() {
    this.cleanupTimer = undefined;
    if (this.closed || this.maintenance || this.cleanupPaused()) return;
    try {
      const began = performance.now();
      const phase = ECHO_PHASES.find((entry) => this.phaseLast(entry) < this.phaseMax(entry));
      if (!phase) return this.finishCleanup();
      this.cleanBatch(phase);
      this.cleanupStats.longestBatchMs = Math.max(
        this.cleanupStats.longestBatchMs,
        performance.now() - began,
      );
      this.cleanupStats.batches++;
      this.adaptWindow(performance.now() - began);
      this.scheduleCleanup();
    } catch (error) {
      this.logOnce(error);
      this.settleCleaned();
    }
  }

  private cleanupPaused() {
    const limit = this.hooks.cleanupBatchLimit;
    return limit !== undefined && this.cleanupStats.batches >= limit;
  }

  private phaseLast(phase: EchoPhase) {
    return this.metaValue(phase.key);
  }

  private phaseMax(phase: EchoPhase) {
    return Number(
      this.db.prepare(`SELECT coalesce(max(id),0) AS top FROM ${phase.table}`).get()!.top,
    );
  }

  private adaptWindow(elapsedMs: number) {
    if (elapsedMs < ECHO_BATCH_MS / 2)
      this.cleanupWindow = Math.min(this.cleanupWindow * 2, 50_000);
    else if (elapsedMs > ECHO_BATCH_MS) this.cleanupWindow = Math.max(this.cleanupWindow >> 1, 50);
  }

  private cleanBatch(phase: EchoPhase) {
    const from = this.phaseLast(phase);
    const upto = Math.min(from + this.cleanupWindow, this.phaseMax(phase));
    const rows = this.db.prepare(phase.read).all(from, upto);
    const doomed = rows
      .filter((row) => isEchoRowText(String(row.text)))
      .map((row) => Number(row.id));
    this.db.exec("BEGIN");
    try {
      for (let offset = 0; offset < doomed.length; offset += 500) {
        const chunk = doomed.slice(offset, offset + 500);
        this.db.prepare(`${phase.remove} (${chunk.map(() => "?").join(",")})`).run(...chunk);
      }
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(phase.key, upto);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private finishCleanup() {
    this.db.exec("DELETE FROM meta WHERE key LIKE 'echo_%'; PRAGMA user_version=2;");
    this.echoPending = false;
    this.settleCleaned();
  }

  /** Catch the index up shortly after start and every minute, so queries rarely wait. */
  private scheduleBackground() {
    const tick = () => {
      if (!this.closed && !this.maintenance) this.start().catch((error) => this.logOnce(error));
    };
    const first = setTimeout(tick, BACKGROUND_START_MS);
    const every = setInterval(tick, BACKGROUND_EVERY_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  private logOnce(error: any) {
    if (this.closed) return;
    const message = String(error?.message ?? error);
    if (message === this.loggedError) return;
    this.loggedError = message;
    console.error(`session-search: refresh failed: ${message}`);
  }

  /** Single-flight refresh; callers share one promise. */
  private start() {
    if (this.closed) throw new Error("Session search is closed.");
    if (this.maintenance) throw new Error("Session search is in maintenance.");
    if (!this.pending) {
      this.pending = this.refresh().finally(() => {
        this.pending = undefined;
      });
      this.pending.catch(() => {}); // callers that gave up waiting must not trigger unhandled rejections
    }
    return this.pending;
  }

  private hasIndex() {
    return Number(this.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n) > 0;
  }

  /** Wait for the refresh at most SYNC_WAIT_MS; returns true when answering from a stale index. */
  private async sync() {
    if (this.maintenance) throw new Error("Session search is in maintenance.");
    const run = this.start();
    const limit = Number(process.env.AGENT_CONSOLE_SEARCH_SYNC_MS ?? SYNC_WAIT_MS);
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Number.isFinite(limit) ? limit : SYNC_WAIT_MS);
    });
    try {
      const stale = await Promise.race([run.then(() => false), waited]);
      if (this.maintenance) throw new Error("Session search is in maintenance.");
      return stale;
    } catch (error) {
      if (this.maintenance) throw new Error("Session search is in maintenance.");
      if (!this.hasIndex()) throw error;
      this.logOnce(error);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  private remove(thread: string) {
    this.db.prepare("DELETE FROM session_fts WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM events WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM sessions WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM pr_calls WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM echo_calls WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM prs WHERE thread=?").run(thread);
  }

  /** Remember `gh pr create` calls and record the PR each one printed. Tool calls and results may arrive in different syncs. */
  private trackPrs(thread: string, line: number, event: any) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        isPrCreate(block.input?.command)
      )
        this.db
          .prepare("INSERT OR IGNORE INTO pr_calls(thread,tool_id) VALUES(?,?)")
          .run(thread, block.id);
      else if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        this.db
          .prepare("SELECT 1 FROM pr_calls WHERE thread=? AND tool_id=?")
          .get(thread, block.tool_use_id)
      )
        for (const pr of prsFromResult(block.content))
          this.db
            .prepare("INSERT OR IGNORE INTO prs(thread,line,repo,number,url) VALUES(?,?,?,?,?)")
            .run(thread, line, pr.repo, pr.number, pr.url);
    }
  }

  /** Drop the history tools' own calls and results (found by tool id, which may arrive in a later sync) from an event. */
  private stripEcho(thread: string, event: any) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return event;
    const kept = content.filter((block) => !this.isEchoBlock(thread, block));
    return kept.length === content.length
      ? event
      : { ...event, message: { ...event.message, content: kept } };
  }

  private isEchoBlock(thread: string, block: any) {
    if (block?.type === "tool_use" && isEchoName(block.name)) {
      if (typeof block.id === "string")
        this.db
          .prepare("INSERT OR IGNORE INTO echo_calls(thread,tool_id) VALUES(?,?)")
          .run(thread, block.id);
      return true;
    }
    return (
      block?.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      !!this.db
        .prepare("SELECT 1 FROM echo_calls WHERE thread=? AND tool_id=?")
        .get(thread, block.tool_use_id)
    );
  }

  private async fingerprint(file: string, end: number) {
    if (!end) return "";
    const handle = await fsp.open(file, "r");
    try {
      const head = Buffer.alloc(Math.min(1024, end));
      const first = await handle.read(head, 0, head.length, 0);
      const hash = createHash("sha256").update(head.subarray(0, first.bytesRead));
      if (end > 1024) {
        const tail = Buffer.alloc(Math.min(1024, end - 1024));
        const last = await handle.read(tail, 0, tail.length, end - tail.length);
        hash.update(tail.subarray(0, last.bytesRead));
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  }

  private async readCatalog(): Promise<any[]> {
    let threads: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        threads = JSON.parse(await fsp.readFile(path.join(this.dataDir, "threads.json"), "utf8"));
        break;
      } catch (error: any) {
        if (error.code === "ENOENT") {
          threads = [];
          break;
        }
        if (attempt === 2)
          throw new Error("Session catalog is unavailable; try again after it is saved.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!Array.isArray(threads)) throw new Error("Session catalog must contain an array.");
    return threads;
  }

  private async refresh() {
    await this.hooks.beforeRefresh?.();
    const threads = await this.readCatalog();
    const valid = threads.filter((entry) => safeId(entry?.id));
    const ids = new Set(valid.map((entry) => entry.id));
    this.archived = new Set(valid.filter((entry) => entry.archived).map((entry) => entry.id));
    for (const row of this.db.prepare("SELECT thread FROM sessions").all())
      if (!ids.has(row.thread)) this.remove(String(row.thread));
    for (const entry of valid) await this.syncThread(entry);
  }

  private async logChanged(old: any, stat: fs.Stats | undefined, file: string) {
    if (!old) return true;
    if (!stat) return old.size !== 0;
    return (
      String(stat.ino) !== old.inode ||
      stat.size < old.size ||
      (stat.size === old.size && stat.mtimeMs !== old.mtime) ||
      (stat.size > old.size && (await this.fingerprint(file, old.bytes)) !== old.tail)
    );
  }

  private upsertSessionRow(id: string, title: string, provider: string, old: any) {
    if (!old) {
      this.db
        .prepare("INSERT INTO sessions(thread,title,provider) VALUES(?,?,?)")
        .run(id, title, provider);
      this.db
        .prepare("INSERT INTO session_fts(title,text,thread,line,role) VALUES(?,'',?,0,'title')")
        .run(title, id);
    } else if (old.title !== title || old.provider !== provider) {
      this.db
        .prepare("UPDATE sessions SET title=?,provider=? WHERE thread=?")
        .run(title, provider, id);
      this.db.prepare("UPDATE session_fts SET title=? WHERE thread=?").run(title, id);
    }
  }

  private async syncThread(entry: any) {
    const file = path.join(this.dataDir, "logs", `${entry.id}.jsonl`);
    const title = String(entry.title ?? "Untitled").slice(0, 500),
      provider = String(entry.provider ?? "unknown").slice(0, 100);
    let old = this.db.prepare("SELECT * FROM sessions WHERE thread=?").get(entry.id) as any;
    let stat: fs.Stats | undefined;
    try {
      stat = await fsp.stat(file);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (old && (await this.logChanged(old, stat, file))) {
      this.remove(entry.id);
      old = undefined;
    }
    this.upsertSessionRow(entry.id, title, provider, old);
    if (!stat || (old && stat.size === old.size && stat.mtimeMs === old.mtime)) return;
    await this.indexLog({ id: entry.id, title, file }, stat, old);
  }

  /** Parse complete lines in one chunk, advancing the scan counters and collecting indexable rows. */
  private scanChunk(threadId: string, scan: LogScan, chunk: Buffer) {
    const data = scan.pending.length ? Buffer.concat([scan.pending, chunk]) : chunk;
    let begin = 0,
      newline: number;
    const batch: { line: number; role: string; text: string }[] = [];
    while ((newline = data.indexOf(10, begin)) >= 0) {
      const raw = data.subarray(begin, newline);
      scan.bytes += scan.skipped + raw.length + 1;
      scan.lines++;
      if (!scan.skipped && raw.length <= MAX_LINE) {
        try {
          const parsed = JSON.parse(raw.toString("utf8"));
          const item = eventText(this.stripEcho(threadId, parsed));
          if (item) batch.push({ line: scan.lines, ...item });
          this.trackPrs(threadId, scan.lines, parsed);
        } catch {
          /* Ignore malformed complete lines; keep exact physical line references. */
        }
      }
      scan.skipped = 0;
      begin = newline + 1;
    }
    scan.pending = data.subarray(begin);
    if (scan.pending.length > MAX_LINE) {
      scan.skipped += scan.pending.length;
      scan.pending = Buffer.alloc(0);
    }
    return batch;
  }

  private writeBatch(
    target: { id: string; title: string },
    batch: { line: number; role: string; text: string }[],
  ) {
    this.db.exec("BEGIN");
    try {
      const event = this.db.prepare(
        "INSERT OR REPLACE INTO events(thread,line,role,text) VALUES(?,?,?,?)",
      );
      const fts = this.db.prepare(
        "INSERT INTO session_fts(title,text,thread,line,role) VALUES(?,?,?,?,?)",
      );
      for (const row of batch) {
        event.run(target.id, row.line, row.role, row.text);
        fts.run(target.title, row.text, target.id, row.line, row.role);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async indexLog(
    target: { id: string; title: string; file: string },
    stat: fs.Stats,
    old: any,
  ) {
    const scan: LogScan = {
      bytes: old?.bytes ?? 0,
      lines: old?.lines ?? 0,
      pending: Buffer.alloc(0),
      skipped: 0,
    };
    // Recover a process exit between a batch commit and the file checkpoint.
    this.db.prepare("DELETE FROM events WHERE thread=? AND line>?").run(target.id, scan.lines);
    this.db.prepare("DELETE FROM session_fts WHERE thread=? AND line>?").run(target.id, scan.lines);
    if (stat.size === 0) {
      this.db
        .prepare("UPDATE sessions SET size=0,mtime=?,inode=? WHERE thread=?")
        .run(stat.mtimeMs, String(stat.ino), target.id);
      return;
    }
    // Fixed-size stream chunks keep file I/O asynchronous and bound memory for malformed lines.
    const stream = fs.createReadStream(target.file, {
      start: scan.bytes,
      end: stat.size - 1,
      highWaterMark: 64 * 1024,
    });
    for await (const chunk of stream) {
      const batch = this.scanChunk(target.id, scan, chunk as Buffer);
      if (batch.length) this.writeBatch(target, batch);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const tail = await this.fingerprint(target.file, scan.bytes);
    this.db
      .prepare("UPDATE sessions SET bytes=?,lines=?,size=?,mtime=?,inode=?,tail=? WHERE thread=?")
      .run(scan.bytes, scan.lines, stat.size, stat.mtimeMs, String(stat.ino), tail, target.id);
  }

  /** Start an initial background build before the first provider or browser query. */
  async warm() {
    await this.start();
  }

  async beginMaintenance() {
    if (this.closed) throw new Error("Session search is closed.");
    if (this.maintenance) throw new Error("Session search is already in maintenance.");
    this.maintenance = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    try {
      await this.pending;
    } catch (error) {
      this.maintenance = false;
      if (this.echoPending && !this.cleanupPaused()) this.scheduleCleanup();
      throw error;
    }
  }

  private checkpoint() {
    const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as any;
    if (Number(result.busy) !== 0) throw new Error("Session search index checkpoint is busy.");
  }

  async endMaintenance(rebuild: boolean) {
    if (!this.maintenance) throw new Error("Session search is not in maintenance.");
    try {
      if (!rebuild || this.closed) return;
      this.db.exec("PRAGMA secure_delete=ON;");
      this.db.exec(
        "DELETE FROM session_fts; DELETE FROM events; DELETE FROM sessions; DELETE FROM pr_calls; DELETE FROM prs; DELETE FROM echo_calls;",
      );
      this.finishCleanup();
      this.db.exec("VACUUM;");
      this.checkpoint();
      await this.refresh();
      this.checkpoint();
    } finally {
      this.maintenance = false;
      if (this.echoPending && !this.closed && !this.cleanupPaused()) this.scheduleCleanup();
    }
  }

  async search(input: SessionSearchInput) {
    const query = typeof input?.query === "string" ? input.query.trim() : "";
    if (!query || query.length > 500)
      throw new Error("Search query must contain 1–500 characters.");
    const terms = [...query.matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => m[0]).slice(0, 32);
    if (!terms.length) throw new Error("Search query needs words or numbers.");
    const match = [...new Set(terms)].map((term) => `"${term}"`).join(" OR ");
    const limit = bounded(input.limit, 20, 50);
    if (
      input.provider !== undefined &&
      (typeof input.provider !== "string" || input.provider.length > 100)
    )
      throw new Error("Invalid provider filter.");
    const stale = await this.sync();
    const rows = this.db
      .prepare(`SELECT f.thread,s.title,s.provider,f.line,f.role,
      snippet(session_fts,1,'[',']',' … ',40) AS snippet,bm25(session_fts,3.0,1.0) AS score
      FROM session_fts f JOIN sessions s ON s.thread=f.thread
      WHERE session_fts MATCH ? ${input.provider ? "AND s.provider=?" : ""}${this.echoPending ? " AND NOT (f.role='tool' AND is_echo(f.text))" : ""}
      ORDER BY score, f.thread, f.line LIMIT ?`)
      .all(match, ...(input.provider ? [input.provider] : []), limit);
    return {
      query,
      results: rows.map((row) => ({
        ...row,
        archived: this.archived.has(String(row.thread)),
        citation: `${row.thread}:L${row.line}`,
        url: `/#thread=${encodeURIComponent(String(row.thread))}`,
      })),
      indexedSessions: Number(this.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n),
      ...(stale ? { stale: true } : {}),
    };
  }

  async read(input: SessionReadInput) {
    if (!safeId(input?.thread)) throw new Error("Invalid thread id.");
    const start = bounded(input.start, 1, Number.MAX_SAFE_INTEGER),
      limit = bounded(input.limit, 30, 100);
    const stale = await this.sync();
    const session = this.db
      .prepare("SELECT title,provider,lines FROM sessions WHERE thread=?")
      .get(input.thread);
    if (!session) throw new Error("Unknown session.");
    const rows = this.db
      .prepare(
        `SELECT line,role,substr(text,1,12000) AS text FROM events WHERE thread=? AND line>=?${this.echoPending ? " AND NOT (role='tool' AND is_echo(text))" : ""} ORDER BY line LIMIT ?`,
      )
      .all(input.thread, start, limit);
    // Bound response bytes as well as event count; tool logs may be very large.
    const events: typeof rows = [];
    let size = 0;
    for (const row of rows) {
      size += String(row.text).length;
      if (events.length && size > 48_000) break;
      events.push({ ...row, citation: `${input.thread}:L${row.line}` });
    }
    const next = events.length ? Number(events.at(-1)!.line) + 1 : null;
    return {
      thread: input.thread,
      title: session.title,
      provider: session.provider,
      archived: this.archived.has(input.thread),
      start,
      next: next !== null && next <= Number(session.lines) ? next : null,
      events,
      ...(stale ? { stale: true } : {}),
    };
  }

  /** Sessions whose log changed after `since` (epoch ms), newest first. Empty logs are left out. */
  async recent(input: { since: number; limit?: number }) {
    const since = Number(input?.since);
    if (!Number.isFinite(since)) throw new Error("since must be a time in milliseconds.");
    await this.sync();
    return this.db
      .prepare(
        "SELECT thread AS id,provider,title,mtime,lines FROM sessions WHERE mtime>? AND lines>0 ORDER BY mtime DESC, thread LIMIT ?",
      )
      .all(since, bounded(input.limit, 50, 500))
      .map((row) => ({
        id: String(row.id),
        provider: String(row.provider),
        title: String(row.title),
        mtime: Number(row.mtime),
        lines: Number(row.lines),
      }));
  }

  /** PRs a session raised (by thread), or sessions that raised a PR (by `ref`: URL, `owner/repo#n` or number). */
  async prs(input: { thread?: string; ref?: string }) {
    const stale = await this.sync();
    const select = `SELECT p.thread,s.title,s.provider,p.line,p.repo,p.number,p.url FROM prs p JOIN sessions s ON s.thread=p.thread`;
    let rows: any[];
    if (input.thread !== undefined) {
      if (!safeId(input.thread)) throw new Error("Invalid thread id.");
      rows = this.db.prepare(`${select} WHERE p.thread=? ORDER BY p.line`).all(input.thread);
    } else {
      const ref = parsePrRef(input.ref);
      if (!ref) throw new Error("Give a GitHub PR URL, owner/repo#number, or a PR number.");
      rows = this.db
        .prepare(
          `${select} WHERE p.number=? ${ref.repo ? "AND p.repo=?" : ""} ORDER BY s.mtime DESC, p.line LIMIT 50`,
        )
        .all(ref.number, ...(ref.repo ? [ref.repo] : []));
    }
    return {
      prs: rows.map((r) => ({
        ...r,
        archived: this.archived.has(String(r.thread)),
        citation: `${r.thread}:L${r.line}`,
        sessionUrl: `/#thread=${encodeURIComponent(String(r.thread))}`,
      })),
      ...(stale ? { stale: true } : {}),
    };
  }

  close() {
    this.closed = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.settleCleaned();
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.db.close();
  }
}
