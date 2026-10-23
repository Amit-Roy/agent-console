import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-notification-lifecycle-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
});
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const contexts = new Map<string, any>();
PROVIDERS.set("notification-fixture", {
  id: "notification-fixture",
  label: "Fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(t, ctx) {
    contexts.set(t.id, ctx);
    return { alive: true, send() {}, interrupt() {}, abort() {}, kill() {}, compact() {} };
  },
});
mock.timers.enable({ apis: ["setTimeout"] });
const notices: any[] = [];
const threads = new Threads(
  () => {},
  (notice) => notices.push(notice),
);
const create = () => {
  const t = threads.create({ provider: "notification-fixture", cwd: data, title: "Fixture" });
  threads.send(t.id, "task");
  return t;
};
const event = (t: any, ev: any) => contexts.get(t.id).event(ev);
const result = (t: any, extra = {}) => event(t, { type: "result", subtype: "success", ...extra });
const exit = (t: any, aborted = false) =>
  contexts.get(t.id).exited({ code: 1, signal: null, stderr: "fixture exit", aborted });
const kinds = (t: any) => notices.filter((n) => n.thread === t.id).map((n) => n.kind);
const question = (t: any, id: string, async = false) =>
  event(t, {
    type: "question",
    id,
    ...(async ? { async: true } : {}),
    questions: [{ id: "scope", question: "Which scope?", options: [{ label: "Full" }] }],
  });
try {
  const finished = create();
  threads.update(finished.id, { title: "Current title" });
  result(finished);
  result(finished);
  exit(finished);
  assert.deepEqual(
    kinds(finished),
    ["finished"],
    "result replay and process exit cannot duplicate completion",
  );
  assert.equal(notices.find((n) => n.thread === finished.id).title, "Current title");

  const failed = create();
  result(failed, { is_error: true });
  exit(failed);
  assert.deepEqual(kinds(failed), ["failed"]);
  const crashed = create();
  exit(crashed);
  exit(crashed);
  assert.deepEqual(kinds(crashed), ["failed"], "unexpected process exit emits one failure");

  const blocking = create();
  question(blocking, "blocking");
  question(blocking, "blocking");
  assert.deepEqual(kinds(blocking), ["needs_input"], "replayed question emits once");
  threads.abort(blocking.id);
  result(blocking);
  exit(blocking, true);
  assert.deepEqual(kinds(blocking), ["needs_input"], "manual stop emits no terminal notice");
  const async = create();
  question(async, "async", true);
  result(async);
  exit(async);
  assert.deepEqual(
    kinds(async),
    ["needs_input"],
    "persistent async input keeps needs-input state after result and exit",
  );

  const queued = create();
  threads.send(queued.id, "next", { mode: "queue" });
  result(queued);
  assert.deepEqual(kinds(queued), [], "queued work suppresses interim success");
  mock.timers.tick(250);
  result(queued);
  assert.deepEqual(kinds(queued), ["finished"]);
  const nativeQueued = create();
  result(nativeQueued, { queued_turn_count: 1 });
  assert.deepEqual(kinds(nativeQueued), []);
  result(nativeQueued);
  assert.deepEqual(kinds(nativeQueued), ["finished"]);

  for (const auto of ["brain", "subagent"] as const) {
    const internal = threads.create({
      provider: "notification-fixture",
      cwd: data,
      title: "Internal",
    });
    threads.send(internal.id, "internal", { auto });
    question(internal, `internal-${auto}`);
    result(internal);
    assert.deepEqual(kinds(internal), [], "internal turns do not alert");
  }
  const compact = create();
  result(compact);
  threads.compact(compact.id);
  question(compact, "compact");
  result(compact, { is_error: true });
  exit(compact);
  assert.deepEqual(kinds(compact), ["finished"], "compaction failure and exit do not alert");
  const stopped = create();
  threads.abort(stopped.id);
  exit(stopped, true);
  assert.deepEqual(kinds(stopped), []);

  const quiet = new Threads(
    () => {},
    () => {
      throw Error("notification unavailable");
    },
  );
  const safe = quiet.create({
    provider: "notification-fixture",
    cwd: data,
    title: "Transport failure",
  });
  quiet.send(safe.id, "task");
  result(safe);
  assert.equal(safe.status, "idle", "notification transport exceptions cannot break lifecycle");
  quiet.shutdown();
  console.log(
    "PASS notification lifecycle: finish, failure, crash, input, deduplication, queues, stops, internal turns, compaction and transport isolation",
  );
} finally {
  threads.shutdown();
  mock.timers.reset();
  PROVIDERS.delete("notification-fixture");
  fs.rmSync(data, { recursive: true, force: true });
}
