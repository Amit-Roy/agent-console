import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  effortModelPath,
  loadEffortModel,
  validateEffortModel,
  type LoadedEffortModel,
} from "./providers/triage-effort.ts";
import { TRIAGE_SCORECARD_VERSION } from "./providers/triage-scorecard.ts";

const CALIBRATION_MAX_AGE_MS = 24 * 60 * 60_000;
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

/** Calibration quality is separate from receiver health: degraded estimates must not cause restart loops. */
export function calibrationHealth(options: HealthOptions = {}) {
  const loaded = modelFor(options);
  const now = options.now ?? Date.now();
  const timestamp = options.updatedAt ?? artifactTimestamp(options.path ?? effortModelPath());
  const updatedAt =
    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0
      ? timestamp
      : null;
  const ageMs =
    updatedAt !== null && Number.isFinite(now) && now >= updatedAt ? now - updatedAt : null;
  const stale = ageMs === null || ageMs >= CALIBRATION_MAX_AGE_MS;
  const available = loaded.status === "ready";
  const validation = available ? loaded.model.validation : {};
  const active = record(validation.activeCoverage) ? validation.activeCoverage : null;
  // Active estimator results take precedence. Never substitute rejected candidate coverage
  // when active results exist but are missing or malformed.
  const coverage = active
    ? Object.hasOwn(active, "total")
      ? active.total
      : active.work
    : validation.workCoverage;
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
    available,
    estimator: available ? (loaded.model.estimator ?? "complexity") : null,
    validationStatus: available ? loaded.model.validation.status : null,
    updatedAt,
    ageMs,
    stale,
    p80Coverage,
    p95Coverage,
    p80GapPercentagePoints: gap(p80Coverage, 0.8),
    p95GapPercentagePoints: gap(p95Coverage, 0.95),
    underCovered,
    sampleCount: count(validation.sampleCount),
    groupCount: count(validation.groupCount),
    degraded: !available || stale || validation.status !== "validated" || underCovered !== false,
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
