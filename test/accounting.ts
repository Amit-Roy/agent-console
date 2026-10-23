import assert from "node:assert/strict";
import {
  SessionAccounting,
  codexAccounting,
  claudeTotals,
  piAccounting,
} from "../server/accounting.ts";
const event = (uuid: string, n: number) => ({
  uuid,
  total_cost_usd: n,
  modelUsage: {
    model: {
      inputTokens: n * 10,
      cacheCreationInputTokens: n * 20,
      cacheReadInputTokens: n * 100,
      outputTokens: n * 2,
    },
  },
});
const a = new SessionAccounting();
assert.equal(a.consume("session", event("1", 1)).in, 130);
assert.equal(a.consume("session", event("2", 3)).cost, 2); // resumed native session across processes
assert.equal(a.consume("session", event("2", 3)).duplicate, true);
const restarted = new SessionAccounting();
for (const ev of [event("1", 1), event("2", 3)]) restarted.consume("session", ev); // restart restores durable logs
assert.equal(restarted.consume("session", event("3", 4)).cost, 1);
assert.equal(restarted.consume("session", event("4", 1)).cost, 1); // counter reset
restarted.seedFork("fork", "session");
assert.equal(restarted.consume("fork", event("5", 2)).cost, 1);
assert.equal(restarted.consume("other", event("6", 2)).cost, 2);
assert.equal(claudeTotals({ modelUsage: { model: { inputTokens: 1 } } }).in, undefined);
assert.equal(
  codexAccounting({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }, "codex").in,
  100,
);
assert.equal(codexAccounting(undefined, "codex").cost, undefined);
assert.equal(codexAccounting(undefined, "codex").in, undefined);
assert.equal(
  piAccounting([
    { model: "pi", role: "agent", fresh: 10, cacheRead: 20, cacheWrite: 5, output: 3, cost: 0 },
  ]).in,
  35,
);
assert.equal(piAccounting([]).cost, undefined);
const partial = new SessionAccounting();
partial.consume("s", event("p1", 1));
partial.consume("s", { uuid: "p2", total_cost_usd: 1, modelUsage: {} });
assert.equal(partial.consume("s", event("p3", 2)).in, 130); // omitted model counters never reset history
const reset = new SessionAccounting();
reset.consume("s", event("r1", 2));
assert.equal(
  reset.consume("s", {
    ...event("r2", 1),
    modelUsage: {
      model: {
        inputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
    },
  }).in,
  500,
);
console.log(
  "PASS accounting resume, restart, reset, fork, deduplication, disjoint token categories and missing measurements",
);
