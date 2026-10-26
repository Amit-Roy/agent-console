import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ModelUsage, SessionAccounting } from "./accounting.ts";
import { accountingSamples } from "./accounting-log.ts";
import { normalizeAccountingRows } from "./accounting-repair.ts";
import { apiPricedTurn, pricing } from "./api-pricing.ts";
import { DATA_DIR } from "./auth.ts";
import { headroom } from "./headroom.ts";
import { linesWith } from "./history.ts";

export { claudeTotals, delta } from "./accounting.ts";

// What the dashboard shows. Three sources, all local:
//   turns.jsonl  one row per finished turn, written by Threads when a `result` arrives (usage patterns, tokens, cost)
//   rtk          `rtk gain` daily savings from command-output filtering
//   headroom     the proxy's own durable ledger for compressed Claude requests
export interface Turn {
  ts: number;
  thread: string;
  provider: string;
  model?: string;
  effort?: string;
  accounting?: 2;
  session?: string;
  eventId?: string;
  cumulative?: any;
  models?: ModelUsage[];
  unresolved?: string;
  ms?: number;
  cost?: number;
  in?: number;
  out?: number;
  cache?: number;
  tools?: Record<string, number>;
  err?: 1;
  b?: 1; // b: reconstructed from old logs
}
const LOG_DIR = path.join(DATA_DIR, "logs");
const FILE = path.join(DATA_DIR, "turns.jsonl");
const MARK = path.join(DATA_DIR, "turns.backfilled");

export function recordTurn(t: Turn) {
  fs.appendFileSync(FILE, JSON.stringify(t) + "\n", { mode: 0o600 });
}

export function readTurns(from: number, to: number, max = 50_000): Turn[] {
  let raw = "";
  try {
    raw = fs.readFileSync(FILE, "utf8");
  } catch {
    return [];
  }
  const out: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const t = JSON.parse(line) as Turn;
      out.push(t);
    } catch {}
  }
  return normalizeAccountingRows(DATA_DIR, out)
    .filter((t) => t.ts >= from && t.ts <= to)
    .slice(-max);
}

function replayClaudeLog(accounting: SessionAccounting, threadId: string) {
  let session = threadId;
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path.join(LOG_DIR, `${threadId}.jsonl`));
  } catch {
    return;
  }
  for (const line of linesWith(raw, ['"modelUsage"', '"init"'])) {
    try {
      const event = JSON.parse(line);
      if (event.type === "system" && event.subtype === "init" && event.session_id)
        session = event.session_id;
      if (event.type === "result" && event.modelUsage)
        accounting.consume(event.session_id || session, event);
    } catch {}
  }
}

// Restore baselines from every persisted result, including results with no user_input (e.g. compact).
export function restoreAccounting(threads: { id: string; provider: string; sessionId?: string }[]) {
  const accounting = new SessionAccounting();
  for (const thread of threads.filter((entry) => entry.provider === "claude"))
    replayClaudeLog(accounting, thread.id);
  // The ledger is written before the display result log. Recover even if the process died between those writes.
  for (const row of readTurns(0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).sort(
    (a, b) => a.ts - b.ts,
  )) {
    if (row.accounting === 2 && row.provider === "claude" && row.session && row.cumulative)
      accounting.restore(row.session, row.cumulative, row.eventId);
  }
  return accounting;
}

// One-time: rebuild turns from the thread logs that existed before turns.jsonl did. A turn runs from its user_input (the only event
// with a timestamp) to the next result.
export function backfill(
  threads: { id: string; provider: string; model?: string; effort?: string; createdAt?: number }[],
) {
  if (fs.existsSync(MARK)) return;
  const rows: Turn[] = [];
  for (const th of threads) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(LOG_DIR, `${th.id}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const sample of accountingSamples(raw, th))
      rows.push({
        ...sample,
        thread: th.id,
        provider: th.provider,
        model: th.model,
        effort: th.effort,
        b: 1,
      });
  }
  rows.sort((a, b) => a.ts - b.ts);
  fs.appendFileSync(FILE, rows.map((r) => JSON.stringify(r) + "\n").join(""), { mode: 0o600 });
  fs.writeFileSync(MARK, String(Date.now()));
}

let rtkCache: { at: number; value: any } | undefined;
let rtkPending: Promise<any | null> | undefined;
function rtkGain(): Promise<any | null> {
  if (rtkCache && Date.now() - rtkCache.at < 60_000) return Promise.resolve(rtkCache.value);
  if (rtkPending) return rtkPending;
  rtkPending = new Promise((resolve) => {
    execFile(
      "rtk",
      ["gain", "-f", "json", "--daily"],
      { timeout: 8000, env: { ...process.env, RTK_TELEMETRY_DISABLED: "1" } },
      (err, stdout) => {
        let value = null;
        if (!err)
          try {
            const parsed = JSON.parse(stdout);
            if (Array.isArray(parsed?.daily)) value = parsed;
          } catch {}
        if (value) rtkCache = { at: Date.now(), value };
        resolve(value);
      },
    );
  }).finally(() => {
    rtkPending = undefined;
  });
  return rtkPending;
}

export async function dashboard(from: number, to: number) {
  const [rtk, hr] = await Promise.all([rtkGain(), headroom.stats()]);
  const day = (ts: string) => Date.parse(ts);
  return {
    from,
    to,
    pricing,
    // Public API estimates are a read-only projection; never overwrite provider counters or prices in the ledger.
    turns: readTurns(from, to)
      .map(apiPricedTurn)
      .map(({ cumulative, session, eventId, ...row }) => row), // durable baselines stay server-side
    rtk: rtk
      ? {
          summary: rtk.summary,
          daily: (rtk.daily ?? []).filter(
            (d: any) => Date.parse(d.date) + 86_400_000 > from && Date.parse(d.date) <= to,
          ),
        }
      : null,
    headroom: {
      ...headroom.state(),
      daily: hr
        ? hr.series.daily.filter(
            (d: any) => day(d.timestamp) + 86_400_000 > from && day(d.timestamp) <= to,
          )
        : null,
      lifetime: hr?.lifetime ?? null,
    },
  };
}
