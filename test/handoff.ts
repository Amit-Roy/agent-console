import assert from "node:assert/strict";
import { recentPreamble, replayPreamble } from "../server/export.ts";

const events: any[] = [
  { type: "user_input", text: "Keep the original constraint: local processing only." },
];
for (let i = 0; i < 20; i++) {
  events.push({ type: "user_input", text: `request-${i}: ` + "context ".repeat(500) });
  events.push({
    type: "assistant",
    message: { content: [{ type: "text", text: `answer-${i}: ` + "result ".repeat(500) }] },
  });
}
events.push({ type: "user_input", auto: "brain", text: "hidden-paid-followup" });
events.push({
  type: "assistant",
  parent_tool_use_id: "worker",
  message: { content: [{ type: "text", text: "hidden-worker-context" }] },
});
events.push({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "bash", input: { command: "hidden-tool-input" } }],
  },
});
const handoff = recentPreamble(events);
assert.ok(handoff.length <= 6000);
assert.ok(handoff.length < replayPreamble(events).length);
assert.match(handoff, /local processing only/);
assert.match(handoff, /request-19/);
assert.match(handoff, /answer-19/);
assert.doesNotMatch(handoff, /request-1:|hidden-paid|hidden-worker|hidden-tool/);
assert.match(handoff, /Earlier constraints may be omitted/);
assert.equal(recentPreamble(events, 0), "");
assert.ok(recentPreamble(events, 500).length <= 500);
console.log(
  "PASS local handoff bounds, original request, recent messages and tool/subagent exclusions",
);
