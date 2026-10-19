import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EFFORT_FEATURES, LEGACY_EFFORT_FEATURES, SHAPE_FEATURES, requestShape, empiricalQuantile, loadEffortModel, quoteEffort, validateEffortModel,
  type ComplexityInput, type EffortModel, type EffortQuote } from "../server/providers/triage-effort.ts";

/** Synthetic fixtures exercise inference; production coefficients come only from measured runs. */
function fixture(): EffortModel {
  return {
    schemaVersion: 1, method: "nonnegative-ridge-log-work-v1", featureNames: LEGACY_EFFORT_FEATURES,
    workload: { intercept: 1, coefficients: [0.2, 0.3, 0.4, 0.1], missingCoefficients: [0, 0.1, 0, 0.1],
      imputation: [1, 1, 2, 1], scale: [1, 1, 1, 1],
      featureRanges: LEGACY_EFFORT_FEATURES.map(() => ({ min: 0, max: 3, known: 5, missing: 0 })),
      residualQuantiles: { p50: 0, p80: 0.2, p95: 0.4 } },
    scenarios: [-0.4, -0.2, 0, 0.2, 0.4].map((logResidual, index) => ({ sampleId: `sample-${index}`, logResidual,
      outputPerWork: 100 + index * 10, freshInputPerWork: 200 + index * 20, cachedInputPerWork: 300 + index * 30, roundsPerWork: 0.5 })),
    workCutoffs: { trivialMax: 4, deepMin: 12 }, validation: { status: "experimental", modelMae: 3, baselineMae: 4 },
    training: { sampleIds: Array.from({ length: 5 }, (_, index) => `sample-${index}`), sampleCount: 5, groupCount: 5 },
  };
}
const features = (value: number | null): ComplexityInput => Object.fromEntries(LEGACY_EFFORT_FEATURES.map(name => [name, { value }])) as ComplexityInput;
const predict = (input = features(1), model = fixture()): EffortQuote => {
  const result = quoteEffort(input, validateEffortModel(model));
  assert.equal(result.status, "ready");
  return result as EffortQuote;
};
const sessionTotals = fixture();
sessionTotals.scope = "completed-session";
sessionTotals.workloadMetric = "totalTokens";
sessionTotals.tokenYieldBasis = "workload";
sessionTotals.workload.intercept = Math.log1p(1000);
sessionTotals.workload.coefficients = [0, 0, 0, 0];
sessionTotals.workload.missingCoefficients = [0, 0, 0, 0];
sessionTotals.scenarios = sessionTotals.scenarios.map(row => ({ ...row, logResidual: 0,
  inputPerWork: 0.8, outputPerWork: 0.2, freshInputPerWork: null, cachedInputPerWork: null, roundsPerWork: null }));
const directUsage = predict(features(1), sessionTotals);
assert.equal(directUsage.workloadMetric, "totalTokens");
assert.equal(directUsage.input!.p50, 800);
assert.equal(directUsage.output.p50, 200);
assert.equal(directUsage.total!.p50, 1000);
assert.equal(directUsage.freshInput, null, "Unknown cache split must not erase a known total");
assert.equal(directUsage.rounds, null, "Tool telemetry is not required to quote session usage");
const cappedModel = structuredClone(sessionTotals); cappedModel.workload.intercept = 40;
assert.ok(Math.abs(predict(features(1), cappedModel).activity.p50 / Math.expm1(30) - 1) < 1e-12,
  "Runtime numerical bounds must match the offline fit and validation");
const zeros = structuredClone(sessionTotals);
zeros.scenarios.slice(0, 3).forEach(row => { row.zeroWork = true; row.inputPerWork = 0; row.outputPerWork = 0; });
assert.equal(predict(features(1), zeros).total!.p50, 0, "Measured zero-total sessions preserve an empirical point mass");
assert.equal(predict(features(1), zeros).activity.p50, 0);
const badShares = structuredClone(sessionTotals); badShares.scenarios[0].inputPerWork = 1;
assert.equal(validateEffortModel(badShares).status, "unavailable");
const noEvidence = structuredClone(sessionTotals);
noEvidence.workload.featureRanges = noEvidence.workload.featureRanges.map(() => ({ min: null, max: null, known: 0, missing: 5 }));
assert.equal(validateEffortModel(noEvidence).status, "ready");
assert.deepEqual(predict(features(1), noEvidence).outOfRange, [...LEGACY_EFFORT_FEATURES]);
const baselineModel = structuredClone(sessionTotals);
baselineModel.estimator = "historical-baseline";
assert.equal(predict(features(0), baselineModel).estimator, "historical-baseline");
assert.deepEqual(predict(features(0), baselineModel).total, predict(features(3), baselineModel).total,
  "A historical fallback must not pretend to vary budgets with task features");
assert.match(predict(features(1), baselineModel).formula, /did not beat/);
baselineModel.workload.coefficients[0] = 0.1;
assert.equal(validateEffortModel(baselineModel).status, "unavailable", "Baseline artifacts cannot contain active complexity weights");

assert.equal(empiricalQuantile([4, 1, 2, 3], 0.5), 2.5);
assert.throws(() => empiricalQuantile([], 0.5));
assert.throws(() => empiricalQuantile([Infinity], 0.5));
assert.throws(() => empiricalQuantile([1], -1));
assert.equal(validateEffortModel(fixture()).status, "ready");
const quote = predict();
// Golden vector computed independently with Python math.expm1 and linear quantiles.
for (const [key, expected] of Object.entries({ p50: 6.38905609893065, p80: 8.424646075675618, p95: 9.623543804400105 })) {
  assert.ok(Math.abs(quote.activity[key as keyof typeof quote.activity] - expected) < 1e-12);
}
assert.deepEqual(quote.output, { p50: 767, p80: 1116, p95: 1332 });
// Independent fitting-code golden vector covers scaling, missing features and residuals.
const pythonModel = fixture();
pythonModel.workload.coefficients = [0.1, 0.2, 0.3, 0.4];
pythonModel.workload.missingCoefficients = [-0.1, 0.1, 0, 0.2];
pythonModel.workload.imputation = [1, 1.5, 2, 1];
pythonModel.workload.scale = [1, 2, 1, 1];
pythonModel.scenarios = [-0.3, 0, 0.5].map((logResidual, index) => ({ sampleId: `sample-${index}`, logResidual,
  outputPerWork: [70, 100, 140][index], freshInputPerWork: 10, cachedInputPerWork: 20, roundsPerWork: 0.5 }));
const pythonQuote = predict({ breadth: { value: 2 }, complexity: { value: null }, uncertainty: { value: 1 }, risk: { value: 3 } }, pythonModel);
for (const [key, expected] of Object.entries({ p50: 18.10595372823165, p80: 25.542616876541423, p95: 29.260948450696308 })) {
  assert.ok(Math.abs(pythonQuote.activity[key as keyof typeof pythonQuote.activity] - expected) < 1e-12);
}
assert.deepEqual(pythonQuote.output, { p50: 1811, p80: 3287, p95: 4025 });
assert.deepEqual(pythonQuote.freshInput, { p50: 182, p80: 256, p95: 293 });
assert.deepEqual(pythonQuote.cachedInput, { p50: 363, p80: 511, p95: 586 });
assert.equal(quote.scope, "completed-delivery-run");
assert.equal(quote.tokenYieldBasis, "actions");
assert.equal(quote.workloadMetric, "toolCalls");
assert.equal(quote.confidence, "experimental");
assert.equal(quote.effortBasis, "p50");
assert.equal(quote.recommendedBudget, "p80");
assert.match(quote.formula, /not a whole issue or human hours/);
const sessionModel = fixture();
sessionModel.scope = "completed-session";
sessionModel.tokenYieldBasis = "actions-plus-one";
const sessionQuote = predict(features(1), sessionModel);
assert.equal(sessionQuote.scope, "completed-session");
assert.equal(sessionQuote.tokenYieldBasis, "actions-plus-one");
assert.deepEqual(sessionQuote.activity, quote.activity);
assert.ok(sessionQuote.output.p50 > quote.output.p50);
assert.match(sessionQuote.formula, /entire completed session\/thread, including later follow-ups/);
assert.match(sessionQuote.formula, /Only initial user requests supply predictors/);
const zeroAction = fixture();
zeroAction.scope = "completed-session";
zeroAction.tokenYieldBasis = "actions-plus-one";
zeroAction.workload.intercept = 0;
zeroAction.workload.coefficients = [0, 0, 0, 0];
zeroAction.scenarios.forEach(scenario => { scenario.logResidual = 0; scenario.outputPerWork = 100; scenario.freshInputPerWork = 20; scenario.cachedInputPerWork = 30; });
const zeroActionQuote = predict(features(0), zeroAction);
assert.deepEqual(zeroActionQuote.activity, { p50: 0, p80: 0, p95: 0 });
assert.deepEqual(zeroActionQuote.output, { p50: 100, p80: 100, p95: 100 });
assert.deepEqual(zeroActionQuote.input, { p50: 50, p80: 50, p95: 50 });
assert.deepEqual(zeroActionQuote.total, { p50: 150, p80: 150, p95: 150 });
// Complete session input remains available without cache/non-cache split telemetry.
zeroAction.scenarios.forEach(scenario => { scenario.inputPerWork = 70; scenario.freshInputPerWork = null; scenario.cachedInputPerWork = null; });
const unsplitQuote = predict(features(0), zeroAction);
assert.deepEqual(unsplitQuote.input, { p50: 70, p80: 70, p95: 70 });
assert.deepEqual(unsplitQuote.total, { p50: 170, p80: 170, p95: 170 });
assert.equal(unsplitQuote.freshInput, null);
assert.equal(unsplitQuote.cachedInput, null);
zeroAction.scenarios.forEach((scenario, index) => { scenario.outputPerWork = (index + 1) * 100; scenario.inputPerWork = (5 - index) * 100; });
const pairedTotal = predict(features(0), zeroAction);
assert.deepEqual(pairedTotal.total, { p50: 600, p80: 600, p95: 600 });
assert.ok(pairedTotal.total!.p95 < pairedTotal.output.p95 + pairedTotal.input!.p95,
  "Joint scenario totals must not add unrelated marginal upper quantiles.");
for (const channel of [quote.activity, quote.output, quote.input!, quote.freshInput!, quote.cachedInput!, quote.rounds!]) {
  assert.ok(channel.p50 <= channel.p80 && channel.p80 <= channel.p95);
}
assert.ok(quote.riskPremium.work > 0);
assert.equal(quote.riskPremium.output, quote.output.p80 - quote.output.p50);
assert.equal(quote.riskPremium.input, quote.input!.p80 - quote.input!.p50);

// Monotone in each observed complexity feature when the unknown mask remains fixed.
for (const name of LEGACY_EFFORT_FEATURES) {
  let previous = 0;
  for (let value = 0; value <= 3; value++) {
    const input = features(1);
    input[name].value = value;
    const result = predict(input);
    assert.ok(result.activity.p50 >= previous);
    previous = result.activity.p50;
  }
}
const partial = features(1);
partial.complexity.value = null;
const unknownQuote = predict(partial);
assert.deepEqual(unknownQuote.unknowns, ["complexity"]);
assert.equal(unknownQuote.confidence, "experimental");
assert.equal(unknownQuote.effortBasis, "p95");
assert.equal(unknownQuote.recommendedBudget, "p95");
assert.equal(unknownQuote.contributions.find(item => item.feature === "complexity")!.imputed, 1);
for (let value = 0; value < 3; value++) {
  const low = features(1);
  low.risk.value = null;
  low.breadth.value = value;
  const high = { ...low, breadth: { value: value + 1 } };
  assert.ok(predict(high).activity.p50 >= predict(low).activity.p50);
}
assert.deepEqual(predict(features(null)).unknowns, [...LEGACY_EFFORT_FEATURES]);
const ranged = fixture();
ranged.workload.featureRanges[0].max = 1;
assert.deepEqual(predict(features(2), ranged).outOfRange, ["breadth"]);
assert.equal(predict(features(2), ranged).effortBasis, "p95");
assert.equal(predict(features(2), ranged).recommendedBudget, "p95");
// Missingness may correlate with cheap historical runs. Routing uses the measured tail,
// without inventing variance or pretending imputation improved the evidence.
const biasedMissingness = fixture();
biasedMissingness.workload.missingCoefficients = [-0.2, 0, 0, 0];
biasedMissingness.workload.imputation[0] = 0;
biasedMissingness.workCutoffs = { trivialMax: 4, deepMin: 12 };
const missingBreadth = features(1);
missingBreadth.breadth.value = null;
const conservativeQuote = predict(missingBreadth, biasedMissingness);
assert.ok(conservativeQuote.activity.p50 <= biasedMissingness.workCutoffs.trivialMax);
assert.ok(conservativeQuote.activity.p95 > biasedMissingness.workCutoffs.trivialMax);
assert.equal(conservativeQuote.effort, "bau");
assert.equal(conservativeQuote.effortBasis, "p95");
const observedImputation = { ...missingBreadth, breadth: { value: 0 } };
const noMissingPenalty = structuredClone(biasedMissingness);
noMissingPenalty.workload.missingCoefficients[0] = 0;
assert.deepEqual(predict(missingBreadth, noMissingPenalty).activity, predict(observedImputation, noMissingPenalty).activity);
assert.equal(quoteEffort({ ...features(1), breadth: { value: 4 } }, validateEffortModel(fixture())).status, "unavailable");

// Input replay/caching measurements and metadata cannot alter work or labels.
const replay = fixture();
replay.scenarios.forEach(scenario => { scenario.freshInputPerWork = 1e7; scenario.cachedInputPerWork = 1e8; });
replay.training.description = "A metadata label must never change effort.";
const replayQuote = predict(features(1), replay);
assert.deepEqual(replayQuote.activity, quote.activity);
assert.equal(replayQuote.effort, quote.effort);
assert.notDeepEqual(replayQuote.input, quote.input);
const withExtraneous = { ...features(1), inputTokens: 1e12, outputTokens: 1e12, changedFiles: 1e8 };
assert.deepEqual(predict(withExtraneous).activity, quote.activity);
const missingCache = fixture();
missingCache.scenarios[0].cachedInputPerWork = null;
assert.equal(predict(features(1), missingCache).cachedInput, null);
assert.equal(predict(features(1), missingCache).input, null);
assert.ok(predict(features(1), missingCache).freshInput);
const equalCutoffs = fixture();
equalCutoffs.workCutoffs = { trivialMax: 8, deepMin: 8 };
assert.equal(predict(features(0), equalCutoffs).effort, "bau");
assert.equal(predict(features(3), equalCutoffs).effort, "bau");

for (const mutate of [
  (model: any) => { model.schemaVersion = 2; },
  (model: any) => { model.scope = "whole-company"; },
  (model: any) => { model.tokenYieldBasis = "tokens"; },
  (model: any) => { model.scenarios[0].inputPerWork = Infinity; },
  (model: any) => { model.workload.coefficients[0] = -0.1; },
  (model: any) => { model.workload.coefficients[0] = NaN; },
  (model: any) => { model.workload.scale[0] = 0; },
  (model: any) => { model.workload.coefficients.push(1); },
  (model: any) => { model.workload.featureRanges[0].known = 500; },
  (model: any) => { model.scenarios[0].logResidual = Infinity; },
  (model: any) => { model.scenarios[0].outputPerWork = -1; },
  (model: any) => { model.scenarios[0].sampleId = "outside-training"; },
  (model: any) => { model.scenarios[0].sampleId = model.scenarios[1].sampleId; },
  (model: any) => { model.validation.status = "trusted"; },
  (model: any) => { model.validation.data = Array(2_001).fill(1); },
  (model: any) => { model.training.sampleIds = []; },
]) {
  const model = fixture();
  mutate(model);
  assert.equal(validateEffortModel(model).status, "unavailable");
}
const unavailable = { status: "unavailable", scope: "completed-delivery-run", reason: "No private fit." } as const;
assert.deepEqual(quoteEffort(features(1), unavailable), unavailable);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "triage-effort-test-"));
try {
  const file = path.join(temporary, "model.json");
  fs.writeFileSync(file, JSON.stringify(fixture()), { mode: 0o600 });
  assert.equal(loadEffortModel(file).status, "ready");
  fs.chmodSync(file, 0o644);
  assert.equal(loadEffortModel(file).status, "unavailable");
  fs.chmodSync(file, 0o600);
  const link = path.join(temporary, "linked-model.json");
  fs.symlinkSync(file, link);
  assert.equal(loadEffortModel(link).status, "unavailable");
  assert.equal(loadEffortModel(temporary).status, "unavailable");
  fs.writeFileSync(file, "{SECRET_PRIVATE_REQUEST");
  assert.ok(!JSON.stringify(loadEffortModel(file)).includes("SECRET_PRIVATE_REQUEST"));
  fs.truncateSync(file, 4 * 1024 * 1024 + 1);
  assert.equal(loadEffortModel(file).status, "unavailable");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }


// Request-shape features: deterministic, always known, monotonic buckets.
assert.deepEqual(Object.keys(requestShape("")), [...SHAPE_FEATURES]);
assert.deepEqual(Object.values(requestShape("")).map(item => item.value), [0, 0, 0, 0]);
assert.equal(requestShape("Fix the bug in login flow").requestSize.value, 1);
assert.equal(requestShape("x".repeat(120)).requestSize.value, 2);
assert.equal(requestShape("x".repeat(400)).requestSize.value, 3);
const rich = requestShape("Add a retry queue.\nReview `server/queue.ts` and https://example.com/spec.\nFix flaky tests, update docs, deploy, then restart.\nCommit.\n");
assert.equal(rich.requestLines.value, 2);
assert.equal(rich.requestReferences.value, 2);
assert.equal(rich.requestActions.value, 3);
const longer = (text: string) => requestShape(text + " ".repeat(0));
assert.ok(longer("x".repeat(500)).requestSize.value >= longer("x".repeat(5)).requestSize.value);
const shaped = fixture();
shaped.featureNames = EFFORT_FEATURES;
shaped.workload = { ...shaped.workload, coefficients: [0, 0, 0, 0, 0.5, 0, 0, 0.1], missingCoefficients: [0, 0, 0, 0, 0, 0, 0, 0],
  imputation: Array(8).fill(1), scale: Array(8).fill(1), featureRanges: EFFORT_FEATURES.map(() => ({ min: 0, max: 3, known: 5, missing: 0 })) };
const shapedFeatures = (size: number) => ({ ...features(1), ...requestShape("x".repeat(size)) });
const small = predict(shapedFeatures(5), shaped), large = predict(shapedFeatures(500), shaped);
assert.ok(large.activity.p50 > small.activity.p50, "Longer requests price higher through the learned size weight");
assert.equal(large.contributions.length, 8);
assert.deepEqual(large.contributions.slice(4).map(item => item.feature), [...SHAPE_FEATURES]);
const shapedTotals = { ...shaped, scope: sessionTotals.scope, workloadMetric: sessionTotals.workloadMetric, tokenYieldBasis: sessionTotals.tokenYieldBasis, scenarios: sessionTotals.scenarios } as EffortModel;
assert.match(predict(shapedFeatures(5), shapedTotals).formula, /request shape/);
const unknownModelMetrics = predict({ ...features(null), ...requestShape("Fix the login flow") }, shaped);
assert.deepEqual(unknownModelMetrics.unknowns, [...LEGACY_EFFORT_FEATURES]);
assert.equal(unknownModelMetrics.effortBasis, "p50", "Unknown model-extracted metrics do not force the stretch reserve once request shape prices the work");
assert.equal(predict(features(null)).effortBasis, "p95", "Four-feature artifacts keep the unknown-scope policy");
assert.equal(quoteEffort(features(1), validateEffortModel(shaped)).status, "unavailable", "A shaped model needs every shape feature");
const wrongSize = fixture();
wrongSize.featureNames = EFFORT_FEATURES;
assert.equal(validateEffortModel(wrongSize).status, "unavailable", "Eight names need eight-element vectors");
console.log("triage effort inference: monotonic work, empirical budgets, private model validation passed");
