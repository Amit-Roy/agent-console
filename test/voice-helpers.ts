// Pure helpers behind voice input: option matching for spoken answers and the read-aloud summary. Run: node test/voice-helpers.ts
import assert from "node:assert/strict";
import { matchOptions, splitSentences, tldr } from "../public/voice-text.js";

const labels = ["Quick pass", "Full review", "Skip it"];
assert.deepEqual(matchOptions("quick pass", labels), ["Quick pass"]);
assert.deepEqual(matchOptions("Full Review.", labels), ["Full review"]);
assert.deepEqual(matchOptions("one", labels), ["Quick pass"]);
assert.deepEqual(matchOptions("the second", labels), ["Full review"]);
assert.deepEqual(matchOptions("the second one", labels), ["Full review"]);
assert.deepEqual(matchOptions("Option three", labels), ["Skip it"]);
assert.deepEqual(matchOptions("let's do the full review please", labels), ["Full review"]);
assert.deepEqual(matchOptions("fifth", labels), [], "An ordinal past the end matches nothing");
assert.deepEqual(matchOptions("something completely different", labels), []);
assert.deepEqual(matchOptions("", labels), []);

assert.equal(tldr("Done. All tests pass.\n\nSecond paragraph."), "Done. All tests pass.");
assert.equal(tldr("```js\nconst a = 1;\n```\n\nThe fix is in place."), "The fix is in place.");
assert.equal(tldr("| a | b |\n| - | - |\n\nAfter the table."), "After the table.");
assert.equal(
  tldr("## Heading\n**Bold** and [a link](http://x.test) with `code`."),
  "Heading Bold and a link with code.",
);
const long = `${"This is a sentence. ".repeat(30)}`;
const cut = tldr(long);
assert.ok(cut.length <= 280 && cut.endsWith("."), `cut at a sentence end: ${cut.length}`);
assert.ok(tldr("x".repeat(500)).length <= 280, "A single huge sentence is truncated");
assert.equal(tldr("```\nonly code\n```"), "");
assert.deepEqual(splitSentences("One. Two! Three? Four"), ["One.", "Two!", "Three?", "Four"]);
console.log("Voice helper checks passed.");
