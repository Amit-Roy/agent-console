// Offline regression (issue #16): output of a Codex subagent must reach its parent card as canonical events tagged with parent_tool_use_id.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-forward-"));
const previous = { ...process.env };
Object.assign(process.env, { PATH: `${scratch}${path.delimiter}${previous.PATH}`, CODEX_HOME: path.join(scratch, "home"), AGENT_CONSOLE_ENV_FILES: path.join(scratch, "absent-env"), AGENT_CONSOLE_RUN: path.join(scratch, "run"), AGENT_CONSOLE_HEADROOM: "0" });
fs.mkdirSync(process.env.CODEX_HOME!);
fs.writeFileSync(path.join(scratch, "codex"), `#!${process.execPath}
let buffer = '', thread;
const send = value => console.log(JSON.stringify(value));
const note = (method, params, id = thread) => send({method, params: {threadId: id, ...params}});
const later = (ms, fn) => setTimeout(fn, ms);
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
      later(30, () => note('turn/started', {turn: {id: 'k1'}}, 'kid'));
      later(40, () => note('item/completed', {item: {id: 'k-msg', type: 'agentMessage', text: 'Looking at the repo.'}}, 'kid'));
      later(50, () => note('item/started', {item: {id: 'k-cmd', type: 'commandExecution', command: 'ls -la', cwd: '/tmp'}}, 'kid'));
      later(60, () => note('item/completed', {item: {id: 'k-cmd', type: 'commandExecution', command: 'ls -la', cwd: '/tmp', aggregatedOutput: 'total 8', exitCode: 0, status: 'completed'}}, 'kid'));
      later(70, () => note('turn/completed', {turn: {id: 'k1', status: 'completed'}}, 'kid'));
      later(150, () => note('turn/completed', {turn: {id: 't1', status: 'completed'}}));
    }
  }
});
`, { mode: 0o700 });

const { codex } = await import("../server/providers/codex.ts");
const collected: any[] = [];
let exited!: () => void;
const exit = new Promise<void>(resolve => { exited = resolve; });
const agent = codex.start({ id: "fixture", cwd: scratch, mode: "bypassPermissions", model: "default" }, { event: (e: any) => collected.push(e), commands() {}, exited } as any);
try {
  agent.send("go");
  const deadline = Date.now() + 5000;
  while (!collected.some(e => e.type === "result") && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  const child = collected.filter(e => e.parent_tool_use_id === "spawn");
  const blocks = child.flatMap(e => e.message?.content ?? []);
  assert.ok(child.every(e => e.type === "assistant" || e.type === "user"), "child events use canonical assistant/user types");
  assert.ok(blocks.some(b => b.type === "text" && b.text === "Looking at the repo."), "child message is tagged with the parent call");
  assert.ok(blocks.some(b => b.type === "tool_use" && b.name === "Bash" && b.input.command === "ls -la"), "child tool call is tagged");
  assert.ok(blocks.some(b => b.type === "tool_result" && b.content === "total 8"), "child tool result is tagged");
  assert.equal(collected.filter(e => e.type === "result").length, 1, "only the parent turn ends the run");
  assert.equal(collected.filter(e => e.type === "stream_event").length, 1, "child turn start does not open a second parent turn");
  const resultAt = collected.findIndex(e => e.type === "result");
  assert.ok(collected.lastIndexOf(child.at(-1)) < resultAt, "child output arrives before the parent turn completes");
  assert.ok(!collected.some(e => !e.parent_tool_use_id && e.type === "assistant" && e.message?.content?.some((b: any) => b.type === "text" && b.text === "Looking at the repo.")), "child text never lands untagged in the parent thread");
  console.log("PASS codex subagent messages and tool activity are forwarded under the parent card without completing the parent turn");
} finally { agent.kill(); await Promise.race([exit, new Promise(r => setTimeout(r, 2000))]); fs.rmSync(scratch, { recursive: true, force: true }); }
