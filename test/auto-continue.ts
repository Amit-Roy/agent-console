import assert from "node:assert/strict";
import { AUTO_CONTINUE_PROMPT, autoContinueEnabled } from "../server/auto-continue.ts";

assert.match(
  AUTO_CONTINUE_PROMPT,
  /^Continue if you are waiting on an action the user already approved/,
);

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
