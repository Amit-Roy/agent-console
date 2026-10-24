import assert from "node:assert/strict";
import { quoteEffort, requestShape } from "../server/providers/triage-effort.ts";
import {
  extractStructure,
  parseStructureReply,
  quoteStructure,
  requestStructure,
} from "../server/providers/triage-structure.ts";
import { fixtureEffortModel } from "./fixtures/triage-effort.ts";

const sparse = "Fix the preview";
const repoContext =
  "The preview pane shows the rendered page after every build. Run `npm test` to verify the preview.";
const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    hasFilePath: false,
    hasExpectedOutput: true,
    hasAcceptanceCheck: false,
    missing: "acceptance-check",
    suggestion: "Add how to check the preview.",
    inferredFromRepo: true,
    ...over,
  });
const stub = (raw: string | undefined) => async () => raw;
const price = quoteEffort(
  {
    breadth: { value: 1 },
    complexity: { value: 1 },
    uncertainty: { value: 1 },
    risk: { value: 1 },
    impact: { value: 1 },
    urgency: { value: 0 },
    frequency: { value: 1 },
    ...requestShape(sparse),
  },
  fixtureEffortModel,
);

// A sparse request touching a documented workflow gets an inferred, marked suggestion.
{
  const result = await extractStructure({ text: sparse, repoContext, complete: stub(reply()) });
  assert.equal(result.flags.hasExpectedOutput, true);
  assert.equal(result.inferredFromRepo, true);
  assert.equal(result.missing, "hasAcceptanceCheck");
  assert.equal(result.suggestion, "Add how to check the preview.");
  const quote = quoteStructure(sparse, price, result);
  assert.equal(quote.inferredFromRepo, true);
  assert.equal(quote.counterfactual?.flag, "hasAcceptanceCheck");
  assert.equal(quote.counterfactual?.suggestion, "Add how to check the preview.");
}

// File paths are never taken from the model or the repository description.
{
  const text = "Fix the preview";
  const result = await extractStructure({
    text,
    repoContext: "The file server/preview.ts renders the preview.",
    complete: stub(reply({ hasFilePath: true, missing: "none", suggestion: null })),
  });
  assert.equal(result.flags.hasFilePath, false);
  const withPath = await extractStructure({
    text: "Fix server/queue.ts retry",
    complete: stub(reply({ hasFilePath: false })),
  });
  assert.equal(withPath.flags.hasFilePath, true);
}

// Invalid JSON, a wrong schema, an error, or a timeout fall back to the pure-code flags.
const shapeOnly = {
  flags: requestStructure(sparse),
  missing: null,
  suggestion: null,
  inferredFromRepo: false,
};
for (const complete of [
  stub("not json"),
  stub(JSON.stringify({ hasFilePath: false })),
  stub(reply({ missing: "everything" })),
  stub(reply({ hasExpectedOutput: "yes" })),
  stub(undefined),
  async () => {
    throw Error("HTTP 500");
  },
  () => new Promise<undefined>(() => {}),
]) {
  assert.deepEqual(
    await extractStructure({ text: sparse, repoContext, complete, timeoutMs: 20 }),
    shapeOnly,
  );
}

// A claim of inference without repository text, or without a gained flag, is dropped.
assert.equal(parseStructureReply(reply(), { text: sparse })?.inferredFromRepo, false);
assert.equal(
  parseStructureReply(reply(), { text: "Expected: it shows. Verify with tests.", repoContext })
    ?.inferredFromRepo,
  false,
);

// Model advice is a short plain sentence: links, mentions, markup and paths are rejected.
for (const suggestion of [
  "Ping @owner about this.",
  "See https://example.com/x for details.",
  "Edit server/preview.ts to fix it.",
  "Use `code` here.",
  "x".repeat(121),
]) {
  assert.equal(
    parseStructureReply(reply({ suggestion }), { text: sparse, repoContext })?.suggestion,
    null,
  );
}

// Without extraction the quote is the shape-only quote from before.
assert.deepEqual(quoteStructure(sparse, price).flags, requestStructure(sparse));
assert.equal(quoteStructure(sparse, price).inferredFromRepo, false);

// Tree quotes never name a ridge cost driver; ridge quotes keep theirs.
{
  const ridgeDriver = quoteStructure(sparse, price).costDriver;
  const heavy = structuredClone(price);
  heavy.contributions = heavy.contributions.map((item, index) => ({
    ...item,
    logWork: index === 0 ? 5 : 0.1,
  }));
  assert.notEqual(quoteStructure(sparse, heavy).costDriver, null, "Ridge quote keeps its driver");
  const tree = { ...heavy, method: "boosted-trees-quantile-v1" as const };
  assert.equal(quoteStructure(sparse, tree).costDriver, null);
  assert.equal(quoteStructure(sparse, { ...tree, recommendedBudget: "p95" }).costDriver, null);
  assert.equal(quoteStructure(sparse, { ...tree, total: null }).costDriver, null);
  assert.ok(ridgeDriver === null || typeof ridgeDriver === "string");
}

console.log("triage-structure ok");
