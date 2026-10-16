import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DATA_DIR } from "./auth.ts";
import { headroom } from "./headroom.ts";

// What the dashboard shows. Three sources, all local:
//   turns.jsonl  one row per finished turn, written by Threads when a `result` arrives (usage patterns, tokens, cost)
//   rtk          `rtk gain` daily savings from command-output filtering
//   headroom     the proxy's own durable ledger for compressed Claude requests
export interface Turn {
  ts: number; thread: string; provider: string; model?: string; effort?: string;
  ms?: number; cost?: number; in?: number; out?: number; cache?: number; tools?: Record<string, number>; err?: 1; b?: 1; // b: reconstructed from old logs
}
const LOG_DIR = path.join(DATA_DIR, "logs");
const FILE = path.join(DATA_DIR, "turns.jsonl");
const MARK = path.join(DATA_DIR, "turns.backfilled");

export function recordTurn(t: Turn) {
  fs.appendFileSync(FILE, JSON.stringify(t) + "\n", { mode: 0o600 });
}

export function readTurns(from: number, to: number, max = 50_000): Turn[] {
  let raw = "";
  try { raw = fs.readFileSync(FILE, "utf8"); } catch { return []; }
  const out: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const t = JSON.parse(line) as Turn;
      if (t.ts >= from && t.ts <= to) out.push(t);
    } catch {}
  }
  return out.slice(-max);
}

// Counters in Claude's result events are cumulative for the session; a smaller number than before means the counter restarted.
export const delta = (now: number, before: number | undefined) => (before == null || now < before ? now : now - before);
export function claudeTotals(ev: any): { cost?: number; in: number; out: number; cache: number } {
  const models = Object.values(ev.modelUsage ?? {}) as any[];
  return {
    cost: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
    in: models.reduce((s, m) => s + (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0),
    out: models.reduce((s, m) => s + (m.outputTokens ?? 0), 0),
    cache: models.reduce((s, m) => s + (m.cacheReadInputTokens ?? 0), 0),
  };
}

// One-time: rebuild turns from the thread logs that existed before turns.jsonl did. A turn runs from its user_input (the only event
// with a timestamp) to the next result.
export function backfill(threads: { id: string; provider: string; model?: string; effort?: string }[]) {
  if (fs.existsSync(MARK)) return;
  const rows: Turn[] = [];
  for (const th of threads) {
    let raw = "";
    try { raw = fs.readFileSync(path.join(LOG_DIR, `${th.id}.jsonl`), "utf8"); } catch { continue; }
    let start: number | undefined;
    let tools: Record<string, number> = {};
    let last: ReturnType<typeof claudeTotals> | undefined;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "user_input" && typeof ev.ts === "number" && start == null) start = ev.ts;
      else if (ev.type === "assistant") {
        for (const b of ev.message?.content ?? []) if (b?.type === "tool_use") tools[b.name] = (tools[b.name] ?? 0) + 1;
      } else if (ev.type === "result" && start != null) {
        const row: Turn = { ts: start, thread: th.id, provider: th.provider, model: th.model, effort: th.effort, ms: ev.duration_ms, b: 1 };
        if (Object.keys(tools).length) row.tools = tools;
        if (ev.is_error) row.err = 1;
        if (ev.modelUsage) {
          const now = claudeTotals(ev);
          row.cost = now.cost == null ? undefined : delta(now.cost, last?.cost);
          row.in = delta(now.in, last?.in); row.out = delta(now.out, last?.out); row.cache = delta(now.cache, last?.cache);
          last = now;
        }
        rows.push(row);
        start = undefined; tools = {};
      }
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  fs.appendFileSync(FILE, rows.map((r) => JSON.stringify(r) + "\n").join(""), { mode: 0o600 });
  fs.writeFileSync(MARK, String(Date.now()));
}

let rtkCache: { at: number; value: any } | undefined;
function rtkGain(): Promise<any | null> {
  if (rtkCache && Date.now() - rtkCache.at < 60_000) return Promise.resolve(rtkCache.value);
  return new Promise((resolve) => {
    execFile("rtk", ["gain", "-f", "json", "--daily"], { timeout: 8000, env: { ...process.env, RTK_TELEMETRY_DISABLED: "1" } }, (err, stdout) => {
      let value = null;
      if (!err) try { value = JSON.parse(stdout); } catch {}
      rtkCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

export async function dashboard(from: number, to: number) {
  const [rtk, hr] = await Promise.all([rtkGain(), headroom.stats()]);
  const day = (ts: string) => Date.parse(ts);
  return {
    from, to,
    turns: readTurns(from, to),
    rtk: rtk ? { summary: rtk.summary, daily: (rtk.daily ?? []).filter((d: any) => Date.parse(d.date) + 86_400_000 > from && Date.parse(d.date) <= to) } : null,
    headroom: { ...headroom.state(), daily: (hr?.series?.daily ?? []).filter((d: any) => day(d.timestamp) + 86_400_000 > from && day(d.timestamp) <= to), lifetime: hr?.lifetime ?? null },
  };
}
