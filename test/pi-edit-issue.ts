import assert from "node:assert/strict";
import { piEditIssueDraft } from "../server/providers/triage-model.ts";

// Test 1: Empty draft returns null
const empty = await piEditIssueDraft("");
assert.equal(empty, null, "Empty draft should return null");

// Test 2: Whitespace-only draft returns null
const whitespace = await piEditIssueDraft("   \n\t   ");
assert.equal(whitespace, null, "Whitespace-only draft should return null");

// Test 3: piEditIssueDraft returns valid shape even when pi is unavailable
// (falls back to original draft)
const draft = "Fix the broken preview component";
const result = await piEditIssueDraft(draft);
assert.ok(result !== null, "Should return a result even when pi is unavailable");
if (result) {
  assert.equal(result.title, draft.slice(0, 100), "Title should fall back to original draft when pi fails");
  assert.equal(result.body, draft.trim(), "Body should fall back to original draft when pi fails");
}

console.log("piEditIssueDraft fallback tests passed");
