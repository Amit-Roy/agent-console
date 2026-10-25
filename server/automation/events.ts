import fs from "node:fs";
import { type AutomationEvent, type EventKind, STEP_IDS, type StepId } from "./contracts.ts";

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
  typeof v === "string"
    ? redact(v).slice(0, 500)
    : Array.isArray(v)
      ? depth < 4
        ? v.slice(0, 50).map((x) => clean(x, depth + 1))
        : []
      : v && typeof v === "object"
        ? depth < 4
          ? Object.fromEntries(
              Object.entries(v)
                .slice(0, 50)
                .map(([k, x]) => [k, clean(x, depth + 1)]),
            )
          : {}
        : v;

const KEEP = 5000; // events held in memory: enough for the dashboard, bounded for a long-lived server
export const STALE_RUN_MS = 30 * 60_000;

export type NewEvent = {
  step: StepId;
  kind: EventKind;
  run?: string;
  ref?: string;
  msg?: string;
  data?: Record<string, unknown>;
};
type EventLogState = {
  file: string;
  now: () => number;
  maxBytes: number;
  events: AutomationEvent[];
  size: number;
  seq: number;
};

function loadEvents(state: EventLogState) {
  for (const file of [state.file + ".1", state.file]) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        try {
          if (line) state.events.push(JSON.parse(line));
        } catch {}
      }
      if (file === state.file) state.size = fs.statSync(file).size;
    } catch {}
  }
  state.events = state.events.slice(-KEEP);
  state.seq = state.events.at(-1)?.seq ?? 0;
}

function persistLine(state: EventLogState, line: string) {
  try {
    if (state.size + line.length > state.maxBytes) {
      fs.renameSync(state.file, state.file + ".1");
      state.size = 0;
    }
    fs.appendFileSync(state.file, line, { mode: 0o600 });
    state.size += line.length;
  } catch {
    /* a full disk must not stop the automation it describes */
  }
}

function recordEvent(state: EventLogState, input: NewEvent): AutomationEvent {
  if (!STEP_IDS.includes(input.step)) throw new Error(`Unknown step "${input.step}"`);
  const event: AutomationEvent = {
    seq: ++state.seq,
    ts: state.now(),
    step: input.step,
    kind: input.kind,
    ...(input.run ? { run: input.run } : {}),
    ...(input.ref ? { ref: redact(input.ref).slice(0, 200) } : {}),
    ...(input.msg ? { msg: redact(input.msg).slice(0, 300) } : {}),
    ...(input.data ? { data: clean(input.data) as Record<string, unknown> } : {}),
  };
  persistLine(state, JSON.stringify(event) + "\n");
  state.events.push(event);
  if (state.events.length > KEEP * 2) state.events = state.events.slice(-KEEP);
  return event;
}

/** Newest first. `before` is the `next` of the previous page. */
function readEvents(
  state: EventLogState,
  query: { step?: StepId; limit?: number; before?: number },
): {
  events: AutomationEvent[];
  next?: number;
} {
  const limit = Math.min(500, Math.max(1, Math.floor(query.limit ?? 100)));
  const out: AutomationEvent[] = [];
  for (let index = state.events.length - 1; index >= 0 && out.length < limit; index--) {
    const event = state.events[index];
    if (
      (query.before != null && event.seq >= query.before) ||
      (query.step && event.step !== query.step)
    )
      continue;
    out.push(event);
  }
  const more =
    out.length === limit &&
    state.events.some(
      (event) => event.seq < out[out.length - 1].seq && (!query.step || event.step === query.step),
    );
  return { events: out, ...(more ? { next: out[out.length - 1].seq } : {}) };
}

/** Runs that started and never ended. A run older than STALE_RUN_MS is abandoned rather than active. */
function openRunsOf(state: EventLogState): { run: string; step: StepId; ts: number }[] {
  const open = new Map<string, AutomationEvent>();
  for (const event of state.events) {
    if (!event.run) continue;
    if (event.kind === "start") open.set(event.run, event);
    else if (event.kind === "ok" || event.kind === "fail" || event.kind === "abandoned")
      open.delete(event.run);
  }
  return [...open.values()].map((event) => ({ run: event.run!, step: event.step, ts: event.ts }));
}

export function createEventLog(opts: { file: string; now?: () => number; maxBytes?: number }) {
  const state: EventLogState = {
    file: opts.file,
    now: opts.now ?? Date.now,
    maxBytes: opts.maxBytes ?? 5 * 1024 * 1024,
    events: [],
    size: 0,
    seq: 0,
  };
  loadEvents(state);
  const record = (input: NewEvent) => recordEvent(state, input);
  const read = (query: { step?: StepId; limit?: number; before?: number }) =>
    readEvents(state, query);
  const openRuns = () => openRunsOf(state);

  /** At start-up nothing from a previous process is still running: close every open run as abandoned. */
  function recoverOpenRuns(): string[] {
    return openRuns().map((open) => {
      record({ step: open.step, kind: "abandoned", run: open.run, msg: "server restarted" });
      return open.run;
    });
  }
  return { record, read, openRuns, recoverOpenRuns, all: () => state.events };
}
export type EventLog = ReturnType<typeof createEventLog>;
