import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observedActivity, preworkContext } from "../scripts/triage-history-build.ts";
import { safePreworkRequest, parseFeatureBatch, extractEffortFeatures, effortDataset, requestHash, writePrivateJson } from "../scripts/triage-effort-features.ts";

const request = "Update only one component with reversible functional changes.";
const unknown = () => ({ value: null, evidence: null });
const metrics = () => ({ breadth: { value: 1, evidence: "only one component" }, complexity: unknown(), uncertainty: unknown(), risk: { value: 1, evidence: "reversible functional changes" } });
const input = [{ id: "0", request }];
assert.equal(safePreworkRequest("Ordinary task request", {}), "Ordinary task request");
for (const text of ["api_key=unusuallylongsecret123", "Bearer asecretlongtoken123", "https://user:secret@example.test", "sk-proj-somelongcredential1234567", "-----BEGIN PRIVATE KEY-----", "token=" + "A".repeat(60)]) assert.equal(safePreworkRequest(text, {}), undefined);
assert.equal(safePreworkRequest("Do work using a known-secret-value.", { EXAMPLE_TOKEN: "known-secret-value" }), undefined);
assert.equal(parseFeatureBatch(JSON.stringify({ records: [{ id: "0", metrics: metrics() }] }), input)?.[0].metrics.breadth.value, 1);
const invented = metrics(); invented.breadth.evidence = "one hidden component";
assert.equal(parseFeatureBatch(JSON.stringify({ records: [{ id: "0", metrics: invented }] }), input), undefined);
assert.equal(parseFeatureBatch(JSON.stringify({ records: [{ id: "0", metrics: metrics() }, { id: "0", metrics: metrics() }] }), input), undefined);
assert.deepEqual(observedActivity([
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] } },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "c" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "c" }] } },
]), { toolCalls: 3, toolRounds: 2 });
const contextEvents = [
  { type: "user_input", text: "Earlier approved task." },
  { type: "assistant", message: { content: [{ type: "text", text: "Plan: implement asynchronous recovery.\nCommitted abc1234.\nUsed 100 tokens." }, { type: "thinking", thinking: "HIDDEN" }, { type: "tool_use", id: "secret-tool", input: { text: "HIDDEN" } }] } },
  { type: "user_input", text: "Implement that plan." },
  { type: "assistant", message: { content: [{ type: "text", text: "POST OUTCOME" }] } },
];
assert.deepEqual(preworkContext(contextEvents, 2), [{ role: "user", text: "Earlier approved task." }, { role: "assistant", text: "Plan: implement asynchronous recovery." }]);
assert.ok(!JSON.stringify(preworkContext(contextEvents, 2)).includes("HIDDEN"));
assert.ok(!JSON.stringify(preworkContext(contextEvents, 2)).includes("POST OUTCOME"));
assert.equal(preworkContext([{ type: "user_input", text: "x".repeat(9000) }, { type: "user_input", text: "y".repeat(9000) }], 2).reduce((sum, item) => sum + item.text.length, 0), 8000);
assert.notEqual(requestHash(request), requestHash(request, [{ role: "assistant", text: "Applicable prior plan." }]));
const contextual = metrics(); contextual.complexity = { value: 2, evidence: "asynchronous recovery" };
assert.equal(parseFeatureBatch(JSON.stringify({ records: [{ id: "0", metrics: contextual }] }), [{ id: "0", request, preworkContext: [{ role: "assistant", text: "Plan: implement asynchronous recovery." }] }]), undefined, "Assistant plans cannot become initial-request evidence");

const source = { id: "s1", request, group: "g1", startedAt: "2025-12-31T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z", provider: "fixture", commits: [{ title: "POST OUTCOME SECRET" }], toolCalls: 10, toolRounds: 5, inputTokens: 1000, cacheReadTokens: 800, nonCachedInputTokens: 200, outputTokens: 300 };
let calls = 0;
const engines = [{ id: "invalid", call: async () => "invalid" }, { id: "good", call: async (prompt: string) => {
  calls++; assert.ok(!prompt.includes("POST OUTCOME SECRET")); assert.ok(!prompt.includes("outputTokens")); assert.ok(!prompt.includes("toolCalls"));
  return JSON.stringify({ records: [{ id: "0", metrics: metrics() }] });
} }];
const result = await extractEffortFeatures([source], [], engines);
assert.equal(result.audit.extracted, 1); assert.equal(result.records[0].requestHash, requestHash(request));
assert.equal(result.records[0].model, "good");
const cached = await extractEffortFeatures([source], result.records, engines);
assert.equal(cached.audit.reused, 1); assert.equal(calls, 1);
const refused = await extractEffortFeatures([{ ...source, preworkContext: [{ role: "user", text: "password=secret" }] }], result.records, engines);
assert.equal(refused.audit.invalidSource, 1); assert.equal(calls, 1, "Later conversation must never reach any model");
const changed = await extractEffortFeatures([{ ...source, request: request + " More." }], result.records, engines);
assert.equal(changed.audit.extracted, 1); assert.equal(calls, 2);
const dataset = effortDataset([source], result.records);
assert.equal(dataset.scope, "completed-session");
assert.equal(effortDataset([{ ...source, preworkContext: [{ role: "assistant", text: "Later plan" }] }], result.records).samples.length, 0);
assert.deepEqual(dataset.samples[0].features, { breadth: 1, complexity: null, uncertainty: null, risk: 1 });
assert.equal(dataset.samples[0].outcomes.cachedInputTokens, 800);
assert.equal(dataset.samples[0].outcomes.nonCachedInputTokens, 200);
assert.equal(dataset.samples[0].startedAt, source.startedAt);
assert.equal(effortDataset([{ ...source, startedAt: undefined }], result.records).samples.length, 0, "Missing start times must never be imputed");
assert.ok(!JSON.stringify(dataset).includes(request));
const unknownFeatures = effortDataset([{ ...source, request: "changed" }], result.records);
assert.equal(unknownFeatures.samples.length, 1, "Missing feature annotations must not discard known session outcomes");
assert.equal(unknownFeatures.samples[0].featureStatus, "unavailable");
assert.deepEqual(unknownFeatures.samples[0].features, { breadth: null, complexity: null, uncertainty: null, risk: null });
assert.equal(unknownFeatures.samples[0].outcomes.outputTokens, source.outputTokens);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "effort-feature-fixture-"));
try { const output = path.join(dir, "cache.json"); writePrivateJson(output, result); assert.equal(fs.statSync(output).mode & 0o777, 0o600); }
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("Effort prework features: quote validation, privacy refusal, outcome isolation, fallback, cache identity, and activity counts passed.");
