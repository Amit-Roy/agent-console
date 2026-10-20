import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairAccounting, normalizeAccountingRows } from "../server/accounting-repair.ts";
import { accountingSamples } from "../server/accounting-log.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ledger-repair-"));
const result = (uuid: string, amount: number) => ({ type: "result", uuid, session_id: "native", total_cost_usd: amount, modelUsage: { opus: { inputTokens: amount * 10, cacheCreationInputTokens: amount * 20, cacheReadInputTokens: amount * 100, outputTokens: amount * 2, costUSD: amount } } });
const events = [
  { type: "user_input", ts: 10_000, text: "first task" },
  { type: "system", subtype: "init", session_id: "native" }, result("a", 1),
  { type: "user_input", ts: 20_000, text: "resume" },
  { type: "system", subtype: "init", session_id: "native" }, result("b", 3),
  { type: "user_input", ts: 30_000, text: "/compact", command: true },
  { ...result("early", 3), num_turns: 0 },
  { type: "system", subtype: "compact_boundary" }, result("c", 4),
];
const raw = events.map(e => JSON.stringify(e)).join("\n") + "\n";
const thread = { id: "thread", provider: "claude", model: "sonnet", createdAt: 1 };
const samples = accountingSamples(raw, thread);
assert.deepEqual(samples.map(s => s.cost), [1, 2, 1]);
const forkSamples = accountingSamples(raw + [
  { type: "user_input", ts: 50_000, text: "fork" },
  { type: "system", subtype: "init", session_id: "fork" },
  { ...result("fork-event", 5), session_id: "fork" },
].map(e => JSON.stringify(e)).join("\n"), { ...thread, createdAt: 40_000 });
assert.equal(forkSamples.length, 1);
assert.equal(forkSamples[0].cost, 1);
try {
  fs.mkdirSync(path.join(dir, "logs"));
  fs.writeFileSync(path.join(dir, "threads.json"), JSON.stringify([thread]));
  fs.writeFileSync(path.join(dir, "logs", "thread.jsonl"), raw);
  const rows = [
    { ts: 10_000, thread: "thread", provider: "claude", cost: 1 },
    { ts: 20_000, thread: "thread", provider: "claude", cost: 3 },
    { ts: 30_000, thread: "thread", provider: "claude", cost: 4 },
    { ts: 70_000, thread: "thread", provider: "claude", cost: 99 },
    { ts: 80_000, thread: "codex", provider: "codex", in: 100, out: 10, cache: 80 },
  ];
  const file = path.join(dir, "turns.jsonl");
  const original = rows.map(r => JSON.stringify(r) + "\n").join("");
  fs.writeFileSync(file, original);
  const projected = normalizeAccountingRows(dir, rows);
  assert.deepEqual(projected.slice(0, 3).map(r => r.cost), [1, 2, 1]);
  assert.equal(projected[3].cost, undefined);
  assert.ok(projected[3].unresolved);
  assert.equal(projected[4].in, 100);
  assert.equal(rows[1].cost, 3, "read-time projection never mutates ledger rows");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(normalizeAccountingRows(dir, rows), projected, "repeated reads do not accumulate usage");
  assert.deepEqual(normalizeAccountingRows(dir, projected), projected, "normalized projection is idempotent");
  const replay = normalizeAccountingRows(dir, [projected[0], rows[0]]);
  assert.ok(replay[1].unresolved, "normalized rows reserve their result before legacy matching");
  const duplicate = normalizeAccountingRows(dir, [rows[0], rows[0]]);
  assert.ok(duplicate[1].unresolved, "one retained result cannot be counted twice");
  const nearby = normalizeAccountingRows(dir, [
    { ...rows[0], ts: 15_000 },
  ]);
  assert.ok(nearby[0].unresolved, "equidistant results remain unknown");
  const dry = repairAccounting(dir);
  assert.equal(dry.applied, false); assert.equal(dry.repaired, 4); assert.equal(dry.unknown, 1);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  const priorData = process.env.AGENT_CONSOLE_DATA;
  try {
    process.env.AGENT_CONSOLE_DATA = dir;
    const { readTurns } = await import("../server/analytics.ts");
    assert.deepEqual(readTurns(20_000, 30_000).map(row => row.cost), [2, 1], "date filtering happens after reconstruction");
    assert.equal(fs.readFileSync(file, "utf8"), original);
    // A newly appended result is visible without a restart, repair or stale cache.
    fs.appendFileSync(path.join(dir, "logs", "thread.jsonl"), [
      { type: "user_input", ts: 40_000, text: "next" }, result("d", 6),
    ].map(event => JSON.stringify(event) + "\n").join(""));
    fs.appendFileSync(file, JSON.stringify({ ts: 40_000, thread: "thread", provider: "claude", cost: 6 }) + "\n");
    assert.equal(readTurns(40_000, 40_000)[0].cost, 2);
    fs.writeFileSync(file, original);
  } finally {
    if (priorData === undefined) delete process.env.AGENT_CONSOLE_DATA; else process.env.AGENT_CONSOLE_DATA = priorData;
  }
  const applied = repairAccounting(dir, true);
  assert.ok(applied.backup);
  assert.equal(fs.readFileSync(applied.backup!, "utf8"), original);
  const repaired = fs.readFileSync(file, "utf8").trim().split("\n").map(r => JSON.parse(r));
  assert.deepEqual(repaired.slice(0, 3).map(r => r.cost), [1, 2, 1]);
  assert.equal(repaired[3].cost, undefined); assert.ok(repaired[3].unresolved);
  assert.equal(repaired[4].in, 100); assert.equal(repaired[4].models[0].fresh, 20);
  assert.equal(repairAccounting(dir, true).applied, false); // no second backup or duplicate migration
  console.log("PASS backed-up repair, resume/fork/compaction reconstruction, missing data, Codex preservation and idempotency");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
