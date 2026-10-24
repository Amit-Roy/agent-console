import type { EffortQuantiles, EffortQuote } from "./providers/triage-effort.ts";
import type { TriageDecision } from "./providers/triage-model.ts";
import {
  METRIC_MAX,
  type MetricName,
  TRIAGE_RULES,
  TRIAGE_SCORECARD_VERSION,
} from "./providers/triage-scorecard.ts";
import type { StructureQuote } from "./providers/triage-structure.ts";

export const EFFORT_LABELS = {
  trivial: "Eff: Trivial",
  bau: "Eff: BAU",
  deep: "Eff: Deep",
} as const;
export const PRIORITY_LABELS = {
  p0: "Pri: P0",
  p1: "Pri: P1",
  p2: "Pri: P2",
  p3: "Pri: P3",
} as const;
export const TRIAGE_COMMENT_MARKER = "<!-- agent-console-triage -->";
export const TRIAGE_COMMENT_VERSION_MARKER = `<!-- agent-console-triage-version:${TRIAGE_SCORECARD_VERSION} -->`;

/** Render untrusted prose as text, without HTML, mentions, or Markdown structure. */
export const safeTriageText = (value: unknown): string =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[&<>@|`!*_#[\]\\~]/g, (char) => `&#${char.charCodeAt(0)};`);

const compact = (value: number): string =>
  value >= 1e6
    ? `${(value / 1e6).toFixed(1)}M`
    : value >= 1e3
      ? `${Math.round(value / 1e3)}K`
      : String(Math.round(value));
const number = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const amount = (values: EffortQuantiles | null, percentile: keyof EffortQuantiles): string =>
  values ? number(values[percentile]) : "Unavailable";
type ValidationMetric = { mae?: number };
type Coverage = { p80?: number; p95?: number };
type PricingValidation = {
  sampleCount?: number;
  groupCount?: number;
  work?: ValidationMetric;
  baselineWork?: ValidationMetric;
  outputTokens?: ValidationMetric;
  baselineOutputTokens?: ValidationMetric;
  activeWork?: ValidationMetric;
  activeOutputTokens?: ValidationMetric;
  workCoverage?: Coverage;
  outputCoverage?: Coverage;
  activeCoverage?: { work?: Coverage; total?: Coverage; output?: Coverage };
  hasLearnedComplexitySignal?: boolean;
  quantileModel?: TreeValidation;
};
type TreeValidation = {
  sampleCount?: number;
  groupCount?: number;
  meanPinball?: number;
  baselinePinball?: Record<string, number>;
  quantiles?: Record<string, { pinball?: number; coverage?: number }>;
};
type PlanningMetric = {
  value: number | null;
  evidence: string | null;
  basis?: "observed" | "inferred" | null;
  rationale?: string | null;
  context?: string | null;
};
const investigation: Record<MetricName, string> = {
  breadth: "map affected components",
  complexity: "trace required behavior",
  uncertainty: "check unresolved dependencies",
  risk: "check data and recovery paths",
  impact: "name the blocked workflow",
  urgency: "confirm any deadline or current incident",
  frequency: "confirm how often users meet this in the app workflow",
};

// Pinball losses are small log-scale numbers, so keep three decimals.
const loss = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 3 });
const average = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const finiteValues = (values: unknown[]): number[] =>
  values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

/** Held-out stats of the boosted heads: sample size, mean pinball loss, and its baseline. */
function treeCheckLines(heads?: TreeValidation): string[] {
  if (!heads) return [];
  const lines: string[] = [];
  if (typeof heads.sampleCount === "number")
    lines.push(
      `Held-out check: ${number(heads.sampleCount)} outcomes; ${safeTriageText(heads.groupCount ?? "not recorded")} thread groups.`,
    );
  const mean =
    typeof heads.meanPinball === "number"
      ? heads.meanPinball
      : average(finiteValues(Object.values(heads.quantiles ?? {}).map((item) => item?.pinball)));
  const baseline = average(finiteValues(Object.values(heads.baselinePinball ?? {})));
  if (mean !== null)
    lines.push(
      `Mean pinball: ${loss(mean)}${baseline === null ? "" : `; baseline ${loss(baseline)}`}.`,
    );
  return lines;
}

/** Held-out stats of the ridge fit, including the rejected candidate when the baseline won. */
function ridgeCheckLines(
  metrics: PricingValidation,
  fellBack: boolean,
  totalTarget: boolean,
): string[] {
  const lines: string[] = [];
  const selectedWork = metrics.activeWork ?? metrics.work;
  const selectedOutput = metrics.activeOutputTokens ?? metrics.outputTokens;
  if (typeof metrics.sampleCount === "number")
    lines.push(
      `Held-out check: ${number(metrics.sampleCount)} outcomes; ${safeTriageText(metrics.groupCount ?? "not recorded")} thread groups.`,
    );
  if (typeof selectedWork?.mae === "number")
    lines.push(
      `Active ${totalTarget ? "total-token" : "work"} MAE: ${number(selectedWork.mae)}${typeof metrics.baselineWork?.mae === "number" ? `; baseline ${number(metrics.baselineWork.mae)}` : ""}.`,
    );
  if (fellBack && typeof metrics.work?.mae === "number")
    lines.push(
      `Rejected complexity-fit ${totalTarget ? "total-token" : "work"} MAE: ${number(metrics.work.mae)}. This holdout selected the fallback; it is not an independent test of that selection.`,
    );
  if (typeof selectedOutput?.mae === "number")
    lines.push(
      `Generated-token MAE: ${number(selectedOutput.mae)}${typeof metrics.baselineOutputTokens?.mae === "number" ? `; baseline ${number(metrics.baselineOutputTokens.mae)}` : ""}.`,
    );
  return lines;
}

/** Ridge per-feature log-work terms; they do not explain tree prices. */
const contributionLines = (contributions: EffortQuote["contributions"]): string[] => [
  "",
  "Pricing contributions use the original request-only metrics:",
  "",
  ...contributions.map(
    (item) =>
      `- ${safeTriageText(item.feature)}: ${item.value ?? "not stated"}; log-work ${number(item.logWork)}, missingness ${number(item.missingLogWork)}.`,
  ),
];

/** Budget, biggest cost driver and the cheapest missing item, so a sparse request shows what it costs. */
function structureLines(structure?: StructureQuote, typical?: number): string[] {
  if (!structure || structure.budget === null) return [];
  const { counterfactual } = structure;
  return [
    `Recommended budget **${compact(structure.budget)}** tokens${typical === undefined ? "" : `; typical **${compact(typical)}**`}.`,
    ...(structure.costDriver ? [`Biggest cost driver: ${structure.costDriver}.`] : []),
    ...(counterfactual
      ? [
          `${counterfactual.suggestion ? safeTriageText(counterfactual.suggestion).replace(/[.]$/, "") : `Add ${counterfactual.label}`} → estimated budget drops to **${compact(counterfactual.budget)}** tokens.`,
        ]
      : []),
    ...(structure.inferredFromRepo
      ? [
          "The expected output or acceptance check is inferred from the repository description, not stated in the request.",
        ]
      : []),
  ];
}

type Scorecard = NonNullable<TriageDecision["scorecard"]>;
type Pricing = Scorecard["pricing"];
type CoveragePair = { work: Coverage | undefined; output: Coverage | undefined };
const TREE_METHOD = "boosted-trees-quantile-v1";

const headerLines = (decision: TriageDecision, sourceMarker: string): string[] => {
  const score = decision.scorecard;
  return [
    TRIAGE_COMMENT_MARKER,
    TRIAGE_COMMENT_VERSION_MARKER,
    ...(sourceMarker ? [sourceMarker] : []),
    `**${EFFORT_LABELS[decision.effort]} · ${PRIORITY_LABELS[decision.priority]}**`,
    ...(score?.urgency
      ? [
          `Urgency ${score.urgency.score}/3 sets the priority: ${score.urgency.drivers.map(safeTriageText).join("; ")}.`,
        ]
      : []),
    ...structureLines(score?.structure, score?.pricing.total?.p50),
    "",
    "### Book of work",
    "",
  ];
};

const unavailableLines = (decision: TriageDecision): string[] => [
  "Assessment unavailable. Run triage again to generate a work plan.",
  "",
  "### Estimated token usage",
  "",
  "Unavailable without a scorecard.",
  "",
  "### Level of design",
  "",
  "Unknown.",
  "",
  `Model: ${safeTriageText(decision.model)}.`,
];

/** Tree prices come from the boosted heads, so only their held-out coverage applies. */
function coverageOf(
  price: Pricing,
  metrics: PricingValidation,
  totalTarget: boolean,
): CoveragePair {
  if (price.method === TREE_METHOD) {
    const heads = metrics.quantileModel?.quantiles;
    return {
      work: { p80: heads?.p80?.coverage, p95: heads?.p95?.coverage },
      output: undefined,
    };
  }
  return {
    work:
      metrics.activeCoverage?.[totalTarget ? "total" : "work"] ??
      metrics.activeCoverage?.work ??
      metrics.workCoverage,
    output: metrics.activeCoverage?.output ?? metrics.outputCoverage,
  };
}

const hasTail = (values: EffortQuantiles): boolean =>
  values.p75 !== undefined && values.p99 !== undefined;
const seriesOf = (values: EffortQuantiles): number[] =>
  hasTail(values)
    ? [values.p50, values.p75 as number, values.p80, values.p95, values.p99 as number]
    : [values.p50, values.p80, values.p95];

function tokenUsageText(price: Pricing, model: string): string {
  const total = price.total;
  if (!total)
    return `Token usage estimation is not available for ${model || "this request type"}. [Please refer to the pricing model documentation](http://docs.agent-console.dev/pricing-model) for guidance.`;
  const budget = price.total?.[price.recommendedBudget] ?? null;
  if (total.p75 !== undefined && total.p99 !== undefined)
    return `Best guess **${compact(total.p50)}** tokens; **${compact(total.p75)}** at 3 in 4; **${compact(total.p80)}** likely ceiling; **${compact(total.p95)}** at 19 in 20; **${compact(total.p99)}** worst case. Plan with **${compact(budget ?? total.p80)}**.`;
  return `About **${compact(total.p50)}** tokens typical; **${compact(total.p80)}** likely ceiling; **${compact(total.p95)}** worst case. Plan with **${compact(budget ?? total.p80)}**.`;
}

/** A simple image chart showing token usage scenarios. */
function chartLines(price: Pricing): string[] {
  if (!price.total || !price.output) return [];
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
    JSON.stringify({
      type: "line",
      data: {
        labels: hasTail(price.total) ? ["P50", "P75", "P80", "P95", "P99"] : ["P50", "P80", "P95"],
        datasets: [
          { label: "Total tokens", data: seriesOf(price.total) },
          { label: "Generated tokens", data: seriesOf(price.output) },
        ],
      },
      options: { title: { display: true, text: "Token Usage Scenarios" } },
    }),
  )}`;
  return ["", `![Token usage chart](${chartUrl})`];
}

function fitWarning(price: Pricing, metrics: PricingValidation): string[] {
  // Ridge fit warnings do not describe the boosted heads that priced a tree quote.
  if (price.method === TREE_METHOD) return [];
  if (price.estimator === "historical-baseline")
    return [
      "The complexity fit failed the held-out baseline check. Historical quotes are not task-specific.",
    ];
  return metrics.hasLearnedComplexitySignal === false
    ? ["Initial-request features have not established predictive value."]
    : [];
}

function warningLines(
  price: Pricing,
  metrics: PricingValidation,
  coverage: CoveragePair,
): string[] {
  const underCovered = [coverage.work, coverage.output].some(
    (item) => (item?.p80 ?? 1) < 0.8 || (item?.p95 ?? 1) < 0.95,
  );
  const warning = [
    ...fitWarning(price, metrics),
    ...(underCovered ? ["Ranges under-covered held-out outcomes."] : []),
    "Percentiles are scenarios, not success probabilities.",
  ];
  return [
    warning.join(" "),
    price.scope === "completed-session"
      ? "Whole-session usage includes later follow-ups. Only the initial request supplies predictors."
      : "Usage covers one observed direct-agent delivery run.",
  ];
}

function assessmentLine(name: MetricName, assessment: PlanningMetric & { value: number }): string {
  const inferred = assessment.basis === "inferred";
  return `- **${name} ${assessment.value}/${METRIC_MAX[name]}${inferred ? " (inferred)" : ""}:** ${safeTriageText(assessment.evidence)}${inferred && assessment.rationale ? ` — ${safeTriageText(assessment.rationale)}` : ""}${assessment.context ? ` Repo context: “${safeTriageText(assessment.context)}”` : ""}`;
}

function evidenceLines(score: Scorecard): string[] {
  const lines = [
    "",
    "### Level of design",
    "",
    `**${safeTriageText(score.design.level)}.** ${safeTriageText(score.design.reason)}`,
    "",
    "<details><summary>Evidence and open questions</summary>",
    "",
  ];
  const planning =
    (score as Scorecard & { planningMetrics?: Record<MetricName, PlanningMetric> })
      .planningMetrics ?? score.metrics;
  const unknowns: MetricName[] = [];
  for (const name of Object.keys(METRIC_MAX) as MetricName[]) {
    const assessment: PlanningMetric | undefined = planning[name];
    if (!assessment || assessment.value === null) unknowns.push(name);
    else lines.push(assessmentLine(name, assessment as PlanningMetric & { value: number }));
  }
  if (unknowns.length)
    lines.push(
      "",
      `Missing: ${unknowns.join(", ")}.`,
      `Next: ${unknowns.map((name) => investigation[name]).join("; ")}.`,
    );
  if (score.facts && Object.keys(score.facts).length)
    lines.push(
      "",
      `PR facts: ${Object.entries(score.facts)
        .map(([key, value]) => `${safeTriageText(key)}=${safeTriageText(value)}`)
        .join(", ")}. These are not pricing predictors.`,
    );
  lines.push(
    "",
    "Effort, design, and priority follow scoring rules. Effort follows the level of design. Urgency (the priority) comes from impact, how often the workflow meets the problem, and any stated deadline; past token usage does not determine them.",
    "",
    "</details>",
  );
  return lines;
}

function targetText(totalTarget: boolean, session: boolean): string {
  if (totalTarget) return "Initial request → total session usage";
  return session
    ? "initial request → session work → whole-session tokens"
    : "initial request → delivery-run work → tokens";
}

function accountingTables(price: Pricing, totalTarget: boolean): string[] {
  const session = price.scope === "completed-session";
  const lines = [
    "",
    "<details><summary>Token accounting and model check</summary>",
    "",
    `Status: ${safeTriageText(price.confidence)}. Target: ${targetText(totalTarget, session)}.`,
    `Training: ${safeTriageText(price.training.sampleCount ?? price.training.sampleIds.length)} ${session ? "sessions" : "delivery runs"}; ${safeTriageText(price.training.groupCount ?? "not recorded")} thread groups.`,
    "",
    "| Scenario | Total tokens | Generated |",
    "| --- | ---: | ---: |",
    ...(["p50", "p80", "p95"] as const).map(
      (key) =>
        `| ${key.toUpperCase()} | ${amount(price.total, key)} | ${amount(price.output, key)} |`,
    ),
    "",
    "| Input tokens | P50 | P80 | P95 |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const [label, values] of [
    ["Total input", price.input],
    ["Non-cached input", price.freshInput],
    ["Cached replay", price.cachedInput],
  ] as const) {
    lines.push(
      `| ${label} | ${amount(values, "p50")} | ${amount(values, "p80")} | ${amount(values, "p95")} |`,
    );
  }
  if (!totalTarget)
    lines.push(
      "",
      `Logged tool actions: P50 ${amount(price.activity, "p50")}; P80 ${amount(price.activity, "p80")}; P95 ${amount(price.activity, "p95")}.`,
    );
  return lines;
}

function accountingNotes(price: Pricing, totalTarget: boolean): string[] {
  const workUnit = totalTarget ? "total session tokens" : "logged tool actions";
  const lines = [
    "",
    "Total tokens include input and output. Cached replay is included once. Human hours and unmeasured child agents are excluded.",
    `Effort follows the level of design: none is Trivial, light is BAU, detailed is Deep. The token table is a rough guide only. It prices ${price.effortBasis.toUpperCase()} ${workUnit}; unknown or extrapolated pricing scope selects P95 by policy.`,
    `P80 − P50 reserve: ${price.total ? `${number(price.total.p80 - price.total.p50)} total tokens; ` : ""}${number(price.riskPremium.output)} generated tokens.`,
  ];
  if (price.unknowns.length || price.outOfRange.length)
    lines.push(
      `Pricing features missing: ${price.unknowns.join(", ") || "none"}. Outside training range: ${price.outOfRange.join(", ") || "none"}.`,
    );
  return lines;
}

function hitRateLines(coverage: CoveragePair, totalTarget: boolean): string[] {
  const lines: string[] = [];
  for (const [label, item] of [
    [totalTarget ? "Total-token" : "Work", coverage.work],
    ["Generated-token", coverage.output],
  ] as const) {
    if (typeof item?.p80 === "number")
      lines.push(
        `${label} observed hit rate: P80 ${number(item.p80 * 100)}%${typeof item.p95 === "number" ? `; P95 ${number(item.p95 * 100)}%` : ""}.`,
      );
  }
  return lines;
}

function checkLines(
  price: Pricing,
  metrics: PricingValidation,
  coverage: CoveragePair,
  totalTarget: boolean,
): string[] {
  const tree = price.method === TREE_METHOD;
  return [
    ...(tree
      ? treeCheckLines(metrics.quantileModel)
      : ridgeCheckLines(metrics, price.estimator === "historical-baseline", totalTarget)),
    ...hitRateLines(coverage, totalTarget),
    ...(tree ? [] : contributionLines(price.contributions)),
  ];
}

const closingLines = (price: Pricing, model: string): string[] => [
  "",
  safeTriageText(price.formula),
  "",
  "</details>",
  "",
  "<details><summary>Scoring rules</summary>",
  "",
  ...Object.values(TRIAGE_RULES).map((rule) => `${safeTriageText(rule)}\n`),
  "</details>",
  "",
  `Model: ${safeTriageText(model)}.`,
];

/** Pi supplies work and evidence; the renderer preserves computed labels and token counts. */
export function renderTriageComment(decision: TriageDecision, sourceMarker = ""): string {
  const score = decision.scorecard;
  const lines = headerLines(decision, sourceMarker);
  if (!score) return [...lines, ...unavailableLines(decision)].join("\n");
  score.work.forEach((item, index) => {
    lines.push(`${index + 1}. ${safeTriageText(item.step)} Check: ${safeTriageText(item.check)}`);
  });
  const price = score.pricing;
  const totalTarget = price.workloadMetric === "totalTokens";
  const metrics = price.validation as PricingValidation;
  const coverage = coverageOf(price, metrics, totalTarget);
  lines.push(
    "",
    "### Estimated token usage",
    "",
    tokenUsageText(price, decision.model),
    ...chartLines(price),
    ...warningLines(price, metrics, coverage),
    ...evidenceLines(score),
    ...accountingTables(price, totalTarget),
    ...accountingNotes(price, totalTarget),
    ...checkLines(price, metrics, coverage, totalTarget),
    ...closingLines(price, decision.model),
  );
  return lines.join("\n");
}
