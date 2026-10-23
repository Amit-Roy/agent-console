// Offline: fake Pi RPC events for a `subagent` tool call. The parent conversation must get the Agent tool_use,
// task_started, child progress tagged with parent_tool_use_id, and a task_notification at completion.
import assert from "node:assert/strict";
import { piTranslator } from "../server/providers/pi.ts";

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
    message: { role: "assistant", content: [{ type: "text", text: "two files" }] },
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
console.log("pi-subagent ok");
