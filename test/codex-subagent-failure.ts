// Offline regression: a Codex subagent that fails after the parent turn ended must stop counting as background work.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-subagent-"));
const previous = { ...process.env };
Object.assign(process.env, {
  PATH: `${scratch}${path.delimiter}${previous.PATH}`,
  CODEX_HOME: path.join(scratch, "home"),
  AGENT_CONSOLE_ENV_FILES: path.join(scratch, "absent-env"),
  AGENT_CONSOLE_RUN: path.join(scratch, "run"),
  AGENT_CONSOLE_HEADROOM: "0",
});
fs.mkdirSync(process.env.CODEX_HOME!);
fs.writeFileSync(
  path.join(scratch, "codex"),
  `#!${process.execPath}
let buffer = '', thread;
const send = value => console.log(JSON.stringify(value));
const note = (method, params, id = thread) => send({method, params: {threadId: id, ...params}});
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === 'initialize') send({id: message.id, result: {}});
    if (message.method === 'thread/start' || message.method === 'thread/resume') { thread = 'parent'; send({id: message.id, result: {thread: {id: thread}}}); }
    if (message.method === 'turn/start') {
      send({id: message.id, result: {turn: {id: 't1'}}});
      note('turn/started', {turn: {id: 't1'}});
      note('item/completed', {item: {id: 'spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'kid', agentPath: 'worker'}});
      note('turn/completed', {turn: {id: 't1', status: 'completed'}});
      setTimeout(() => note('item/started', {item: {id: 'k-msg', type: 'agentMessage'}}, 'kid'), 50);
      setTimeout(() => note('turn/completed', {turn: {id: 'k1', status: 'failed', error: {message: 'usage limit reached'}}}, 'kid'), 100);
    }
  }
});
`,
  { mode: 0o700 },
);

const { codex } = await import("../server/providers/codex.ts");
const collected: any[] = [];
let exited!: () => void;
const exit = new Promise<void>((resolve) => {
  exited = resolve;
});
const agent = codex.start(
  { id: "fixture", cwd: scratch, mode: "bypassPermissions", model: "default" },
  { event: (e: any) => collected.push(e), commands() {}, exited } as any,
);
try {
  agent.send("go");
  const deadline = Date.now() + 5000;
  while (!collected.some((e) => e.type === "subagent_wake") && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  const counts = collected
    .filter((e) => e.subtype === "background_tasks_changed")
    .map((e) => e.tasks.length);
  assert.deepEqual(
    counts,
    [1, 0],
    "background task count must return to 0 when the subagent fails",
  );
  assert.ok(
    collected.some(
      (e) =>
        e.subtype === "task_notification" && e.status === "failed" && /usage limit/.test(e.summary),
    ),
  );
  assert.ok(
    /failed: usage limit reached/.test(collected.find((e) => e.type === "subagent_wake").text),
  );
  assert.deepEqual(
    collected.filter((e) => e.subtype === "task_updated").map((e) => e.task_id),
    ["kid"],
    "child progress is a throttled proof of life",
  );
  console.log(
    "PASS codex subagent failure clears background count and wakes the parent; child progress is reported",
  );
} finally {
  agent.kill();
  await Promise.race([exit, new Promise((r) => setTimeout(r, 2000))]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
