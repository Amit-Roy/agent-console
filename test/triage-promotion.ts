import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  effortConfigPath,
  promotionDecision,
  readEffortConfig,
  writeEffortConfig,
} from "../server/triage-promotion.ts";

type Json = Record<string, unknown>;
const quantiles = (p80 = 0.82, p95 = 0.95) => ({
  p50: { pinball: 1, coverage: 0.5 },
  p75: { pinball: 1, coverage: 0.75 },
  p80: { pinball: 1, coverage: p80 },
  p95: { pinball: 1, coverage: p95 },
  p99: { pinball: 1, coverage: 0.99 },
});
const champion = (overrides: Json = {}) => ({
  scoreable: true,
  reason: null,
  sampleCount: 40,
  quantiles: quantiles(),
  meanPinball: 1,
  ...overrides,
});
const artifact = (model: Json = {}, withChampion: Json | null = champion()): Json => ({
  validation: {
    quantileModel: {
      status: "validated",
      sampleCount: 100,
      quantiles: quantiles(),
      beatsPinballBaseline: true,
      meanPinball: 1,
      ...(withChampion ? { champion: withChampion } : {}),
      ...model,
    },
  },
});

// Passing case.
const pass = promotionDecision(artifact());
assert.equal(pass.promote, true);
assert.deepEqual(pass.reasons, []);
assert.equal(pass.bootstrap, false);
assert.equal(pass.metrics.p80Coverage, 0.82);
assert.equal(pass.metrics.championMeanPinball, 1);

// Missing or malformed challenger.
for (const bad of [
  undefined,
  null,
  42,
  "text",
  [],
  {},
  { validation: null },
  { validation: {} },
  { validation: { quantileModel: "x" } },
  { validation: { quantileModel: [] } },
  artifact({ meanPinball: Number.NaN }),
  artifact({ meanPinball: "1" }),
  artifact({ quantiles: undefined }),
  artifact({ quantiles: { p80: { pinball: 1, coverage: 0.8 } } }),
  artifact({ quantiles: quantiles(Number.POSITIVE_INFINITY) }),
  artifact({ quantiles: { ...quantiles(), p95: { pinball: "x", coverage: 0.95 } } }),
]) {
  const decision = promotionDecision(bad);
  assert.equal(decision.promote, false);
  assert.deepEqual(decision.reasons, ["challenger has no quantile trees."]);
  assert.equal(decision.bootstrap, false);
}
const throwing = {
  get validation(): never {
    throw Error("boom");
  },
};
assert.equal(promotionDecision(throwing).promote, false);
assert.equal(promotionDecision(artifact(), null as never).promote, true);

// Coverage bounds.
assert.equal(promotionDecision(artifact({ quantiles: quantiles(0.75) })).promote, true);
assert.equal(promotionDecision(artifact({ quantiles: quantiles(0.92) })).promote, true);
assert.equal(promotionDecision(artifact({ quantiles: quantiles(0.9, 0.9) })).promote, true);
const low = promotionDecision(artifact({ quantiles: quantiles(0.7) }));
assert.equal(low.promote, false);
assert.deepEqual(low.reasons, ["p80 coverage 0.70 is below 0.75."]);
const high = promotionDecision(artifact({ quantiles: quantiles(0.95) }));
assert.equal(high.promote, false);
assert.deepEqual(high.reasons, ["p80 coverage 0.95 is above 0.92."]);
const thin = promotionDecision(artifact({ quantiles: quantiles(0.8, 0.85) }));
assert.equal(thin.promote, false);
assert.deepEqual(thin.reasons, ["p95 coverage 0.85 is below 0.90."]);
const both = promotionDecision(artifact({ quantiles: quantiles(0.5, 0.5) }));
assert.equal(both.reasons.length, 2);

// Baseline flag must be exactly true.
for (const flag of [false, undefined, "true", 1]) {
  const decision = promotionDecision(artifact({ beatsPinballBaseline: flag }));
  assert.equal(decision.promote, false);
  assert.deepEqual(decision.reasons, ["challenger does not beat the pinball baseline."]);
}

// Champion tolerance boundary.
assert.equal(promotionDecision(artifact({ meanPinball: 1.02 })).promote, true);
assert.equal(promotionDecision(artifact({ meanPinball: 0.5 })).promote, true);
const over = promotionDecision(artifact({ meanPinball: 1.0201 }));
assert.equal(over.promote, false);
assert.equal(over.bootstrap, false);
assert.match(over.reasons[0], /1\.0201.*1\.02 times champion 1\.0000/);
assert.equal(
  promotionDecision(artifact({ meanPinball: 5 }), { compareChampion: false }).promote,
  true,
);

// Statistical gate: pairedDelta present.
const paired = (lower90: number, upper90: number, mean = (lower90 + upper90) / 2) =>
  champion({ pairedDelta: { mean, lower90, upper90, resamples: 2000 } });
const worse = promotionDecision(artifact({ meanPinball: 1.05 }, paired(0.05, 0.1, 0.07)));
assert.equal(worse.promote, false);
assert.deepEqual(worse.reasons, ["pinball worse: delta 0.07 [0.05,0.10]"]);
const noisy = promotionDecision(artifact({ meanPinball: 1.05 }, paired(-0.02, 0.1, 0.04)));
assert.equal(noisy.promote, true);
assert.deepEqual(noisy.reasons, []);
assert.equal(promotionDecision(artifact({ meanPinball: 1.05 }, paired(0, 0.1))).promote, true);
const capped = promotionDecision(artifact({ meanPinball: 1.12 }, paired(-0.02, 0.1)));
assert.equal(capped.promote, false);
assert.deepEqual(capped.reasons, ["pinball ratio 1.12 above cap 1.10"]);
assert.equal(promotionDecision(artifact({ meanPinball: 1.1 }, paired(-0.02, 0.1))).promote, true);
const strict = promotionDecision(artifact({ meanPinball: 0.9 }, paired(-0.2, -0.05)));
assert.equal(strict.promote, true);
// Malformed pairedDelta falls back to the 1.02 ratio.
const malformed = promotionDecision(
  artifact({ meanPinball: 1.05 }, champion({ pairedDelta: { mean: "x", lower90: -1 } })),
);
assert.equal(malformed.promote, false);
assert.match(malformed.reasons[0], /1\.02 times champion/);
// Missing pairedDelta keeps the 1.02 rule.
assert.equal(promotionDecision(artifact({ meanPinball: 1.05 })).promote, false);
assert.equal(promotionDecision(artifact({ meanPinball: 1.02 })).promote, true);

// Bootstrap cases promote when other rules pass.
const bootstraps: [string, Json | null, RegExp][] = [
  ["missing champion", null, /champion unscoreable: no champion/],
  [
    "unscoreable",
    champion({ scoreable: false, reason: "model_missing" }),
    /champion unscoreable: model_missing/,
  ],
  ["few samples", champion({ sampleCount: 19 }), /only 19 samples/],
  ["null mean", champion({ meanPinball: null }), /mean pinball is missing/],
];
for (const [name, value, pattern] of bootstraps) {
  const decision = promotionDecision(artifact({ meanPinball: 9 }, value));
  assert.equal(decision.promote, true, name);
  assert.equal(decision.bootstrap, true, name);
  assert.match(decision.reasons[0], pattern, name);
}
assert.equal(promotionDecision(artifact({}, champion({ sampleCount: 20 }))).bootstrap, false);
const bootstrapFail = promotionDecision(artifact({ quantiles: quantiles(0.5) }, null));
assert.equal(bootstrapFail.promote, false);
assert.equal(bootstrapFail.bootstrap, true);
assert.equal(bootstrapFail.reasons.length, 2);
const skipped = promotionDecision(artifact({}, null), { compareChampion: false });
assert.equal(skipped.bootstrap, false);
assert.deepEqual(skipped.reasons, []);

// Config path.
const saved = process.env.AGENT_CONSOLE_DATA;
process.env.AGENT_CONSOLE_DATA = "/tmp/ac-data";
assert.equal(effortConfigPath(), "/tmp/ac-data/effort-model.json");
delete process.env.AGENT_CONSOLE_DATA;
assert.equal(
  effortConfigPath(),
  path.join(os.homedir(), ".config", "agent-console", "effort-model.json"),
);
if (saved !== undefined) process.env.AGENT_CONSOLE_DATA = saved;

// Config read and write.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "effort-config-"));
const file = path.join(dir, "nested", "effort-model.json");
const allTrue = {
  enabled: true,
  steps: { sessions: true, features: true, fit: true, gate: true, promote: true, reprice: true },
};
assert.deepEqual(readEffortConfig(file), allTrue);
fs.mkdirSync(path.dirname(file));
fs.writeFileSync(file, "{not json");
assert.deepEqual(readEffortConfig(file), allTrue);
fs.writeFileSync(file, "[1,2]");
assert.deepEqual(readEffortConfig(file), allTrue);
fs.writeFileSync(
  file,
  JSON.stringify({ enabled: false, steps: { fit: false, gate: "no" }, extra: 1 }),
);
assert.deepEqual(readEffortConfig(file), {
  enabled: false,
  steps: { ...allTrue.steps, fit: false },
});
fs.writeFileSync(file, JSON.stringify({ enabled: "off", steps: 5 }));
assert.deepEqual(readEffortConfig(file), allTrue);

const next = { enabled: false, steps: { ...allTrue.steps, reprice: false, sessions: false } };
writeEffortConfig(next, file);
assert.deepEqual(readEffortConfig(file), next);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
assert.deepEqual(fs.readdirSync(path.dirname(file)), ["effort-model.json"]);
const fresh = path.join(dir, "made", "later", "effort-model.json");
writeEffortConfig(allTrue, fresh);
assert.deepEqual(readEffortConfig(fresh), allTrue);
fs.rmSync(dir, { recursive: true, force: true });
console.log("triage promotion tests passed");
