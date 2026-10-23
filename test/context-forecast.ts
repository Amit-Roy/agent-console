import assert from "node:assert/strict";
import { forecastContext, forecastModel, recommendCompaction } from "../public/context-forecast.js";

const scenario = {
  context: 100000,
  retained: 0.2,
  added: 2000,
  requests: 20,
  ttlMs: 1800000,
  ageMs: 60000,
  resumeMs: 0,
  gapMs: 60000,
  rate: [2, 0.1, 2.5, 10],
};
const warm = forecastContext(scenario)!;
assert.equal(warm.summary, 20000);
assert.equal(warm.points[0].keepCost, 0);
assert.equal(warm.compactCost, 0.21, "summary generation costs output tokens plus a warm read");
assert.equal(warm.points[1].keepCost, 0.015, "read existing prefix, write new tokens");
assert.equal(warm.points[1].compactCost, 0.265, "rewritten summary is cold on first reuse");
assert.equal(warm.points[1].compactTokens, 142000, "compaction input/output are included once");
const stale = forecastContext({ ...scenario, ageMs: 1800000 })!;
assert.equal(stale.compactCost, 0.45, "expired context must be rewritten for compaction");
assert.equal(stale.points[1].keepCost, 0.255);
const resumeStale = forecastContext({ ...scenario, resumeMs: 1800000 })!;
assert.equal(resumeStale.compactCost, warm.compactCost, "compact now while warm, resume later");
assert.equal(resumeStale.points[1].keepCost, stale.points[1].keepCost);
assert.equal(resumeStale.warmResume, false);
assert.ok(
  resumeStale.breakEven != null &&
    (warm.breakEven == null || resumeStale.breakEven < warm.breakEven),
  "idle expiry makes compaction pay back sooner",
);
const spaced = forecastContext({ ...scenario, gapMs: 1800000 })!;
assert.ok(spaced.points[2].keepCost! > warm.points[2].keepCost!);
assert.equal(spaced.points[2].keepCost! - spaced.points[1].keepCost!, 0.26);
const noPrice = forecastContext({ ...scenario, rate: undefined })!;
assert.equal(noPrice.priced, false);
assert.equal(noPrice.points[1].keepCost, null);
assert.equal(noPrice.points[1].compactCost, null);
assert.equal(noPrice.points[1].compactTokens, warm.points[1].compactTokens);
assert.equal(noPrice.breakEven, null);
const limited = forecastContext({ ...scenario, maxContext: 105000 })!;
assert.equal(limited.windowLimited, true);
assert.equal(limited.points.at(-1)!.added, 4000, "never project through native window compaction");
assert.equal(forecastContext({ ...scenario, context: NaN }), null);
assert.equal(forecastContext({ ...scenario, context: 0 }), null);
assert.equal(forecastContext({ ...scenario, rate: [2, NaN, 2, 10] })!.priced, false);
const rates = {
  "gpt-5.5": scenario.rate,
  "gpt-6.1": scenario.rate,
  "gpt-6.1-sol": scenario.rate,
  "claude-sonnet-5-5": scenario.rate,
};
assert.deepEqual(
  forecastModel({ model: "default", resolvedModel: "gpt-6.1-sol" }, rates).rate,
  scenario.rate,
);
assert.equal(
  forecastModel({ model: "unknown", resolvedModel: "gpt-6.1-sol" }, rates).rate,
  undefined,
);
assert.equal(
  forecastModel({ provider: "codex", model: "default", lastRun: { model: "gpt-6.1-sol" } }, rates)
    .rate,
  undefined,
  "CLI default cannot inherit a previous model's price",
);
assert.equal(forecastModel({ model: "gpt-6.1-sol-2026-10-17" }, rates).rate, scenario.rate);
assert.equal(forecastModel({ model: "gpt-5.5-codex" }, rates).rate, scenario.rate);
assert.equal(
  forecastModel({ model: "gpt-6.1", resolvedModel: "gpt-6.1-codex" }, rates).rate,
  scenario.rate,
);
assert.equal(
  forecastModel(
    { provider: "claude", model: "sonnet", lastRun: { model: "claude-sonnet-5-5" } },
    rates,
  ).rate,
  scenario.rate,
);
assert.equal(
  forecastModel(
    { provider: "claude", model: "opus", lastRun: { model: "claude-sonnet-5-5" } },
    rates,
  ).rate,
  undefined,
);
console.log(
  "PASS context forecast: warm/stale cache, compaction overhead, delayed resume, gaps, break-even, unknown prices and window limits",
);

// The horizon is future work, not extra work unlocked by a smaller context.
const recommendation = recommendCompaction({ ...scenario, resumeMs: 3600000 });
assert.equal(recommendation.action, "now");
assert.equal(recommendation.afterRequests, 0);
assert.equal(recommendation.atContextTokens, scenario.context);
assert.equal(recommendation.horizonRequests, scenario.requests);
assert.ok(recommendation.savings > 0);
assert.equal(recommendation.baselineCost - recommendation.cost, recommendation.savings);
assert.equal(
  recommendation.cost,
  forecastContext({ ...scenario, resumeMs: 3600000 })!.points.at(-1)!.compactCost,
);
assert.equal(recommendCompaction(scenario).action, "continue");
assert.equal(recommendCompaction({ ...scenario, requests: 1 }).action, "continue");
assert.equal(recommendCompaction({ ...scenario, retained: 1 }).action, "continue");
assert.equal(recommendCompaction({ ...scenario, rate: undefined }).action, "unknown");
assert.equal(recommendCompaction({ ...scenario, context: 0 }).action, "unknown");
assert.equal(recommendCompaction({ ...scenario, maxContext: scenario.context }).action, "unknown");
const limitedRecommendation = recommendCompaction({
  ...scenario,
  maxContext: scenario.context + 4000,
});
assert.equal(limitedRecommendation.horizonRequests, 2);
assert.equal(limitedRecommendation.action, "continue");
// With no cache discount and no output charge, earlier reduction always saves more.
const uncached = recommendCompaction({ ...scenario, rate: [2, 2.5, 2.5, 0] });
assert.equal(uncached.action, "now");
assert.equal(
  uncached.cost,
  forecastContext({ ...scenario, rate: [2, 2.5, 2.5, 0] })!.points.at(-1)!.compactCost,
);
// Cold prefixes and long request gaps must use fresh-input prices on both paths.
const coldScenario = { ...scenario, ageMs: Infinity, gapMs: 3600000, rate: [2, 0.1, 2.5, 2] };
const coldRecommendation = recommendCompaction(coldScenario);
assert.equal(coldRecommendation.action, "wait");
assert.equal(coldRecommendation.afterRequests, 1);
assert.equal(coldRecommendation.atContextTokens, 102000);
const afterFirstRequest = forecastContext({
  ...coldScenario,
  context: 102000,
  requests: 19,
  ageMs: 0,
  resumeMs: coldScenario.gapMs,
})!;
const expectedDeferred =
  (102000 * coldScenario.rate[2]) / 1e6 + afterFirstRequest.points.at(-1)!.compactCost!;
assert.ok(Math.abs(coldRecommendation.cost! - expectedDeferred) < 1e-12);
assert.ok(coldRecommendation.cost! < forecastContext(coldScenario)!.points.at(-1)!.compactCost!);
console.log(
  "PASS compaction recommendations: warm, stale, gaps, overhead, unknown prices and fixed horizon",
);

// Independently compose existing forecast prefixes/suffixes for every candidate.
for (const sample of [
  scenario,
  { ...scenario, resumeMs: 3600000 },
  coldScenario,
  { ...coldScenario, maxContext: 110000 },
  { ...scenario, retained: 0.8 },
]) {
  const whole = forecastContext(sample)!;
  const horizon = whole.points.length - 1;
  const costs = [whole.points.at(-1)!.keepCost!];
  for (let k = 0; k < horizon; k++) {
    const suffix = forecastContext({
      ...sample,
      context: sample.context + k * sample.added,
      requests: horizon - k,
      maxContext: Infinity,
      ageMs: k ? 0 : sample.ageMs,
      resumeMs: k ? sample.gapMs : sample.resumeMs,
    })!;
    costs.push(whole.points[k].keepCost! + suffix.points.at(-1)!.compactCost!);
  }
  assert.ok(Math.abs(recommendCompaction(sample).cost! - Math.min(...costs)) < 1e-12);
}
