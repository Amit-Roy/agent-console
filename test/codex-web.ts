import assert from "node:assert/strict";
import { toolName, toolSummary } from "../public/tool-display.js";
import { turnsOf } from "../server/export.ts";
import { codexTranslator } from "../server/providers/codex.ts";
import { codexWebTool } from "../server/providers/codex-web.ts";

const events: any[] = [];
const translate = codexTranslator((e) => events.push(e));
const item = { id: "web1", type: "web_search", query: "" };
translate({ type: "item.started", item });
assert.equal(events[0].message.content[0].name, "WebBrowse");
const rich = { ...item, action: { type: "search", queries: ["alpha", "beta"] } };
translate({ type: "item.updated", item: rich });
translate({ type: "item.completed", item: rich });
assert.equal(events.filter((e) => e.type === "assistant").length, 1);
assert.equal(events.filter((e) => e.type === "tool_update").length, 1);
assert.equal(toolSummary(events[1].name, events[1].input), "alpha · beta");
assert.equal(events.at(-1).message.content[0].is_error, false);
assert.equal(turnsOf(events)[0].text, "WebSearch: alpha · beta");
assert.equal(codexWebTool({ query: "legacy query" }).input.query, "legacy query");
for (const type of ["open_page", "openPage"]) {
  const v = codexWebTool({ query: "not a search", action: { type, url: "https://example.com" } });
  assert.deepEqual(v, { name: "WebFetch", input: { url: "https://example.com" } });
}
for (const type of ["find_in_page", "findInPage"]) {
  const v = codexWebTool({ action: { type, url: "https://example.com", pattern: "needle" } });
  assert.equal(v.name, "WebFind");
  assert.equal(toolSummary(v.name, v.input), "needle · https://example.com");
}
assert.equal(codexWebTool({ query: "misleading", action: { type: "other" } }).name, "WebBrowse");
assert.match(codexWebTool({ action: { type: "search" } }).input.description, /not reported/);
assert.equal(toolName("WebSearch", { query: "" }), "WebBrowse");
assert.match(toolSummary("WebSearch", { query: "" }), /not reported/);
// Read calls get a shortened, readable path summary instead of the raw absolute path
assert.equal(
  toolSummary("Read", { file_path: "/home/coder/repos/agent-console/server/threads.ts" }),
  "agent-console/server/threads.ts",
);
assert.equal(toolSummary("Read", { file_path: "/tmp/scratch/notes.md" }), "scratch/notes.md");
assert.equal(toolSummary("Read", { file_path: "README.md" }), "README.md");
assert.equal(toolSummary("Read", {}), "");
translate({
  type: "item.completed",
  item: { id: "fail", type: "web_search", status: "failed", error: { message: "network down" } },
});
assert.equal(events.at(-1).message.content[0].is_error, true);
assert.equal(events.at(-1).message.content[0].content, "network down");
translate({
  type: "item.completed",
  item: {
    id: "results",
    type: "web_search",
    query: "hello",
    results: [{ url: "https://example.com" }],
  },
});
assert.match(events.at(-1).message.content[0].content, /example.com/);
console.log(
  "PASS web actions, metadata enrichment, deduplication, legacy missing metadata, failures and reported results",
);
