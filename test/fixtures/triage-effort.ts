import { validateEffortModel } from "../../server/providers/triage-effort.ts";

// Synthetic coefficients test inference; production fitting never reads this file.
const fixture = validateEffortModel({
  schemaVersion: 1, method: "nonnegative-ridge-log-work-v1",
  scope: "completed-session", tokenYieldBasis: "actions-plus-one",
  featureNames: ["breadth", "complexity", "uncertainty", "risk"],
  workload: { intercept: Math.log(2), coefficients: [0.1, 0.2, 0.3, 0.4], missingCoefficients: [0, 0, 0, 0],
    imputation: [1, 1, 1, 1], scale: [1, 1, 1, 1],
    featureRanges: Array.from({ length: 4 }, () => ({ min: 0, max: 3, known: 3, missing: 0 })),
    residualQuantiles: { p50: 0, p80: 0.2, p95: 0.3 } },
  scenarios: [-0.2, 0, 0.3].map((logResidual, index) => ({ sampleId: `synthetic-${index}`, logResidual,
    outputPerWork: 100 + index * 50, freshInputPerWork: 1000, cachedInputPerWork: 3000, roundsPerWork: 1 })),
  workCutoffs: { trivialMax: 3, deepMin: 10 },
  training: { sampleIds: ["synthetic-0", "synthetic-1", "synthetic-2"], sampleCount: 3, groupCount: 3 },
  validation: { status: "experimental", hasLearnedComplexitySignal: true, sampleCount: 1, groupCount: 1,
    work: { mae: 2 }, baselineWork: { mae: 3 }, workCoverage: { p80: 1 } },
});
if (fixture.status !== "ready") throw Error("Synthetic effort fixture is invalid.");
export const fixtureEffortModel = fixture;
