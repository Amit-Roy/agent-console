import assert from "node:assert/strict";
import { ThreadToolAuth } from "../server/thread-tool-auth.ts";

const input = { threadId: "recipient", message: "Hello." };
function event(
  identity: string,
  name = "thread_send",
  params: unknown = input,
  parent: unknown = null,
) {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    message: {
      content: [{ type: "tool_use", id: identity, name, input: params }],
    },
  };
}
function authorization(options = {}) {
  return new ThreadToolAuth({ waitMs: 2, ...options });
}

for (const name of [
  "thread_send",
  "mcp__agent_console__thread_send",
  "agent_console:thread_send",
]) {
  const auth = authorization();
  auth.observe("root", event("call", name));
  assert.equal(await auth.consume("root", "thread_send", input), true, name);
  assert.equal(
    await auth.consume("root", "thread_send", input),
    false,
    "A grant permits only one request.",
  );
  auth.observe("root", event("call", name));
  assert.equal(
    await auth.consume("root", name, input),
    false,
    "A repeated tool event cannot mint another grant.",
  );
}

const child = authorization();
child.observe("root", event("child", "thread_send", input, "parent-call"));
assert.equal(
  await child.consume("root", "thread_send", input),
  false,
  "A child with copied thread credentials has no grant.",
);
child.observe("root", { type: "tool_use", id: "untrusted", name: "thread_send", input });
assert.equal(await child.consume("root", "thread_send", input), false);
assert.equal(await child.consume("missing", "thread_send", input), false);

const binding = authorization();
binding.observe(
  "root",
  event("bound", "thread_send", { ...input, nested: { second: 2, first: 1 } }),
);
assert.equal(await binding.consume("other", "thread_send", input), false);
assert.equal(await binding.consume("root", "unrelated", input), false);
assert.equal(
  await binding.consume("root", "thread_send", { ...input, message: "Changed." }),
  false,
);
assert.equal(
  await binding.consume("root", "thread_send", {
    nested: { first: 1, second: 2 },
    message: "Hello.",
    threadId: "recipient",
  }),
  true,
);

let clock = 0;
const expiry = authorization({ now: () => clock, grantTtlMs: 10 });
expiry.observe("root", event("expired"));
clock = 10;
assert.equal(await expiry.consume("root", "thread_send", input), false);
expiry.observe("root", event("cleared"));
expiry.clear("root");
expiry.observe("root", event("cleared"));
assert.equal(await expiry.consume("root", "thread_send", input), false);
const pendingClear = expiry.consume("root", "thread_send", input);
expiry.clear("root");
assert.equal(await pendingClear, false);

const ordering = authorization({ waitMs: 100 });
const pending = ordering.consume("root", "thread_send", input);
ordering.observe("root", event("late"));
assert.equal(await pending, true, "A request can arrive before its trusted provider event.");
assert.equal(await ordering.consume("root", "thread_send", input), false);

const capacity = authorization({ maxGrants: 1, maxWaiters: 1, maxSeenIds: 3 });
capacity.observe("root", event("first"));
capacity.observe("other", event("overflow"));
assert.equal(await capacity.consume("other", "thread_send", input), false);
assert.equal(await capacity.consume("root", "thread_send", input), true);
capacity.observe("other", event("overflow"));
assert.equal(await capacity.consume("other", "thread_send", input), false);
const waiting = capacity.consume("waiting", "thread_send", input);
assert.equal(await capacity.consume("excess", "thread_send", input), false);
capacity.clear("waiting");
assert.equal(await waiting, false);
capacity.observe("root", event("third"));
assert.equal(await capacity.consume("root", "thread_send", input), true);
capacity.observe("root", event("ledger-full"));
assert.equal(
  await capacity.consume("root", "thread_send", input),
  false,
  "A full replay ledger fails closed.",
);
console.log("Thread tool authorization checks passed.");
