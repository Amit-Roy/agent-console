// Unit tests for the ```arch spec validator and DOM builder (public/arch.js). Run: node test/arch.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";

const { validateArch, buildArch, setArchIcons } = await import("../public/arch.js");
const example = JSON.parse(
  fs.readFileSync(new URL("fixtures/architecture.json", import.meta.url), "utf8"),
);

assert.deepEqual(validateArch(example), [], "example spec is valid");

const unknownKey = structuredClone(example);
unknownKey.bogus = 1;
assert.match(validateArch(unknownKey).join("\n"), /unknown keys bogus/);

const dangling = structuredClone(example);
dangling.edges.push({ from: "agent", to: "nope" });
assert.match(validateArch(dangling).join("\n"), /to must reference a node or group id, got nope/);

const badValues = {
  title: "t",
  items: [{ id: "a", label: "A", color: "red", status: "weird" }, { id: "a", label: "B" }],
};
const badText = validateArch(badValues).join("\n");
assert.match(badText, /color must be one of/);
assert.match(badText, /status must be one of/);
assert.match(badText, /duplicate id a/);
assert.deepEqual(validateArch(null), ["spec must be a JSON object"]);

// DOM build in linkedom: every node gets data-id, edges are kept for the router.
const { document, window } = parseHTML("<!doctype html><html><head></head><body><div id=c></div></body></html>");
Object.assign(globalThis, { document, window });
setArchIcons({ bot: '<circle cx="12" cy="12" r="3"/>' });
const box = document.getElementById("c");
await buildArch(example, box);
type Item = { group?: string; items?: Item[] };
const countNodes = (items: Item[]): number =>
  items.reduce((n, i) => n + (i.items ? countNodes(i.items) : 1), 0);
assert.equal(box.querySelectorAll(".node[data-id]").length, countNodes(example.items));
assert.equal(box.__archEdges.length, example.edges.length);
assert.ok(box.querySelector(".legend"));
assert.ok(box.querySelector('.node[data-id="agent"] svg.glyph circle'), "Lucide icon inlined");
console.log("arch ok");
