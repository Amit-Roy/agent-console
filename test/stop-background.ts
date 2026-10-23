// Stop must end background subagents, which an in-place interrupt would leave running. The sweep ends hung ones and hung turns.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-stop-bg-"));
Object.assign(process.env, { AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"), AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"), AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_LABELS: "0", AGENT_CONSOLE_BACKGROUND_STALE_MS: "60000", AGENT_CONSOLE_TURN_STALE_MS: "60000" });
const { Threads } = await import(pathToFileURL(path.join(root, "server/threads.ts")).href);
const { PROVIDERS } = await import(pathToFileURL(path.join(root, "server/providers/index.ts")).href);
const contexts = new Map<string, any>();
const calls: string[] = [];
PROVIDERS.set("stop-fixture", {
  id: "stop-fixture", label: "Stop fixture", modes: ["plan"], defaultMode: "plan", models: () => ["fixture"], defaultModel: () => "fixture", status: () => ({ ok: true }),
  start(t: any, ctx: any) {
    let alive = true;
    contexts.set(t.id, ctx);
    return {
      get alive() { return alive; }, send() {},
      interrupt() { calls.push("interrupt"); },
      abort() { alive = false; calls.push("abort"); ctx.exited({ code: null, signal: "SIGINT", stderr: "", aborted: true }); },
      kill() { alive = false; calls.push("kill"); ctx.exited({ code: null, signal: "SIGTERM", stderr: "", aborted: true }); },
    };
  },
});
mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
const threads = new Threads(() => {});
try {
  const plain = threads.create({ provider: "stop-fixture", cwd: data, title: "plain" });
  threads.send(plain.id, "go");
  threads.abort(plain.id);
  assert.deepEqual(calls, ["interrupt"], "a turn without subagents is still interrupted in place");

  calls.length = 0;
  const t = threads.create({ provider: "stop-fixture", cwd: data, title: "bg" });
  threads.send(t.id, "go");
  contexts.get(t.id).event({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a" }] });
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
  contexts.get(hung.id).event({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w" }] });
  contexts.get(hung.id).event({ type: "result", subtype: "success" });
  mock.timers.tick(50_000);
  contexts.get(hung.id).event({ type: "system", subtype: "task_updated" }); // progress noise proves the task is alive
  mock.timers.tick(50_000); threads.sweep();
  assert.equal(threads.get(hung.id).background, 1, "a task that reported progress recently is kept");
  mock.timers.tick(20_000); threads.sweep();
  assert.equal(threads.get(hung.id).background, undefined, "silent background work past the limit is killed");
  assert.equal(threads.get(hung.id).status, "idle");

  // hung turn: running, but the process has been silent for longer than the limit
  const stuck = threads.create({ provider: "stop-fixture", cwd: data, title: "stuck" });
  threads.send(stuck.id, "go");
  mock.timers.tick(50_000);
  contexts.get(stuck.id).event({ type: "stream_event", event: { type: "ping" } });
  mock.timers.tick(50_000); threads.sweep();
  assert.equal(threads.get(stuck.id).status, "running", "a turn that streamed recently is kept");
  calls.length = 0;
  mock.timers.tick(20_000); threads.sweep();
  assert.equal(threads.get(stuck.id).status, "idle", "a turn silent past the limit is ended");
  assert.deepEqual(calls, ["kill"], "its hung agent is killed");

  // a blocking question waits on the user, however long that takes
  const asking = threads.create({ provider: "stop-fixture", cwd: data, title: "asking" });
  threads.send(asking.id, "go");
  contexts.get(asking.id).event({ type: "question", id: "q", questions: [{ id: "a", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] });
  for (let i = 0; i < 5; i++) { mock.timers.tick(50_000); threads.sweep(); }
  assert.equal(threads.get(asking.id).status, "running", "a turn waiting for an answer is not hung");
  contexts.get(asking.id).event({ type: "question_answer", id: "q" });
  mock.timers.tick(50_000); threads.sweep();
  assert.equal(threads.get(asking.id).status, "running", "the silence clock starts again after the answer");
  mock.timers.tick(20_000); threads.sweep();
  assert.equal(threads.get(asking.id).status, "idle");
  console.log("PASS stop ends background subagents; plain turns are still interrupted in place; the sweep kills hung background work and hung turns");
} catch (error) { console.error(error); process.exitCode = 1; }
finally { fs.rmSync(data, { recursive: true, force: true }); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
