import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-accounting-threads-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_MOCK = "1";
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "missing-brain");
const result = (uuid: string, n: number, session = "native") => ({
  type: "result",
  uuid,
  session_id: session,
  total_cost_usd: n,
  modelUsage: {
    opus: {
      inputTokens: n * 10,
      cacheCreationInputTokens: n * 20,
      cacheReadInputTokens: n * 100,
      outputTokens: n * 2,
      costUSD: n,
    },
  },
});
fs.mkdirSync(path.join(data, "logs"));
const source = {
  id: "thread",
  title: "fixture",
  provider: "claude",
  model: "sonnet",
  mode: "acceptEdits",
  cwd: data,
  sessionId: "native",
  cost: 99,
  status: "idle",
  createdAt: 1,
  updatedAt: 10_000,
};
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([source]));
fs.writeFileSync(
  path.join(data, "logs/thread.jsonl"),
  [
    { type: "user_input", ts: 10_000, text: "first" },
    { type: "system", subtype: "init", session_id: "native" },
    result("a", 1),
  ]
    .map((e) => JSON.stringify(e) + "\n")
    .join(""),
);
fs.writeFileSync(
  path.join(data, "turns.jsonl"),
  JSON.stringify({ ts: 10_000, thread: "thread", provider: "claude", cost: 99 }) + "\n",
);
fs.writeFileSync(path.join(data, "turns.backfilled"), "fixture");
const { Threads } = await import("../server/threads.ts");
let threads = new Threads(() => {});
const finish = (id: string, ts: number, ev: any) => {
  (threads as any).turns.set(id, { start: ts, tools: {} });
  (threads as any).onEvent(threads.get(id), ev);
};
const rows = () =>
  fs
    .readFileSync(path.join(data, "turns.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
try {
  assert.equal(threads.get("thread")?.cost, 1); // startup repairs the old ledger and inflated footer
  assert.ok(fs.readdirSync(data).some((f) => f.startsWith("turns.jsonl.backup-")));
  finish("thread", 20_000, result("b", 3));
  assert.equal(rows().at(-1).cost, 2);
  assert.equal(threads.get("thread")?.cost, 3);
  // Simulate a crash after durable accounting but before the corresponding display event reached the log.
  const log = path.join(data, "logs/thread.jsonl");
  fs.writeFileSync(
    log,
    fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => !line.includes('"uuid":"b"'))
      .join("\n"),
  );
  threads.shutdown();
  threads = new Threads(() => {});
  finish("thread", 30_000, result("c", 4));
  assert.equal(rows().at(-1).cost, 1);
  assert.equal(threads.get("thread")?.cost, 4);
  const count = rows().length;
  (threads as any).onEvent(threads.get("thread"), result("c", 4));
  assert.equal(rows().length, count);
  const fork = threads.fork("thread");
  (threads as any).onEvent(fork, { type: "system", subtype: "init", session_id: "fork" });
  finish(fork.id, 40_000, result("d", 5, "fork"));
  assert.equal(rows().at(-1).cost, 1);
  assert.equal(threads.get(fork.id)?.cost, 1);
  threads.shutdown();
  threads = new Threads(() => {});
  finish(fork.id, 50_000, result("e", 6, "fork"));
  assert.equal(rows().at(-1).cost, 1);
  assert.equal(threads.get(fork.id)?.cost, 2);
  const codex = threads.create({ provider: "mock", cwd: data, title: "missing counter" });
  codex.provider = "codex";
  codex.lastRun = { input_tokens: 9999, output_tokens: 99 };
  finish(codex.id, 60_000, { type: "result" });
  assert.equal(rows().at(-1).in, undefined); // no stale usage from an earlier run
  console.log(
    "PASS Threads startup repair, durable session resume, thread totals, fork/restart accounting and unknown usage",
  );
} finally {
  threads.shutdown();
  fs.rmSync(data, { recursive: true, force: true });
}
