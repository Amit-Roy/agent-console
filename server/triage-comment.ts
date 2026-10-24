import type { EffortQuantiles } from "./providers/triage-effort.ts";
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

/** Pi supplies work and evidence; the renderer preserves computed labels and token counts. */
export function renderTriageComment(decision: TriageDecision, sourceMarker = ""): string {
  const score = decision.scorecard;
  const lines = [
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
  if (!score) {
    lines.push(
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
    );
    return lines.join("\n");
  }
  score.work.forEach((item, index) => {
    lines.push(`${index + 1}. ${safeTriageText(item.step)} Check: ${safeTriageText(item.check)}`);
  });
  const price = score.pricing;
  const session = price.scope === "completed-session";
  const totalTarget = price.workloadMetric === "totalTokens";
  const workUnit = totalTarget ? "total session tokens" : "logged tool actions";
  const metrics = price.validation as {
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
  };
  const workCoverage =
    metrics.activeCoverage?.[totalTarget ? "total" : "work"] ??
    metrics.activeCoverage?.work ??
    metrics.workCoverage;
  const outputCoverage = metrics.activeCoverage?.output ?? metrics.outputCoverage;
  const underCovered = [workCoverage, outputCoverage].some(
    (coverage) => (coverage?.p80 ?? 1) < 0.8 || (coverage?.p95 ?? 1) < 0.95,
  );
  const budget = price.total?.[price.recommendedBudget] ?? null;
  let tokenUsageText: string;
  if (price.total) {
    tokenUsageText = price.total
      ? price.total.p75 !== undefined && price.total.p99 !== undefined
        ? `Best guess **${compact(price.total.p50)}** tokens; **${compact(price.total.p75)}** at 3 in 4; **${compact(price.total.p80)}** likely ceiling; **${compact(price.total.p95)}** at 19 in 20; **${compact(price.total.p99)}** worst case. Plan with **${compact(budget ?? price.total.p80)}**.`
        : `About **${compact(price.total.p50)}** tokens typical; **${compact(price.total.p80)}** likely ceiling; **${compact(price.total.p95)}** worst case. Plan with **${compact(budget ?? price.total.p80)}**.`
      : "Unavailable.";
  } else {
    tokenUsageText = `Token usage estimation is not available for ${decision.model || "this request type"}. [Please refer to the pricing model documentation](http://docs.agent-console.dev/pricing-model) for guidance.`;
  }
  lines.push("", "### Estimated token usage", "", tokenUsageText);
  // Add a simple image chart showing token usage scenarios
  if (price.total && price.output) {
    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
      JSON.stringify({
        type: "line",
        data: {
          labels:
            price.total.p75 !== undefined && price.total.p99 !== undefined
              ? ["P50", "P75", "P80", "P95", "P99"]
              : ["P50", "P80", "P95"],
          datasets: [
            {
              label: "Total tokens",
              data:
                price.total.p75 !== undefined && price.total.p99 !== undefined
                  ? [
                      price.total.p50,
                      price.total.p75,
                      price.total.p80,
                      price.total.p95,
                      price.total.p99,
                    ]
                  : [price.total.p50, price.total.p80, price.total.p95],
            },
            {
              label: "Generated tokens",
              data:
                price.output.p75 !== undefined && price.output.p99 !== undefined
                  ? [
                      price.output.p50,
                      price.output.p75,
                      price.output.p80,
                      price.output.p95,
                      price.output.p99,
                    ]
                  : [price.output.p50, price.output.p80, price.output.p95],
            },
          ],
        },
        options: { title: { display: true, text: "Token Usage Scenarios" } },
      }),
    )}`;
    lines.push("", `![Token usage chart](${chartUrl})`);
  }
  const warning: string[] = [];
  if (price.estimator === "historical-baseline")
    warning.push(
      "The complexity fit failed the held-out baseline check. Historical quotes are not task-specific.",
    );
  else if (metrics.hasLearnedComplexitySignal === false)
    warning.push("Initial-request features have not established predictive value.");
  if (underCovered) warning.push("Ranges under-covered held-out outcomes.");
  warning.push("Percentiles are scenarios, not success probabilities.");
  lines.push(
    warning.join(" "),
    session
      ? "Whole-session usage includes later follow-ups. Only the initial request supplies predictors."
      : "Usage covers one observed direct-agent delivery run.",
  );
  lines.push(
    "",
    "### Level of design",
    "",
    `**${safeTriageText(score.design.level)}.** ${safeTriageText(score.design.reason)}`,
    "",
    "<details><summary>Evidence and open questions</summary>",
    "",
  );
  const planning =
    (score as typeof score & { planningMetrics?: Record<MetricName, PlanningMetric> })
      .planningMetrics ?? score.metrics;
  const unknowns: MetricName[] = [];
  for (const name of Object.keys(METRIC_MAX) as MetricName[]) {
    const assessment: PlanningMetric | undefined = planning[name];
    if (!assessment || assessment.value === null) {
      unknowns.push(name);
      continue;
    }
    lines.push(
      `- **${name} ${assessment.value}/${METRIC_MAX[name]}${assessment.basis === "inferred" ? " (inferred)" : ""}:** ${safeTriageText(assessment.evidence)}${assessment.basis === "inferred" && assessment.rationale ? ` — ${safeTriageText(assessment.rationale)}` : ""}${assessment.context ? ` Repo context: “${safeTriageText(assessment.context)}”` : ""}`,
    );
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
    "",
    "<details><summary>Token accounting and model check</summary>",
    "",
    `Status: ${safeTriageText(price.confidence)}. Target: ${totalTarget ? "Initial request → total session usage" : session ? "initial request → session work → whole-session tokens" : "initial request → delivery-run work → tokens"}.`,
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
  );
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
  lines.push(
    "",
    "Total tokens include input and output. Cached replay is included once. Human hours and unmeasured child agents are excluded.",
    `Effort follows the level of design: none is Trivial, light is BAU, detailed is Deep. The token table is a rough guide only. It prices ${price.effortBasis.toUpperCase()} ${workUnit}; unknown or extrapolated pricing scope selects P95 by policy.`,
    `P80 − P50 reserve: ${price.total ? `${number(price.total.p80 - price.total.p50)} total tokens; ` : ""}${number(price.riskPremium.output)} generated tokens.`,
  );
  if (price.unknowns.length || price.outOfRange.length)
    lines.push(
      `Pricing features missing: ${price.unknowns.join(", ") || "none"}. Outside training range: ${price.outOfRange.join(", ") || "none"}.`,
    );
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
  if (price.estimator === "historical-baseline" && typeof metrics.work?.mae === "number")
    lines.push(
      `Rejected complexity-fit ${totalTarget ? "total-token" : "work"} MAE: ${number(metrics.work.mae)}. This holdout selected the fallback; it is not an independent test of that selection.`,
    );
  if (typeof selectedOutput?.mae === "number")
    lines.push(
      `Generated-token MAE: ${number(selectedOutput.mae)}${typeof metrics.baselineOutputTokens?.mae === "number" ? `; baseline ${number(metrics.baselineOutputTokens.mae)}` : ""}.`,
    );
  for (const [label, coverage] of [
    [totalTarget ? "Total-token" : "Work", workCoverage],
    ["Generated-token", outputCoverage],
  ] as const) {
    if (typeof coverage?.p80 === "number")
      lines.push(
        `${label} observed hit rate: P80 ${number(coverage.p80 * 100)}%${typeof coverage.p95 === "number" ? `; P95 ${number(coverage.p95 * 100)}%` : ""}.`,
      );
  }
  lines.push(
    "",
    "Pricing contributions use the original request-only metrics:",
    "",
    ...price.contributions.map(
      (item) =>
        `- ${safeTriageText(item.feature)}: ${item.value ?? "not stated"}; log-work ${number(item.logWork)}, missingness ${number(item.missingLogWork)}.`,
    ),
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
    `Model: ${safeTriageText(decision.model)}.`,
  );
  return lines.join("\n");
}
