import assert from "node:assert/strict";
import { requestStructure, quoteStructure } from "../server/providers/triage-structure.ts";
import { quoteEffort, requestShape } from "../server/providers/triage-effort.ts";
import { fixtureEffortModel } from "./fixtures/triage-effort.ts";

const price = quoteEffort(
  {
    breadth: { value: 1 },
    complexity: { value: 1 },
    uncertainty: { value: 1 },
    risk: { value: 1 },
    impact: { value: 1 },
    urgency: { value: 0 },
    frequency: { value: 1 },
    ...requestShape("test"),
  },
  fixtureEffortModel,
);

// Test 1: hasExpectedOutput inferred from repo context
{
  const sparseText = "Fix the preview";
  const repoContext = "The preview component shows the expected output after every build. Users must see state.";
  const flags = requestStructure(sparseText, repoContext);
  assert.equal(flags.hasExpectedOutput, true, "hasExpectedOutput should be inferred from repo context");
  assert.equal(flags.inferredFromRepo, true, "inferredFromRepo should be true when inferred from repo context");
  console.log("Test 1 passed: hasExpectedOutput inferred from repo context");
}

// Test 2: hasFilePath never inferred from repo context
{
  const sparseText = "Fix the preview";
  const repoContext = "The file server/preview.ts shows the expected output after every build.";
  const flags = requestStructure(sparseText, repoContext);
  assert.equal(flags.hasFilePath, false, "hasFilePath should NOT be inferred from repo context");
  console.log("Test 2 passed: hasFilePath never inferred from repo context");
}

// Test 3: quoteStructure with repo context
{
  const sparseText = "Fix the preview";
  const repoContext = "The preview component shows the expected output after every build.";
  const structure = quoteStructure(sparseText, price, repoContext);
  assert.equal(structure.flags.hasExpectedOutput, true);
  assert.equal(structure.flags.inferredFromRepo, true);
  console.log("Test 3 passed: quoteStructure with repo context");
}

// Test 4: shape-only fallback (no repo context, no expected output in text)
{
  const sparseText = "Fix the preview";
  const flags = requestStructure(sparseText);
  assert.equal(flags.hasExpectedOutput, false);
  assert.equal(flags.hasFilePath, false);
  assert.equal(flags.hasAcceptanceCheck, false);
  assert.equal(flags.inferredFromRepo, false);
  console.log("Test 4 passed: shape-only fallback");
}

// Test 5: explicit expected output in text takes precedence
{
  const text = "Fix the preview. Expected: shows the component after build.";
  const repoContext = "The preview component shows the expected output after every build.";
  const flags = requestStructure(text, repoContext);
  assert.equal(flags.hasExpectedOutput, true);
  // When explicitly in text, inferredFromRepo should be false (observed)
  assert.equal(flags.inferredFromRepo, false);
  console.log("Test 5 passed: explicit text takes precedence");
}

console.log("All tests passed!");