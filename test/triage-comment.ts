import assert from "node:assert/strict";
import { renderTriageComment, safeTriageText, TRIAGE_COMMENT_MARKER, TRIAGE_COMMENT_VERSION_MARKER } from "../server/triage-comment.ts";
import { deriveAssessment, METRIC_MAX, type MetricName } from "../server/providers/triage-scorecard.ts";
import { fixtureEffortModel } from "./fixtures/triage-effort.ts";

const metrics = Object.fromEntries(Object.keys(METRIC_MAX).map(name => [name, { value: null, evidence: null }])) as Record<MetricName, { value: number | null; evidence: string | null }>;
const derived = deriveAssessment({ metrics, work: [{ step: "Trace the broken delivery path.", check: "A fixture reproduces the failure." }] }, { title: "Delivery broken", body: "" }, fixtureEffortModel);
assert.ok(derived);
const decision = { ...derived, model: "pi/test" };
decision.scorecard.pricing.estimator = "historical-baseline";
decision.scorecard.pricing.validation = {
  sampleCount: 34, groupCount: 32, hasLearnedComplexitySignal: false,
  work: { mae: 1937335120 }, baselineWork: { mae: 6997939 }, activeWork: { mae: 6997939 },
  activeCoverage: { work: { p80: 0.353, p95: 0.882 }, output: { p80: 0.412, p95: 0.912 } },
};
const rendered = renderTriageComment(decision, "<!-- source:fixture -->");
const visible = rendered.split("<details>")[0];
assert.ok(rendered.startsWith(`${TRIAGE_COMMENT_MARKER}\n${TRIAGE_COMMENT_VERSION_MARKER}\n<!-- source:fixture -->\n**Eff:`));
for (const heading of ["Book of work", "Estimated token usage", "Level of design"]) assert.equal(rendered.split(`### ${heading}`).length - 1, 1);
assert.ok(visible.includes("Trace the broken delivery path. Check: A fixture reproduces the failure."));
assert.equal(rendered.split("Missing:").length - 1, 1);
assert.ok(rendered.includes("Missing: breadth, complexity, uncertainty, risk, impact, urgency, frequency."));
assert.ok(rendered.includes("Next: map affected components; trace required behavior; check unresolved dependencies"));
assert.ok(!rendered.includes("Not stated; needs confirmation"));
assert.ok(!rendered.includes("| Metric | Score |"));
assert.ok(visible.includes("Historical quotes are not task-specific."));
assert.equal(rendered.split("complexity fit failed").length - 1, 1);
assert.ok(visible.includes("Ranges under-covered held-out outcomes."));
assert.ok(visible.includes("not success probabilities"));
assert.ok(visible.includes("Whole-session usage includes later follow-ups."));
assert.ok(!visible.includes("MAE"));
assert.ok(!visible.includes("Non-cached input"));
assert.ok(rendered.includes("Active work MAE: 6,997,939"));
assert.ok(rendered.includes("Rejected complexity-fit work MAE: 1,937,335,120"));
assert.ok(rendered.includes("P80 35.3%; P95 88.2%"));
assert.ok(visible.length < 1800, "Routine visible comment should fit a short phone read");

const inferred = structuredClone(decision) as any;
inferred.scorecard.planningMetrics = structuredClone(metrics);
inferred.scorecard.planningMetrics.breadth = { value: 2, evidence: "delivery path", basis: "inferred", rationale: "The request crosses queue and receiver boundaries." };
const inferenceComment = renderTriageComment(inferred);
assert.ok(inferenceComment.includes("breadth 2/3 (inferred)"));
assert.ok(inferenceComment.includes("The request crosses queue and receiver boundaries."));
assert.equal(inferred.scorecard.metrics.breadth.value, null, "Rendering planning inferences must not rewrite pricing predictors");
assert.ok(inferenceComment.includes("Missing: complexity, uncertainty, risk, impact, urgency, frequency."));

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

const unavailable = renderTriageComment({ effort: "bau", priority: "p2", reason: "Unavailable", model: "none" });
assert.ok(unavailable.includes("Run triage again"));
assert.ok(unavailable.includes("Unavailable without a scorecard."));
assert.ok(!unavailable.includes("undefined"));
console.log("triage-comment: pass");
