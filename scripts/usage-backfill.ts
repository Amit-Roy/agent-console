// Rebuild usage-history.jsonl from quota readings already stored in Console thread logs and Codex rollouts.
// Idempotent: rows already in the history are skipped. `--dry` prints the report without writing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../server/auth.ts";
import { claudeWindows, codexWindows, historyRows, type ProviderUsage } from "../server/usage.ts";

type Sample = { ts: number; provider: "claude" | "codex"; windows: ProviderUsage["windows"] };
const dry = process.argv.includes("--dry");
const samples: Sample[] = [];
const lines = (f: string) => { try { return fs.readFileSync(f, "utf8").split("\n"); } catch { return []; } };

// Console logs: rate_limit_event has no timestamp; use the latest user_input before it (the turn that triggered it).
const logs = path.join(DATA_DIR, "logs");
for (const name of fs.existsSync(logs) ? fs.readdirSync(logs).filter(n => n.endsWith(".jsonl")) : []) {
  let ts = 0;
  for (const line of lines(path.join(logs, name))) {
    if (!line.includes('"user_input"') && !line.includes('"rate_limit_event"')) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "user_input" && typeof ev.ts === "number") ts = ev.ts;
    else if (ev.type === "rate_limit_event" && ts) { const windows = claudeWindows(ev); if (windows.length) samples.push({ ts, provider: "claude", windows }); }
  }
}
// Codex rollouts carry an ISO timestamp on every token_count.
const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".jsonl") ? [path.join(d, e.name)] : []) : [];
for (const file of walk(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"))) {
  for (const line of lines(file)) {
    if (!line.includes('"rate_limits"')) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    const r = ev.payload?.rate_limits, ts = Date.parse(ev.timestamp);
    if (ev.payload?.type !== "token_count" || !r || (r.limit_id && r.limit_id !== "codex") || !Number.isFinite(ts)) continue;
    const windows = codexWindows(r);
    if (windows.length) samples.push({ ts, provider: "codex", windows });
  }
}
samples.sort((a, b) => a.ts - b.ts);

const file = path.join(DATA_DIR, "usage-history.jsonl");
const rowKey = (r: any) => [r.ts, r.provider, r.label, r.resetsAt, r.used].join("|");
const have = new Set(lines(file).filter(Boolean).flatMap(l => { try { return [rowKey(JSON.parse(l))]; } catch { return []; } }));
const prev: Record<string, ProviderUsage> = {};
const rows: any[] = [];
for (const s of samples) {
  const next = { windows: s.windows, updatedAt: s.ts };
  for (const r of historyRows(s.provider, prev[s.provider], next)) if (!have.has(rowKey(r))) rows.push(r);
  prev[s.provider] = next;
}

// Report: peak reading of each 5-hour window = how much of it was used before it reset. Reset times jitter by seconds
// between readings, so readings within two minutes of each other are one window. Windows still open are not scored.
const fmt = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: process.env.TZ || "Asia/Kolkata", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(t);
const now = Date.now();
for (const p of ["claude", "codex"]) {
  const wins: { end: number; peak: number; seen: number }[] = [];
  for (const r of rows.filter(r => r.provider === p && r.label === "5-hour" && r.resetsAt).sort((a, b) => a.resetsAt - b.resetsAt)) {
    const w = wins.find(x => Math.abs(x.end - r.resetsAt) < 120_000);
    const used = Math.min(100, r.used);
    if (w) { w.peak = Math.max(w.peak, used); w.seen = Math.max(w.seen, r.ts); } else wins.push({ end: r.resetsAt, peak: used, seen: r.ts });
  }
  const done = wins.filter(w => w.end < now);
  console.log(`${p}: ${done.length} finished windows${wins.length > done.length ? " (+1 open)" : ""}`);
  for (const w of done) console.log(`  ended ${fmt(w.end)}  peak ${Math.round(w.peak)}% used`);
  if (done.length) console.log(`  mean peak ${Math.round(done.reduce((a, w) => a + w.peak, 0) / done.length)}%; ${done.filter(w => w.peak < 90).length} of ${done.length} finished under 90%`);
}
console.log(`${samples.length} readings, ${rows.length} new rows${dry ? " (dry run, nothing written)" : ""}`);
if (!dry && rows.length) {
  const merged = [...lines(file).filter(Boolean).map(l => JSON.parse(l)), ...rows].sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(file, merged.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}
