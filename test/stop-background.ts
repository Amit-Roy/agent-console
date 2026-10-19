// Stop must end background subagents, which an in-place interrupt would leave running.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-stop-bg-"));
Object.assign(process.env, { AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"), AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"), AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_LABELS: "0" });
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
      kill() { alive = false; ctx.exited({ code: null, signal: "SIGTERM", stderr: "", aborted: true }); },
    };
  },
});
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
  console.log("PASS stop ends background subagents; plain turns are still interrupted in place");
} finally { fs.rmSync(data, { recursive: true, force: true }); process.exit(0); }
