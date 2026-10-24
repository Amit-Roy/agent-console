import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessmentRevision, calibrationHealth } from "../server/triage-calibration.ts";
import { fixtureEffortModel } from "./fixtures/triage-effort.ts";

const now = 1_800_000_000_000;
const model = structuredClone(fixtureEffortModel);
if (model.status !== "ready") throw Error("Invalid fixture");
model.model.validation = {
  status: "experimental",
  sampleCount: 34,
  groupCount: 32,
  workCoverage: { p80: 1, p95: 1 },
  activeCoverage: { total: { p80: 0.353, p95: 0.882 }, work: { p80: 1, p95: 1 } },
};
const health = calibrationHealth({ model, now, updatedAt: now - 1000 });
assert.equal(health.available, true);
assert.equal(health.p80Coverage, 0.353);
assert.equal(health.p80GapPercentagePoints, -44.7);
assert.equal(health.p95GapPercentagePoints, -6.8);
assert.equal(health.underCovered, true);
assert.equal(health.stale, false);
assert.equal(health.degraded, true);
assert.equal(health.sampleCount, 34);
assert.equal(health.groupCount, 32);
assert.equal(calibrationHealth({ model, now, updatedAt: now - 24 * 60 * 60_000 }).stale, false);
assert.equal(calibrationHealth({ model, now, updatedAt: now + 1 }).ageMs, null);
assert.equal(calibrationHealth({ model, now, updatedAt: now + 1 }).stale, true);

const adequate = structuredClone(model);
adequate.model.validation = { status: "validated", workCoverage: { p80: 0.8, p95: 0.95 } };
assert.equal(calibrationHealth({ model: adequate, now, updatedAt: now }).degraded, false);
adequate.model.validation.activeCoverage = { total: { p80: null, p95: 2 } };
const unknown = calibrationHealth({ model: adequate, now, updatedAt: now });
assert.equal(unknown.p80Coverage, null);
assert.equal(unknown.p95Coverage, null);
assert.equal(unknown.underCovered, null);
assert.equal(unknown.p80GapPercentagePoints, null);
assert.equal(unknown.degraded, true);
adequate.model.validation.activeCoverage = { work: { p80: 0.9, p95: 0.96 } };
assert.equal(calibrationHealth({ model: adequate, now, updatedAt: now }).p80Coverage, 0.9);
adequate.model.validation.activeCoverage = {};
assert.equal(calibrationHealth({ model: adequate, now, updatedAt: now }).p80Coverage, null);

// Eight-day freshness: weekly retraining must not read as stale mid-week.
assert.equal(calibrationHealth({ model, now, updatedAt: now - 7 * 24 * 60 * 60_000 }).stale, false);
assert.equal(calibrationHealth({ model, now, updatedAt: now - 8 * 24 * 60 * 60_000 }).stale, true);

// A tree artifact reads the boosted quantile heads, never the ridge active coverage.
const tree = structuredClone(model);
tree.model.validation = {
  status: "validated",
  workCoverage: { p80: 0.1, p95: 0.1 },
  activeCoverage: { total: { p80: 0.1, p95: 0.1 } },
  quantileModel: {
    status: "validated",
    quantiles: { p80: { coverage: 0.82 }, p95: { coverage: 0.96 } },
  },
};
const treeHealth = calibrationHealth({ model: tree, now, updatedAt: now });
assert.equal(treeHealth.p80Coverage, 0.82);
assert.equal(treeHealth.p95Coverage, 0.96);
assert.equal(treeHealth.underCovered, false);
tree.model.validation.quantileModel = {
  status: "experimental",
  quantiles: { p80: { coverage: 0.6 }, p95: { coverage: 0.96 } },
};
assert.equal(calibrationHealth({ model: tree, now, updatedAt: now }).underCovered, true);
// Status and degradation follow the quantile block when it exists, not the ridge status.
tree.model.validation.status = "experimental";
tree.model.validation.quantileModel = {
  status: "validated",
  quantiles: { p80: { coverage: 0.82 }, p95: { coverage: 0.96 } },
};
const treeStatus = calibrationHealth({ model: tree, now, updatedAt: now });
assert.equal(treeStatus.validationStatus, "validated");
assert.equal(treeStatus.degraded, false);
tree.model.validation.status = "validated";
tree.model.validation.quantileModel = {
  status: "experimental",
  quantiles: { p80: { coverage: 0.82 }, p95: { coverage: 0.96 } },
};
const treeWeak = calibrationHealth({ model: tree, now, updatedAt: now });
assert.equal(treeWeak.validationStatus, "experimental");
assert.equal(treeWeak.degraded, true);
tree.model.validation.quantileModel = { status: "validated", quantiles: {} };
const treeMissing = calibrationHealth({ model: tree, now, updatedAt: now });
assert.equal(treeMissing.p80Coverage, null, "Malformed tree coverage never falls back to ridge");
assert.equal(treeMissing.underCovered, null);

const revision = assessmentRevision({ model, scorecardVersion: 5 });
assert.equal(assessmentRevision({ model: structuredClone(model), scorecardVersion: 5 }), revision);
assert.notEqual(assessmentRevision({ model, scorecardVersion: 6 }), revision);
const refitted = structuredClone(model);
refitted.model.workload.intercept += 0.1;
assert.notEqual(assessmentRevision({ model: refitted, scorecardVersion: 5 }), revision);
refitted.model.validation.activeCoverage = { total: { p80: 0.7, p95: 0.9 } };
assert.notEqual(assessmentRevision({ model: refitted, scorecardVersion: 5 }), revision);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "triage-calibration-"));
try {
  const file = path.join(directory, "model.json");
  assert.equal(calibrationHealth({ path: file, now }).available, false);
  assert.equal(calibrationHealth({ path: file, now }).degraded, true);
  assert.equal(calibrationHealth({ path: file, now }).underCovered, null);
  fs.writeFileSync(file, JSON.stringify(model.model), { mode: 0o600 });
  fs.utimesSync(file, now / 1000, (now - 500) / 1000);
  assert.equal(calibrationHealth({ path: file, now }).ageMs, 500);
  assert.equal(assessmentRevision({ path: file, scorecardVersion: 5 }), revision);
  const symlink = path.join(directory, "symlink.json");
  fs.symlinkSync(file, symlink);
  assert.equal(calibrationHealth({ path: symlink, now }).available, false);
  assert.equal(calibrationHealth({ path: symlink, now }).updatedAt, null);
  fs.chmodSync(file, 0o644);
  assert.equal(calibrationHealth({ path: file, now }).available, false);
  assert.equal(calibrationHealth({ path: file, now }).updatedAt, null);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "{}");
  assert.equal(calibrationHealth({ path: file, now }).available, false);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(
  "PASS calibration freshness, active coverage gaps, private artifacts, and assessment revisions",
);
