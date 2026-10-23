import assert from "node:assert/strict";
import { codexTranslator } from "../server/providers/codex.ts";

const events: any[] = [];
const feed = codexTranslator((event) => events.push(event));
const item = {
  id: "call_3429281a972b41e490938923a167ed26",
  type: "agent_message",
  text: "Which part should we polish next?\n- Looks good as is\n- Make it more compact",
  phase: "final_answer",
  delivery: "async",
  questions: [
    {
      title: "Which part should we polish next?",
      options: ["Looks good as is", "Make it more compact"],
    },
  ],
};
feed({ type: "turn.started" });
feed({ type: "item.started", item });
assert.equal(
  events.filter((e) => e.type === "question").length,
  0,
  "wait for completed structured metadata",
);
feed({ type: "item.completed", item });
const question = events.find((e) => e.type === "question");
assert.equal(question.async, true);
assert.equal(question.id, `codex-async-${item.id}`);
assert.deepEqual(question.questions, [
  {
    id: "0",
    question: item.questions[0].title,
    options: item.questions[0].options.map((label) => ({ label })),
    allowOther: true,
  },
]);
assert.equal(
  events.some((e) => e.type === "assistant"),
  false,
  "structured questions replace fallback plaintext",
);
feed({ type: "item.completed", item });
feed({ type: "turn.completed" });
assert.equal(
  events.filter((e) => e.type === "question").length,
  1,
  "duplicate completions cannot create duplicate cards",
);
feed({ type: "turn.started" });
feed({
  type: "item.completed",
  item: {
    ...item,
    id: "free-text",
    questions: [{ title: "What should I call you?", options: null }],
  },
});
assert.deepEqual(events.filter((e) => e.type === "question").at(-1).questions, [
  { id: "0", question: "What should I call you?", options: [], allowOther: true },
]);
feed({
  type: "item.completed",
  item: { type: "agent_message", id: "ordinary", text: "Plain text\n- A\n- B", questions: null },
});
assert.equal(
  events.at(-1).message.content[0].text,
  "Plain text\n- A\n- B",
  "ordinary lists never become fabricated forms",
);
feed({
  type: "item.completed",
  item: { type: "agent_message", text: "Fallback", questions: [{ title: "" }] },
});
assert.equal(events.at(-1).message.content[0].text, "Fallback");
console.log(
  "PASS Codex async question metadata: real rollout shape, choices/free text, no duplicate plaintext/cards, ordinary text preserved",
);
