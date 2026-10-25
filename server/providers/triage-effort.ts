import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  predictQuantiles,
  type QuantileTreeModel,
  type RequestFeatureOptions,
  requestFeatures,
  validateQuantileModel,
} from "./triage-quantile.ts";

/** Only pre-work task characteristics enter the effort equation. */
export const LEGACY_EFFORT_FEATURES = ["breadth", "complexity", "uncertainty", "risk"] as const;
/** Deterministic request-shape buckets (0..3). They are always known, so they never depend on a model call. */
export const SHAPE_FEATURES = [
  "requestSize",
  "requestLines",
  "requestReferences",
  "requestActions",
] as const;
export const EFFORT_FEATURES = [...LEGACY_EFFORT_FEATURES, ...SHAPE_FEATURES] as const;
export type EffortFeature = (typeof EFFORT_FEATURES)[number];

const bucket = (value: number, cuts: number[]) => cuts.filter((cut) => value >= cut).length;
const ACTION_VERBS =
  /\b(fix|add|build|implement|create|make|set ?up|write|support|deploy|restart|audit|review|investigate|research|compare|test|remove|update|change|label|merge|push|commit)\b/gi;
/** Size and structure of the initial request. Longer, more structured requests have measurably longer sessions. */
export function requestShape(
  text: string,
): Record<(typeof SHAPE_FEATURES)[number], { value: number }> {
  const lines = text.split("\n").filter((line) => line.trim()).length;
  const references = (text.match(/https?:\/\/|[/~][\w.-]+\/[\w.-]+|`[^`]+`/g) ?? []).length;
  const actions = (text.match(ACTION_VERBS) ?? []).length;
  return {
    requestSize: { value: bucket(text.length, [20, 120, 400]) },
    requestLines: { value: bucket(lines, [2, 4, 8]) },
    requestReferences: { value: bucket(references, [1, 2, 4]) },
    requestActions: { value: bucket(actions, [1, 2, 4]) },
  };
}
export type EffortScope = "completed-delivery-run" | "completed-session";
export type TokenYieldBasis = "actions" | "actions-plus-one" | "workload";
export type EffortWorkloadMetric = "toolCalls" | "totalTokens";
export type EffortEstimator = "complexity" | "historical-baseline";
export type ComplexityInput = Partial<Record<EffortFeature, { value: number | null }>>;
export interface EffortQuantiles {
  p50: number;
  /** Present when the quantile-tree estimator prices the session. */
  p75?: number;
  p80: number;
  p95: number;
  p99?: number;
}
export interface FeatureRange {
  min: number | null;
  max: number | null;
  known: number;
  missing: number;
}
export interface EffortScenario {
  sampleId: string;
  logResidual: number;
  /** Empirical point mass for sessions with explicitly measured zero total usage. */
  zeroWork?: boolean;
  outputPerWork: number;
  /** Whole input can be measured even when cached/non-cached splits are absent. */
  inputPerWork?: number | null;
  freshInputPerWork: number | null;
  cachedInputPerWork: number | null;
  roundsPerWork: number | null;
}
export interface EffortModel {
  schemaVersion: 1;
  /** Missing on legacy artifacts, whose scope is one completed delivery run. */
  scope?: EffortScope;
  tokenYieldBasis?: TokenYieldBasis;
  workloadMetric?: EffortWorkloadMetric;
  estimator?: EffortEstimator;
  method: "nonnegative-ridge-log-work-v1";
  featureNames: readonly EffortFeature[];
  workload: {
    intercept: number;
    coefficients: number[];
    missingCoefficients: number[];
    imputation: number[];
    scale: number[];
    featureRanges: FeatureRange[];
    residualQuantiles: EffortQuantiles;
  };
  scenarios: EffortScenario[];
  /** Direct session quantiles from boosted tree heads; legacy artifacts omit it. */
  quantileModel?: QuantileTreeModel | null;
  workCutoffs: { trivialMax: number; deepMin: number };
  /** Training maximum of the fitted target. Session pricing never exceeds it. */
  workloadCeiling?: number | null;
  validation: { status: "experimental" | "validated"; [key: string]: unknown };
  training: { sampleIds: string[]; [key: string]: unknown };
}
export interface EffortUnavailable {
  status: "unavailable";
  reason: string;
  scope: EffortScope;
}
export type LoadedEffortModel = { status: "ready"; model: EffortModel } | EffortUnavailable;
export interface EffortQuote {
  status: "ready";
  confidence: "experimental" | "validated";
  scope: EffortScope;
  tokenYieldBasis: TokenYieldBasis;
  workloadMetric: EffortWorkloadMetric;
  estimator: EffortEstimator;
  method: EffortModel["method"] | "boosted-trees-quantile-v1";
  /** Token tercile tier, a rough guide only. The triage label follows the level of design. */
  effort: "trivial" | "bau" | "deep";
  /** Explicit routing policy; it does not modify the learned distribution. */
  effortBasis: "p50" | "p95";
  recommendedBudget: "p80" | "p95";
  activity: EffortQuantiles;
  output: EffortQuantiles;
  total: EffortQuantiles | null;
  /** Input includes cached replay once; unknown splits remain unavailable. */
  input: EffortQuantiles | null;
  freshInput: EffortQuantiles | null;
  cachedInput: EffortQuantiles | null;
  rounds: EffortQuantiles | null;
  riskPremium: { work: number; output: number; input: number | null };
  contributions: {
    feature: EffortFeature;
    value: number | null;
    imputed: number;
    logWork: number;
    missingLogWork: number;
  }[];
  unknowns: EffortFeature[];
  outOfRange: EffortFeature[];
  thresholds: EffortModel["workCutoffs"];
  training: EffortModel["training"];
  validation: EffortModel["validation"];
  formula: string;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 2_000;
const unavailable = (reason: string): EffortUnavailable => ({
  status: "unavailable",
  scope: "completed-delivery-run",
  reason,
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min = -1e12, max = 1e12): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ROWS;
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const vector = (value: unknown, min: number, max: number, size = 4): value is number[] =>
  Array.isArray(value) && value.length === size && value.every((item) => finite(item, min, max));
/** Metadata is retained for audit, but cannot inject unbounded or executable data. */
function boundedMetadata(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return finite(value);
  if (typeof value === "string")
    return value.length <= 2_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  if (Array.isArray(value))
    return value.length <= MAX_ROWS && value.every((item) => boundedMetadata(item, depth + 1));
  return (
    record(value) &&
    Object.keys(value).length <= 100 &&
    Object.entries(value).every(
      ([key, item]) =>
        identifier(key) &&
        !["__proto__", "constructor", "prototype"].includes(key) &&
        boundedMetadata(item, depth + 1),
    )
  );
}

/** Tree quotes are only as validated as the boosted heads themselves, never the ridge fit. */
function treeValidationStatus(validation: EffortModel["validation"]): "experimental" | "validated" {
  const heads = validation.quantileModel;
  return record(heads) && heads.status === "validated" ? "validated" : "experimental";
}

type LooseRecord = Record<string, any>;

function malformedHeader(value: LooseRecord): boolean {
  return (
    value.schemaVersion !== 1 ||
    value.method !== "nonnegative-ridge-log-work-v1" ||
    (value.scope !== undefined &&
      value.scope !== "completed-delivery-run" &&
      value.scope !== "completed-session") ||
    (value.tokenYieldBasis !== undefined &&
      !["actions", "actions-plus-one", "workload"].includes(value.tokenYieldBasis as string)) ||
    (value.workloadMetric !== undefined &&
      !["toolCalls", "totalTokens"].includes(value.workloadMetric as string))
  );
}

function malformedEstimator(value: LooseRecord): boolean {
  return (
    (value.estimator !== undefined &&
      !["complexity", "historical-baseline", "quantile-trees"].includes(
        value.estimator as string,
      )) ||
    (value.quantileModel !== undefined &&
      value.quantileModel !== null &&
      validateQuantileModel(value.quantileModel) === null) ||
    (value.workloadMetric === "totalTokens") !== (value.tokenYieldBasis === "workload") ||
    ![LEGACY_EFFORT_FEATURES, SHAPE_FEATURES, EFFORT_FEATURES].some(
      (names) => JSON.stringify(value.featureNames) === JSON.stringify(names),
    ) ||
    !record(value.workload)
  );
}

function malformedWorkload(work: LooseRecord, size: number): boolean {
  return (
    !finite(work.intercept, -40, 40) ||
    !vector(work.coefficients, 0, 40, size) ||
    !vector(work.missingCoefficients, -40, 40, size) ||
    !vector(work.imputation, 0, 3, size) ||
    !vector(work.scale, 1e-9, 100, size) ||
    !Array.isArray(work.featureRanges) ||
    work.featureRanges.length !== size ||
    !record(work.residualQuantiles)
  );
}

function malformedBaseline(value: LooseRecord, work: LooseRecord): boolean {
  return (
    value.estimator === "historical-baseline" &&
    (value.workloadMetric !== "totalTokens" ||
      (work.coefficients as number[]).some((n) => n !== 0) ||
      (work.missingCoefficients as number[]).some((n) => n !== 0))
  );
}

function malformedRange(range: unknown): boolean {
  const item = range as LooseRecord;
  return !(
    record(range) &&
    count(item.known) &&
    count(item.missing) &&
    ((item.known === 0 && item.min === null && item.max === null) ||
      (finite(item.min, 0, 3) && finite(item.max, item.min, 3)))
  );
}

function malformedResidual(residual: LooseRecord): boolean {
  return (
    !finite(residual.p50, -40, 40) ||
    !finite(residual.p80, residual.p50, 40) ||
    !finite(residual.p95, residual.p80, 40)
  );
}

function malformedWorkloadScenario(scenario: LooseRecord): boolean {
  if (!finite(scenario.inputPerWork, 0, 1) || !finite(scenario.outputPerWork, 0, 1)) return true;
  const share = scenario.inputPerWork + scenario.outputPerWork;
  if (scenario.zeroWork === true ? share !== 0 : Math.abs(share - 1) > 1e-8) return true;
  for (const channel of ["freshInputPerWork", "cachedInputPerWork"] as const) {
    if (scenario[channel] !== null && !finite(scenario[channel], 0, scenario.inputPerWork + 1e-8))
      return true;
  }
  return (
    scenario.freshInputPerWork !== null &&
    scenario.cachedInputPerWork !== null &&
    Math.abs(scenario.freshInputPerWork + scenario.cachedInputPerWork - scenario.inputPerWork) >
      1e-8
  );
}

function malformedScenario(scenario: unknown, seen: Set<string>, yieldBasis: unknown): boolean {
  const item = scenario as LooseRecord;
  if (
    !record(scenario) ||
    !identifier(item.sampleId) ||
    seen.has(item.sampleId) ||
    !finite(item.logResidual, -40, 40) ||
    !finite(item.outputPerWork, 0, 1e9)
  )
    return true;
  if (
    item.zeroWork !== undefined &&
    (typeof item.zeroWork !== "boolean" || yieldBasis !== "workload")
  )
    return true;
  if (
    item.inputPerWork !== undefined &&
    item.inputPerWork !== null &&
    !finite(item.inputPerWork, 0, 1e12)
  )
    return true;
  for (const channel of ["freshInputPerWork", "cachedInputPerWork", "roundsPerWork"] as const) {
    if (item[channel] !== null && !finite(item[channel], 0, 1e12)) return true;
  }
  return yieldBasis === "workload" && malformedWorkloadScenario(item);
}

/** Returns the validated sample ids, or undefined when any scenario is malformed. */
function validScenarioIds(value: LooseRecord): Set<string> | undefined {
  if (
    !Array.isArray(value.scenarios) ||
    value.scenarios.length < 3 ||
    value.scenarios.length > MAX_ROWS
  )
    return undefined;
  const seen = new Set<string>();
  for (const scenario of value.scenarios) {
    if (malformedScenario(scenario, seen, value.tokenYieldBasis)) return undefined;
    seen.add((scenario as EffortScenario).sampleId);
  }
  return seen;
}

function malformedTrailer(value: LooseRecord, seen: Set<string>): boolean {
  return (
    !record(value.workCutoffs) ||
    !finite(value.workCutoffs.trivialMax, 0, 1e9) ||
    !finite(value.workCutoffs.deepMin, value.workCutoffs.trivialMax, 1e9) ||
    (value.workloadCeiling !== undefined &&
      value.workloadCeiling !== null &&
      !finite(value.workloadCeiling, 1, 1e15)) ||
    !record(value.validation) ||
    !["experimental", "validated"].includes(value.validation.status as string) ||
    !boundedMetadata(value.validation) ||
    !record(value.training) ||
    !boundedMetadata(value.training) ||
    !Array.isArray(value.training.sampleIds) ||
    value.training.sampleIds.length < 3 ||
    value.training.sampleIds.length > MAX_ROWS ||
    !value.training.sampleIds.every(identifier) ||
    new Set(value.training.sampleIds).size !== value.training.sampleIds.length ||
    [...seen].some((id) => !(value.training.sampleIds as string[]).includes(id))
  );
}

/** Stages run in the original order; the first failing stage rejects the artifact. */
function malformedEffortModel(value: LooseRecord): boolean {
  const work = value.workload;
  const size = (value.featureNames as string[]).length;
  if (malformedWorkload(work, size) || malformedBaseline(value, work)) return true;
  if (work.featureRanges.some(malformedRange) || malformedResidual(work.residualQuantiles))
    return true;
  const seen = validScenarioIds(value);
  if (!seen || malformedTrailer(value, seen)) return true;
  const sampleTotal = (value.training as EffortModel["training"]).sampleIds.length;
  return !work.featureRanges.every(
    (range: FeatureRange) => range.known + range.missing === sampleTotal,
  );
}

/** Reject the whole artifact: partial loading could silently change its learned equation. */
export function validateEffortModel(value: unknown): LoadedEffortModel {
  if (!record(value) || malformedHeader(value) || malformedEstimator(value))
    return unavailable("The effort model is malformed or unsupported.");
  if (malformedEffortModel(value))
    return unavailable("The effort model is malformed or unsupported.");
  return { status: "ready", model: value as unknown as EffortModel };
}

export function effortModelPath(): string {
  return (
    process.env.AGENT_CONSOLE_TRIAGE_EFFORT_MODEL ||
    path.join(os.homedir(), ".config/agent-console/triage-effort-model.json")
  );
}

/** Private local fit artifacts may contain run IDs. Never disclose their contents on failure. */
export function loadEffortModel(file = effortModelPath()): LoadedEffortModel {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      return unavailable(
        "The effort model must be a private regular file owned by the current user.",
      );
    }
    if (stat.size < 1 || stat.size > MAX_BYTES)
      return unavailable("The effort model exceeds its size limit.");
    // Bound the read as well as the stat: a concurrent writer may grow the file.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (bytes === 0) break;
      length += bytes;
    }
    if (length > MAX_BYTES) return unavailable("The effort model exceeds its size limit.");
    const bytes = buffer.subarray(0, length);
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes))
      return unavailable("The private effort model is unavailable or malformed.");
    return validateEffortModel(JSON.parse(decoded));
  } catch {
    return unavailable("The private effort model is unavailable or malformed.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function empiricalQuantile(values: readonly number[], probability: number): number {
  if (
    !values.length ||
    !finite(probability, 0, 1) ||
    !values.every((item) => finite(item, 0, 1e15))
  )
    throw new Error("Invalid empirical effort quantile.");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}
const quantiles = (values: number[], round = true): EffortQuantiles => {
  const result = {
    p50: empiricalQuantile(values, 0.5),
    p80: empiricalQuantile(values, 0.8),
    p95: empiricalQuantile(values, 0.95),
  };
  return round
    ? { p50: Math.ceil(result.p50), p80: Math.ceil(result.p80), p95: Math.ceil(result.p95) }
    : result;
};

type TreeQuantiles = ReturnType<typeof predictQuantiles>;

interface FeatureTally {
  unknowns: EffortFeature[];
  outOfRange: EffortFeature[];
  contributions: EffortQuote["contributions"];
  logWork: number;
}

interface ScenarioValues {
  activity: number[];
  output: number[];
  input: number[];
  total: number[];
  fresh: number[];
  cached: number[];
  rounds: number[];
}

interface PricedChannels {
  total: EffortQuantiles | null;
  activity: EffortQuantiles;
  output: EffortQuantiles | null;
  input: EffortQuantiles | null;
  fresh: EffortQuantiles | null;
  cached: EffortQuantiles | null;
  rounds: EffortQuantiles | null;
}

interface QuoteSettings {
  scope: EffortScope;
  tokenYieldBasis: TokenYieldBasis;
  workloadMetric: EffortWorkloadMetric;
  estimator: EffortEstimator;
}

const RANGE_ERROR = "The effort prediction exceeds its supported range.";

function validMetric(metric: unknown): metric is { value: number | null } {
  return (
    record(metric) &&
    !(metric.value !== null && (!Number.isInteger(metric.value) || !finite(metric.value, 0, 3)))
  );
}

function outsideRange(value: number | null, range: FeatureRange): boolean {
  return (
    value !== null &&
    (!range.known ||
      range.min === null ||
      range.max === null ||
      value < range.min ||
      value > range.max)
  );
}

/** Returns undefined when any feature is malformed. */
function tallyFeatures(model: EffortModel, metrics: ComplexityInput): FeatureTally | undefined {
  const tally: FeatureTally = {
    unknowns: [],
    outOfRange: [],
    contributions: [],
    logWork: model.workload.intercept,
  };
  for (let index = 0; index < model.featureNames.length; index++) {
    const feature = model.featureNames[index];
    const metric = metrics[feature];
    if (!validMetric(metric)) return undefined;
    const value = metric.value as number | null;
    if (value === null) tally.unknowns.push(feature);
    const imputed = value ?? model.workload.imputation[index];
    if (outsideRange(value, model.workload.featureRanges[index])) tally.outOfRange.push(feature);
    const contribution =
      (model.workload.coefficients[index] * imputed) / model.workload.scale[index];
    const missing = value === null ? model.workload.missingCoefficients[index] : 0;
    tally.contributions.push({
      feature,
      value,
      imputed,
      logWork: contribution,
      missingLogWork: missing,
    });
    tally.logWork += contribution + missing;
  }
  return tally;
}

function scenarioInputYield(scenario: EffortScenario): number | null {
  return (
    scenario.inputPerWork ??
    (scenario.freshInputPerWork !== null && scenario.cachedInputPerWork !== null
      ? scenario.freshInputPerWork + scenario.cachedInputPerWork
      : null)
  );
}

function pushScenarioChannels(
  values: ScenarioValues,
  scenario: EffortScenario,
  yieldWork: number,
  output: number,
) {
  if (scenario.freshInputPerWork !== null)
    values.fresh.push(yieldWork * scenario.freshInputPerWork);
  if (scenario.cachedInputPerWork !== null)
    values.cached.push(yieldWork * scenario.cachedInputPerWork);
  const inputYield = scenarioInputYield(scenario);
  if (inputYield !== null) {
    const input = yieldWork * inputYield;
    values.input.push(input);
    values.total.push(input + output);
  }
  if (scenario.roundsPerWork !== null) values.rounds.push(yieldWork * scenario.roundsPerWork);
}

/** Returns undefined when a scenario prices outside the supported range. */
function scenarioValues(
  model: EffortModel,
  tokenYieldBasis: TokenYieldBasis,
  predictedLogWork: number,
): ScenarioValues | undefined {
  const values: ScenarioValues = {
    activity: [],
    output: [],
    input: [],
    total: [],
    fresh: [],
    cached: [],
    rounds: [],
  };
  // A residual tail must not price more session usage than training ever observed.
  const ceiling =
    tokenYieldBasis === "workload" && typeof model.workloadCeiling === "number"
      ? model.workloadCeiling
      : null;
  for (const scenario of model.scenarios) {
    const raw =
      scenario.zeroWork === true
        ? 0
        : Math.max(0, Math.expm1(Math.min(30, predictedLogWork + scenario.logResidual)));
    const activity = ceiling === null ? raw : Math.min(ceiling, raw);
    // Session usage can be positive with zero logged actions. The fitted denominator
    // is explicit so legacy per-action artifacts keep their original arithmetic.
    const yieldWork = activity + (tokenYieldBasis === "actions-plus-one" ? 1 : 0);
    const output = yieldWork * scenario.outputPerWork;
    if (!finite(activity, 0, 1e15) || !finite(output, 0, 1e15)) return undefined;
    values.activity.push(activity);
    values.output.push(output);
    pushScenarioChannels(values, scenario, yieldWork, output);
  }
  const channels = [values.input, values.total, values.fresh, values.cached, values.rounds];
  return channels.every((list) => list.every((item) => finite(item, 0, 1e15))) ? values : undefined;
}

// A channel with missing measurements is unavailable, rather than silently changing cohorts.
function completeQuantiles(expected: number, values: number[], round = true) {
  return values.length === expected ? quantiles(values, round) : null;
}

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scaledQuantiles(
  values: (number | null)[],
  total: EffortQuantiles,
): EffortQuantiles | null {
  const ratio = medianOf(values.filter((value): value is number => value !== null));
  if (ratio === null) return null;
  const round = (value: number) => Math.ceil(value);
  return {
    p50: round(total.p50 * ratio),
    ...(total.p75 === undefined ? {} : { p75: round(total.p75 * ratio) }),
    p80: round(total.p80 * ratio),
    p95: round(total.p95 * ratio),
    ...(total.p99 === undefined ? {} : { p99: round(total.p99 * ratio) }),
  };
}

// Tree heads price the whole session directly. Channel splits keep the observed paired
// shares, so any printed input/output budget still sums to the priced total.
function treeChannels(model: EffortModel, tree: TreeQuantiles): PricedChannels {
  const total: EffortQuantiles = {
    p50: tree.p50,
    p75: tree.p75,
    p80: tree.p80,
    p95: tree.p95,
    p99: tree.p99,
  };
  const share = (pick: (row: EffortScenario) => number | null) =>
    scaledQuantiles(model.scenarios.map(pick), total);
  return {
    total,
    activity: { p50: tree.p50, p75: tree.p75, p80: tree.p80, p95: tree.p95, p99: tree.p99 },
    output: share((row) => row.outputPerWork),
    input: share(scenarioInputYield),
    fresh: share((row) => row.freshInputPerWork),
    cached: share((row) => row.cachedInputPerWork),
    rounds: share((row) => row.roundsPerWork),
  };
}

function scenarioChannels(model: EffortModel, values: ScenarioValues): PricedChannels {
  const expected = model.scenarios.length;
  return {
    total: completeQuantiles(expected, values.total),
    // Keep work continuous for the learned tercile policy; round only token budgets.
    activity: quantiles(values.activity, false),
    output: quantiles(values.output),
    input: completeQuantiles(expected, values.input),
    fresh: completeQuantiles(expected, values.fresh),
    cached: completeQuantiles(expected, values.cached),
    rounds: completeQuantiles(expected, values.rounds, false),
  };
}

function effortTier(
  thresholds: EffortModel["workCutoffs"],
  activity: EffortQuantiles,
  basis: "p50" | "p95",
) {
  if (thresholds.trivialMax === thresholds.deepMin) return "bau";
  if (activity[basis] <= thresholds.trivialMax) return "trivial";
  return activity[basis] >= thresholds.deepMin ? "deep" : "bau";
}

function featureNarrative(featureNames: readonly EffortFeature[]): string {
  if (featureNames.length > 4)
    return "breadth, complexity, uncertainty, risk, and request shape (size, lines, references, action verbs)";
  return featureNames[0] === "requestSize"
    ? "shape (size, lines, references, action verbs)"
    : "breadth, complexity, uncertainty, and risk";
}

function quoteFormula(model: EffortModel, settings: QuoteSettings, tree: boolean): string {
  const { scope, tokenYieldBasis, workloadMetric, estimator } = settings;
  if (tree)
    return `Boosted quantile tree heads predict five session-total quantiles from the initial request text (length, structure, references, action verbs, code fences, paths, tests, checklists) plus the request-shape buckets. Heads are rearranged into a monotone set and capped at the largest observed training total. Input, generated, and cached channels reuse the median observed share of the priced total. P50 routes complete in-range scope; unknown or extrapolated scope routes through P95 by policy. Those are observed session snapshots, including later follow-ups, not human hours.`;
  if (estimator === "historical-baseline")
    return "The complexity fit did not beat the training-median baseline on held-out session totals. This quote uses the empirical training-session usage distribution and paired observed token shares. It does not claim task-specific predictive accuracy. All measured zero-usage sessions remain in that distribution. Total input includes cached replay once; input plus generated output defines total session usage. Initial requests remain the only candidate predictors. Unknown scope selects the P95 reserve by policy. These are historical session snapshots, including later follow-ups, not human hours or guarantees about future resumption.";
  if (workloadMetric === "totalTokens")
    return `Initial-request ${featureNarrative(model.featureNames)} predict log(1 + total session tokens) with nonnegative ridge coefficients. Total session tokens are recorded input plus generated output, including cached replay once. Chronological out-of-fold residuals produce usage scenarios; paired observed input/output/cache shares split those scenarios. Explicitly measured zero-total sessions retain an empirical point mass at zero. Tool counts are optional diagnostics, never the fitted target. Effort tiers compare predicted session tokens against training-session terciles. P50 routes complete in-range scope; unknown or extrapolated scope routes through P95 by policy. Only initial user messages supply predictors; later follow-ups are part of the outcome and add unexplained variance. Raw usage and later conversation never enter the predictors. Unknowns use training-only imputation and remain flagged. These are observed session snapshots, not human hours or guarantees about future resumption.`;
  return `Initial-request breadth, complexity, uncertainty, and risk predict log(1 + tool calls) with nonnegative ridge coefficients. Tool calls are an observed, agent-style-dependent work proxy. Chronological out-of-fold work residuals and observed usage divided by ${tokenYieldBasis === "actions-plus-one" ? "(1 + tool calls)" : "tool calls"} produce P50/P80/P95 budgets. Effort compares predicted tool calls against training ${scope === "completed-session" ? "session" : "delivery-run"} lower/upper terciles; equal cutoffs mean BAU. Explicit routing policy uses P50 effort and P80 planning for complete in-range features, or P95 effort and planning when any feature is unknown or outside training ranges. This policy does not change model budgets or confidence. Input context replay never sets effort. Unknowns use learned imputation and are flagged. ${scope === "completed-session" ? "Scope is one entire completed session/thread, including later follow-ups. Only initial user requests supply predictors; later prompts are unseen at prediction time and add variance. Human hours and unmeasured child agents are not priced." : "Scope is one completed logged delivery run, not a whole issue or human hours."}`;
}

function quoteConfidence(
  model: EffortModel,
  incomplete: boolean,
  tree: boolean,
): "experimental" | "validated" {
  if (incomplete) return "experimental";
  return tree ? treeValidationStatus(model.validation) : model.validation.status;
}

function assembleQuote(
  model: EffortModel,
  settings: QuoteSettings,
  tally: FeatureTally,
  channels: PricedChannels,
  values: ScenarioValues,
  tree: boolean,
): EffortQuote {
  const thresholds = model.workCutoffs;
  // Out-of-sample residuals already include the usual share of unknown model-extracted metrics, so
  // when request-shape features exist only unknown shape features (never expected) or extrapolation force P95.
  const required: readonly EffortFeature[] = model.featureNames.some((name) =>
    (SHAPE_FEATURES as readonly string[]).includes(name),
  )
    ? SHAPE_FEATURES
    : model.featureNames;
  const incomplete =
    tally.unknowns.some((name) => required.includes(name)) || tally.outOfRange.length > 0;
  const effortBasis = incomplete ? "p95" : "p50";
  const output = channels.output ?? quantiles(values.output);
  return {
    status: "ready",
    confidence: quoteConfidence(model, incomplete, tree),
    scope: settings.scope,
    tokenYieldBasis: settings.tokenYieldBasis,
    workloadMetric: settings.workloadMetric,
    estimator: settings.estimator,
    method: tree ? "boosted-trees-quantile-v1" : model.method,
    effort: effortTier(thresholds, channels.activity, effortBasis),
    effortBasis,
    recommendedBudget: incomplete ? "p95" : "p80",
    activity: channels.activity,
    output,
    total: channels.total,
    input: channels.input,
    freshInput: channels.fresh,
    cachedInput: channels.cached,
    rounds: channels.rounds,
    riskPremium: {
      work: channels.activity.p80 - channels.activity.p50,
      output: output.p80 - output.p50,
      input: channels.input ? channels.input.p80 - channels.input.p50 : null,
    },
    contributions: tally.contributions,
    unknowns: tally.unknowns,
    outOfRange: tally.outOfRange,
    thresholds,
    training: model.training,
    validation: model.validation,
    formula: quoteFormula(model, settings, tree),
  };
}

/** The small model supplies four evidence-backed features; it never selects labels or prices. */
export function quoteEffort(
  metrics: ComplexityInput,
  loaded: LoadedEffortModel = loadEffortModel(),
  requestText?: string,
  featureOptions?: RequestFeatureOptions,
): EffortQuote | EffortUnavailable {
  if (loaded.status !== "ready") return loaded;
  const validated = validateEffortModel(loaded.model);
  if (validated.status !== "ready") return validated;
  if (!record(metrics)) return unavailable("Pre-work complexity features are invalid.");
  const model = validated.model;
  const settings: QuoteSettings = {
    scope: model.scope ?? "completed-delivery-run",
    tokenYieldBasis: model.tokenYieldBasis ?? "actions",
    workloadMetric: model.workloadMetric ?? "toolCalls",
    estimator: model.estimator ?? "complexity",
  };
  const tally = tallyFeatures(model, metrics);
  if (!tally) return unavailable("Pre-work complexity features are invalid.");
  // No extrapolation is hidden: range and missing-feature warnings remain in the quote.
  // Match the offline fitter's numerical bounds before applying paired residuals.
  const predictedLogWork = Math.max(0, Math.min(30, tally.logWork));
  const values = scenarioValues(model, settings.tokenYieldBasis, predictedLogWork);
  if (!values) return unavailable(RANGE_ERROR);
  const tree =
    model.quantileModel && typeof requestText === "string" && requestText.trim()
      ? predictQuantiles(model.quantileModel, requestFeatures(requestText, featureOptions))
      : null;
  const channels = tree ? treeChannels(model, tree) : scenarioChannels(model, values);
  return assembleQuote(model, settings, tally, channels, values, !!tree);
}
