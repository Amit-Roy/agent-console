import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexTelemetry, codexTokenEvent } from "../server/providers/codex-telemetry.ts";
import { createLabelCompletion, askRouter } from "../server/providers/small-model.ts";
import { claudeWindows, codexWindows, routerUsage } from "../server/usage.ts";
import { parseLabels } from "../server/providers/label.ts";
import { codexTranslator } from "../server/providers/codex.ts";
const token = { type: "event_msg", timestamp: "2026-10-16T10:00:00Z", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 5_700_000 }, last_token_usage: { total_tokens: 136279 }, model_context_window: 475000 }, rate_limits: { primary: { used_percent: 15, window_minutes: 300, resets_at: 1792151311 }, secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1792655061 } } } };
assert.deepEqual(codexTokenEvent(token)?.context, { used: 136279, max: 475000, source: "codex/last_request" });
assert.equal(codexWindows(token.payload.rate_limits)[0].label, "5-hour");
assert.equal(codexWindows(token.payload.rate_limits)[1].used, 4);
assert.equal(claudeWindows({ rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1 } } } })[0].used, 100);
assert.equal(routerUsage({ free_model_daily_requests: { used: 49, limit: 50 }, usage_daily: 0 }).windows[0].limit, 50);
assert.equal(routerUsage({ usage_daily: 0 }).windows.length, 0); // no invented allowance
const emitted: any[] = [];
codexTranslator(e => emitted.push(e))({ type: "turn.completed", usage: { input_tokens: 5_700_000, output_tokens: 3000 } });
assert.ok(!emitted.some(e => e.type === "context_usage"));
assert.ok(emitted.some(e => e.type === "token_usage" && e.input_tokens === 5_700_000));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-telemetry-unit-"));
const prior = process.env.CODEX_HOME;
try {
  process.env.CODEX_HOME = root;
  fs.mkdirSync(path.join(root, "sessions"));
  const file = path.join(root, "sessions", "rollout-fixture.jsonl");
  fs.writeFileSync(file, JSON.stringify(token) + "\n");
  const reader = new CodexTelemetry("fixture");
  assert.equal(reader.read()[0].context?.used, 136279);
  assert.equal(reader.read().length, 0);
  fs.appendFileSync(file, JSON.stringify({ ...token, payload: { ...token.payload, info: null } }));
  assert.equal(reader.read().length, 0); // partial line waits until complete
  fs.appendFileSync(file, "\n");
  assert.equal(reader.read()[0].context, undefined); // quota-only telemetry never invents context
  fs.writeFileSync(file, JSON.stringify(token) + "\n");
  assert.equal(reader.read()[0].context?.max, 475000);
} finally { if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); }
assert.equal(parseLabels('[123]', 1), undefined);
const calls: string[] = [];
const complete = createLabelCompletion([
  { id: "haiku", call: async () => { calls.push("haiku"); throw Error("quota exhausted"); } },
  { id: "router", call: async () => { calls.push("router"); return "not json"; } },
  { id: "codex", call: async () => { calls.push("codex"); return '["Running the test suite"]'; } },
]);
const validate = (s: string | undefined) => { try { return JSON.parse(s!); } catch {} };
assert.deepEqual(await complete("fixture", "labels", validate), ["Running the test suite"]);
assert.deepEqual(calls, ["haiku", "router", "codex"]);
calls.length = 0;
await complete("fixture", "labels", validate);
assert.deepEqual(calls, ["codex"]); // failures and invalid output are cooled down
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
let sent: any;
try {
  process.env.OPENROUTER_API_KEY = "fixture-only";
  globalThis.fetch = (async (_url: any, opts: any) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ choices: [{ message: { content: "Fixture label" } }] }), { status: 200 }); }) as typeof fetch;
  assert.equal(await askRouter("fixture", "labels"), "Fixture label");
  assert.equal(sent.model, "openrouter/free");
  assert.equal(sent.reasoning.effort, "none"); // prevent free reasoning models consuming the label's entire output budget
} finally { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey; }
console.log("PASS context vs cumulative usage, Codex tailing, provider allowances, no invented limits, validated helper fallback and cooldown");
