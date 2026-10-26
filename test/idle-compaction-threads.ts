import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-idle-threads-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: dir,
  AGENT_CONSOLE_BRAIN: path.join(dir, "missing"),
  AGENT_CONSOLE_LABELS: "0",
  AGENT_CONSOLE_IDLE_COMPACT_FIXTURE_TTL_MS: "100000",
});
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const contexts = new Map<string, any[]>();
let calls = 0,
  fail = false;
PROVIDERS.set("fixture", {
  id: "fixture",
  label: "Fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(t, ctx) {
    const list = contexts.get(t.id) || [];
    list.push(ctx);
    contexts.set(t.id, list);
    ctx.event({ type: "context_usage", used: 60000, max: 200000 }); // synchronous start events must survive buffering
    return {
      alive: true,
      send() {
        ctx.event({ type: "system", subtype: "init", session_id: t.id });
        ctx.event({ type: "context_usage", used: 60000, max: 200000 });
      },
      compact() {
        calls++;
        if (fail) throw Error("fixture compact failure");
        ctx.event({ type: "system", subtype: "compact_boundary" });
        ctx.event({
          type: "result",
          uuid: `compact-${calls}`,
          session_id: t.id,
          total_cost_usd: calls,
          modelUsage: {
            fixture: {
              inputTokens: calls * 10,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              outputTokens: 2,
              costUSD: calls,
            },
          },
        });
      },
      abort() {},
      kill() {},
    };
  },
});
mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
let threads = new Threads(() => {});
const latest = (id: string) => contexts.get(id)!.at(-1);
const create = () => threads.create({ provider: "fixture", cwd: dir, title: "Fixture" });
const complete = (id: string) => latest(id).event({ type: "result", subtype: "success" });
const ready = () => {
  const t = create();
  threads.send(t.id, "ordinary activity");
  complete(t.id);
  return t;
};
try {
  const t = ready();
  assert.equal(t.idleCompactionTtlMs, 100000);
  assert.equal(t.idleCompactionDueAt, Date.now() + 70000);
  const old = latest(t.id);
  mock.timers.tick(69999);
  assert.equal(calls, 0);
  mock.timers.tick(1);
  assert.equal(calls, 1);
  assert.equal(t.status, "idle");
  assert.equal(t.lastCompactedAt, Date.now());
  assert.equal(t.idleCompactionDueAt, undefined);
  const rows = fs
    .readFileSync(path.join(dir, "turns.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    rows.at(-1).cost,
    1,
    "automatic compaction records provider usage in normal accounting",
  );
  const consumed = t.idleCompactionConsumedAt;
  old.event({ type: "context_usage", used: 199999 });
  old.event({ type: "result", is_error: true });
  assert.notEqual(t.context?.used, 199999, "replaced agent cannot mutate the new session");
  assert.equal(t.idleCompactionConsumedAt, consumed);
  mock.timers.tick(200000);
  assert.equal(calls, 1, "compaction never rearms itself");
  threads.send(t.id, "new ordinary cycle");
  complete(t.id);
  mock.timers.tick(70000);
  assert.equal(calls, 2);
  const opted = ready();
  threads.update(opted.id, { idleCompaction: false });
  assert.equal(opted.idleCompactionDueAt, undefined);
  const archived = ready();
  threads.archive(archived.id, true);
  const deleted = ready();
  threads.remove(deleted.id);
  const stopped = ready();
  threads.abort(stopped.id);
  const small = ready();
  latest(small.id).event({ type: "context_usage", used: 1 });
  const busy = ready();
  threads.send(busy.id, "new request still running");
  const queued = ready();
  (threads as any).queues.set(queued.id, [
    { id: "held", text: "pending", attachments: [], revision: 0, editing: true },
  ]);
  const changed = ready();
  mock.timers.tick(35000);
  threads.send(changed.id, "activity cancels old deadline");
  complete(changed.id);
  mock.timers.tick(35000);
  assert.equal(
    calls,
    2,
    "optout, archived, deleted, stopped, small, busy, queued and changed cycle skip old deadlines",
  );
  mock.timers.tick(35000);
  assert.equal(calls, 3, "new activity gets its own deadline");
  const failed = ready();
  fail = true;
  mock.timers.tick(70000);
  assert.equal(calls, 4);
  assert.equal(failed.status, "idle");
  mock.timers.tick(200000);
  assert.equal(calls, 4, "failed automatic compaction consumes cycle");
  fail = false;
  const future = ready();
  threads.shutdown();
  mock.timers.tick(1000);
  assert.equal(calls, 4);
  const restoredEvents: any[] = [];
  threads = new Threads((event) => restoredEvents.push(event));
  assert.equal(
    threads.get(future.id)!.idleCompactionDueAt,
    undefined,
    "the constructor leaves deadlines to restoreIdleCompaction",
  );
  threads.restoreIdleCompaction();
  assert.ok(threads.get(future.id)!.idleCompactionDueAt, "future deadline restored after listen");
  assert.ok(
    restoredEvents.some((event) => event.t === "thread" && event.thread.id === future.id),
    "a changed deadline is announced to open tabs",
  );
  const announced = restoredEvents.length;
  threads.restoreIdleCompaction();
  assert.equal(restoredEvents.length, announced, "an unchanged deadline emits nothing");
  mock.timers.tick(69000);
  assert.equal(calls, 5);
  const overdue = ready();
  threads.shutdown();
  mock.timers.tick(100000);
  threads = new Threads(() => {});
  threads.restoreIdleCompaction();
  assert.equal(
    threads.get(overdue.id)!.idleCompactionDueAt,
    undefined,
    "startup never catches up overdue paid work",
  );
  mock.timers.tick(100000);
  assert.equal(calls, 5);
  const final = ready();
  threads.shutdown();
  mock.timers.tick(100000);
  assert.equal(calls, 5, "shutdown clears every timer");
  // Exercise the Codex provider dispatch using its resolved CLI-default model.
  const originalCodex = PROVIDERS.get("codex");
  PROVIDERS.set("codex", {
    ...PROVIDERS.get("fixture")!,
    id: "codex",
    models: () => ["default", "gpt-6.1-sol"],
    defaultModel: () => "default",
  });
  try {
    threads = new Threads(() => {});
    const native = threads.create({ provider: "codex", cwd: dir });
    assert.equal(
      native.idleCompactionTtlMs,
      undefined,
      "unresolved CLI default never schedules paid work",
    );
    threads.send(native.id, "Codex activity");
    latest(native.id).event({
      type: "system",
      subtype: "init",
      session_id: native.id,
      model: "gpt-6.1-sol",
    });
    complete(native.id);
    assert.equal(native.resolvedModel, "gpt-6.1-sol");
    assert.equal(native.idleCompactionTtlMs, 1800000);
    assert.equal(native.idleCompactionSource, "openai-default-estimate");
    assert.equal(native.idleCompactionLeadMs, 30000);
    assert.equal(native.idleCompactionMinTokens, 50000);
    assert.equal(native.idleCompactionDueAt, Date.now() + 1770000);
    const before = calls;
    mock.timers.tick(1770000);
    assert.equal(
      calls,
      before + 1,
      "Codex timer invokes native Agent.compact through the normal manager",
    );
    assert.equal(native.lastCompactedAt, Date.now());
    mock.timers.tick(1800000);
    assert.equal(calls, before + 1, "Codex compaction does not schedule itself repeatedly");
    threads.update(native.id, { model: "gpt-6.1-sol" });
    threads.update(native.id, { model: "default" });
    assert.equal(native.resolvedModel, undefined);
    assert.equal(
      native.idleCompactionTtlMs,
      undefined,
      "changing back to CLI default clears old model assumptions",
    );
  } finally {
    if (originalCodex) PROVIDERS.set("codex", originalCodex);
  }
  console.log(
    "PASS automatic idle compaction: once per cycle, accounting, optout, queue/busy/archive/delete/abort guards, stale-agent isolation, failures and restart/shutdown",
  );
} finally {
  threads.shutdown();
  mock.timers.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
