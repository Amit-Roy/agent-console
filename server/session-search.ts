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
const safeId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{1,200}$/.test(id);

// Index displayed conversation content, not credentials, images, provider packets, or token accounting.
function eventText(e: any): { role: string; text: string } | null {
  if (!e || typeof e !== "object") return null;
  if (e.type === "user_input" && typeof e.text === "string")
    return { role: "user", text: e.text.slice(0, MAX_TEXT) };
  if (e.type !== "assistant" && e.type !== "user") return null;
  const parts: string[] = [];
  let length = 0;
  const add = (s: unknown) => {
    if (typeof s === "string" && length < MAX_TEXT) {
      const text = s.slice(0, MAX_TEXT - length);
      parts.push(text);
      length += text.length;
    }
  };
  const toolValue = (v: any, depth = 0) => {
    if (depth > 8 || length >= MAX_TEXT) return;
    if (typeof v === "string") add(v);
    else if (Array.isArray(v)) for (const x of v) toolValue(x, depth + 1);
    else if (v && typeof v === "object")
      for (const [key, value] of Object.entries(v)) {
        if (
          /^(data|image|source|signature|api_key|token|authorization|password|secret)$/i.test(key)
        )
          continue;
        if (v.type === "image" || v.type === "image_url") continue;
        toolValue(value, depth + 1);
      }
  };
  let role = e.type === "assistant" ? "assistant" : "user";
  const content = e.message?.content;
  if (typeof content === "string") add(content);
  else if (Array.isArray(content))
    for (const block of content) {
      if (block?.type === "text") add(block.text);
      else if (block?.type === "tool_use") {
        role = "tool";
        add(block.name);
        toolValue(block.input);
      } else if (block?.type === "tool_result") {
        role = "tool";
        toolValue(block.content);
      }
    }
  const text = parts.join("\n").trim();
  return text ? { role, text } : null;
}

export type SessionSearchInput = { query: string; provider?: string; limit?: number };
export type SessionReadInput = { thread: string; start?: number; limit?: number };

/** Persistent local FTS5/BM25 index of canonical logs, shared by all providers. Lines are 1-based. */
export class SessionSearch {
  private db: DatabaseSync;
  private pending: Promise<void> | undefined;
  private closed = false;
  /** Archive state lives in threads.json, not the logs, so it is refreshed on every sync rather than indexed. */
  private archived = new Set<string>();
  private dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "session-search.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
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
      CREATE TABLE IF NOT EXISTS prs (
        thread TEXT NOT NULL, line INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
        PRIMARY KEY(thread,repo,number)
      );
      CREATE INDEX IF NOT EXISTS prs_number ON prs(number);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(title,text,thread UNINDEXED,line UNINDEXED,role UNINDEXED, tokenize='unicode61 remove_diacritics 2');`);
    // Logs indexed before PR tracking have no prs rows: drop them once so the next sync rebuilds from the logs.
    if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) < 1) {
      this.db.exec(
        "DELETE FROM session_fts; DELETE FROM events; DELETE FROM sessions; PRAGMA user_version=1;",
      );
    }
  }

  private async sync() {
    if (this.closed) throw new Error("Session search is closed.");
    if (!this.pending)
      this.pending = this.refresh().finally(() => {
        this.pending = undefined;
      });
    await this.pending;
  }

  private remove(thread: string) {
    this.db.prepare("DELETE FROM session_fts WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM events WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM sessions WHERE thread=?").run(thread);
    this.db.prepare("DELETE FROM pr_calls WHERE thread=?").run(thread);
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

  private async refresh() {
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
    const valid = threads.filter((t) => safeId(t?.id));
    const ids = new Set(valid.map((t) => t.id));
    this.archived = new Set(valid.filter((t) => t.archived).map((t) => t.id));
    for (const row of this.db.prepare("SELECT thread FROM sessions").all())
      if (!ids.has(row.thread)) this.remove(String(row.thread));
    for (const t of valid) {
      const file = path.join(this.dataDir, "logs", `${t.id}.jsonl`);
      const title = String(t.title ?? "Untitled").slice(0, 500),
        provider = String(t.provider ?? "unknown").slice(0, 100);
      let old = this.db.prepare("SELECT * FROM sessions WHERE thread=?").get(t.id) as any;
      let stat: fs.Stats | undefined;
      try {
        stat = await fsp.stat(file);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      let reset = !old;
      if (old && stat) {
        reset =
          String(stat.ino) !== old.inode ||
          stat.size < old.size ||
          (stat.size === old.size && stat.mtimeMs !== old.mtime) ||
          (stat.size > old.size && (await this.fingerprint(file, old.bytes)) !== old.tail);
      } else if (old && !stat) reset = old.size !== 0;
      if (reset && old) {
        this.remove(t.id);
        old = undefined;
      }
      if (!old) {
        this.db
          .prepare("INSERT INTO sessions(thread,title,provider) VALUES(?,?,?)")
          .run(t.id, title, provider);
        this.db
          .prepare("INSERT INTO session_fts(title,text,thread,line,role) VALUES(?,'',?,0,'title')")
          .run(title, t.id);
      } else if (old.title !== title || old.provider !== provider) {
        this.db
          .prepare("UPDATE sessions SET title=?,provider=? WHERE thread=?")
          .run(title, provider, t.id);
        this.db.prepare("UPDATE session_fts SET title=? WHERE thread=?").run(title, t.id);
      }
      if (!stat || (old && stat.size === old.size && stat.mtimeMs === old.mtime)) continue;
      let bytes = old?.bytes ?? 0,
        lines = old?.lines ?? 0;
      // Recover a process exit between a batch commit and the file checkpoint.
      this.db.prepare("DELETE FROM events WHERE thread=? AND line>?").run(t.id, lines);
      this.db.prepare("DELETE FROM session_fts WHERE thread=? AND line>?").run(t.id, lines);
      if (stat.size === 0) {
        this.db
          .prepare("UPDATE sessions SET size=0,mtime=?,inode=? WHERE thread=?")
          .run(stat.mtimeMs, String(stat.ino), t.id);
        continue;
      }
      let pending = Buffer.alloc(0),
        skipped = 0;
      // Fixed-size stream chunks keep file I/O asynchronous and bound memory for malformed lines.
      const stream = fs.createReadStream(file, {
        start: bytes,
        end: stat.size - 1,
        highWaterMark: 64 * 1024,
      });
      for await (const chunk of stream) {
        const data = pending.length ? Buffer.concat([pending, chunk]) : (chunk as Buffer);
        let begin = 0,
          newline: number;
        const batch: { line: number; role: string; text: string }[] = [];
        while ((newline = data.indexOf(10, begin)) >= 0) {
          const raw = data.subarray(begin, newline);
          bytes += skipped + raw.length + 1;
          lines++;
          if (!skipped && raw.length <= MAX_LINE) {
            try {
              const parsed = JSON.parse(raw.toString("utf8"));
              const item = eventText(parsed);
              if (item) batch.push({ line: lines, ...item });
              this.trackPrs(t.id, lines, parsed);
            } catch {
              /* Ignore malformed complete lines; keep exact physical line references. */
            }
          }
          skipped = 0;
          begin = newline + 1;
        }
        pending = data.subarray(begin);
        if (pending.length > MAX_LINE) {
          skipped += pending.length;
          pending = Buffer.alloc(0);
        }
        if (batch.length) {
          this.db.exec("BEGIN");
          try {
            const event = this.db.prepare(
              "INSERT OR REPLACE INTO events(thread,line,role,text) VALUES(?,?,?,?)",
            );
            const fts = this.db.prepare(
              "INSERT INTO session_fts(title,text,thread,line,role) VALUES(?,?,?,?,?)",
            );
            for (const row of batch) {
              event.run(t.id, row.line, row.role, row.text);
              fts.run(title, row.text, t.id, row.line, row.role);
            }
            this.db.exec("COMMIT");
          } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const tail = await this.fingerprint(file, bytes);
      this.db
        .prepare("UPDATE sessions SET bytes=?,lines=?,size=?,mtime=?,inode=?,tail=? WHERE thread=?")
        .run(bytes, lines, stat.size, stat.mtimeMs, String(stat.ino), tail, t.id);
    }
  }

  /** Start an initial background build before the first provider or browser query. */
  async warm() {
    await this.sync();
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
    await this.sync();
    const rows = this.db
      .prepare(`SELECT f.thread,s.title,s.provider,f.line,f.role,
      snippet(session_fts,1,'[',']',' … ',40) AS snippet,bm25(session_fts,3.0,1.0) AS score
      FROM session_fts f JOIN sessions s ON s.thread=f.thread
      WHERE session_fts MATCH ? ${input.provider ? "AND s.provider=?" : ""}
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
    };
  }

  async read(input: SessionReadInput) {
    if (!safeId(input?.thread)) throw new Error("Invalid thread id.");
    const start = bounded(input.start, 1, Number.MAX_SAFE_INTEGER),
      limit = bounded(input.limit, 30, 100);
    await this.sync();
    const session = this.db
      .prepare("SELECT title,provider,lines FROM sessions WHERE thread=?")
      .get(input.thread);
    if (!session) throw new Error("Unknown session.");
    const rows = this.db
      .prepare(
        "SELECT line,role,substr(text,1,12000) AS text FROM events WHERE thread=? AND line>=? ORDER BY line LIMIT ?",
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
    await this.sync();
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
    };
  }

  close() {
    this.closed = true;
    this.db.close();
  }
}
