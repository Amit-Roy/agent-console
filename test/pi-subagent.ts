// Offline: fake Pi RPC events for a `subagent` tool call. The parent conversation must get the Agent tool_use,
// task_started, child progress tagged with parent_tool_use_id, and a task_notification at completion.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { piTranslator } from "../server/providers/pi.ts";
import extension from "../server/providers/pi-subagent-extension.mjs";

const events: any[] = [];
const t = piTranslator((e) => events.push(e));
const call = {
  type: "toolCall",
  id: "c1",
  name: "subagent",
  arguments: { description: "Survey repo", prompt: "List files" },
};
const child = (event: any) => ({
  type: "tool_execution_update",
  toolCallId: "c1",
  toolName: "subagent",
  args: call.arguments,
  partialResult: { content: [{ type: "text", text: "" }], details: { event } },
});
t({ type: "agent_start" });
t({ type: "message_end", message: { role: "assistant", content: [call], stopReason: "toolUse" } });
t({ type: "tool_execution_start", toolCallId: "c1", toolName: "subagent", args: call.arguments });
t(
  child({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "s1", name: "ls", arguments: { path: "." } }],
    },
  }),
);
t(
  child({
    type: "tool_execution_end",
    toolCallId: "s1",
    result: { content: [{ type: "text", text: "a b" }] },
  }),
);
t(
  child({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "two files" }],
      model: "child-model",
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.01 } },
    },
  }),
);
t({
  type: "tool_execution_end",
  toolCallId: "c1",
  toolName: "subagent",
  result: { content: [{ type: "text", text: "two files" }] },
  isError: false,
});
t({ type: "agent_settled" });

const use = events.find((e) => e.type === "assistant" && e.message.content[0].name === "Agent");
assert.ok(use, "Agent tool_use");
assert.equal(use.message.content[0].id, "c1");
const start = events.find((e) => e.subtype === "task_started");
assert.deepEqual(
  [start.tool_use_id, start.task_id, start.description],
  ["c1", "c1", "Survey repo"],
);
const tagged = events.filter((e) => e.parent_tool_use_id === "c1");
assert.equal(tagged.length, 3, "child progress tagged");
assert.equal(tagged[0].message.content[0].name, "Glob");
assert.equal(tagged[1].message.content[0].tool_use_id, "s1");
assert.equal(tagged[2].message.content[0].text, "two files");
const done = events.find((e) => e.subtype === "task_notification");
assert.deepEqual([done.tool_use_id, done.status, done.summary], ["c1", "completed", "two files"]);
assert.ok(
  events.some(
    (e) => e.type === "user" && !e.parent_tool_use_id && e.message.content[0].tool_use_id === "c1",
  ),
  "parent tool_result",
);
const result = events.find((e) => e.type === "result");
assert.equal(result.total_cost_usd, 0.01);
assert.equal(result.usageModels[0].role, "subagent");
assert.equal(result.usageModels[0].model, "child-model");
assert.equal(result.usageModels[0].fresh, 100);
assert.equal(
  events.some((e) => e.type === "context_usage"),
  false,
  "child context does not inflate parent context",
);
console.log("pi-subagent: start, progress, result and child usage pass");

// Exercise the actual extension and child process, rather than only its translated fixtures.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-"));
const originalEnv = { ...process.env };
try {
  fs.writeFileSync(
    path.join(scratch, "pi"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const out = ev => process.stdout.write(JSON.stringify(ev) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  if (r.type !== "prompt") return;
  fs.writeFileSync(${JSON.stringify(scratch)} + "/" + r.message + ".json", JSON.stringify({ args: process.argv.slice(2), pid: process.pid }));
  if (r.message === "hang" || r.message === "shutdown") return;
  if (r.message === "reject") { out({ type: "response", command: "prompt", success: false, error: "bad model" }); return; }
  if (r.message === "crash") { console.error("child crashed"); process.exit(3); }
  if (r.message === "retry") out({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "transient" } });
  out({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "résultat 😀" }] } });
  out({ type: "agent_settled" });
});
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${scratch}:${process.env.PATH}`;
  process.env.AGENT_CONSOLE_PI_INSTRUCTIONS = "Shared instructions fixture";
  let tool: any;
  let shutdown: () => Promise<void>;
  extension({
    on: (_event: string, handler: () => Promise<void>) => {
      shutdown = handler;
    },
    registerTool: (t: any) => {
      tool = t;
    },
    getThinkingLevel: () => "low",
  });
  assert.equal(tool.executionMode, "parallel", "independent delegations can run concurrently");
  const ctx = {
    cwd: scratch,
    model: { provider: "nvidia", id: "parent/model" },
    modelRegistry: { getAvailable: () => [{ provider: "deepseek", id: "deepseek-chat" }] },
  };
  const updates: any[] = [];
  const run = (prompt: string, extra = {}, signal?: AbortSignal) =>
    tool.execute(
      prompt,
      { description: "Test delegation", prompt, ...extra },
      signal,
      (u: any) => updates.push(u),
      ctx,
    );
  const results = await Promise.all([run("one"), run("two", { model: "deepseek/deepseek-chat" })]);
  assert.equal(results[0].content[0].text, "résultat 😀");
  assert.equal(updates.length, 2, "both children stream progress");
  const args = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(scratch, `${name}.json`), "utf8")).args;
  const option = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
  assert.equal(option(args("one"), "--model"), "nvidia/parent/model");
  assert.equal(option(args("two"), "--model"), "deepseek/deepseek-chat");
  assert.equal(option(args("one"), "--thinking"), "low");
  assert.equal(option(args("one"), "--append-system-prompt"), "Shared instructions fixture");
  assert.ok(args("one").includes("--no-session"));
  assert.ok(
    !args("one").some((a: string) => a.includes("subagent-extension")),
    "children cannot recursively delegate",
  );
  process.env.AGENT_CONSOLE_PI_MODE = "plan";
  await run("plan");
  assert.equal(option(args("plan"), "--tools"), "read,grep,find,ls");
  delete process.env.AGENT_CONSOLE_PI_MODE;
  await assert.rejects(run("unknown", { model: "unknown/model" }), /not available/);
  assert.equal(
    fs.existsSync(path.join(scratch, "unknown.json")),
    false,
    "invalid model never spawns",
  );
  await assert.rejects(run("reject"), /bad model/);
  await assert.rejects(run("crash"), /child crashed/);
  assert.equal(
    (await run("retry")).content[0].text,
    "résultat 😀",
    "successful retry clears earlier error",
  );
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(run("never-start", {}, alreadyAborted.signal), /aborted/);
  assert.equal(fs.existsSync(path.join(scratch, "never-start.json")), false);
  const controller = new AbortController();
  const aborted = run("hang", {}, controller.signal);
  const rejection = assert.rejects(aborted, /aborted/);
  const ready = path.join(scratch, "hang.json");
  if (!fs.existsSync(ready)) {
    await new Promise<void>((resolve, reject) => {
      const watcher = fs.watch(scratch, () => {
        if (fs.existsSync(ready)) {
          clearTimeout(timer);
          watcher.close();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        watcher.close();
        reject(Error("Child never started"));
      }, 3000);
      if (fs.existsSync(ready)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
  }
  const pid = JSON.parse(fs.readFileSync(ready, "utf8")).pid;
  controller.abort();
  await rejection;
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "cancelled child exited");
  const shutdownRun = run("shutdown");
  const shutdownRejection = assert.rejects(shutdownRun, /before completion/);
  await shutdown!();
  await shutdownRejection;
  console.log(
    "pi-subagent extension: parallel children, model choice, Plan limits, instructions, retries and cancellation pass",
  );
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(scratch, { recursive: true, force: true });
}
