import assert from "node:assert/strict";
import { apiPricedTurn, pricing } from "../server/api-pricing.ts";

const model = {
  model: "claude-opus-5-5",
  role: "unattributed" as const,
  fresh: 1_000_000,
  cacheRead: 2_000_000,
  cacheWrite: 3_000_000,
  output: 4_000_000,
  reasoning: 3_000_000,
  cost: 999,
};
const original = { accounting: 2, provider: "claude", cost: 111, models: [model] };
const priced = apiPricedTurn(original);
assert.equal(priced.cost, 99.4);
assert.equal(priced.providerCost, 111);
assert.equal(priced.models![0].providerCost, 999);
assert.equal(original.cost, 111);
assert.equal(original.models[0].cost, 999);
assert.deepEqual(apiPricedTurn(priced), priced, "repricing preserves original provider telemetry");
assert.equal(
  apiPricedTurn({ ...original, models: [{ ...model, model: "claude-opus-5-5-20261017" }] }).cost,
  99.4,
);
assert.equal(
  apiPricedTurn({ ...original, models: [{ ...model, model: "claude-sonnet-5-5" }] }).cost,
  49.7,
);
assert.equal(
  apiPricedTurn({ ...original, models: [{ ...model, model: "claude-haiku-5-5" }] }).cost,
  2.495,
);
assert.equal(
  apiPricedTurn({
    accounting: 2,
    provider: "codex",
    models: [
      {
        model: "gpt-6.1-sol",
        role: "agent",
        fresh: 1_000_000,
        cacheRead: 2_000_000,
        output: 3_000_000,
      },
    ],
  }).cost,
  32.2,
);
assert.equal(
  apiPricedTurn({
    accounting: 2,
    provider: "codex",
    models: [
      {
        model: "gpt-5.5-codex",
        role: "agent",
        fresh: 1_000_000,
        cacheRead: 2_000_000,
        output: 3_000_000,
      },
    ],
  }).cost,
  32.2,
);
assert.equal(
  apiPricedTurn({
    accounting: 2,
    provider: "codex",
    models: [
      {
        model: "gpt-6.1",
        role: "agent",
        fresh: 1_000_000,
        cacheRead: 2_000_000,
        output: 3_000_000,
      },
    ],
  }).cost,
  32.2,
);
assert.equal(
  apiPricedTurn({ ...original, models: [{ ...model, model: "gpt-6-astra" }] }).cost,
  249.5,
);
assert.equal(
  apiPricedTurn({ ...original, models: [{ ...model, model: "gpt-6-luna-2026-10-17" }] }).cost,
  2.495,
);
const partial = apiPricedTurn({ ...original, models: [model, { ...model, model: "default" }] });
assert.equal(partial.cost, undefined);
assert.equal(partial.models![0].cost, 99.4);
assert.equal(partial.models![1].cost, undefined);
assert.equal(apiPricedTurn({ ...original, accounting: undefined }).cost, undefined);
assert.equal(apiPricedTurn({ ...original, models: [] }).cost, undefined);
assert.equal(
  apiPricedTurn({ ...original, models: [{ ...model, cacheWrite: undefined }] }).cost,
  undefined,
);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, fresh: -1 }] }).cost, undefined);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, fresh: NaN }] }).cost, undefined);
assert.equal(
  apiPricedTurn({
    ...original,
    models: [{ ...model, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 }],
  }).cost,
  0,
);
assert.equal(pricing.currency, "USD");
const noProviderPrice = apiPricedTurn({
  ...original,
  cost: undefined,
  models: [{ ...model, cost: undefined }],
});
assert.deepEqual(apiPricedTurn(noProviderPrice), noProviderPrice);
assert.equal(pricing.verifiedAt, "2026-10-17");
console.log(
  "PASS public API list prices, disjoint caches, reasoning exclusion, unknown coverage and preserved provider costs",
);
