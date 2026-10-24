import fs from "node:fs";
import { type EventKind, STEP_IDS, type StepId } from "./contracts.ts";
import type { EventLog } from "./events.ts";

// The triage worker's weekly effort calibration is a separate process. It appends one JSON line per step event to a file
// beside the model; the Console only reads that file and records what is new as automation events, once each.
// Line shape: {"ts": <ms>, "run": "<run id>", "step": "effort_*", "kind": "start|ok|fail|info", "msg"?: string, "data"?: object}

const KINDS: readonly EventKind[] = ["start", "ok", "fail", "info"];
const EFFORT_STEPS = STEP_IDS.filter((id) => id.startsWith("effort_"));
const TAIL_BYTES = 1024 * 1024; // a long-lived file: only the newest megabyte can hold unseen lines
const CLOCK_SKEW_MS = 5 * 60_000; // a line stamped further ahead than this is not a real timestamp

interface Line {
  ts: number;
  run?: string;
  step: StepId;
  kind: EventKind;
  msg?: string;
  data?: Record<string, unknown>;
}

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function parseLine(text: string): Line | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plain(raw)) return null;
  const { ts, run, step, kind, msg, data } = raw;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  if (typeof step !== "string" || !EFFORT_STEPS.includes(step as StepId)) return null;
  if (typeof kind !== "string" || !KINDS.includes(kind as EventKind)) return null;
  return {
    ts,
    step: step as StepId,
    kind: kind as EventKind,
    ...(typeof run === "string" && run ? { run: run.slice(0, 100) } : {}),
    ...(typeof msg === "string" && msg ? { msg } : {}),
    ...(plain(data) ? { data } : {}),
  };
}

/** The last megabyte of the file as lines; a cut first line and an unfinished last line fail to parse and are skipped. */
function readLines(file: string): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

export function createCalibrationBridge(opts: {
  file: string;
  events: EventLog;
  notify?: (n: { thread: string; title: string }) => void;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  // The log stamps events with its own clock, so the producer's time rides along in `data.at`. That is what
  // survives a restart: the newest producer time already in the log is where reading resumes.
  let mark = 0;
  for (const e of opts.events.all())
    if (e.step.startsWith("effort_") && typeof e.data?.at === "number")
      mark = Math.max(mark, e.data.at);

  function poll(): number {
    const limit = now() + CLOCK_SKEW_MS;
    const fresh = readLines(opts.file)
      .map(parseLine)
      .filter((l): l is Line => !!l && l.ts > mark && l.ts <= limit);
    for (const l of fresh) {
      const ev = opts.events.record({
        step: l.step,
        kind: l.kind,
        ...(l.run ? { run: `effort:${l.run}` } : {}),
        ...(l.msg ? { msg: l.msg } : {}),
        data: { ...l.data, at: l.ts },
      });
      mark = Math.max(mark, l.ts);
      if (l.kind === "fail")
        opts.notify?.({
          thread: "effort-model",
          title: `Effort model retrain failed${ev.msg ? `: ${ev.msg}` : ""}`.slice(0, 200),
        });
    }
    return fresh.length;
  }
  return { poll };
}
