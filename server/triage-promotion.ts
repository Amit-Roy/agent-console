import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const P80_MIN = 0.75;
const P80_MAX = 0.92;
const P95_MIN = 0.9;
const PINBALL_TOLERANCE = 1.02;
const PINBALL_HARD_CAP = 1.1;
const MIN_CHAMPION_SAMPLES = 20;

export type PromotionMetrics = {
  p80Coverage: number | null;
  p95Coverage: number | null;
  meanPinball: number | null;
  championMeanPinball: number | null;
  championSampleCount: number | null;
};
export type PromotionDecision = {
  promote: boolean;
  reasons: string[];
  bootstrap: boolean;
  metrics: PromotionMetrics;
};
type Challenger = { p80Coverage: number; p95Coverage: number; meanPinball: number };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const fixed = (value: number) => value.toFixed(2);
const fixedPinball = (value: number) => value.toFixed(4);

function coverageOf(model: Record<string, unknown>, key: string): number | null {
  const quantiles = model.quantiles;
  const entry = record(quantiles) ? quantiles[key] : null;
  return record(entry) && finite(entry.pinball) && finite(entry.coverage) ? entry.coverage : null;
}

function readChallenger(
  artifact: unknown,
): { model: Record<string, unknown>; value: Challenger } | null {
  const validation = record(artifact) ? artifact.validation : null;
  const model = record(validation) ? validation.quantileModel : null;
  if (!record(model) || !finite(model.meanPinball)) return null;
  const p80Coverage = coverageOf(model, "p80");
  const p95Coverage = coverageOf(model, "p95");
  if (p80Coverage === null || p95Coverage === null) return null;
  return { model, value: { p80Coverage, p95Coverage, meanPinball: model.meanPinball } };
}

function coverageReasons(value: Challenger): string[] {
  const reasons: string[] = [];
  if (value.p80Coverage < P80_MIN)
    reasons.push(`p80 coverage ${fixed(value.p80Coverage)} is below ${fixed(P80_MIN)}.`);
  if (value.p80Coverage > P80_MAX)
    reasons.push(`p80 coverage ${fixed(value.p80Coverage)} is above ${fixed(P80_MAX)}.`);
  if (value.p95Coverage < P95_MIN)
    reasons.push(`p95 coverage ${fixed(value.p95Coverage)} is below ${fixed(P95_MIN)}.`);
  return reasons;
}

type PairedDelta = { mean: number; lower90: number; upper90: number };

function readPairedDelta(champion: unknown): PairedDelta | null {
  const delta = record(champion) ? champion.pairedDelta : null;
  if (!record(delta)) return null;
  const { mean, lower90, upper90 } = delta;
  return finite(mean) && finite(lower90) && finite(upper90) ? { mean, lower90, upper90 } : null;
}

/** Statistical gate when a paired bootstrap exists, else the plain ratio tolerance. */
function pinballReasons(value: Challenger, baseline: number, model: Record<string, unknown>) {
  const reasons: string[] = [];
  const delta = readPairedDelta(model.champion);
  if (delta) {
    if (delta.lower90 > 0)
      reasons.push(
        `pinball worse: delta ${fixed(delta.mean)} [${fixed(delta.lower90)},${fixed(delta.upper90)}]`,
      );
    if (value.meanPinball > PINBALL_HARD_CAP * baseline)
      reasons.push(
        `pinball ratio ${fixed(value.meanPinball / baseline)} above cap ${fixed(PINBALL_HARD_CAP)}`,
      );
  } else if (value.meanPinball > PINBALL_TOLERANCE * baseline) {
    reasons.push(
      `challenger mean pinball ${fixedPinball(value.meanPinball)} exceeds ${PINBALL_TOLERANCE} times champion ${fixedPinball(baseline)}.`,
    );
  }
  return reasons;
}

/** Returns the champion mean pinball when it is a scoreable baseline, else why it is not. */
function championBaseline(
  model: Record<string, unknown>,
): { mean: number; samples: number } | string {
  const champion = model.champion;
  if (!record(champion)) return "champion unscoreable: no champion result in artifact.";
  const samples = finite(champion.sampleCount) ? champion.sampleCount : 0;
  if (champion.scoreable !== true) {
    const reason =
      typeof champion.reason === "string" && champion.reason ? champion.reason : "unknown";
    return `champion unscoreable: ${reason}.`;
  }
  if (samples < MIN_CHAMPION_SAMPLES)
    return `champion unscoreable: only ${samples} samples, need ${MIN_CHAMPION_SAMPLES}.`;
  if (!finite(champion.meanPinball)) return "champion unscoreable: mean pinball is missing.";
  return { mean: champion.meanPinball, samples };
}

function decide(artifact: unknown, compareChampion: boolean): PromotionDecision {
  const metrics: PromotionMetrics = {
    p80Coverage: null,
    p95Coverage: null,
    meanPinball: null,
    championMeanPinball: null,
    championSampleCount: null,
  };
  const challenger = readChallenger(artifact);
  if (!challenger)
    return {
      promote: false,
      reasons: ["challenger has no quantile trees."],
      bootstrap: false,
      metrics,
    };
  const { model, value } = challenger;
  metrics.p80Coverage = value.p80Coverage;
  metrics.p95Coverage = value.p95Coverage;
  metrics.meanPinball = value.meanPinball;
  const failures = coverageReasons(value);
  if (model.beatsPinballBaseline !== true)
    failures.push("challenger does not beat the pinball baseline.");
  const notes: string[] = [];
  let bootstrap = false;
  if (compareChampion) {
    const baseline = championBaseline(model);
    if (typeof baseline === "string") {
      bootstrap = true;
      notes.push(`${baseline} Comparison skipped (bootstrap).`);
    } else {
      metrics.championMeanPinball = baseline.mean;
      metrics.championSampleCount = baseline.samples;
      failures.push(...pinballReasons(value, baseline.mean, model));
    }
  }
  return { promote: failures.length === 0, reasons: [...failures, ...notes], bootstrap, metrics };
}

/** Decides whether a freshly fitted challenger replaces the installed model. Never throws. */
export function promotionDecision(
  artifact: unknown,
  options: { compareChampion?: boolean } = {},
): PromotionDecision {
  try {
    return decide(artifact, options?.compareChampion !== false);
  } catch {
    return {
      promote: false,
      reasons: ["challenger has no quantile trees."],
      bootstrap: false,
      metrics: {
        p80Coverage: null,
        p95Coverage: null,
        meanPinball: null,
        championMeanPinball: null,
        championSampleCount: null,
      },
    };
  }
}

export const EFFORT_STEPS = ["sessions", "features", "fit", "gate", "promote", "reprice"] as const;
export type EffortStep = (typeof EFFORT_STEPS)[number];
export type EffortConfig = { enabled: boolean; steps: Record<EffortStep, boolean> };

export function effortConfigPath(): string {
  const dir = process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");
  return path.join(dir, "effort-model.json");
}

const defaultEffortConfig = (): EffortConfig => ({
  enabled: true,
  steps: Object.fromEntries(EFFORT_STEPS.map((step) => [step, true])) as Record<
    EffortStep,
    boolean
  >,
});

/** Missing or invalid files and non-boolean values fall back to all-true defaults. */
export function readEffortConfig(file: string = effortConfigPath()): EffortConfig {
  const config = defaultEffortConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return config;
  }
  if (!record(parsed)) return config;
  if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
  const steps = parsed.steps;
  if (record(steps))
    for (const step of EFFORT_STEPS) {
      const flag = steps[step];
      if (typeof flag === "boolean") config.steps[step] = flag;
    }
  return config;
}

/** Atomic private write: temp file in the same directory, then rename. */
export function writeEffortConfig(next: EffortConfig, file: string = effortConfigPath()): void {
  const merged = defaultEffortConfig();
  merged.enabled = next.enabled === true;
  for (const step of EFFORT_STEPS) merged.steps[step] = next.steps?.[step] === true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(staging, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(staging, 0o600);
    fs.renameSync(staging, file);
  } catch (error) {
    fs.rmSync(staging, { force: true });
    throw error;
  }
}
