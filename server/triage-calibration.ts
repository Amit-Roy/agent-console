import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  effortModelPath,
  type LoadedEffortModel,
  loadEffortModel,
  validateEffortModel,
} from "./providers/triage-effort.ts";
import { TRIAGE_SCORECARD_VERSION } from "./providers/triage-scorecard.ts";

// Weekly retraining plus a one-day grace period.
const CALIBRATION_MAX_AGE_MS = 8 * 24 * 60 * 60_000;
type ModelOptions = { model?: LoadedEffortModel; path?: string };
type HealthOptions = ModelOptions & { now?: number; updatedAt?: number };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function modelFor(options: ModelOptions): LoadedEffortModel {
  const loaded = options.model ?? loadEffortModel(options.path ?? effortModelPath());
  return loaded.status === "ready" ? validateEffortModel(loaded.model) : loaded;
}

/** Only metadata from an owned private regular file supplies artifact freshness. */
function artifactTimestamp(file: string): number | null {
  try {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      return null;
    return Number.isFinite(stat.mtimeMs) && stat.mtimeMs >= 0 ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Boosted quantile heads price tree quotes, so their held-out coverage is the only coverage that
 * counts when present. Otherwise active estimator results take precedence, and rejected candidate
 * coverage is never substituted when active results exist but are missing or malformed.
 */
function healthCoverage(validation: Record<string, unknown>): unknown {
  const heads = validation.quantileModel;
  if (record(heads)) {
    const levels = record(heads.quantiles) ? heads.quantiles : {};
    const level = (name: string) => (record(levels[name]) ? levels[name].coverage : undefined);
    return { p80: level("p80"), p95: level("p95") };
  }
  const active = record(validation.activeCoverage) ? validation.activeCoverage : null;
  if (!active) return validation.workCoverage;
  return Object.hasOwn(active, "total") ? active.total : active.work;
}

/** Boosted heads own the status when present; otherwise the ridge artifact status applies. */
function healthStatus(validation: Record<string, unknown>): string | null {
  const source = record(validation.quantileModel) ? validation.quantileModel : validation;
  return typeof source.status === "string" ? source.status : null;
}

/** Held-out coverage against the 80% and 95% targets; unknown when either level is missing. */
function coverageHealth(validation: Record<string, unknown>) {
  const coverage = healthCoverage(validation);
  const p80Coverage = probability(record(coverage) ? coverage.p80 : undefined);
  const p95Coverage = probability(record(coverage) ? coverage.p95 : undefined);
  const underCovered =
    (p80Coverage !== null && p80Coverage < 0.8) || (p95Coverage !== null && p95Coverage < 0.95)
      ? true
      : p80Coverage !== null && p95Coverage !== null
        ? false
        : null;
  const gap = (value: number | null, target: number) =>
    value === null ? null : Math.round((value - target) * 10_000) / 100;
  return {
    p80Coverage,
    p95Coverage,
    p80GapPercentagePoints: gap(p80Coverage, 0.8),
    p95GapPercentagePoints: gap(p95Coverage, 0.95),
    underCovered,
  };
}

/** Artifact age in milliseconds, or null when the timestamp or clock is unusable. */
function artifactAge(updatedAt: number | null, now: number): number | null {
  return updatedAt !== null && Number.isFinite(now) && now >= updatedAt ? now - updatedAt : null;
}

/** Calibration quality is separate from receiver health: degraded estimates must not cause restart loops. */
export function calibrationHealth(options: HealthOptions = {}) {
  const loaded = modelFor(options);
  const now = options.now ?? Date.now();
  const timestamp = options.updatedAt ?? artifactTimestamp(options.path ?? effortModelPath());
  const updatedAt =
    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0
      ? timestamp
      : null;
  const ageMs = artifactAge(updatedAt, now);
  const stale = ageMs === null || ageMs >= CALIBRATION_MAX_AGE_MS;
  const available = loaded.status === "ready";
  const validation: Record<string, unknown> = available ? loaded.model.validation : {};
  const status = available ? healthStatus(validation) : null;
  const coverage = coverageHealth(validation);
  return {
    available,
    estimator: available ? (loaded.model.estimator ?? "complexity") : null,
    validationStatus: status,
    updatedAt,
    ageMs,
    stale,
    ...coverage,
    sampleCount: count(validation.sampleCount),
    groupCount: count(validation.groupCount),
    degraded: !available || stale || status !== "validated" || coverage.underCovered !== false,
  };
}

/** Include every validated pricing field so refreshed artifacts invalidate cached assessments. */
export function assessmentRevision(
  options: ModelOptions & { scorecardVersion?: number } = {},
): string {
  const loaded = modelFor(options);
  const source = [
    options.scorecardVersion ?? TRIAGE_SCORECARD_VERSION,
    loaded.status === "ready" ? loaded.model : null,
  ];
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}
