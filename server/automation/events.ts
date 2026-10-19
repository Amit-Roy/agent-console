import fs from "node:fs";
import { STEP_IDS, type AutomationEvent, type EventKind, type StepId } from "./contracts.ts";

// The one log every automation stage writes. This process is its only writer; hooks and agents never append to it.
// Nothing here may hold a prompt or a secret: messages are short, and every string is redacted before it reaches disk.

const PATTERNS: [RegExp, string][] = [
  [/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]"],
  [/\b(?:sk|nvapi|xox[abp]|AIza)[-_A-Za-z0-9]{12,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]"],
  [/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, "$1[redacted]"],
];
export function redact(s: string): string {
  return PATTERNS.reduce((out, [re, to]) => out.replace(re, to), s);
}
const clean = (v: unknown, depth = 0): unknown =>
  typeof v === "string" ? redact(v).slice(0, 500)
  : Array.isArray(v) ? (depth < 4 ? v.slice(0, 50).map(x => clean(x, depth + 1)) : [])
  : v && typeof v === "object" ? (depth < 4 ? Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, clean(x, depth + 1)])) : {})
  : v;

const KEEP = 5000; // events held in memory: enough for the dashboard, bounded for a long-lived server
export const STALE_RUN_MS = 30 * 60_000;

export type NewEvent = { step: StepId; kind: EventKind; run?: string; ref?: string; msg?: string; data?: Record<string, unknown> };
export function createEventLog(opts: { file: string; now?: () => number; maxBytes?: number }) {
  const now = opts.now ?? Date.now, maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  let events: AutomationEvent[] = [];
  let size = 0;
  for (const f of [opts.file + ".1", opts.file]) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) { try { if (line) events.push(JSON.parse(line)); } catch {} }
      if (f === opts.file) size = fs.statSync(f).size;
    } catch {}
  }
  events = events.slice(-KEEP);
  let seq = events.at(-1)?.seq ?? 0;

  function record(e: NewEvent): AutomationEvent {
    if (!STEP_IDS.includes(e.step)) throw new Error(`Unknown step "${e.step}"`);
    const ev: AutomationEvent = {
      seq: ++seq, ts: now(), step: e.step, kind: e.kind,
      ...(e.run ? { run: e.run } : {}), ...(e.ref ? { ref: redact(e.ref).slice(0, 200) } : {}),
      ...(e.msg ? { msg: redact(e.msg).slice(0, 300) } : {}), ...(e.data ? { data: clean(e.data) as Record<string, unknown> } : {}),
    };
    const line = JSON.stringify(ev) + "\n";
    try {
      if (size + line.length > maxBytes) { fs.renameSync(opts.file, opts.file + ".1"); size = 0; }
      fs.appendFileSync(opts.file, line, { mode: 0o600 });
      size += line.length;
    } catch { /* a full disk must not stop the automation it describes */ }
    events.push(ev);
    if (events.length > KEEP * 2) events = events.slice(-KEEP);
    return ev;
  }

  /** Newest first. `before` is the `next` of the previous page. */
  function read(q: { step?: StepId; limit?: number; before?: number }): { events: AutomationEvent[]; next?: number } {
    const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100)));
    const out: AutomationEvent[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = events[i];
      if ((q.before != null && e.seq >= q.before) || (q.step && e.step !== q.step)) continue;
      out.push(e);
    }
    const more = out.length === limit && events.some(e => e.seq < out[out.length - 1].seq && (!q.step || e.step === q.step));
    return { events: out, ...(more ? { next: out[out.length - 1].seq } : {}) };
  }

  /** Runs that started and never ended. A run older than STALE_RUN_MS is abandoned rather than active. */
  function openRuns(): { run: string; step: StepId; ts: number }[] {
    const open = new Map<string, AutomationEvent>();
    for (const e of events) {
      if (!e.run) continue;
      if (e.kind === "start") open.set(e.run, e);
      else if (e.kind === "ok" || e.kind === "fail" || e.kind === "abandoned") open.delete(e.run);
    }
    return [...open.values()].map(e => ({ run: e.run!, step: e.step, ts: e.ts }));
  }

  /** At start-up nothing from a previous process is still running: close every open run as abandoned. */
  function recoverOpenRuns(): string[] {
    return openRuns().map(r => { record({ step: r.step, kind: "abandoned", run: r.run, msg: "server restarted" }); return r.run; });
  }
  return { record, read, openRuns, recoverOpenRuns, all: () => events };
}
export type EventLog = ReturnType<typeof createEventLog>;
