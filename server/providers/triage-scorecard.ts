import { quoteEffort, type EffortQuote, type LoadedEffortModel } from "./triage-effort.ts";

/** Initial-request complexity predicts observed session usage; later outcomes are not features. */
export const TRIAGE_SCORECARD_VERSION = 6;
export const METRIC_MAX = { breadth: 3, complexity: 3, uncertainty: 3, risk: 3, impact: 3, urgency: 2, frequency: 2 } as const;
export type MetricName = keyof typeof METRIC_MAX;
export interface MetricEvidence { value: number | null; evidence: string | null }
/** Planning inference is separate from the frozen historical pricing predictors. */
export interface PlanningMetricEvidence extends MetricEvidence {
  basis: "observed" | "inferred" | null;
  rationale: string | null;
}
export interface WorkStep { step: string; check: string }
export interface ScorecardFacts { changedFiles?: number; additions?: number; deletions?: number }
export interface TriageScorecard {
  version: typeof TRIAGE_SCORECARD_VERSION;
  metrics: Record<MetricName, MetricEvidence>;
  planningMetrics?: Record<MetricName, PlanningMetricEvidence>;
  unknowns: MetricName[];
  facts: ScorecardFacts;
  work: WorkStep[];
  design: { level: "none" | "light" | "detailed"; reason: string };
  tokens: { input: [number, number] | null; output: [number, number]; formula: string; confidence: "experimental" | "validated" };
  pricing: EffortQuote;
}
export interface AssessmentInput extends ScorecardFacts { title: string; body: string; files?: string[] }
export interface ExtractedAssessment { metrics: Record<MetricName, MetricEvidence>; planningMetrics?: Record<MetricName, PlanningMetricEvidence>; work: WorkStep[] }

/** Unknowns must remain visible; defaults are planning assumptions, never evidence. */
export const UNKNOWN_DEFAULTS: Record<MetricName, number> = {
  breadth: 1, complexity: 1, uncertainty: 2, risk: 1, impact: 1, urgency: 0, frequency: 0,
};
export const TRIAGE_RULES = {
  effort: "Initial-request breadth, behavior complexity, uncertainty, and risk enter a learned nonnegative log-usage equation. Current session models fit total recorded input plus output tokens directly; tool counts are optional diagnostics. Effort tiers use training-session token terciles. P50 routes known scope; P95 routes unknown or extrapolated scope by policy. Chronological out-of-fold residuals and paired token shares produce budgets. Raw usage is the supervised outcome, never a complexity feature. Later conversation and realized PR diffs never enter predictors. Legacy artifacts retain their declared workload metric. Session usage is not human hours.",
  priority: "P0 if urgency =2, impact =3, and risk ≥2. Otherwise P1 if impact =3 or impact ≥2 and frequency =2. Otherwise P3 if impact =0; otherwise P2.",
  design: "Detailed if breadth =3, complexity =3, uncertainty =3, or risk ≥2. Otherwise None if breadth =0, complexity =0, uncertainty ≤1, and risk ≤1; otherwise Light.",
  unknowns: "Unknowns remain visible. Priority/design defaults: breadth 1, complexity 1, uncertainty 2, risk 1, impact 1, urgency 0, frequency 0. Effort never uses these defaults or model-proposed work-step counts.",
} as const;

function plainText(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** P0 requires a quoted current incident, not just a word such as "deployment". */
function confirmedIncident(quote: string): boolean {
  if (/\b(prevent(?:s|ing|ion)?|avoid(?:s|ing)?|potential|hypothetical|proposed|safeguard|could|would|might|if|future|possible|possibility|risk|no|not|never)\b/i.test(quote)) return false;
  const incident = /\b(outage|down|unavailable|data loss|losing data|security incident|breach|leak(?:ing)?|compromis(?:ed|e))\b/i;
  const current = /\b(active|ongoing|currently|now|continues)\b|\b(?:is|are)\s+(?:an?\s+)?(?:down|unavailable|outage|leaking|losing data|data loss)\b/i;
  return incident.test(quote) && current.test(quote);
}

/** Recurrence and timing are facts; source quotes must state them explicitly. */
function supportedPlanningFact(name: MetricName, value: number, quote: string): boolean {
  if (name === "urgency") {
    if (value === 2) return confirmedIncident(quote);
    if (value === 0) return /\b(no (?:deadline|rush|urgency)|not urgent|no time pressure|whenever|no active incident)\b/i.test(quote);
    return /\b(deadline|due|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)|before (?:release|launch)|this week|tomorrow)\b/i.test(quote);
  }
  if (name === "frequency") {
    if (/\b(no|not|never|might|could|potential|future|if)\b/i.test(quote)) return false;
    return value === 0 ? /\b(one[- ]off|one time|once only|single occurrence)\b/i.test(quote)
      : value === 1 ? /\b(occasionally|occasional|sometimes|infrequent|rarely)\b/i.test(quote)
      : /\b(repeated(?:ly)?|daily|every (?:day|build|session|time|run)|per[- ](?:build|session|run)|each (?:build|session|run)|always)\b/i.test(quote);
  }
  return true;
}

/** The model extracts evidence and proposes a work plan; it cannot select labels or budgets. */
export function parseAssessment(raw: string | undefined, input: AssessmentInput): ExtractedAssessment | undefined {
  if (!raw || raw.length > 16_384) return;
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (!value.metrics || typeof value.metrics !== "object" || Array.isArray(value.metrics)) return;
    const sources = [input.title.slice(0, 500), input.body.slice(0, 12_000)];
    const metrics = {} as Record<MetricName, MetricEvidence>;
    for (const name of Object.keys(METRIC_MAX) as MetricName[]) {
      const metric = value.metrics[name];
      if (!metric || typeof metric !== "object" || Array.isArray(metric)) return;
      if (metric.value === null && metric.evidence === null) { metrics[name] = { value: null, evidence: null }; continue; }
      if (!Number.isInteger(metric.value) || metric.value < 0 || metric.value > METRIC_MAX[name]) return;
      // Quotes must be meaningful exact substrings, not invented supporting claims.
      if (!plainText(metric.evidence, 240) || metric.evidence.trim().length < 4 || !sources.some(source => source.includes(metric.evidence))) return;
      // A proposed safeguard cannot supply incident urgency, even if the extractor overstates it.
      if (name === "urgency" && metric.value === 2 && !confirmedIncident(metric.evidence)) return;
      metrics[name] = { value: metric.value, evidence: metric.evidence };
    }
    let planningMetrics: ExtractedAssessment["planningMetrics"];
    if (value.planningMetrics !== undefined) {
      if (!value.planningMetrics || typeof value.planningMetrics !== "object" || Array.isArray(value.planningMetrics)) return;
      planningMetrics = {} as NonNullable<ExtractedAssessment["planningMetrics"]>;
      for (const name of Object.keys(METRIC_MAX) as MetricName[]) {
        const item = value.planningMetrics[name];
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        if (item.value === null && item.evidence === null && item.basis === null && item.rationale === null) {
          planningMetrics[name] = { value: null, evidence: null, basis: null, rationale: null };
          continue;
        }
        if (!Number.isInteger(item.value) || item.value < 0 || item.value > METRIC_MAX[name]
          || !plainText(item.evidence, 240) || item.evidence.trim().length < 4
          || !sources.some(source => source.includes(item.evidence))
          || !["observed", "inferred"].includes(item.basis) || !plainText(item.rationale, 240)) return;
        if ((name === "urgency" || name === "frequency") && item.basis !== "observed") return;
        if (!supportedPlanningFact(name, item.value, item.evidence)) return;
        planningMetrics[name] = { value: item.value, evidence: item.evidence, basis: item.basis, rationale: item.rationale.trim() };
      }
    }
    if (!Array.isArray(value.work) || value.work.length < 1 || value.work.length > 5) return;
    const work: WorkStep[] = [];
    for (const item of value.work) {
      if (!item || typeof item !== "object" || !plainText(item.step, 240) || !plainText(item.check, 240)) return;
      work.push({ step: item.step.trim(), check: item.check.trim() });
    }
    return { metrics, ...(planningMetrics ? { planningMetrics } : {}), work };
  } catch { return; }
}

export function deriveAssessment(extracted: ExtractedAssessment, input: AssessmentInput, model: LoadedEffortModel) {
  const pricing = quoteEffort(extracted.metrics, model);
  if (pricing.status !== "ready") return;
  const names = Object.keys(METRIC_MAX) as MetricName[];
  const planning = extracted.planningMetrics ?? extracted.metrics;
  const unknowns = names.filter(name => planning[name].value === null);
  const scores = Object.fromEntries(names.map(name => [name, planning[name].value ?? UNKNOWN_DEFAULTS[name]])) as Record<MetricName, number>;
  const effort = pricing.effort;
  const priority = scores.urgency === 2 && scores.impact === 3 && scores.risk >= 2 ? "p0"
    : scores.impact === 3 || scores.impact >= 2 && scores.frequency === 2 ? "p1"
    : scores.impact === 0 ? "p3" : "p2";
  const detailed = scores.breadth === 3 || scores.complexity === 3 || scores.uncertainty === 3 || scores.risk >= 2;
  const none = scores.breadth === 0 && scores.complexity === 0 && scores.uncertainty <= 1 && scores.risk <= 1;
  const designSignals = (["breadth", "complexity", "uncertainty", "risk"] as const)
    .filter(name => name === "risk" ? scores[name] >= 2 : scores[name] === 3)
    .map(name => `${name} ${scores[name]}/3`).join(", ");
  const design: TriageScorecard["design"] = detailed
    ? { level: "detailed", reason: `Required by ${designSignals}. Write boundaries, state/data flow, failure paths, rollout, and acceptance checks before implementation.` }
    : none ? { level: "none", reason: "Breadth and complexity are 0; uncertainty and risk are ≤1. Use the work checklist and acceptance checks without a separate design document." }
    : { level: "light", reason: "Planning scores fall between mechanical and detailed-design thresholds. Record the approach, touched components, failure cases, and acceptance checks." };
  const facts: ScorecardFacts = {};
  for (const name of ["changedFiles", "additions", "deletions"] as const) {
    if (Number.isSafeInteger(input[name]) && input[name]! >= 0 && input[name]! <= 100_000_000) facts[name] = input[name];
  }
  const scorecard: TriageScorecard = {
    version: TRIAGE_SCORECARD_VERSION, metrics: extracted.metrics, ...(extracted.planningMetrics ? { planningMetrics: extracted.planningMetrics } : {}), unknowns, facts, work: extracted.work, design,
    tokens: { input: pricing.input ? [pricing.input.p50, pricing.input.p95] : null,
      output: [pricing.output.p50, pricing.output.p95], formula: pricing.formula, confidence: pricing.confidence },
    pricing,
  };
  const actions = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const workUnit = pricing.workloadMetric === "totalTokens" ? "total session tokens" : "logged tool actions";
  const reason = pricing.estimator === "historical-baseline"
    ? `Historical session usage: ${actions(pricing.activity.p50)} ${workUnit} (P50), ${actions(pricing.activity.p80)} (P80). Initial-message complexity did not beat the median baseline; this quote is not task-specific.`
    : `Initial-request complexity implies ${actions(pricing.activity.p50)} ${workUnit} (P50), ${actions(pricing.activity.p80)} (P80) per ${pricing.scope === "completed-session" ? "whole session" : "delivery run"}; ${pricing.confidence} quote with ${pricing.unknowns.length} unknown complexity feature(s).`;
  return { effort, priority, reason, scorecard } as const;
}
