import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeControl } from "../server/providers/claude.ts";
import { codexQuestion } from "../server/providers/codex-app.ts";
import { codex } from "../server/providers/codex.ts";
import { piQuestions } from "../server/providers/pi-questions.ts";
import piExtension, { QUESTION_DIALOG } from "../server/providers/pi-questions-extension.mjs";

const question = {
  id: "scope",
  header: "Scope",
  question: "How much detail?",
  options: [
    { label: "Quick", description: "Short answer" },
    { label: "Full", description: "Include details" },
  ],
};
const events: any[] = [],
  writes: any[] = [];
const control = claudeControl(
  (m) => writes.push(m),
  (e) => events.push(e),
  "acceptEdits",
);
const askClaude = (id: string) =>
  control.handle({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [question] },
    },
  });
askClaude("claude-1");
assert.equal(events.at(-1).questions[0].allowOther, true);
assert.equal(control.answer("claude-1", { answers: { "0": ["Quick", "Custom"] } }), false);
assert.deepEqual(writes.at(-1).response.response.updatedInput.answers, {
  "How much detail?": "Quick, Custom",
});
assert.throws(() => control.answer("claude-1", { answers: {} }), /no longer/);
askClaude("claude-note");
assert.equal(control.answer("claude-note", { answers: {}, note: "Follow my latest brief" }), true);
assert.match(writes.at(-1).response.response.message, /Follow my latest brief/);
askClaude("claude-skip");
control.answer("claude-skip", { answers: {}, skip: true });
assert.equal(writes.at(-1).response.response.behavior, "deny");
askClaude("claude-cancel");
control.handle({ type: "control_cancel_request", request_id: "claude-cancel" });
assert.equal(events.at(-1).cancelled, true);
askClaude("claude-stop");
control.cancelAll();
assert.equal(control.pending.size, 0);
control.handle({
  type: "control_request",
  request_id: "permission",
  request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm file" } },
});
assert.equal(writes.at(-1).response.response.behavior, "deny");

const native = codexQuestion("item/tool/requestUserInput", {
  questions: [question, { id: "secret", question: "Private?", options: null, isSecret: true }],
})!;
assert.equal(native.questions[1].secret, true);
assert.equal(native.questions[1].allowOther, true);
assert.deepEqual(native.reply({ answers: { scope: ["Full"] } }), {
  answers: { scope: { answers: ["Full"] } },
});
assert.deepEqual(native.reply({ answers: {}, skip: true }), { answers: {} });
assert.deepEqual(native.reply({ answers: {}, note: "Use the brief" }), {
  answers: { scope: { answers: ["Use the brief"] } },
});
assert.equal(native.consumesNote, true);
assert.equal(codexQuestion("item/commandExecution/requestApproval", {}), undefined);
const form = codexQuestion("mcpServer/elicitation/request", {
  mode: "form",
  serverName: "fixture",
  message: "Preferences",
  requestedSchema: {
    properties: {
      ready: { type: "boolean" },
      count: { type: "integer" },
      tags: { type: "array", items: { enum: ["a", "b"] } },
    },
    required: ["ready"],
  },
})!;
assert.deepEqual(
  form.reply({ answers: { ready: ["No"], count: ["2"], tags: ["a", "b"] } }).content,
  { ready: false, count: 2, tags: ["a", "b"] },
);
assert.equal(form.reply({ answers: {}, note: "Use the brief" }).action, "decline");
assert.equal(form.consumesNote, false);
assert.throws(
  () => form.reply({ answers: { ready: ["Yes"], count: ["not a number"] } }),
  /valid integer/,
);
assert.throws(() => form.reply({ answers: { count: ["2"] } }), /Please answer ready/);
assert.equal(
  codexQuestion("mcpServer/elicitation/request", {
    mode: "form",
    requestedSchema: { properties: { nested: { type: "object" } } },
  }),
  undefined,
);
assert.ok(
  codexQuestion("mcpServer/elicitation/request", {
    mode: "openai/form",
    requestedSchema: { properties: { name: { type: "string" } } },
  }),
);

events.length = 0;
writes.length = 0;
const pi = piQuestions(
  (m) => writes.push(m),
  (e) => events.push(e),
);
const dialog = (id: string, method = "input", extra: any = {}) =>
  pi.handle({ type: "extension_ui_request", id, method, title: "Pick a scope", ...extra });
dialog("input");
assert.equal(events.at(-1).questions[0].allowOther, true);
assert.equal(pi.answer("pi-input", { answers: {}, note: "My brief" }), true);
assert.deepEqual(writes.at(-1), { type: "extension_ui_response", id: "input", value: "My brief" });
dialog("select", "select", { options: ["Quick", "Full"] });
assert.deepEqual(events.at(-1).questions[0].options, [{ label: "Quick" }, { label: "Full" }]);
pi.answer("pi-select", { answers: { answer: ["Full"] } });
assert.equal(writes.at(-1).value, "Full");
dialog("confirm", "confirm", { message: "Proceed?" });
assert.equal(pi.answer("pi-confirm", { answers: {}, note: "Wait for my brief" }), false);
assert.equal(writes.at(-1).cancelled, true);
dialog("no", "confirm");
pi.answer("pi-no", { answers: { answer: ["No"] } });
assert.equal(writes.at(-1).confirmed, false);
dialog("skip", "editor");
pi.answer("pi-skip", { answers: {}, skip: true });
assert.equal(writes.at(-1).cancelled, true);
let tool: any;
piExtension({
  registerTool(t: any) {
    tool = t;
  },
});
assert.equal(tool.name, "ask_user");
const toolResult = tool.execute(
  "tool-1",
  { questions: [question] },
  new AbortController().signal,
  () => {},
  {
    hasUI: true,
    ui: {
      input: async (title: string, placeholder: string) => {
        dialog("structured", "input", { title, placeholder });
        assert.equal(events.at(-1).questions[0].question, question.question);
        pi.answer("pi-structured", { answers: { scope: ["Full"] } });
        return writes.at(-1).value;
      },
    },
  },
);
assert.deepEqual(JSON.parse((await toolResult).content[0].text), { answers: { scope: ["Full"] } });
dialog("tool-cancel", "input", {
  title: QUESTION_DIALOG,
  placeholder: JSON.stringify({
    agentConsoleQuestions: 1,
    toolCallId: "tool-2",
    questions: [question],
  }),
});
pi.handle({ type: "tool_execution_end", toolCallId: "tool-2" });
assert.equal(events.at(-1).cancelled, true);
assert.throws(() => pi.answer("pi-tool-cancel", { answers: {} }), /no longer/);
dialog("timeout", "select", { options: ["Quick"], timeout: 5 });
await new Promise((r) => setTimeout(r, 15));
assert.equal(events.at(-1).id, "pi-timeout");
assert.equal(events.at(-1).cancelled, true);
dialog("stop");
pi.cancelAll();
assert.equal(events.at(-1).cancelled, true);

// Exercise the persistent Codex wire protocol with a child process. No model or
// network access: the fake CLI asks, accepts replies, and cancels stale asks.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-provider-questions-"));
const oldPath = process.env.PATH;
const agents: any[] = [];
try {
  fs.writeFileSync(
    path.join(dir, "codex"),
    `#!${process.execPath}
let buffer='',thread='fixture';const send=x=>console.log(JSON.stringify(x));
process.stdin.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:thread}}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({method:'turn/started',params:{threadId:thread,turn:{id:'turn'}}});send({id:'ask',method:'item/tool/requestUserInput',params:{threadId:thread,questions:[${JSON.stringify(question)}]}});if(m.params.input[0].text==='cancel')setTimeout(()=>send({method:'serverRequest/resolved',params:{threadId:thread,requestId:'ask'}}),15);}
if(m.id==='ask'&&m.result){send({method:'item/completed',params:{threadId:thread,item:{type:'agentMessage',id:'reply',text:JSON.stringify(m.result)}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn',status:'completed'}}});}
}});
`,
    { mode: 0o700 },
  );
  process.env.PATH = dir + path.delimiter + oldPath;
  const make = () => {
    const log: any[] = [];
    const agent = codex.start(
      { id: "provider-fixture", cwd: dir, mode: "bypassPermissions", model: "default" },
      { event: (e) => log.push(e), commands() {}, exited() {} },
    );
    agents.push(agent);
    const wait = async (type: string) => {
      for (let i = 0; i < 200; i++) {
        const row = log.find((e) => e.type === type);
        if (row) return row;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("Timed out waiting for " + type);
    };
    return { agent, log, wait };
  };
  const run = make();
  run.agent.send("question");
  const ask = await run.wait("question");
  assert.equal(run.agent.answer!(ask.id, { answers: {}, note: "Use my brief" }), true);
  const answer = await run.wait("assistant");
  assert.deepEqual(JSON.parse(answer.message.content[0].text), {
    answers: { scope: { answers: ["Use my brief"] } },
  });
  await run.wait("result");
  assert.throws(() => run.agent.answer!(ask.id, { answers: {} }), /no longer/);
  const cancelled = make();
  cancelled.agent.send("cancel");
  const pending = await cancelled.wait("question");
  assert.notEqual(
    pending.id,
    ask.id,
    "new app-server instances must not reuse canonical question ids even when the native RPC id is identical",
  );
  await cancelled.wait("question_answer");
  assert.throws(() => cancelled.agent.answer!(pending.id, { answers: {} }), /no longer/);
  const stopped = make();
  stopped.agent.send("question");
  await stopped.wait("question");
  stopped.agent.abort();
  assert.equal(stopped.log.at(-1).cancelled, true);
} finally {
  for (const agent of agents) agent.kill();
  process.env.PATH = oldPath;
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  "PASS provider questions: Claude control replies/permissions/cancel, Codex native input and MCP forms, persistent RPC answer/cancel/abort, Pi ask_user extension/native dialogs/timeout/cancel (no inference)",
);
