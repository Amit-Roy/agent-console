import assert from "node:assert/strict";
import { apiPricedTurn, pricing, calculateDeepSeekProjection } from "../server/api-pricing.ts";

const model = { model: "claude-opus-5-5", role: "unattributed" as const, fresh: 1_000_000, cacheRead: 2_000_000, cacheWrite: 3_000_000, output: 4_000_000, reasoning: 3_000_000, cost: 999 };
const original = { accounting: 2, provider: "claude", cost: 111, models: [model] };
const priced = apiPricedTurn(original);
assert.equal(priced.cost, 99.4);
assert.equal(priced.providerCost, 111);
assert.equal(priced.models![0].providerCost, 999);
assert.equal(original.cost, 111);
assert.equal(original.models[0].cost, 999);
assert.deepEqual(apiPricedTurn(priced), priced, "repricing preserves original provider telemetry");
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, model: "claude-opus-5-5-20261017" }] }).cost, 99.4);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, model: "claude-sonnet-5-5" }] }).cost, 49.7);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, model: "claude-haiku-5-5" }] }).cost, 2.495);
assert.equal(apiPricedTurn({ accounting: 2, provider: "codex", models: [{ model: "gpt-6.1-sol", role: "agent", fresh: 1_000_000, cacheRead: 2_000_000, output: 3_000_000 }] }).cost, 32.2);
assert.equal(apiPricedTurn({ accounting: 2, provider: "codex", models: [{ model: "gpt-5.5-codex", role: "agent", fresh: 1_000_000, cacheRead: 2_000_000, output: 3_000_000 }] }).cost, 32.2);
assert.equal(apiPricedTurn({ accounting: 2, provider: "codex", models: [{ model: "gpt-6.1", role: "agent", fresh: 1_000_000, cacheRead: 2_000_000, output: 3_000_000 }] }).cost, 32.2);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, model: "gpt-6-astra" }] }).cost, 249.5);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, model: "gpt-6-luna-2026-10-17" }] }).cost, 2.495);
const partial = apiPricedTurn({ ...original, models: [model, { ...model, model: "default" }] });
assert.equal(partial.cost, undefined);
assert.equal(partial.models![0].cost, 99.4);
assert.equal(partial.models![1].cost, undefined);
assert.equal(apiPricedTurn({ ...original, accounting: undefined }).cost, undefined);
assert.equal(apiPricedTurn({ ...original, models: [] }).cost, undefined);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, cacheWrite: undefined }] }).cost, undefined);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, fresh: -1 }] }).cost, undefined);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, fresh: NaN }] }).cost, undefined);
assert.equal(apiPricedTurn({ ...original, models: [{ ...model, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 }] }).cost, 0);
assert.equal(pricing.currency, "USD");
const noProviderPrice = apiPricedTurn({ ...original, cost: undefined, models: [{ ...model, cost: undefined }] });
assert.deepEqual(apiPricedTurn(noProviderPrice), noProviderPrice);
assert.equal(pricing.verifiedAt, "2026-10-17");

// DeepSeek projection tests
const flash = calculateDeepSeekProjection(3_000_000, 200_000, 1_800_000, 7, "deepseek-flash");
assert.equal(flash.model, "deepseek-flash");
assert.equal(flash.modelLabel, "DeepSeek V4.1 Flash");
assert.equal(flash.rates.input, 0.30);
assert.equal(flash.rates.cacheRead, 0.006);
assert.equal(flash.rates.output, 1.20);
assert.equal(flash.dailyInputTokens, 428571); // 3M / 7
assert.equal(flash.dailyOutputTokens, 28571); // 200k / 7
assert.equal(flash.dailyCacheReadTokens, 257143); // 1.8M / 7
assert.equal(flash.dailyCostUsd, 0.0873);
const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
const flashDailyFresh = 3_000_000 / 7 - 1_800_000 / 7;
const flashDailyCost = (flashDailyFresh * 0.30 + 1_800_000 / 7 * 0.006 + 200_000 / 7 * 1.20) / 1_000_000;
const expectedFlashMonthly = Number((flashDailyCost * daysInMonth).toFixed(2));
assert.equal(flash.monthlyCostUsd, expectedFlashMonthly);

const pro = calculateDeepSeekProjection(3_000_000, 200_000, 1_800_000, 7, "deepseek-v4-pro");
assert.equal(pro.model, "deepseek-v4-pro");
assert.equal(pro.modelLabel, "DeepSeek V4 Pro");
assert.equal(pro.rates.input, 1.32);
assert.equal(pro.rates.cacheRead, 0.044);
assert.equal(pro.rates.output, 3.96);
assert.equal(pro.dailyCostUsd, 0.3507);
const proDailyFresh = 3_000_000 / 7 - 1_800_000 / 7;
const proDailyCost = (proDailyFresh * 1.32 + 1_800_000 / 7 * 0.044 + 200_000 / 7 * 3.96) / 1_000_000;
const expectedProMonthly = Number((proDailyCost * daysInMonth).toFixed(2));
assert.equal(pro.monthlyCostUsd, expectedProMonthly);

// Test error for unknown model
try {
  calculateDeepSeekProjection(0, 0, 0, 1, "unknown-model" as any);
  assert.fail("should throw");
} catch (e) {
  assert.match(String(e), /Unknown DeepSeek model/);
}

console.log("PASS public API list prices, disjoint caches, reasoning exclusion, unknown coverage and preserved provider costs");
console.log("PASS DeepSeek cost projection: flash, pro, error handling");