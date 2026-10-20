import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConsoleSessions, initialSessionRequest, writePrivateSessionJson } from "../scripts/triage-console-sessions.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-session-source-"));
fs.mkdirSync(path.join(dir, "logs"));
const nativeId = "11111111-1111-4111-8111-111111111111";
const activeId = "22222222-2222-4222-8222-222222222222";
const piUsage = (input: number, output: number, cache: number) => [{ model: "fixture", role: "agent", fresh: input - cache, cacheWrite: 0, cacheRead: cache, output }];
const threads: any[] = [], rows: any[] = [];
const add = (id: string, provider: string, events: any[] | null, ledger: any[] = [], extra: any = {}) => {
  threads.push({ id, provider, model: "fixture", status: "idle", createdAt: 50, updatedAt: 500, ...extra });
  rows.push(...ledger.map(row => ({ thread: id, provider, accounting: 2, ...row })));
  if (events) fs.writeFileSync(path.join(dir, "logs", `${id}.jsonl`), events.map(event => JSON.stringify(event)).join("\n") + "\n");
};
try {
  add("basic", "pi", [
    { type: "system", subtype: "init", session_id: nativeId },
    { type: "user_input", ts: 70, text: "/model" },
    { type: "user_input", ts: 80, text: "Automated wake", auto: "subagent" },
    { type: "user_input", ts: 100, text: "Go" },
    { type: "user_input", ts: 101, text: "Build a small app." },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "a" }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "a" }] } },
    { type: "result", uuid: "r1", ts: 200, duration_ms: 100, usageModels: piUsage(50, 20, 20) },
    { type: "user_input", ts: 300, text: "Later changed scope must never be a predictor." },
    { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "POST OUTCOME PLAN" }, { type: "tool_use", id: "b" }, { type: "tool_use", id: "c" }] } },
    { type: "token_usage", input_tokens: 70, output_tokens: 30, cached_input_tokens: 10 },
    { type: "result", uuid: "r2", ts: 400, duration_ms: 100, is_error: true },
  ], [
    { ts: 100, eventId: "r1", in: 50, out: 20, cache: 20 },
    { ts: 100, eventId: "r1", in: 50, out: 20, cache: 20 },
    { ts: 300, eventId: "r2", provider: "codex", in: 70, out: 30, cache: 10, err: 1 },
    { ts: 300, duplicate: true, in: 999, out: 999, cache: 0 },
  ], { sessionId: nativeId });
  add("active", "codex", [{ type: "user_input", ts: 100, text: "Run" }], [], { status: "running", sessionId: activeId });
  add("missing", "pi", [{ type: "user_input", ts: 100, text: "Run" }, { type: "result", ts: 200 }], [{ ts: 100, unresolved: "Missing counters" }]);
  add("zero", "pi", [{ type: "user_input", ts: 100, text: "?" }, { type: "result", ts: 200, usageModels: piUsage(0, 0, 0) }], [{ ts: 100, in: 0, out: 0, cache: 0 }]);
  const claudeResult = (uuid: string, fresh: number, cache: number, output: number, cost: number, ts: number) => ({ type: "result", uuid, session_id: nativeId, ts, total_cost_usd: cost,
    modelUsage: { fixture: { inputTokens: fresh, cacheCreationInputTokens: 0, cacheReadInputTokens: cache, outputTokens: output, costUSD: cost } } });
  add("claude", "claude", [
    { type: "user_input", ts: 100, text: "First" }, claudeResult("c1", 10, 90, 10, 1, 200),
    { type: "user_input", ts: 300, text: "Second" }, { ...claudeResult("c2", 30, 130, 15, 2, 400), is_error: true },
  ], [
    { ts: 100, accounting: 1, in: 999, out: 999, cache: 0 },
    { ts: 300, accounting: 1, in: 999, out: 999, cache: 0, err: 1 },
  ]);
  add("reconstructed", "pi", [{ type: "user_input", ts: 100, text: "Do" }, { type: "result", ts: 200, usageModels: piUsage(13, 7, 3) }]);
  add("missing-log", "codex", null, [{ ts: 100, in: 1, out: 1, cache: 0 }]);
  add("no-initial", "pi", [{ type: "user_input", ts: 100, text: "Question answer", questionAnswer: true }, { type: "assistant", message: { content: [{ type: "text", text: "A later plan is not an initial request." }] } }]);
  add("fixture-synthetic", "pi", [{ type: "user_input", ts: 100, text: "Go" }]);
  add("conflict", "pi", [{ type: "user_input", ts: 100, text: "Go" }], [{ ts: 100, eventId: "same", in: 1, out: 1, cache: 0 }, { ts: 100, eventId: "same", in: 2, out: 1, cache: 0 }]);
  const parentId = "33333333-3333-4333-8333-333333333333";
  const forkA = "44444444-4444-4444-8444-444444444444", forkB = "55555555-5555-4555-8555-555555555555";
  add("parent-session", "pi", [{ type: "user_input", ts: 100, text: "Original" }, { type: "result", ts: 200, session_id: parentId, usageModels: piUsage(10, 5, 2) }], [{ ts: 100, session: parentId, in: 10, out: 5, cache: 2 }], { sessionId: parentId });
  for (const [id, ownId] of [["fork-a", forkA], ["fork-b", forkB]]) add(id, "pi", [
    { type: "user_input", ts: 100, text: "Inherited parent input must not become a fork predictor." },
    { type: "system", subtype: "init", session_id: parentId },
    { type: "result", ts: 200, session_id: parentId, usageModels: piUsage(10, 5, 2) },
    { type: "user_input", ts: 300, text: "Fork task" },
    { type: "system", subtype: "init", session_id: ownId },
    { type: "result", ts: 400, session_id: ownId, usageModels: piUsage(20, 5, 10) },
  ], [{ ts: 100, session: parentId, in: 10, out: 5, cache: 2 }, { ts: 300, session: ownId, in: 20, out: 5, cache: 10 }], { createdAt: 250, sessionId: ownId, forkFrom: parentId });
  add("cache-unknown", "codex", [{ type: "user_input", ts: 100, text: "Count" }, { type: "token_usage", input_tokens: 25, output_tokens: 5 }, { type: "result", ts: 200 },
    { type: "user_input", ts: 300, text: "Later" }, { type: "token_usage", input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 }, { type: "result", ts: 400 }], [{ ts: 100, in: 25, out: 5 }, { ts: 300, in: 10, out: 2, cache: 4 }]);
  add("legacy-cache-unknown", "codex", [{ type: "user_input", ts: 100, text: "Count" }, { type: "result", ts: 200 }], [{ ts: 100, accounting: 1, in: 25, out: 5 }]);
  add("invalid-cache", "codex", [{ type: "user_input", ts: 100, text: "Count" }, { type: "token_usage", input_tokens: 20, output_tokens: 5, cached_input_tokens: 50 }, { type: "result", ts: 200 }], [{ ts: 100, in: 20, out: 5, cache: 50 }]);
  rows.push({ thread: "orphan-ledger", provider: "codex", accounting: 2, ts: 100, in: 1, out: 1, cache: 0 });
  fs.writeFileSync(path.join(dir, "logs", "orphan-log.jsonl"), JSON.stringify({ type: "user_input", ts: 100, text: "Go" }) + "\n");
  fs.writeFileSync(path.join(dir, "threads.json"), JSON.stringify(threads));
  fs.writeFileSync(path.join(dir, "turns.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = buildConsoleSessions({ dataDir: dir });
  const basic = result.tasks.find(row => row.id === "console:basic")!;
  assert.equal(basic.request, "Go\n\nBuild a small app.");
  assert.deepEqual(basic.preworkContext, []);
  assert.ok(!JSON.stringify({ request: basic.request, context: basic.preworkContext }).includes("POST OUTCOME"));
  assert.equal(basic.inputTokens, 120); assert.equal(basic.outputTokens, 50);
  assert.equal(basic.cacheReadTokens, 30); assert.equal(basic.nonCachedInputTokens, 90);
  assert.equal(basic.provider, "mixed"); assert.deepEqual(basic.providerMix, { codex: 1, pi: 1 });
  assert.equal(basic.provenance.historicalFailureRecords, 1, "Failed usage belongs to the session total");
  assert.equal(basic.provenance.initialMessageCount, 2);
  assert.deepEqual([basic.toolCalls, basic.toolRounds], [3, 2]);
  assert.equal(basic.startedAt, new Date(100).toISOString());
  assert.equal(basic.completedAt, new Date(500).toISOString());
  const claude = result.tasks.find(row => row.id === "console:claude")!;
  assert.equal(claude.inputTokens, 160, "Cumulative provider snapshots must become deltas once");
  assert.equal(claude.outputTokens, 15); assert.equal(claude.cacheReadTokens, 130);
  const zero = result.tasks.find(row => row.id === "console:zero")!;
  assert.equal(zero.inputTokens, 0); assert.equal(zero.outputTokens, 0); assert.equal(zero.toolCalls, 0);
  assert.equal(result.tasks.find(row => row.id === "console:reconstructed")?.inputTokens, 13);
  assert.equal(result.audit.totalSessions, 18); assert.equal(result.audit.selectedSessions, 9);
  assert.equal(result.audit.excludedSessions, 9); assert.equal(result.audit.accountingExhaustive, true);
  assert.equal(result.audit.ledgerDuplicateRows, 2); assert.equal(result.audit.ledgerExplicitDuplicateRows, 1);
  assert.equal(result.audit.exclusions.incompleteSessionAccounting, 2);
  assert.equal(result.audit.exclusions.missingThreadMetadata, 2);
  assert.equal(result.audit.exclusions.conflictingDuplicateAccounting, 1);
  assert.deepEqual(result.activeNativeSessionIds, [activeId]);
  assert.ok(result.linkedNativeSessionIds.includes(nativeId));
  assert.equal(result.sessionLinks.find(row => row.threadId === "active")?.active, true);
  const forkTaskA = result.tasks.find(row => row.id === "console:fork-a")!, forkTaskB = result.tasks.find(row => row.id === "console:fork-b")!;
  assert.equal(forkTaskA.request, "Fork task"); assert.equal(forkTaskA.inputTokens, 20);
  assert.deepEqual(forkTaskA.provenance.nativeSessionIds, [forkA]);
  assert.deepEqual(forkTaskB.provenance.nativeSessionIds, [forkB]);
  assert.deepEqual(forkTaskA.provenance.lineageNativeSessionIds, [parentId]);
  assert.ok(!forkTaskA.provenance.nativeSessionIds.includes(parentId));
  assert.notEqual(forkTaskA.group, forkTaskB.group, "Shared fork lineage is not session identity");
  for (const id of ["cache-unknown", "legacy-cache-unknown"]) {
    const task = result.tasks.find(row => row.id === `console:${id}`)!;
    assert.equal(task.inputTokens, id === "cache-unknown" ? 35 : 25); assert.equal(task.outputTokens, id === "cache-unknown" ? 7 : 5);
    assert.equal(task.cacheReadTokens, null); assert.equal(task.nonCachedInputTokens, null);
  }
  const long = initialSessionRequest([{ type: "user_input", ts: 1, text: "x".repeat(12_010) }, { type: "assistant" }])!;
  assert.equal(long.request.length, 12_000); assert.equal(long.truncated, true); assert.equal(long.originalCharacters, 12_010);
  assert.equal(initialSessionRequest([{ type: "user_input", ts: 1, text: "/build-app Build the requested app." }, { type: "assistant" }])?.request, "/build-app Build the requested app.", "Task skill invocations are genuine requests, not control commands");
  const output = path.join(dir, "private.json"); writePrivateSessionJson(output, result);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  console.log("Console sessions: whole-session usage, initial-only predictors, failure inclusion, cumulative normalization, duplicate protection, missing-versus-zero, linkage, and private output passed.");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
