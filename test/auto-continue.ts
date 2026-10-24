import assert from "node:assert/strict";
import {
  AUTO_CONTINUE_PROMPT,
  announcesNextStep,
  autoContinueEnabled,
} from "../server/auto-continue.ts";

const positives = [
  "Next: I implement fixes 1–5 in a worktree, then rerun the A/B.",
  "**Next:** I will implement the fixes.",
  "I'll now run the tests.",
  "Let me fix the lint next.",
  "I will push the branch after the check.",
  "I'm going to rerun the migration.",
  "I am going to read the config file.",
  "Now I update the parser.",
  "Next I rerun the suite.",
  "Then I commit the fix.",
  "Next step: I'll patch the handler.",
  "Done with the refactor.\nLet me run the tests now.",
  "Next steps: I will wire the flag.",
  "Let me check the server output.",
];

const negatives = [
  "Next: run deploy.",
  "Want me to merge?",
  "Should I continue?",
  "Done. Tests pass.",
  "```\nI'll run the tests now.\n```",
  "Shall I open the PR?",
  "Would you like me to retry?",
  "Let me know if you want the logs.",
  "I'll wait for you to approve the merge.",
  "Next: confirm the plan with the team.",
  "Tests pass. Your call on the rollout.",
  "I'll run the tests if you want.",
  "Next: deploy the app to the VPS.",
  "",
];

for (const text of positives) {
  assert.equal(announcesNextStep(text), true, `expected positive: ${text}`);
}
for (const text of negatives) {
  assert.equal(announcesNextStep(text), false, `expected negative: ${text}`);
}

assert.match(AUTO_CONTINUE_PROMPT, /^Continue: do what you said you would do next/);

const previous = process.env.AGENT_CONSOLE_AUTO_CONTINUE;
try {
  delete process.env.AGENT_CONSOLE_AUTO_CONTINUE;
  assert.equal(autoContinueEnabled(), true);
  process.env.AGENT_CONSOLE_AUTO_CONTINUE = "1";
  assert.equal(autoContinueEnabled(), true);
  process.env.AGENT_CONSOLE_AUTO_CONTINUE = "0";
  assert.equal(autoContinueEnabled(), false);
} finally {
  if (previous === undefined) delete process.env.AGENT_CONSOLE_AUTO_CONTINUE;
  else process.env.AGENT_CONSOLE_AUTO_CONTINUE = previous;
}
