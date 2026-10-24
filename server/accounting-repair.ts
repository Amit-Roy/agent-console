import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codexAccounting } from "./accounting.ts";
import { accountingSamples } from "./accounting-log.ts";

type RetainedSamples = Map<string, ReturnType<typeof accountingSamples>>;

function readThreadMetadata(dir: string) {
  let threads: any[] = [];
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, "threads.json"), "utf8"));
    if (Array.isArray(value)) threads = value;
  } catch {}
  return new Map(threads.map((thread) => [thread.id, thread]));
}

function collectCandidates(dir: string, rows: Record<string, any>[]): RetainedSamples {
  const metadata = readThreadMetadata(dir);
  const candidates: RetainedSamples = new Map();
  for (const row of rows) {
    if (row.accounting === 2 || candidates.has(row.thread)) continue;
    // A deleted/archived thread can still have a retained log and ledger metadata.
    const thread = metadata.get(row.thread) || {
      id: row.thread,
      provider: row.provider,
      model: row.model,
    };
    try {
      candidates.set(
        row.thread,
        accountingSamples(
          fs.readFileSync(path.join(dir, "logs", `${row.thread}.jsonl`), "utf8"),
          thread,
        ),
      );
    } catch {
      candidates.set(row.thread, []);
    }
  }
  return candidates;
}

// Already-normalized rows own their log results; never award that measurement twice.
function dropClaimedSamples(candidates: RetainedSamples, rows: Record<string, any>[]) {
  for (const row of rows.filter((entry) => entry.accounting === 2)) {
    const matches = candidates.get(row.thread);
    if (!matches) continue;
    const at = matches.findIndex((sample) =>
      row.eventId ? sample.eventId === row.eventId : sample.ts === row.ts,
    );
    if (at >= 0) matches.splice(at, 1);
  }
}

// Legacy Codex counters were per-turn, with cache reads included in input.
function legacyCodexRow<T extends Record<string, any>>(row: T): T | undefined {
  if (
    row.provider !== "codex" ||
    ![row.in, row.out, row.cache].every(
      (count) => typeof count === "number" && Number.isFinite(count) && count >= 0,
    ) ||
    row.cache > row.in
  )
    return undefined;
  return {
    ...row,
    ...codexAccounting(
      { input_tokens: row.in, output_tokens: row.out, cached_input_tokens: row.cache },
      row.model || "unknown",
    ),
    cost: undefined,
    b: 1,
  };
}

function matchedLogRow<T extends Record<string, any>>(row: T, candidates: RetainedSamples): T {
  const matches = candidates.get(row.thread) || [];
  const exact = matches.filter((sample) => sample.ts === row.ts);
  const close = exact.length
    ? exact
    : matches.filter((sample) => Math.abs(sample.ts - row.ts) <= 5000);
  const { cost, in: input, out, cache, models, cumulative, ...rest } = row;
  if (close.length !== 1)
    return {
      ...rest,
      accounting: 2,
      unresolved: "No unique timestamp-matched result in retained logs",
    } as T;
  const measured = close[0];
  matches.splice(matches.indexOf(measured), 1);
  return { ...rest, ...measured, ts: row.ts, b: 1 } as T;
}

/** Project legacy rows from retained logs without ever modifying the ledger or source rows.
 * Normalize the complete ledger before date filtering so timestamp matches cannot be reused.
 */
export function normalizeAccountingRows<T extends Record<string, any>>(
  dir: string,
  rows: T[],
): T[] {
  if (!rows.some((row) => row.accounting !== 2)) return rows;
  const candidates = collectCandidates(dir, rows);
  dropClaimedSamples(candidates, rows);
  return rows.map((row) => {
    if (row.accounting === 2) return row;
    return legacyCodexRow(row) ?? matchedLogRow(row, candidates);
  });
}

/** Call before accepting turns at server startup; original ledger is always backed up before applying. */
export function repairAccounting(dir: string, apply = false) {
  const file = path.join(dir, "turns.jsonl");
  if (!fs.existsSync(file)) return { rows: 0, repaired: 0, unknown: 0, applied: false };
  const original = fs.readFileSync(file, "utf8");
  const rows = original
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = normalizeAccountingRows(dir, rows);
  const legacy = result.filter((_, index) => rows[index].accounting !== 2);
  const unknown = legacy.filter((row) => row.unresolved).length,
    repaired = legacy.length - unknown;
  const sum = (rs: any[]) => ({
    tokens: rs.reduce((s, r) => s + (r.in || 0) + (r.out || 0), 0),
    cost: rs.reduce((s, r) => s + (r.cost || 0), 0),
  });
  let backup: string | undefined;
  if (apply && repaired + unknown > 0) {
    if (fs.readFileSync(file, "utf8") !== original)
      throw Error("Ledger changed during repair; retry at startup before accepting turns");
    backup = `${file}.backup-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    const temp = `${file}.repair-${process.pid}`;
    fs.writeFileSync(temp, result.map((r) => JSON.stringify(r) + "\n").join(""), {
      flag: "wx",
      mode: 0o600,
    });
    if (fs.readFileSync(file, "utf8") !== original) {
      fs.unlinkSync(temp);
      throw Error("Ledger changed; backup retained, original untouched");
    }
    fs.renameSync(temp, file);
  }
  return {
    rows: rows.length,
    repaired,
    unknown,
    before: sum(rows),
    after: sum(result),
    applied: !!backup,
    backup,
  };
}
