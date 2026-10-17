import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { accountingSamples } from "./accounting-log.ts";
import { codexAccounting } from "./accounting.ts";

/** Call before accepting turns at server startup; original ledger is always backed up before applying. */
export function repairAccounting(dir: string, apply = false) {
  const file = path.join(dir, "turns.jsonl");
  if (!fs.existsSync(file)) return { rows: 0, repaired: 0, unknown: 0, applied: false };
  const original = fs.readFileSync(file, "utf8");
  const rows = original.split("\n").filter(Boolean).map(line => JSON.parse(line));
  let repaired = 0, unknown = 0;
  const candidates = new Map<string, ReturnType<typeof accountingSamples>>();
  if (rows.some(row => row.accounting !== 2)) {
    const threads = JSON.parse(fs.readFileSync(path.join(dir, "threads.json"), "utf8"));
    for (const thread of threads) {
      try {
        candidates.set(thread.id, accountingSamples(fs.readFileSync(path.join(dir, "logs", `${thread.id}.jsonl`), "utf8"), thread));
      } catch (err: any) { if (err.code !== "ENOENT") throw err; }
    }
  }
  const result = rows.map(row => {
    if (row.accounting === 2) return row;
    // Legacy Codex rows already used per-turn counters with cache reads included.
    if (row.provider === "codex" && [row.in, row.out, row.cache].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) && row.cache <= row.in) {
      repaired++;
      return { ...row, ...codexAccounting({ input_tokens: row.in, output_tokens: row.out, cached_input_tokens: row.cache }, row.model || "unknown"), cost: undefined, b: 1 };
    }
    const matches = candidates.get(row.thread) || [];
    const close = matches.filter(r => Math.abs(r.ts - row.ts) <= 5000);
    const { cost, in: input, out, cache, models, cumulative, ...rest } = row;
    if (close.length !== 1) { unknown++; return { ...rest, accounting: 2, unresolved: "No unique timestamp-matched result in retained logs" }; }
    const measured = close[0]; matches.splice(matches.indexOf(measured), 1);
    repaired++;
    return { ...rest, ...measured, ts: row.ts, b: 1 };
  });
  const sum = (rs: any[]) => ({ tokens: rs.reduce((s, r) => s + (r.in || 0) + (r.out || 0), 0), cost: rs.reduce((s, r) => s + (r.cost || 0), 0) });
  let backup: string | undefined;
  if (apply && repaired + unknown > 0) {
    if (fs.readFileSync(file, "utf8") !== original) throw Error("Ledger changed during repair; retry at startup before accepting turns");
    backup = `${file}.backup-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    const temp = `${file}.repair-${process.pid}`;
    fs.writeFileSync(temp, result.map(r => JSON.stringify(r) + "\n").join(""), { flag: "wx", mode: 0o600 });
    if (fs.readFileSync(file, "utf8") !== original) { fs.unlinkSync(temp); throw Error("Ledger changed; backup retained, original untouched"); }
    fs.renameSync(temp, file);
  }
  return { rows: rows.length, repaired, unknown, before: sum(rows), after: sum(result), applied: !!backup, backup };
}
