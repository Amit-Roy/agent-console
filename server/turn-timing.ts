import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Per-turn timing and agent-process lifecycle, measured by the server from the canonical event stream it already receives.
// Metadata only: tool names, durations, counts, HTTP statuses and short error classes. Never prompt, command or output text.
// Nothing here reaches a model or the network. Stored next to the browser samples in latency.sqlite (bounded rows, day window, 0600)
// rather than in turns.jsonl: that file is the cost ledger, append-only, re-read whole and repaired by accounting code.

export const RETENTION_DAYS = 30;
const MAX_TOOLS = 100, MAX_RETRIES = 20;
// Timeline: ordered segments of one turn for the Run details "Full breakdown". Bounded: the first MAX_SEGMENTS in time order,
// everything later folded into one tail summary. Tool spans are tracked up to MAX_TIMED_TOOLS (the tools column keeps MAX_TOOLS).
export const MAX_SEGMENTS = 300;
const MAX_TIMED_TOOLS = 400;

const toolName = (s: unknown) => (typeof s === "string" && s.replace(/[^\w.:\-]/g, "").slice(0, 64)) || "tool";
const shortWord = (s: unknown) => (typeof s === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(s) ? s : undefined);

// A raw provider error becomes one short class. The message itself is never kept.
const CLASSES: [RegExp, string][] = [
  [/\b429\b|rate.?limit|too many requests|usage.?limit|quota/i, "rate_limit"],
  [/\b529\b|overload/i, "overloaded"],
  [/\b40[13]\b|unauthori[sz]ed|forbidden|authentication/i, "auth"],
  [/time.?out|timed out|ETIMEDOUT/i, "timeout"],
  [/ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|disconnect/i, "network"],
  [/\b5\d\d\b|server error|internal error|bad gateway|unavailable/i, "server_error"],
  [/\b4\d\d\b|invalid request|bad request/i, "bad_request"],
];
export function errorClass(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "unknown";
  const word = shortWord(raw.trim().replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()); // Claude "rate_limit", Codex "serverOverloaded"
  if (word) return word;
  for (const [re, name] of CLASSES) if (re.test(raw)) return name;
  return "other";
}
export function httpStatus(n: unknown, text?: unknown): number | null {
  const v = Number(n);
  if (n != null && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  const m = typeof text === "string" ? /\b([45]\d\d)\b/.exec(text) : null;
  return m ? Number(m[1]) : null;
}
// Canonical retry notice in Claude's shape, for adapters whose harness retries silently (Codex, Pi). Sanitized: no message text.
export function retryEvent(o: { attempt?: unknown; status?: unknown; error?: unknown; message?: unknown; delay?: unknown }) {
  return {
    type: "system", subtype: "api_retry",
    attempt: Number.isInteger(o.attempt) ? o.attempt : null,
    error_status: httpStatus(o.status, o.message),
    error: o.error != null ? errorClass(String(o.error)) : errorClass(o.message),
    ...(Number.isFinite(o.delay) ? { retry_delay_ms: o.delay } : {}),
  };
}

interface Span { a: number; b?: number }
function covered(spans: Span[], end: number) {
  const xs = spans.map((s) => [s.a, Math.max(s.a, s.b ?? end)]).sort((x, y) => x[0] - y[0]);
  let total = 0, a = -Infinity, b = -Infinity;
  for (const [x, y] of xs) {
    if (x > b) { if (b > a) total += b - a; a = x; b = y; }
    else b = Math.max(b, y);
  }
  if (b > a) total += b - a;
  return total;
}
// Events the adapter itself makes up front; they say nothing about the process or the model.
const SYNTHETIC = new Set(["run_settings", "console_error"]);
export const fromProcess = (ev: any) => !SYNTHETIC.has(ev?.type);

export interface ToolTime { n: string; ms: number; e?: 1 }
// a/d: start offset and duration in ms from the turn start (queue sits before 0). i: model step number.
// model f: that step's time to first output. retry s/c: HTTP status and short error class. tool e: failed.
export type Segment =
  | { k: "queue" | "startup" | "wait"; a: number; d: number }
  | { k: "model"; i: number; a: number; d: number; f: number | null }
  | { k: "tool"; i: number; n: string; a: number; d: number; e?: 1 }
  | { k: "retry"; i: number; a: number; d: number; s: number | null; c: string };
export interface Timeline { seg: Segment[]; more?: { n: number; from: number; model_ms: number; tool_ms: number; other_ms: number; tools: number; errors: number } }
export interface TurnTiming {
  turn_ts: number; provider: string; model: string; alias: string; cold: 0 | 1; spawn_ms: number | null; queue_ms: number | null;
  first_ms: number | null; total_ms: number; model_ms: number; tool_ms: number; startup_ms: number; wait_ms: number; steps: number;
  tools: ToolTime[]; retries: number; retry_detail: { s: number | null; c: string }[]; rate_limits: number; outcome: string; timeline?: Timeline;
}

// One turn, as the server sees it: send -> first process event (startup) -> first model output (TTFT) -> tools <-> model steps -> result.
// Model time is what is left after tools, user waits (questions) and startup; API retries and their delays count as model time.
// Main-thread only: a subagent's own tools run inside its Agent tool call and are counted there.
export class TurnClock {
  private firstEvent?: number;
  private firstOutput?: number;
  private tools = new Map<string, Span & { n: string; e?: 1; i: number }>();
  private stepSpans: { a: number; first?: number; last?: number }[] = [];
  private retrySegs: { a: number; d: number; s: number | null; c: string; i: number }[] = [];
  private lastResult?: number;
  private waits = new Map<string, Span>();
  private steps = 0;
  private inModel = false;
  private model?: string;
  private retries: { s: number | null; c: string }[] = [];
  private retryCount = 0;
  private rateLimits = 0;
  private o: { provider: string; alias: string; start: number; cold: boolean; queueMs?: number; model?: string };
  // model: the id this process already resolved (harnesses that announce it once per process, e.g. Codex)
  constructor(o: { provider: string; alias: string; start: number; cold: boolean; queueMs?: number; model?: string }) { this.o = o; this.model = o.model; }
  get start() { return this.o.start; }
  get resolvedModel() { return this.model; }
  private output(now: number) {
    this.firstOutput ??= now;
    if (!this.inModel) {
      this.steps++; this.inModel = true;
      // A step's request goes out when the last tool result lands (or, for the first step, when the process first speaks).
      const a = this.steps === 1 ? (this.firstEvent ?? this.o.start) : (this.lastResult ?? now);
      this.stepSpans.push({ a: Math.min(a, now), first: now });
    }
    this.stepSpans[this.stepSpans.length - 1].last = now;
  }
  event(ev: any, now = Date.now()) {
    if (!ev || typeof ev !== "object") return;
    if (fromProcess(ev)) this.firstEvent ??= now;
    if (ev.type === "system" && ev.subtype === "api_retry") {
      this.retryCount++;
      const s = httpStatus(ev.error_status), c = errorClass(ev.error);
      if (this.retries.length < MAX_RETRIES) this.retries.push({ s, c });
      const delay = Number(ev.retry_delay_ms);
      this.retrySegs.push({ a: now, d: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 3_600_000) : 0, s, c, i: this.inModel ? this.steps : this.steps + 1 });
      return;
    }
    if (ev.type === "rate_limit_event") {
      const status = ev.rate_limit_info?.status;
      if (typeof status === "string" && status !== "allowed") this.rateLimits++;
      return;
    }
    if (ev.type === "run_settings" && typeof ev.model === "string" && ev.model !== "default") this.model ||= ev.model;
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") this.model = ev.model;
    if (ev.parent_tool_use_id) return;
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") this.output(now);
    else if (ev.type === "assistant") {
      if (typeof ev.message?.model === "string" && !this.model) this.model = ev.message.model;
      for (const b of ev.message?.content ?? []) {
        if (b?.type === "text" || b?.type === "thinking" || b?.type === "redacted_thinking") this.output(now);
        else if (b?.type === "tool_use") {
          this.output(now);
          if (typeof b.id === "string" && !this.tools.has(b.id) && this.tools.size < MAX_TIMED_TOOLS) this.tools.set(b.id, { n: toolName(b.name), a: now, i: this.steps });
        }
      }
    } else if (ev.type === "user") {
      for (const b of ev.message?.content ?? []) {
        if (b?.type !== "tool_result") continue;
        const tool = this.tools.get(b.tool_use_id);
        if (tool && tool.b == null) { tool.b = now; if (b.is_error) tool.e = 1; }
        this.inModel = false; // the next output is a new model request
        this.lastResult = now;
      }
    } else if (ev.type === "question" && typeof ev.id === "string") this.waits.set(ev.id, { a: now });
    else if (ev.type === "question_answer") { const w = this.waits.get(ev.id); if (w && w.b == null) w.b = now; }
  }
  finish(ev: any, now = Date.now(), spawnMs?: number | null): TurnTiming {
    const start = this.o.start, total = Math.max(0, now - start);
    const tools = [...this.tools.values()], waits = [...this.waits.values()];
    const wait = covered(waits, now);
    const tool = Math.max(0, covered([...tools, ...waits], now) - wait); // a tool waiting on the user counts as waiting
    const startup = Math.min(total, Math.max(0, (this.firstEvent ?? now) - start));
    const outcome = ev?.subtype === "aborted" ? "aborted" : ev?.subtype === "exited" ? "exited" : ev?.is_error ? "error" : "ok";
    return {
      turn_ts: start, provider: this.o.provider, model: this.model || this.o.alias, alias: this.o.alias, cold: this.o.cold ? 1 : 0,
      spawn_ms: this.o.cold && spawnMs != null && spawnMs >= 0 ? spawnMs : null, queue_ms: this.o.queueMs ?? null,
      first_ms: this.firstOutput != null ? this.firstOutput - start : null, total_ms: total,
      model_ms: Math.max(0, total - tool - wait - startup), tool_ms: tool, startup_ms: startup, wait_ms: wait, steps: this.steps,
      tools: tools.slice(0, MAX_TOOLS).map((t) => ({ n: t.n, ms: Math.max(0, (t.b ?? now) - t.a), ...(t.e ? { e: 1 as const } : {}) })),
      retries: this.retryCount, retry_detail: this.retries, rate_limits: this.rateLimits, outcome,
      timeline: this.timeline(now, startup),
    };
  }
  // Ordered segments, offsets from the turn start. Metadata only, like the rest of the row.
  private timeline(now: number, startup: number): Timeline {
    const start = this.o.start, off = (t: number) => Math.max(0, t - start), dur = (a: number, b: number) => Math.max(0, b - a);
    const seg: Segment[] = [];
    if (this.o.queueMs) seg.push({ k: "queue", a: -this.o.queueMs, d: this.o.queueMs });
    if (startup > 0) seg.push({ k: "startup", a: 0, d: startup });
    this.stepSpans.forEach((s, n) => {
      const last = n === this.stepSpans.length - 1;
      // A step ends at its last output; the final step runs on to the result unless it left a tool open.
      const end = last && ![...this.tools.values()].some((t) => t.i === n + 1 && t.b == null) ? now : (s.last ?? s.a);
      seg.push({ k: "model", i: n + 1, a: off(s.a), d: dur(s.a, end), f: s.first != null ? dur(s.a, s.first) : null });
    });
    for (const t of this.tools.values()) seg.push({ k: "tool", i: t.i, n: t.n, a: off(t.a), d: dur(t.a, t.b ?? now), ...(t.e ? { e: 1 as const } : {}) });
    for (const r of this.retrySegs) seg.push({ k: "retry", i: r.i, a: off(r.a), d: r.d, s: r.s, c: r.c });
    for (const w of this.waits.values()) seg.push({ k: "wait", a: off(w.a), d: dur(w.a, w.b ?? now) });
    const rank: Record<string, number> = { queue: 0, startup: 1, model: 2, retry: 3, tool: 4, wait: 5 };
    seg.sort((x, y) => x.a - y.a || rank[x.k] - rank[y.k]);
    return capTimeline(seg);
  }
}
export function capTimeline(seg: Segment[], max = MAX_SEGMENTS): Timeline {
  if (seg.length <= max) return { seg };
  const rest = seg.slice(max), more = { n: rest.length, from: rest[0].a, model_ms: 0, tool_ms: 0, other_ms: 0, tools: 0, errors: 0 };
  for (const s of rest) {
    if (s.k === "model") more.model_ms += s.d;
    else if (s.k === "tool") { more.tool_ms += s.d; more.tools++; if (s.e) more.errors++; }
    else more.other_ms += s.d;
  }
  return { seg: seg.slice(0, max), more };
}

// What the Run details panel shows for the last run; small, it rides on every thread update.
export function runFacts(t: TurnTiming) {
  const slow = [...t.tools].sort((a, b) => b.ms - a.ms).slice(0, 3);
  const slowest = slow[0];
  return {
    first_ms: t.first_ms, total_ms: t.total_ms, model_ms: t.model_ms, tool_ms: t.tool_ms, other_ms: t.startup_ms + t.wait_ms,
    steps: t.steps, tool_calls: t.tools.length, cold: !!t.cold, spawn_ms: t.spawn_ms, retries: t.retries + t.rate_limits,
    ...(slowest ? { slowest: { name: slowest.n, ms: slowest.ms }, slow: slow.map((x) => ({ name: x.n, ms: x.ms, ...(x.e ? { error: true } : {}) })) } : {}), model: t.model,
  };
}

// Nearest-rank, like the Run details speed table: the p% sample of sorted times.
export const nearestRank = (sorted: number[], p: number) => (sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const pcts = (values: number[]) => { const s = values.filter(Number.isFinite).sort((a, b) => a - b); return { count: s.length, p50_ms: nearestRank(s, 50), p95_ms: nearestRank(s, 95) }; };
const round = (n: number | null) => (n == null ? null : Math.round(n));

export class TurnTimingStore {
  private db: DatabaseSync;
  private writes = 0;
  private maxRows: number;
  private days: number;
  constructor(file: string, maxRows = 20_000, days = RETENTION_DAYS) {
    this.maxRows = maxRows;
    this.days = days;
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS turn_timing (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, turn_ts INTEGER NOT NULL, thread TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, alias TEXT,
        cold INTEGER NOT NULL, spawn_ms REAL, queue_ms REAL, first_ms REAL, total_ms REAL NOT NULL, model_ms REAL, tool_ms REAL, startup_ms REAL,
        wait_ms REAL, steps INTEGER, tools TEXT, retries INTEGER NOT NULL DEFAULT 0, retry_detail TEXT, rate_limits INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL
        , timeline TEXT
      ); CREATE INDEX IF NOT EXISTS turn_timing_ts ON turn_timing(turn_ts); CREATE INDEX IF NOT EXISTS turn_timing_thread ON turn_timing(thread, turn_ts);
      CREATE TABLE IF NOT EXISTS agent_process (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, thread TEXT NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL, ms REAL, code INTEGER, signal TEXT, reason TEXT
      ); CREATE INDEX IF NOT EXISTS agent_process_at ON agent_process(at);`);
    this.migrate();
    this.prune();
  }
  // Databases from before the timeline column gain it in place; their old rows simply have no timeline.
  private migrate() {
    const cols = (this.db.prepare("PRAGMA table_info(turn_timing)").all() as any[]).map((c) => c.name);
    if (!cols.includes("timeline")) this.db.exec("ALTER TABLE turn_timing ADD COLUMN timeline TEXT");
  }
  recordTurn(thread: string, t: TurnTiming, now = Date.now()) {
    const timeline = t.timeline ? JSON.stringify(t.timeline.seg.length > MAX_SEGMENTS ? capTimeline(t.timeline.seg) : t.timeline) : null;
    this.db.prepare(`INSERT INTO turn_timing(at,turn_ts,thread,provider,model,alias,cold,spawn_ms,queue_ms,first_ms,total_ms,model_ms,tool_ms,startup_ms,wait_ms,steps,tools,retries,retry_detail,rate_limits,outcome,timeline)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(now, t.turn_ts, thread, t.provider, t.model.slice(0, 80), t.alias.slice(0, 80), t.cold, t.spawn_ms, t.queue_ms, t.first_ms,
      t.total_ms, t.model_ms, t.tool_ms, t.startup_ms, t.wait_ms, t.steps, JSON.stringify(t.tools.slice(0, MAX_TOOLS)), t.retries, JSON.stringify(t.retry_detail.slice(0, MAX_RETRIES)), t.rate_limits, t.outcome, timeline);
    this.wrote(now);
  }
  // kind: spawn | ready (ms = spawn -> first process output) | exit (ms = process lifetime; reason idle/settings/stop/compact/remove/shutdown/crash)
  recordProcess(p: { thread: string; provider: string; kind: "spawn" | "ready" | "exit"; ms?: number | null; code?: number | null; signal?: string | null; reason?: string }, now = Date.now()) {
    this.db.prepare("INSERT INTO agent_process(at,thread,provider,kind,ms,code,signal,reason) VALUES(?,?,?,?,?,?,?,?)")
      .run(now, p.thread, p.provider, p.kind, p.ms ?? null, Number.isInteger(p.code) ? p.code! : null, p.signal ? String(p.signal).slice(0, 16) : null, p.reason ? p.reason.slice(0, 16) : null);
    this.wrote(now);
  }
  private wrote(now: number) { if (++this.writes >= 100) { this.writes = 0; this.prune(now); } }
  private prune(now = Date.now()) {
    for (const [table, col] of [["turn_timing", "turn_ts"], ["agent_process", "at"]]) {
      this.db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(now - this.days * 86400_000);
      this.db.prepare(`DELETE FROM ${table} WHERE id <= (SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(this.maxRows);
    }
  }
  private static COLS = "id,at,turn_ts,thread,provider,model,alias,cold,spawn_ms,queue_ms,first_ms,total_ms,model_ms,tool_ms,startup_ms,wait_ms,steps,tools,retries,retry_detail,rate_limits,outcome";
  turns(from: number, to: number, thread?: string): any[] {
    const cols = TurnTimingStore.COLS; // aggregates never need the timelines
    const rows = (thread
      ? this.db.prepare(`SELECT ${cols} FROM turn_timing WHERE turn_ts BETWEEN ? AND ? AND thread = ? ORDER BY turn_ts`).all(from, to, thread)
      : this.db.prepare(`SELECT ${cols} FROM turn_timing WHERE turn_ts BETWEEN ? AND ? ORDER BY turn_ts`).all(from, to)) as any[];
    return rows.map((r) => ({ ...r, tools: JSON.parse(r.tools || "[]"), retry_detail: JSON.parse(r.retry_detail || "[]") }));
  }
  // The thread's last `limit` turns, newest first, each with its timeline (null for rows recorded before timelines existed).
  recent(thread: string, limit = 10): any[] {
    const rows = this.db.prepare(`SELECT ${TurnTimingStore.COLS},timeline FROM turn_timing WHERE thread = ? ORDER BY turn_ts DESC, id DESC LIMIT ?`).all(thread, Math.max(1, Math.min(20, limit))) as any[];
    const parse = (s: any, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
    return rows.map(({ id, at, thread: _t, ...r }) => ({ ...r, tools: parse(r.tools, []), retry_detail: parse(r.retry_detail, []), timeline: parse(r.timeline, null) }));
  }
  // `phone`: browser-measured send -> first token painted samples (latency kind first_token), same window.
  summary(from: number, to: number, opts: { thread?: string; phone?: { provider: string; total_ms: number }[] } = {}) {
    const rows = this.turns(from, to, opts.thread);
    const providers = [...new Set(rows.map((r) => r.provider))].sort();
    const by = (p: string) => rows.filter((r) => r.provider === p);
    const tools = new Map<string, { ms: number[]; errors: number }>();
    for (const r of rows) for (const t of r.tools) { const x = tools.get(t.n) || { ms: [], errors: 0 }; x.ms.push(t.ms); if (t.e) x.errors++; tools.set(t.n, x); }
    const classes: Record<string, number> = {}, statuses: Record<string, number> = {};
    for (const r of rows) for (const d of r.retry_detail) { classes[d.c] = (classes[d.c] || 0) + 1; if (d.s != null) statuses[d.s] = (statuses[d.s] || 0) + 1; }
    const cold = rows.filter((r) => r.cold);
    const exits: Record<string, number> = {};
    const procs = (opts.thread
      ? this.db.prepare("SELECT reason, COUNT(*) n FROM agent_process WHERE kind = 'exit' AND at BETWEEN ? AND ? AND thread = ? GROUP BY reason").all(from, to, opts.thread)
      : this.db.prepare("SELECT reason, COUNT(*) n FROM agent_process WHERE kind = 'exit' AND at BETWEEN ? AND ? GROUP BY reason").all(from, to)) as any[];
    for (const p of procs) exits[p.reason || "unknown"] = p.n;
    const models: Record<string, number> = {};
    for (const r of rows) models[`${r.provider}/${r.model}`] = (models[`${r.provider}/${r.model}`] || 0) + 1;
    const sum = (xs: any[], k: string) => Math.round(xs.reduce((n, r) => n + (r[k] || 0), 0));
    const phone = opts.phone || [];
    return {
      from, to, retention_days: this.days, turns: rows.length,
      ttft: [...providers.map((p) => ({ provider: p, ...pcts(by(p).map((r) => r.first_ms)) })), ...(providers.length > 1 ? [{ provider: "all", ...pcts(rows.map((r) => r.first_ms)) }] : [])],
      phone_ttft: [...new Set(phone.map((s) => s.provider))].sort().map((p) => ({ provider: p, ...pcts(phone.filter((s) => s.provider === p).map((s) => s.total_ms)) })),
      split: providers.map((p) => ({ provider: p, turns: by(p).length, model_ms: sum(by(p), "model_ms"), tool_ms: sum(by(p), "tool_ms"), other_ms: sum(by(p), "startup_ms") + sum(by(p), "wait_ms"), total_ms: sum(by(p), "total_ms") })),
      tools: [...tools].map(([name, x]) => ({ name, count: x.ms.length, total_ms: Math.round(x.ms.reduce((a, b) => a + b, 0)), ...pcts(x.ms), errors: x.errors }))
        .sort((a, b) => b.total_ms - a.total_ms).slice(0, 5),
      cold: { turns: rows.length, cold: cold.length, share: rows.length ? cold.length / rows.length : null, spawn: pcts(cold.map((r) => r.spawn_ms).filter((n) => n != null)) },
      retries: { retries: rows.reduce((n, r) => n + r.retries, 0), rate_limits: rows.reduce((n, r) => n + r.rate_limits, 0), turns_affected: rows.filter((r) => r.retries || r.rate_limits).length, by_class: classes, by_status: statuses },
      outcomes: rows.reduce((m: Record<string, number>, r) => ((m[r.outcome] = (m[r.outcome] || 0) + 1), m), {}),
      exits, models,
      steps: pcts(rows.map((r) => r.steps)),
      recent: rows.slice(-20).reverse().map((r) => ({ turn_ts: r.turn_ts, thread: r.thread, provider: r.provider, model: r.model, cold: r.cold, first_ms: round(r.first_ms), total_ms: round(r.total_ms), model_ms: round(r.model_ms), tool_ms: round(r.tool_ms), steps: r.steps, retries: r.retries, outcome: r.outcome })),
    };
  }
  close() { this.db.close(); }
}
