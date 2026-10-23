import assert from "node:assert/strict";
import {
  deriveAssessment,
  METRIC_MAX,
  type MetricName,
} from "../server/providers/triage-scorecard.ts";
import {
  renderTriageComment,
  safeTriageText,
  TRIAGE_COMMENT_MARKER,
  TRIAGE_COMMENT_VERSION_MARKER,
} from "../server/triage-comment.ts";
import { fixtureEffortModel } from "./fixtures/triage-effort.ts";

const metrics = Object.fromEntries(
  Object.keys(METRIC_MAX).map((name) => [name, { value: null, evidence: null }]),
) as Record<MetricName, { value: number | null; evidence: string | null }>;
const derived = deriveAssessment(
  {
    metrics,
    work: [{ step: "Trace the broken delivery path.", check: "A fixture reproduces the failure." }],
  },
  { title: "Delivery broken", body: "" },
  fixtureEffortModel,
);
assert.ok(derived);
const decision = { ...derived, model: "pi/test" };
decision.scorecard.pricing.estimator = "historical-baseline";
decision.scorecard.pricing.validation = {
  sampleCount: 34,
  groupCount: 32,
  hasLearnedComplexitySignal: false,
  work: { mae: 1937335120 },
  baselineWork: { mae: 6997939 },
  activeWork: { mae: 6997939 },
  activeCoverage: { work: { p80: 0.353, p95: 0.882 }, output: { p80: 0.412, p95: 0.912 } },
};
const rendered = renderTriageComment(decision, "<!-- source:fixture -->");
const visible = rendered.split("<details>")[0];
assert.ok(
  rendered.startsWith(
    `${TRIAGE_COMMENT_MARKER}\n${TRIAGE_COMMENT_VERSION_MARKER}\n<!-- source:fixture -->\n**Eff:`,
  ),
);
for (const heading of ["Book of work", "Estimated token usage", "Level of design"])
  assert.equal(rendered.split(`### ${heading}`).length - 1, 1);
assert.ok(
  visible.includes("Trace the broken delivery path. Check: A fixture reproduces the failure."),
);
assert.equal(rendered.split("Missing:").length - 1, 1);
assert.ok(
  rendered.includes("Missing: breadth, complexity, uncertainty, risk, impact, urgency, frequency."),
);
assert.ok(
  rendered.includes(
    "Next: map affected components; trace required behavior; check unresolved dependencies",
  ),
);
assert.ok(!rendered.includes("Not stated; needs confirmation"));
assert.ok(!rendered.includes("| Metric | Score |"));
assert.ok(visible.includes("Historical quotes are not task-specific."));
assert.equal(rendered.split("complexity fit failed").length - 1, 1);
assert.ok(visible.includes("Ranges under-covered held-out outcomes."));
assert.ok(visible.includes("not success probabilities"));
assert.ok(!visible.includes("| P50"));
assert.ok(visible.includes("Whole-session usage includes later follow-ups."));
// Effort follows the design level; the token table is only a rough guide.
assert.equal(derived.scorecard.design.level, "light");
assert.equal(derived.effort, "bau");
assert.ok(
  rendered.includes(
    "Effort follows the level of design: none is Trivial, light is BAU, detailed is Deep. The token table is a rough guide only.",
  ),
);
assert.ok(!/Trivial ≤|Deep ≥/.test(rendered));
assert.ok(rendered.includes("Effort follows the level of design. Urgency"));
const withScores = (values: number[]) =>
  deriveAssessment(
    {
      metrics: Object.fromEntries(
        Object.keys(METRIC_MAX).map((name, index) => [
          name,
          { value: values[index], evidence: "Delivery" },
        ]),
      ) as typeof metrics,
      work: [
        { step: "Trace the broken delivery path.", check: "A fixture reproduces the failure." },
      ],
    },
    { title: "Delivery broken", body: "" },
    fixtureEffortModel,
  )!;
assert.equal(withScores([0, 0, 0, 0, 0, 0, 0]).effort, "trivial");
assert.equal(withScores([1, 1, 1, 1, 0, 0, 0]).effort, "bau");
assert.equal(withScores([3, 1, 1, 1, 0, 0, 0]).effort, "deep");
assert.ok(!visible.includes("MAE"));
assert.ok(!visible.includes("Non-cached input"));
assert.ok(rendered.includes("Active work MAE: 6,997,939"));
assert.ok(rendered.includes("Rejected complexity-fit work MAE: 1,937,335,120"));
assert.ok(rendered.includes("P80 35.3%; P95 88.2%"));
assert.ok(visible.length < 1800, "Routine visible comment should fit a short phone read");

decision.scorecard.urgency = {
  score: 2,
  priority: "p1",
  drivers: ["impact 3/3", "workflow frequency 2/2 (assumed)"],
};
const withUrgency = renderTriageComment(decision);
assert.ok(
  withUrgency
    .split("<details>")[0]
    .includes("Urgency 2/3 sets the priority: impact 3/3; workflow frequency 2/2 (assumed)."),
);
const inferred = structuredClone(decision) as any;
inferred.scorecard.planningMetrics = structuredClone(metrics);
inferred.scorecard.planningMetrics.frequency = {
  value: 2,
  evidence: "fails every build",
  basis: "inferred",
  rationale: "Previews are in every turn.",
  context: "must see state",
};
inferred.scorecard.planningMetrics.breadth = {
  value: 2,
  evidence: "delivery path",
  basis: "inferred",
  rationale: "The request crosses queue and receiver boundaries.",
};
const inferenceComment = renderTriageComment(inferred);
assert.ok(inferenceComment.includes("breadth 2/3 (inferred)"));
assert.ok(inferenceComment.includes("The request crosses queue and receiver boundaries."));
assert.equal(
  inferred.scorecard.metrics.breadth.value,
  null,
  "Rendering planning inferences must not rewrite pricing predictors",
);
assert.ok(inferenceComment.includes("frequency 2/2 (inferred)"));
assert.ok(inferenceComment.includes("Repo context: “must see state”"));
assert.ok(inferenceComment.includes("Missing: complexity, uncertainty, risk, impact, urgency."));

const malicious = structuredClone(decision);
const attack = "<details open>\n# @everyone [click](https://example.com) ![](x) ~~~";
malicious.scorecard.work[0] = { step: attack, check: attack };
malicious.scorecard.design.reason = attack;
malicious.model = attack;
const escaped = renderTriageComment(malicious);
assert.ok(!escaped.includes("<details open>"));
assert.ok(!escaped.includes("@everyone"));
assert.ok(!escaped.includes("\n# @"));
assert.ok(!escaped.includes("[click]"));
assert.ok(!escaped.includes("~~~"));
assert.equal(safeTriageText("a\u0000\nb"), "a  b");

const unavailable = renderTriageComment({
  effort: "bau",
  priority: "p2",
  reason: "Unavailable",
  model: "none",
});
assert.ok(unavailable.includes("Run triage again"));
assert.ok(unavailable.includes("Unavailable without a scorecard."));
assert.ok(!unavailable.includes("undefined"));

// Test for image chart in estimated token usage section
const imageTestDecision = { ...derived, model: "pi/test" };
imageTestDecision.scorecard.pricing.estimator = "historical-baseline";
imageTestDecision.scorecard.pricing.validation = {
  sampleCount: 34,
  groupCount: 32,
  hasLearnedComplexitySignal: false,
  work: { mae: 1000 },
  baselineWork: { mae: 2000 },
  activeWork: { mae: 1000 },
  activeCoverage: { work: { p80: 0.8, p95: 0.9 }, output: { p80: 0.7, p95: 0.85 } },
};
const imageRendered = renderTriageComment(imageTestDecision, "<!-- source:fixture -->");
console.log("Rendered comment:");
console.log(imageRendered);
const estimatedTokenUsageSection = imageRendered
  .split("### Estimated token usage")[1]
  .split("### Level of design")[0];
console.log("Estimated token usage section:");
console.log(estimatedTokenUsageSection);
const hasImage =
  estimatedTokenUsageSection.includes("![") && estimatedTokenUsageSection.includes("http");
console.log("Has image tag (looking for '![' and 'http'):", hasImage);
assert.ok(hasImage, "Expected an image tag in the estimated token usage section");

// Test for replacement of "Unavailable" with a contextual description
const unavailableDecision = { ...derived, model: "pi/test" };
unavailableDecision.scorecard.pricing = { ...unavailableDecision.scorecard.pricing, total: null };
const unavailableRendered = renderTriageComment(unavailableDecision, "<!-- source:fixture -->");
console.log("Unavailable decision rendered comment:");
console.log(unavailableRendered);
const estimatedTokenUsageSectionUnavailable = unavailableRendered
  .split("### Estimated token usage")[1]
  .split("### Level of design")[0];
console.log("Unavailable decision estimated token usage section:");
console.log(estimatedTokenUsageSectionUnavailable);
assert.ok(
  !estimatedTokenUsageSectionUnavailable.includes("Unavailable"),
  "Expected no 'Unavailable' in token usage section",
);
assert.ok(
  estimatedTokenUsageSectionUnavailable.trim().length > 0,
  "Expected some contextual description",
);

// Test for link to pricing model documentation and plain language
const plainLanguageDecision = { ...derived, model: "pi/test" };
plainLanguageDecision.scorecard.pricing.estimator = "historical-baseline";
plainLanguageDecision.scorecard.pricing.validation = {
  sampleCount: 34,
  groupCount: 32,
  hasLearnedComplexitySignal: false,
  work: { mae: 1000 },
  baselineWork: { mae: 2000 },
  activeWork: { mae: 1000 },
  activeCoverage: { work: { p80: 0.8, p95: 0.9 }, output: { p80: 0.7, p95: 0.85 } },
};
const plainLanguageRendered = renderTriageComment(plainLanguageDecision, "<!-- source:fixture -->");
// Check for a link to the pricing model documentation
assert.ok(
  plainLanguageRendered.includes("http://docs.agent-console.dev/pricing-model"),
  "Expected a link to the pricing model documentation",
);
// Structure-first pricing: sparse requests reserve more budget and show what a missing item costs.
const priced = (title: string, body: string) => {
  const result = deriveAssessment(
    {
      metrics: Object.fromEntries(
        Object.keys(METRIC_MAX).map((name) => [name, { value: 1, evidence: "Request" }]),
      ) as typeof metrics,
      work: [{ step: "Inspect the request.", check: "Result is recorded." }],
    },
    { title, body },
    fixtureEffortModel,
  )!;
  return { ...result, model: "pi/test" };
};
const sparse = priced("fix this", "");
const structured = priced(
  "Fix retry in `server/queue.ts`",
  "Update `server/queue.ts` so failed jobs retry once.\nExpected: the job shows as done in the list.\nAcceptance: `npm test` passes with a retry case.",
);
const sparseStructure = sparse.scorecard.structure!;
const structuredStructure = structured.scorecard.structure!;
assert.deepEqual(sparseStructure.flags, {
  hasFilePath: false,
  hasExpectedOutput: false,
  hasAcceptanceCheck: false,
  inferredFromRepo: false,
});
assert.deepEqual(structuredStructure.flags, {
  hasFilePath: true,
  hasExpectedOutput: true,
  hasAcceptanceCheck: true,
  inferredFromRepo: false,
});
assert.ok(sparseStructure.budget! > structuredStructure.budget!);
assert.ok(sparseStructure.counterfactual!.budget < sparseStructure.budget!);
assert.equal(structuredStructure.counterfactual, null);
const sparseText = renderTriageComment(sparse);
const structuredText = renderTriageComment(structured);
const sparseVisible = sparseText.split("<details>")[0];
assert.ok(
  /Add a file path → estimated budget drops to \*\*[\d.]+[KM]?\*\* tokens/.test(sparseVisible),
);
assert.ok(sparseVisible.includes("Recommended budget"));
assert.ok(!/Add a .* → estimated budget/.test(structuredText));
assert.ok(!/\bunknown\b/i.test(sparseVisible));
console.log("triage-comment: pass");
