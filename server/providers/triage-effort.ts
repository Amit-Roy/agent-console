import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Only pre-work task characteristics enter the effort equation. */
export const LEGACY_EFFORT_FEATURES = ["breadth", "complexity", "uncertainty", "risk"] as const;
/** Deterministic request-shape buckets (0..3). They are always known, so they never depend on a model call. */
export const SHAPE_FEATURES = ["requestSize", "requestLines", "requestReferences", "requestActions"] as const;
export const EFFORT_FEATURES = [...LEGACY_EFFORT_FEATURES, ...SHAPE_FEATURES] as const;
export type EffortFeature = typeof EFFORT_FEATURES[number];

const bucket = (value: number, cuts: number[]) => cuts.filter(cut => value >= cut).length;
const ACTION_VERBS = /\b(fix|add|build|implement|create|make|set ?up|write|support|deploy|restart|audit|review|investigate|research|compare|test|remove|update|change|label|merge|push|commit)\b/gi;
/** Size and structure of the initial request. Longer, more structured requests have measurably longer sessions. */
export function requestShape(text: string): Record<typeof SHAPE_FEATURES[number], { value: number }> {
  const lines = text.split("\n").filter(line => line.trim()).length;
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
export interface EffortQuantiles { p50: number; p80: number; p95: number }
export interface FeatureRange { min: number | null; max: number | null; known: number; missing: number }
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
  workCutoffs: { trivialMax: number; deepMin: number };
  validation: { status: "experimental" | "validated"; [key: string]: unknown };
  training: { sampleIds: string[]; [key: string]: unknown };
}
export interface EffortUnavailable { status: "unavailable"; reason: string; scope: EffortScope }
export type LoadedEffortModel = { status: "ready"; model: EffortModel } | EffortUnavailable;
export interface EffortQuote {
  status: "ready";
  confidence: "experimental" | "validated";
  scope: EffortScope;
  tokenYieldBasis: TokenYieldBasis;
  workloadMetric: EffortWorkloadMetric;
  estimator: EffortEstimator;
  method: EffortModel["method"];
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
  contributions: { feature: EffortFeature; value: number | null; imputed: number; logWork: number; missingLogWork: number }[];
  unknowns: EffortFeature[];
  outOfRange: EffortFeature[];
  thresholds: EffortModel["workCutoffs"];
  training: EffortModel["training"];
  validation: EffortModel["validation"];
  formula: string;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 2_000;
const unavailable = (reason: string): EffortUnavailable => ({ status: "unavailable", scope: "completed-delivery-run", reason });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min = -1e12, max = 1e12): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ROWS;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const vector = (value: unknown, min: number, max: number, size = 4): value is number[] => Array.isArray(value) && value.length === size && value.every(item => finite(item, min, max));
/** Metadata is retained for audit, but cannot inject unbounded or executable data. */
function boundedMetadata(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return finite(value);
  if (typeof value === "string") return value.length <= 2_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  if (Array.isArray(value)) return value.length <= MAX_ROWS && value.every(item => boundedMetadata(item, depth + 1));
  return record(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) => identifier(key) && !["__proto__", "constructor", "prototype"].includes(key) && boundedMetadata(item, depth + 1));
}

/** Reject the whole artifact: partial loading could silently change its learned equation. */
export function validateEffortModel(value: unknown): LoadedEffortModel {
  const invalid = () => unavailable("The effort model is malformed or unsupported.");
  if (!record(value) || value.schemaVersion !== 1 || value.method !== "nonnegative-ridge-log-work-v1"
    || (value.scope !== undefined && value.scope !== "completed-delivery-run" && value.scope !== "completed-session")
    || (value.tokenYieldBasis !== undefined && !["actions", "actions-plus-one", "workload"].includes(value.tokenYieldBasis as string))
    || (value.workloadMetric !== undefined && !["toolCalls", "totalTokens"].includes(value.workloadMetric as string))
    || (value.estimator !== undefined && !["complexity", "historical-baseline"].includes(value.estimator as string))
    || ((value.workloadMetric === "totalTokens") !== (value.tokenYieldBasis === "workload"))
    || ![LEGACY_EFFORT_FEATURES, SHAPE_FEATURES, EFFORT_FEATURES].some(names => JSON.stringify(value.featureNames) === JSON.stringify(names)) || !record(value.workload)) return invalid();
  const work = value.workload;
  const size = (value.featureNames as string[]).length;
  if (!finite(work.intercept, -40, 40) || !vector(work.coefficients, 0, 40, size) || !vector(work.missingCoefficients, -40, 40, size)
    || !vector(work.imputation, 0, 3, size) || !vector(work.scale, 1e-9, 100, size)
    || !Array.isArray(work.featureRanges) || work.featureRanges.length !== size || !record(work.residualQuantiles)) return invalid();
  if (value.estimator === "historical-baseline" && (value.workloadMetric !== "totalTokens"
    || (work.coefficients as number[]).some(n => n !== 0) || (work.missingCoefficients as number[]).some(n => n !== 0))) return invalid();
  if (!work.featureRanges.every(range => record(range) && count(range.known) && count(range.missing)
    && ((range.known === 0 && range.min === null && range.max === null)
      || (finite(range.min, 0, 3) && finite(range.max, range.min, 3))))) return invalid();
  const residual = work.residualQuantiles;
  if (!finite(residual.p50, -40, 40) || !finite(residual.p80, residual.p50, 40) || !finite(residual.p95, residual.p80, 40)) return invalid();
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 3 || value.scenarios.length > MAX_ROWS) return invalid();
  const seen = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!record(scenario) || !identifier(scenario.sampleId) || seen.has(scenario.sampleId)
      || !finite(scenario.logResidual, -40, 40) || !finite(scenario.outputPerWork, 0, 1e9)) return invalid();
    if (scenario.zeroWork !== undefined && (typeof scenario.zeroWork !== "boolean" || value.tokenYieldBasis !== "workload")) return invalid();
    if (scenario.inputPerWork !== undefined && scenario.inputPerWork !== null && !finite(scenario.inputPerWork, 0, 1e12)) return invalid();
    for (const channel of ["freshInputPerWork", "cachedInputPerWork", "roundsPerWork"] as const) {
      if (scenario[channel] !== null && !finite(scenario[channel], 0, 1e12)) return invalid();
    }
    if (value.tokenYieldBasis === "workload") {
      if (!finite(scenario.inputPerWork, 0, 1) || !finite(scenario.outputPerWork, 0, 1)) return invalid();
      const share = scenario.inputPerWork + scenario.outputPerWork;
      if (scenario.zeroWork === true ? share !== 0 : Math.abs(share - 1) > 1e-8) return invalid();
      for (const channel of ["freshInputPerWork", "cachedInputPerWork"] as const) {
        if (scenario[channel] !== null && !finite(scenario[channel], 0, scenario.inputPerWork + 1e-8)) return invalid();
      }
      if (scenario.freshInputPerWork !== null && scenario.cachedInputPerWork !== null
        && Math.abs(scenario.freshInputPerWork + scenario.cachedInputPerWork - scenario.inputPerWork) > 1e-8) return invalid();
    }
    seen.add(scenario.sampleId);
  }
  if (!record(value.workCutoffs) || !finite(value.workCutoffs.trivialMax, 0, 1e9)
    || !finite(value.workCutoffs.deepMin, value.workCutoffs.trivialMax, 1e9)
    || !record(value.validation) || !["experimental", "validated"].includes(value.validation.status as string)
    || !boundedMetadata(value.validation) || !record(value.training) || !boundedMetadata(value.training)
    || !Array.isArray(value.training.sampleIds) || value.training.sampleIds.length < 3 || value.training.sampleIds.length > MAX_ROWS
    || !value.training.sampleIds.every(identifier) || new Set(value.training.sampleIds).size !== value.training.sampleIds.length
    || [...seen].some(id => !(value.training.sampleIds as string[]).includes(id))) return invalid();
  if (!work.featureRanges.every(range => (range as FeatureRange).known + (range as FeatureRange).missing === (value.training as EffortModel["training"]).sampleIds.length)) return invalid();
  return { status: "ready", model: value as unknown as EffortModel };
}

export function effortModelPath(): string {
  return process.env.AGENT_CONSOLE_TRIAGE_EFFORT_MODEL || path.join(os.homedir(), ".config/agent-console/triage-effort-model.json");
}

/** Private local fit artifacts may contain run IDs. Never disclose their contents on failure. */
export function loadEffortModel(file = effortModelPath()): LoadedEffortModel {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      return unavailable("The effort model must be a private regular file owned by the current user.");
    }
    if (stat.size < 1 || stat.size > MAX_BYTES) return unavailable("The effort model exceeds its size limit.");
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
    if (!Buffer.from(decoded, "utf8").equals(bytes)) return unavailable("The private effort model is unavailable or malformed.");
    return validateEffortModel(JSON.parse(decoded));
  } catch { return unavailable("The private effort model is unavailable or malformed."); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function empiricalQuantile(values: readonly number[], probability: number): number {
  if (!values.length || !finite(probability, 0, 1) || !values.every(item => finite(item, 0, 1e15))) throw new Error("Invalid empirical effort quantile.");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}
const quantiles = (values: number[], round = true): EffortQuantiles => {
  const result = { p50: empiricalQuantile(values, 0.5), p80: empiricalQuantile(values, 0.8), p95: empiricalQuantile(values, 0.95) };
  return round ? { p50: Math.ceil(result.p50), p80: Math.ceil(result.p80), p95: Math.ceil(result.p95) } : result;
};

/** The small model supplies four evidence-backed features; it never selects labels or prices. */
export function quoteEffort(metrics: ComplexityInput, loaded: LoadedEffortModel = loadEffortModel()): EffortQuote | EffortUnavailable {
  if (loaded.status !== "ready") return loaded;
  const validated = validateEffortModel(loaded.model);
  if (validated.status !== "ready") return validated;
  if (!record(metrics)) return unavailable("Pre-work complexity features are invalid.");
  const model = validated.model;
  const scope = model.scope ?? "completed-delivery-run";
  const tokenYieldBasis = model.tokenYieldBasis ?? "actions";
  const workloadMetric = model.workloadMetric ?? "toolCalls";
  const estimator = model.estimator ?? "complexity";
  const unknowns: EffortFeature[] = [];
  const outOfRange: EffortFeature[] = [];
  const contributions: EffortQuote["contributions"] = [];
  let logWork = model.workload.intercept;
  for (let index = 0; index < model.featureNames.length; index++) {
    const feature = model.featureNames[index];
    const metric = metrics[feature];
    if (!record(metric) || (metric.value !== null && (!Number.isInteger(metric.value) || !finite(metric.value, 0, 3)))) return unavailable("Pre-work complexity features are invalid.");
    const value = metric.value as number | null;
    if (value === null) unknowns.push(feature);
    const imputed = value ?? model.workload.imputation[index];
    const range = model.workload.featureRanges[index];
    if (value !== null && (!range.known || range.min === null || range.max === null || value < range.min || value > range.max)) outOfRange.push(feature);
    const contribution = model.workload.coefficients[index] * imputed / model.workload.scale[index];
    const missing = value === null ? model.workload.missingCoefficients[index] : 0;
    contributions.push({ feature, value, imputed, logWork: contribution, missingLogWork: missing });
    logWork += contribution + missing;
  }
  // No extrapolation is hidden: range and missing-feature warnings remain in the quote.
  const activityValues: number[] = [];
  const outputValues: number[] = [];
  const inputValues: number[] = [];
  const totalValues: number[] = [];
  const freshValues: number[] = [];
  const cachedValues: number[] = [];
  const roundValues: number[] = [];
  // Match the offline fitter's numerical bounds before applying paired residuals.
  const predictedLogWork = Math.max(0, Math.min(30, logWork));
  for (const scenario of model.scenarios) {
    const activity = scenario.zeroWork === true ? 0 : Math.max(0, Math.expm1(Math.min(30, predictedLogWork + scenario.logResidual)));
    // Session usage can be positive with zero logged actions. The fitted denominator
    // is explicit so legacy per-action artifacts keep their original arithmetic.
    const yieldWork = activity + (tokenYieldBasis === "actions-plus-one" ? 1 : 0);
    const output = yieldWork * scenario.outputPerWork;
    if (!finite(activity, 0, 1e15) || !finite(output, 0, 1e15)) return unavailable("The effort prediction exceeds its supported range.");
    activityValues.push(activity);
    outputValues.push(output);
    if (scenario.freshInputPerWork !== null) freshValues.push(yieldWork * scenario.freshInputPerWork);
    if (scenario.cachedInputPerWork !== null) cachedValues.push(yieldWork * scenario.cachedInputPerWork);
    const inputYield = scenario.inputPerWork ?? (scenario.freshInputPerWork !== null && scenario.cachedInputPerWork !== null
      ? scenario.freshInputPerWork + scenario.cachedInputPerWork : null);
    if (inputYield !== null) {
      const input = yieldWork * inputYield;
      inputValues.push(input);
      totalValues.push(input + output);
    }
    if (scenario.roundsPerWork !== null) roundValues.push(yieldWork * scenario.roundsPerWork);
  }
  if (![inputValues, totalValues, freshValues, cachedValues, roundValues].every(values => values.every(item => finite(item, 0, 1e15)))) return unavailable("The effort prediction exceeds its supported range.");
  // Keep work continuous for the learned tercile policy; round only token budgets.
  const activity = quantiles(activityValues, false);
  const output = quantiles(outputValues);
  // A channel with missing measurements is unavailable, rather than silently changing cohorts.
  const complete = (values: number[], round = true) => values.length === model.scenarios.length ? quantiles(values, round) : null;
  const input = complete(inputValues);
  const thresholds = model.workCutoffs;
  // Out-of-sample residuals already include the usual share of unknown model-extracted metrics, so
  // when request-shape features exist only unknown shape features (never expected) or extrapolation force P95.
  const required: readonly EffortFeature[] = model.featureNames.some(name => (SHAPE_FEATURES as readonly string[]).includes(name)) ? SHAPE_FEATURES : model.featureNames;
  const incomplete = unknowns.some(name => required.includes(name)) || outOfRange.length > 0;
  const effortBasis = incomplete ? "p95" : "p50";
  const recommendedBudget = incomplete ? "p95" : "p80";
  const effort = thresholds.trivialMax === thresholds.deepMin ? "bau"
    : activity[effortBasis] <= thresholds.trivialMax ? "trivial" : activity[effortBasis] >= thresholds.deepMin ? "deep" : "bau";
  return {
    status: "ready", confidence: incomplete ? "experimental" : model.validation.status,
    scope, tokenYieldBasis, workloadMetric, estimator, method: model.method, effort, effortBasis, recommendedBudget,
    activity, output, total: complete(totalValues), input, freshInput: complete(freshValues), cachedInput: complete(cachedValues), rounds: complete(roundValues, false),
    riskPremium: { work: activity.p80 - activity.p50, output: output.p80 - output.p50, input: input ? input.p80 - input.p50 : null },
    contributions, unknowns, outOfRange, thresholds, training: model.training, validation: model.validation,
    formula: estimator === "historical-baseline"
      ? "The complexity fit did not beat the training-median baseline on held-out session totals. This quote uses the empirical training-session usage distribution and paired observed token shares. It does not claim task-specific predictive accuracy. All measured zero-usage sessions remain in that distribution. Total input includes cached replay once; input plus generated output defines total session usage. Initial requests remain the only candidate predictors. Unknown scope selects the P95 reserve by policy. These are historical session snapshots, including later follow-ups, not human hours or guarantees about future resumption."
      : workloadMetric === "totalTokens"
      ? `Initial-request ${model.featureNames.length > 4 ? "breadth, complexity, uncertainty, risk, and request shape (size, lines, references, action verbs)" : model.featureNames[0] === "requestSize" ? "shape (size, lines, references, action verbs)" : "breadth, complexity, uncertainty, and risk"} predict log(1 + total session tokens) with nonnegative ridge coefficients. Total session tokens are recorded input plus generated output, including cached replay once. Chronological out-of-fold residuals produce usage scenarios; paired observed input/output/cache shares split those scenarios. Explicitly measured zero-total sessions retain an empirical point mass at zero. Tool counts are optional diagnostics, never the fitted target. Effort tiers compare predicted session tokens against training-session terciles. P50 routes complete in-range scope; unknown or extrapolated scope routes through P95 by policy. Only initial user messages supply predictors; later follow-ups are part of the outcome and add unexplained variance. Raw usage and later conversation never enter the predictors. Unknowns use training-only imputation and remain flagged. These are observed session snapshots, not human hours or guarantees about future resumption.`
      : `Initial-request breadth, complexity, uncertainty, and risk predict log(1 + tool calls) with nonnegative ridge coefficients. Tool calls are an observed, agent-style-dependent work proxy. Chronological out-of-fold work residuals and observed usage divided by ${tokenYieldBasis === "actions-plus-one" ? "(1 + tool calls)" : "tool calls"} produce P50/P80/P95 budgets. Effort compares predicted tool calls against training ${scope === "completed-session" ? "session" : "delivery-run"} lower/upper terciles; equal cutoffs mean BAU. Explicit routing policy uses P50 effort and P80 planning for complete in-range features, or P95 effort and planning when any feature is unknown or outside training ranges. This policy does not change model budgets or confidence. Input context replay never sets effort. Unknowns use learned imputation and are flagged. ${scope === "completed-session" ? "Scope is one entire completed session/thread, including later follow-ups. Only initial user requests supply predictors; later prompts are unseen at prediction time and add variance. Human hours and unmeasured child agents are not priced." : "Scope is one completed logged delivery run, not a whole issue or human hours."}`,
  };
}
