import { quoteEffort, type EffortQuote, type LoadedEffortModel } from "./triage-effort.ts";

/** Complexity precedes work estimation; token budgets are derived from predicted activity. */
export const TRIAGE_SCORECARD_VERSION = 4;
export const METRIC_MAX = { breadth: 3, complexity: 3, uncertainty: 3, risk: 3, impact: 3, urgency: 2, frequency: 2 } as const;
export type MetricName = keyof typeof METRIC_MAX;
export interface MetricEvidence { value: number | null; evidence: string | null }
export interface WorkStep { step: string; check: string }
export interface ScorecardFacts { changedFiles?: number; additions?: number; deletions?: number }
export interface TriageScorecard {
  version: typeof TRIAGE_SCORECARD_VERSION;
  metrics: Record<MetricName, MetricEvidence>;
  unknowns: MetricName[];
  facts: ScorecardFacts;
  work: WorkStep[];
  design: { level: "none" | "light" | "detailed"; reason: string };
  tokens: { input: [number, number] | null; output: [number, number]; formula: string; confidence: "experimental" | "validated" };
  pricing: EffortQuote;
}
export interface AssessmentInput extends ScorecardFacts { title: string; body: string; files?: string[] }
export interface ExtractedAssessment { metrics: Record<MetricName, MetricEvidence>; work: WorkStep[] }

/** Unknowns must remain visible; defaults are planning assumptions, never evidence. */
export const UNKNOWN_DEFAULTS: Record<MetricName, number> = {
  breadth: 1, complexity: 1, uncertainty: 2, risk: 1, impact: 1, urgency: 0, frequency: 0,
};
export const TRIAGE_RULES = {
  effort: "Pre-work breadth, behavior complexity, uncertainty, and risk enter a learned nonnegative log-work equation. Effort uses P50 predicted logged actions against historical activity terciles when scope is known, or P95 when features are unknown or outside training ranges. That conservative routing is an explicit policy. Token budgets follow from empirical per-action yields and out-of-fold residual scenarios. Raw token consumption and context length never set complexity. These are delivery-run proxies, not human hours or whole-issue totals.",
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

/** The model extracts evidence and proposes a work plan; it cannot select labels or budgets. */
export function parseAssessment(raw: string | undefined, input: AssessmentInput): ExtractedAssessment | undefined {
  if (!raw || raw.length > 16_384) return;
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (!value.metrics || typeof value.metrics !== "object" || Array.isArray(value.metrics)) return;
    const sources = [input.title.slice(0, 500), input.body.slice(0, 12_000), ...(input.files || []).slice(0, 100).map(f => f.slice(0, 250))];
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
    if (!Array.isArray(value.work) || value.work.length < 1 || value.work.length > 5) return;
    const work: WorkStep[] = [];
    for (const item of value.work) {
      if (!item || typeof item !== "object" || !plainText(item.step, 240) || !plainText(item.check, 240)) return;
      work.push({ step: item.step.trim(), check: item.check.trim() });
    }
    return { metrics, work };
  } catch { return; }
}

export function deriveAssessment(extracted: ExtractedAssessment, input: AssessmentInput, model: LoadedEffortModel) {
  const pricing = quoteEffort(extracted.metrics, model);
  if (pricing.status !== "ready") return;
  const names = Object.keys(METRIC_MAX) as MetricName[];
  const unknowns = names.filter(name => extracted.metrics[name].value === null);
  const scores = Object.fromEntries(names.map(name => [name, extracted.metrics[name].value ?? UNKNOWN_DEFAULTS[name]])) as Record<MetricName, number>;
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
    version: TRIAGE_SCORECARD_VERSION, metrics: extracted.metrics, unknowns, facts, work: extracted.work, design,
    tokens: { input: pricing.input ? [pricing.input.p50, pricing.input.p95] : null,
      output: [pricing.output.p50, pricing.output.p95], formula: pricing.formula, confidence: pricing.confidence },
    pricing,
  };
  const reason = `Complexity implies ${pricing.activity.p50} logged tool actions (P50), ${pricing.activity.p80} (P80); ${pricing.confidence} quote with ${pricing.unknowns.length} unknown complexity feature(s).`;
  return { effort, priority, reason, scorecard } as const;
}
