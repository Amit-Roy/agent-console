// Stop must end background subagents, which an in-place interrupt would leave running. The sweep ends hung ones and hung turns.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-stop-bg-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
  AGENT_CONSOLE_BACKGROUND_STALE_MS: "60000",
  AGENT_CONSOLE_TURN_STALE_MS: "60000",
});
const { Threads } = await import(pathToFileURL(path.join(root, "server/threads.ts")).href);
const { PROVIDERS } = await import(
  pathToFileURL(path.join(root, "server/providers/index.ts")).href
);
const contexts = new Map<string, any>();
const calls: string[] = [];
PROVIDERS.set("stop-fixture", {
  id: "stop-fixture",
  label: "Stop fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(t: any, ctx: any) {
    let alive = true;
    contexts.set(t.id, ctx);
    return {
      get alive() {
        return alive;
      },
      send() {},
      interrupt() {
        calls.push("interrupt");
      },
      abort() {
        alive = false;
        calls.push("abort");
        ctx.exited({ code: null, signal: "SIGINT", stderr: "", aborted: true });
      },
      kill() {
        alive = false;
        calls.push("kill");
        ctx.exited({ code: null, signal: "SIGTERM", stderr: "", aborted: true });
      },
    };
  },
});
mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
const threads = new Threads(() => {});
try {
  const tracked = threads.create({ provider: "stop-fixture", cwd: data, title: "tracked" });
  threads.send(tracked.id, "go");
  const event = (value: any) => contexts.get(tracked.id).event(value);
  const work = () => threads.page(tracked.id).workState;
  event({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "bash-live", name: "Bash", input: {} },
        { type: "tool_use", id: "agent-live", name: "Agent", input: {} },
      ],
    },
  });
  assert.deepEqual(work(), {
    version: 1,
    foreground: ["bash-live", "agent-live"],
    background: [],
    backgroundCount: 0,
  });
  event({
    type: "assistant",
    parent_tool_use_id: "agent-live",
    message: { content: [{ type: "tool_use", id: "nested", name: "Bash", input: {} }] },
  });
  assert.deepEqual(
    work().foreground,
    ["bash-live", "agent-live"],
    "nested calls belong to the subagent, not the parent turn",
  );
  event({
    type: "system",
    subtype: "task_started",
    tool_use_id: "agent-live",
    task_id: "task-live",
    is_backgrounded: true,
  });
  event({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "agent-live", content: "launched" }] },
  });
  event({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-live" }] });
  event({ type: "result", subtype: "success" });
  assert.deepEqual(
    work(),
    { version: 1, foreground: [], background: ["agent-live"], backgroundCount: 1 },
    "launch receipt and turn end preserve known live background work",
  );
  event({
    type: "system",
    subtype: "task_notification",
    task_id: "task-live",
    status: "completed",
  });
  assert.deepEqual(work(), { version: 1, foreground: [], background: [], backgroundCount: 0 });
  event({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "unknown" }] });
  assert.equal(work().backgroundCount, 1, "unknown task identities retain the live count");
  event({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: "replacement", tool_use_id: "replacement-tool" }],
  });
  assert.deepEqual(
    threads.get(tracked.id).workState.background,
    ["replacement-tool"],
    "equal task counts still update live task identities",
  );
  threads.abort(tracked.id);
  assert.deepEqual(work(), { version: 1, foreground: [], background: [], backgroundCount: 0 });
  calls.length = 0;

  const resolved = threads.create({ provider: "stop-fixture", cwd: data, title: "resolved" });
  threads.send(resolved.id, "go");
  const resolvedEvent = (value: any) => contexts.get(resolved.id).event(value);
  resolvedEvent({
    type: "system",
    subtype: "task_started",
    task_id: "old-task",
    tool_use_id: "old-tool",
  });
  resolvedEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "old-tool", content: "done" }] },
  });
  resolvedEvent({
    type: "system",
    subtype: "task_started",
    task_id: "ended-task",
    tool_use_id: "ended-tool",
  });
  resolvedEvent({ type: "result", subtype: "success" });
  resolvedEvent({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: "old-task" }, { task_id: "ended-task" }],
  });
  assert.deepEqual(
    threads.page(resolved.id).workState.background,
    [],
    "finished foreground calls cannot become confirmed background work through stale task identities",
  );
  threads.abort(resolved.id);
  calls.length = 0;

  const plain = threads.create({ provider: "stop-fixture", cwd: data, title: "plain" });
  threads.send(plain.id, "go");
  threads.abort(plain.id);
  assert.deepEqual(calls, ["interrupt"], "a turn without subagents is still interrupted in place");

  calls.length = 0;
  const t = threads.create({ provider: "stop-fixture", cwd: data, title: "bg" });
  threads.send(t.id, "go");
  contexts
    .get(t.id)
    .event({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a" }] });
  contexts.get(t.id).event({ type: "result", subtype: "success" });
  assert.equal(threads.get(t.id).status, "idle");
  assert.equal(threads.get(t.id).background, 1, "idle main thread with a subagent still working");
  threads.abort(t.id);
  assert.deepEqual(calls, ["abort"], "stop with background work kills the agent process");
  assert.equal(threads.get(t.id).background, undefined);

  // hung background work: no event from the process for longer than the limit
  calls.length = 0;
  const hung = threads.create({ provider: "stop-fixture", cwd: data, title: "hung" });
  threads.send(hung.id, "go");
  contexts
    .get(hung.id)
    .event({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w" }] });
  contexts.get(hung.id).event({ type: "result", subtype: "success" });
  mock.timers.tick(50_000);
  contexts.get(hung.id).event({ type: "system", subtype: "task_updated" }); // progress noise proves the task is alive
  mock.timers.tick(50_000);
  threads.sweep();
  assert.equal(
    threads.get(hung.id).background,
    1,
    "a task that reported progress recently is kept",
  );
  mock.timers.tick(20_000);
  threads.sweep();
  assert.equal(
    threads.get(hung.id).background,
    undefined,
    "silent background work past the limit is killed",
  );
  assert.equal(threads.get(hung.id).status, "idle");

  // hung turn: running, but the process has been silent for longer than the limit
  const stuck = threads.create({ provider: "stop-fixture", cwd: data, title: "stuck" });
  threads.send(stuck.id, "go");
  mock.timers.tick(50_000);
  contexts.get(stuck.id).event({ type: "stream_event", event: { type: "ping" } });
  mock.timers.tick(50_000);
  threads.sweep();
  assert.equal(threads.get(stuck.id).status, "running", "a turn that streamed recently is kept");
  calls.length = 0;
  mock.timers.tick(20_000);
  threads.sweep();
  assert.equal(threads.get(stuck.id).status, "idle", "a turn silent past the limit is ended");
  assert.deepEqual(calls, ["kill"], "its hung agent is killed");

  // a blocking question waits on the user, however long that takes
  const asking = threads.create({ provider: "stop-fixture", cwd: data, title: "asking" });
  threads.send(asking.id, "go");
  contexts.get(asking.id).event({
    type: "question",
    id: "q",
    questions: [{ id: "a", question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
  });
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(50_000);
    threads.sweep();
  }
  assert.equal(
    threads.get(asking.id).status,
    "running",
    "a turn waiting for an answer is not hung",
  );
  contexts.get(asking.id).event({ type: "question_answer", id: "q" });
  mock.timers.tick(50_000);
  threads.sweep();
  assert.equal(
    threads.get(asking.id).status,
    "running",
    "the silence clock starts again after the answer",
  );
  mock.timers.tick(20_000);
  threads.sweep();
  assert.equal(threads.get(asking.id).status, "idle");
  const saved = JSON.parse(fs.readFileSync(path.join(data, "threads.json"), "utf8"));
  assert.ok(
    saved.every((thread: any) => !thread.workState),
    "runtime liveness is not persisted",
  );
  saved[0].workState = {
    version: 1,
    foreground: ["stale"],
    background: ["stale"],
    backgroundCount: 1,
  };
  fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify(saved));
  const restored = new Threads(() => {});
  assert.deepEqual(
    restored.get(saved[0].id).workState,
    { version: 1, foreground: [], background: [], backgroundCount: 0 },
    "restart never revives persisted tool liveness",
  );
  console.log(
    "PASS stop ends background subagents; plain turns are still interrupted in place; the sweep kills hung background work and hung turns",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(data, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
