import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  estimateHistory,
  HISTORY_POLICY,
  type HistoricalTask,
  type HistoryEstimate,
  type HistoryModel,
  historyQuantile,
  lexicalHistoryQuery,
  loadHistory,
  predictHistory,
  trainHistory,
  validateHistory,
} from "../server/providers/triage-history.ts";

// Synthetic fixtures test the estimator. Production calibration uses measured local records only.
function run(index: number, options: Partial<HistoricalTask> = {}): HistoricalTask {
  const start = new Date(Date.UTC(2020, 0, index + 1));
  return {
    id: `run-${index}`,
    group: `group-${index}`,
    startedAt: start.toISOString(),
    completedAt: new Date(start.getTime() + 60_000).toISOString(),
    request:
      index % 2
        ? "database migration transaction schema durability"
        : "mechanical spelling correction tiny typo",
    provider: index % 2 ? "claude" : "codex",
    inputTokens: index % 2 ? 9_000 : 90,
    outputTokens: index % 2 ? 1_000 : 10,
    commits: [{ repo: "example/app", sha: index.toString(16).padStart(40, "0") }],
    ...options,
  };
}
const envelope = (tasks: HistoricalTask[]) => ({
  version: 1,
  scope: "completed-delivery-run",
  tasks,
});
const readyModel = (value: ReturnType<typeof trainHistory>): HistoryModel => {
  assert.equal(value.status, "ready");
  return value as HistoryModel;
};
const readyEstimate = (value: ReturnType<typeof predictHistory>): HistoryEstimate => {
  assert.equal(value.status, "ready");
  return value as HistoryEstimate;
};
const asOf = "2022-01-01T00:00:00.000Z";

assert.equal(historyQuantile([4, 1, 2, 3], 0.5), 2.5);
assert.equal(historyQuantile([10], 0.1), 10);
assert.throws(() => historyQuantile([], 0.5));
assert.throws(() => historyQuantile([1], 2));
assert.equal(
  lexicalHistoryQuery('" OR 1=1; DROP TABLE requests; --'),
  '"drop" OR "table" OR "requests"',
);
assert.equal(lexicalHistoryQuery('+ : * - "'), "");
assert.equal(lexicalHistoryQuery(Array(1_000).fill("test").join(" ")), '"test"');
assert.ok(
  lexicalHistoryQuery(Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")).split(" OR ")
    .length <= 48,
);

const sparse = Array.from({ length: 11 }, (_, i) =>
  run(i, { group: `thread-${Math.floor(i / 3)}` }),
);
const small = readyModel(trainHistory(sparse, { asOf }));
assert.equal(small.method, "global-median");
assert.match(small.validation.selectionReason, /Only 4 independent groups/);
const baseline = readyEstimate(predictHistory(small, "database migration"));
assert.equal(baseline.scope, "completed-delivery-run");
assert.equal(baseline.workloadMetric, "outputTokens");
assert.equal(baseline.method, "global-median");
assert.equal(baseline.evidence, "low");
assert.equal(baseline.sampleCount, 11);
assert.equal(baseline.independentGroupCount, 4);
assert.equal(baseline.analogueCount, 0);
assert.equal(baseline.total.median, 100);
assert.deepEqual(baseline.total.range, [100, 10_000]);
assert.match(baseline.formula, /not the whole issue/);
assert.deepEqual(
  baseline.analogues.flatMap((value) => value.ids).sort(),
  sparse.map((task) => task.id).sort(),
);
assert.equal(
  predictHistory(small, "task", { startedAt: "2019-01-01T00:00:00Z" }).status,
  "insufficient-history",
);

const calibrated = readyModel(
  trainHistory(
    Array.from({ length: 30 }, (_, i) => run(i)),
    { asOf },
  ),
);
assert.equal(calibrated.method, "lexical-k3");
assert.ok(
  calibrated.validation.tuning.model.multiplicativeError! <
    calibrated.validation.tuning.baseline.multiplicativeError!,
);
assert.equal(calibrated.validation.holdout.model.count, 6);
assert.equal(calibrated.validation.holdout.model.maeTokens, 0);
assert.equal(calibrated.validation.holdout.model.rangeCoverage, 1);
assert.ok(calibrated.validation.holdout.baseline.maeTokens! > 0);
const cheap = readyEstimate(predictHistory(calibrated, "mechanical spelling typo"));
const costly = readyEstimate(predictHistory(calibrated, "database schema durability"));
assert.equal(cheap.effort, "trivial");
assert.equal(costly.effort, "deep");
assert.equal(cheap.total.median, 100);
assert.equal(costly.total.median, 10_000);
assert.deepEqual(cheap.thresholds, { trivialMax: 10, deepMin: 1_000 });
assert.equal(cheap.analogueCount, 3);
assert.equal(new Set(cheap.analogues.flatMap((item) => item.ids)).size, 3);
assert.equal(cheap.evidence, "backtested");
assert.equal(
  readyEstimate(predictHistory(calibrated, "unmatched zeppelin xylophone")).method,
  "global-median",
);
assert.equal(
  readyEstimate(predictHistory(calibrated, '" OR 1=1; DROP TABLE requests;')).method,
  "global-median",
);

// A lexical signal without predictive value must not win merely because retrieval exists.
const noSignal = readyModel(
  trainHistory(
    Array.from({ length: 30 }, (_, i) => run(i, { inputTokens: 100, outputTokens: 10 })),
    { asOf },
  ),
);
assert.equal(noSignal.method, "global-median");
assert.match(noSignal.validation.selectionReason, /did not improve/);
assert.equal(readyEstimate(predictHistory(noSignal, "database")).effort, "bau");

// Cached-input replay changes budget estimates, never the effort target or selected method.
const cachedReplay = readyModel(
  trainHistory(
    Array.from({ length: 30 }, (_, i) => run(i, { inputTokens: (30 - i) * 100_000_000 })),
    { asOf },
  ),
);
const replayEstimate = readyEstimate(predictHistory(cachedReplay, "mechanical spelling typo"));
assert.equal(cachedReplay.method, calibrated.method);
assert.deepEqual(cachedReplay.validation, calibrated.validation);
assert.equal(replayEstimate.effort, cheap.effort);
assert.deepEqual(replayEstimate.thresholds, cheap.thresholds);
assert.notEqual(replayEstimate.input.median, cheap.input.median);

// Holdout targets never select the method: changing only holdout outcomes cannot change tuning.
const alteredHoldout = Array.from({ length: 30 }, (_, i) =>
  run(i, i >= 24 ? { inputTokens: 1, outputTokens: 99_999 } : {}),
);
const holdoutModel = readyModel(trainHistory(alteredHoldout, { asOf }));
assert.equal(holdoutModel.method, calibrated.method);
assert.deepEqual(holdoutModel.validation.tuning, calibrated.validation.tuning);
assert.notEqual(
  holdoutModel.validation.holdout.model.maeTokens,
  calibrated.validation.holdout.model.maeTokens,
);

// Future outcomes and an entire partly-finished group cannot enter a historical fit.
const future = run(100, { startedAt: "2023-01-01T00:00:00Z", completedAt: "2023-01-01T00:01:00Z" });
const futureModel = readyModel(trainHistory([...sparse, future], { asOf }));
assert.deepEqual(futureModel.tasks, small.tasks);
const partlyFinished = run(101, {
  group: sparse[0].group,
  startedAt: "2023-01-01T00:00:00Z",
  completedAt: "2023-01-01T00:01:00Z",
});
const censored = readyModel(trainHistory([...sparse, partlyFinished], { asOf }));
assert.equal(
  censored.tasks.some((task) => task.group === sparse[0].group),
  false,
);

// Revisions remain one group at the split even when a later turn has a different request.
const revisions = Array.from({ length: 15 }, (_, i) => [
  run(i * 2, { group: `revision-${i}` }),
  run(i * 2 + 1, { group: `revision-${i}` }),
]).flat();
const revisionModel = readyModel(trainHistory(revisions, { asOf }));
assert.equal(revisionModel.validation.trainingGroupCount, 12);
assert.equal(revisionModel.validation.holdoutGroupCount, 3);
assert.equal(revisionModel.validation.holdout.model.count, 6);

assert.equal(trainHistory([], { asOf }).status, "insufficient-history");
assert.equal(trainHistory([run(0), run(1)], { asOf }).status, "insufficient-history");
assert.equal(
  trainHistory(
    [run(0), run(1), run(2)].map((task) => ({ ...task, group: "one" })),
    { asOf },
  ).status,
  "insufficient-history",
);
assert.equal(
  trainHistory([run(0), run(1), run(2)], { asOf: "bad" }).status,
  "insufficient-history",
);
for (const tasks of [
  [run(0), run(0)],
  [run(0), { ...run(0), id: "different-id" }],
  [run(0), run(1, { commits: run(0).commits })],
  [run(0, { inputTokens: -1 })],
  [run(0, { outputTokens: Number.NaN })],
  [run(0, { inputTokens: 0, outputTokens: 0 })],
  [run(0, { completedAt: "2019-01-01T00:00:00Z" })],
  [run(0, { request: "x".repeat(12_001) })],
  [run(0, { commits: [] })],
  [run(0, { commits: [{ repo: "example/app", sha: "not-sha" }] })],
])
  assert.equal(validateHistory(envelope(tasks)).status, "insufficient-history");
assert.equal(validateHistory({ tasks: sparse }).status, "insufficient-history");
assert.equal(
  validateHistory(envelope(Array(HISTORY_POLICY.maximumRows + 1).fill(run(0)))).status,
  "insufficient-history",
);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "triage-history-test-"));
try {
  const file = path.join(directory, "history.json");
  fs.writeFileSync(file, JSON.stringify(envelope(sparse)), { mode: 0o600 });
  assert.equal(loadHistory(file).status, "ready");
  assert.equal(estimateHistory("database", { path: file, startedAt: asOf }).status, "ready");
  fs.chmodSync(file, 0o644);
  assert.equal(loadHistory(file).status, "insufficient-history");
  fs.chmodSync(file, 0o600);
  const symlink = path.join(directory, "symlink.json");
  fs.symlinkSync(file, symlink);
  assert.equal(loadHistory(symlink).status, "insufficient-history");
  fs.writeFileSync(file, "not JSON");
  assert.equal(loadHistory(file).status, "insufficient-history");
  assert.equal(loadHistory(directory).status, "insufficient-history");
  assert.equal(loadHistory(path.join(directory, "absent.json")).status, "insufficient-history");
  fs.writeFileSync(file, " ".repeat(HISTORY_POLICY.maximumBytes + 1));
  assert.equal(loadHistory(file).status, "insufficient-history");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log(
  "triage-history: measured medians, group/time leakage guards, baseline selection, holdout, and private loader passed",
);
