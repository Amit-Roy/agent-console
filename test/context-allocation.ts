import assert from "node:assert/strict";
import {
  buildContextAllocation,
  nativeAllocationCounts,
  contextAllocation,
} from "../server/context-allocation.ts";

const message = (text: string, role = "user") => ({
  type: "message",
  role,
  content: [{ type: "text", text }],
});
const before = "old archived text ".repeat(100);
const codex = nativeAllocationCounts("codex", [
  { type: "session_meta", payload: { base_instructions: { text: "base" } } },
  { type: "response_item", payload: message(before) },
  {
    type: "compacted",
    payload: {
      replacement_history: [
        message("short summary"),
        { type: "compaction", encrypted_content: before },
      ],
    },
  },
  { type: "response_item", payload: { type: "function_call_output", output: "tool data" } },
])!;
assert.equal(codex.messages, 4);
assert.equal(codex.system, 1);
assert.equal(codex.tool_results, 3);
assert.equal(
  nativeAllocationCounts("codex", [{ type: "response_item", payload: message(before) }]),
  undefined,
);
assert.equal(nativeAllocationCounts("codex", [{ type: "compacted", payload: {} }])!.messages, 0);

const claudeRows = [
  {
    type: "api-request-shape",
    shapeHash: "s",
    shape: {
      system: [{ type: "text", text: "rules" }],
      tools: [{ name: "Read", input_schema: {} }],
    },
  },
  { type: "api-request-blob", hash: "a", message: message(before) },
  { type: "api-request-blob", hash: "b", message: message("summary") },
  {
    type: "api-request-blob",
    hash: "c",
    message: { role: "user", content: [{ type: "tool_result", content: "result" }] },
  },
  { type: "api-request", id: "one", shapeHash: "s", keep: 0, tail: ["a"] },
  { type: "api-request", id: "two", shapeHash: "s", base: "one", keep: 0, tail: ["b", "c"] },
];
const claude = nativeAllocationCounts("claude", claudeRows)!;
assert.equal(claude.messages, 2);
assert.equal(claude.tool_results, 2);
assert.ok(claude.tools > 0);
assert.equal(
  nativeAllocationCounts("claude", [
    ...claudeRows,
    { type: "api-request", base: "missing", tail: [] },
  ]),
  undefined,
);

// Long append chains must reconstruct once, retaining the correct prefix after truncation.
const chain: any[] = [{ type: "api-request-blob", hash: "x", message: message("word") }];
for (let i = 0; i < 3000; i++)
  chain.push({
    type: "api-request",
    id: `r${i}`,
    base: i ? `r${i - 1}` : undefined,
    keep: i,
    tail: ["x"],
  });
assert.equal(nativeAllocationCounts("claude", chain)!.messages, 3000);
chain.push({ type: "api-request", id: "trimmed", base: "r2999", keep: 20, tail: ["x"] });
assert.equal(nativeAllocationCounts("claude", chain)!.messages, 21);
assert.equal(
  nativeAllocationCounts("claude", [
    { type: "api-request", id: "a", base: "b", keep: 1, tail: [] },
    { type: "api-request", id: "b", base: "a", keep: 1, tail: [] },
  ]),
  undefined,
);
assert.equal(
  nativeAllocationCounts("claude", [
    { type: "api-request", id: "a", keep: 0, tail: [] },
    { type: "api-request", id: "b", base: "a", keep: 10, tail: [] },
  ]),
  undefined,
);
const deep = Array.from({ length: 4097 }, (_, i) => ({
  type: "api-request",
  id: `d${i}`,
  base: i ? `d${i - 1}` : undefined,
  keep: i,
  tail: ["x"],
}));
assert.equal(nativeAllocationCounts("claude", deep), undefined);

const thread = { provider: "codex", context: { used: 100, max: 1000 } };
const result = buildContextAllocation(thread, { messages: 40, system: 10 });
assert.equal(result.categories.find((c) => c.id === "unknown")!.tokens, 50);
assert.equal(result.categories.find((c) => c.id === "free")!.tokens, 900);
assert.equal(
  result.categories.reduce((sum, c) => sum + c.tokens, 0),
  1000,
);
const oversize = buildContextAllocation(thread, { messages: 200, tools: 101 });
assert.equal(
  oversize.categories.filter((c) => c.id !== "free").reduce((sum, c) => sum + c.tokens, 0),
  100,
);
assert.deepEqual(
  buildContextAllocation({ provider: "claude", context: { max: 1000 } }, claude).categories,
  [],
);
const invalid = await contextAllocation({ ...thread, sessionId: "../../private" } as any);
assert.equal(invalid.source, "codex/usage-only");
assert.equal(invalid.categories[0].tokens, 100);
assert.ok(!JSON.stringify(result).includes("archived"));
console.log(
  "context allocation: retained context, compaction boundaries, request chains, unknown remainder, privacy passed",
);
