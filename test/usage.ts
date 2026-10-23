import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexTranslator } from "../server/providers/codex.ts";
import { CodexTelemetry, codexTokenEvent } from "../server/providers/codex-telemetry.ts";
import { parseLabels } from "../server/providers/label.ts";
import { setLocalModelRateLimit } from "../server/providers/model-rate-client.ts";
import { ModelRateLimit } from "../server/providers/model-rate-limit.ts";
import {
  askNvidia,
  askRouter,
  createLabelCompletion,
  NVIDIA_LABEL_MODELS,
} from "../server/providers/small-model.ts";

const usageData = fs.mkdtempSync(path.join(os.tmpdir(), "usage-data-"));
process.on("exit", () => fs.rmSync(usageData, { recursive: true, force: true }));
process.env.AGENT_CONSOLE_DATA = usageData;
const {
  claudeWindows,
  codexWindows,
  routerUsage,
  deepseekUsage,
  refreshDeepSeekUsage,
  usage,
  historyRows,
} = await import("../server/usage.ts");
setLocalModelRateLimit(
  new ModelRateLimit({
    path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-rate-")), "gate.sqlite"),
    intervalMs: 1,
  }),
);
const token = {
  type: "event_msg",
  timestamp: "2026-10-16T10:00:00Z",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: 5_700_000 },
      last_token_usage: { total_tokens: 136279 },
      model_context_window: 475000,
    },
    rate_limits: {
      primary: { used_percent: 15, window_minutes: 300, resets_at: 1792151311 },
      secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1792655061 },
    },
  },
};
assert.deepEqual(codexTokenEvent(token)?.context, {
  used: 136279,
  max: 475000,
  source: "codex/last_request",
});
assert.equal(codexWindows(token.payload.rate_limits)[0].label, "5-hour");
assert.equal(codexWindows(token.payload.rate_limits)[1].used, 4);
assert.equal(
  claudeWindows({ rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1 } } } })[0].used,
  100,
);
assert.equal(
  routerUsage({ free_model_daily_requests: { used: 49, limit: 50 }, usage_daily: 0 }).windows[0]
    .limit,
  50,
);
assert.equal(routerUsage({ usage_daily: 0 }).windows.length, 0); // no invented allowance
const deepseekPayload = {
  is_available: true,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "12.30",
      granted_balance: "0.30",
      topped_up_balance: "12.00",
    },
    { currency: "CNY", total_balance: "0", granted_balance: "0", topped_up_balance: "0" },
  ],
};
assert.deepEqual(deepseekUsage(deepseekPayload), {
  windows: [],
  available: true,
  balances: [
    { currency: "USD", total: 12.3, granted: 0.3, toppedUp: 12 },
    { currency: "CNY", total: 0, granted: 0, toppedUp: 0 },
  ],
});
assert.equal(deepseekUsage({ ...deepseekPayload, is_available: false })?.available, false);
for (const value of [
  undefined,
  null,
  "",
  " ",
  "NaN",
  "Infinity",
  "0x10",
  "-1",
  -1,
  Infinity,
  NaN,
  true,
  {},
]) {
  assert.equal(
    deepseekUsage({
      ...deepseekPayload,
      balance_infos: [{ ...deepseekPayload.balance_infos[0], total_balance: value }],
    }),
    undefined,
    `invalid balance ${String(value)} cannot replace a successful sample`,
  );
}
for (const payload of [
  null,
  {},
  { ...deepseekPayload, is_available: "true" },
  { ...deepseekPayload, balance_infos: [] },
  { ...deepseekPayload, balance_infos: [null] },
  { ...deepseekPayload, balance_infos: [{ ...deepseekPayload.balance_infos[0], currency: "EUR" }] },
  { ...deepseekPayload, balance_infos: [{ currency: "USD", total_balance: "1" }] },
]) {
  assert.equal(deepseekUsage(payload), undefined);
}

const balanceFetch = globalThis.fetch;
const balanceClock = Date.now;
const balanceKey = process.env.DEEPSEEK_API_KEY;
const balanceMock = process.env.AGENT_CONSOLE_MOCK;
let balanceNow = 2_000_000_000_000;
let balanceCalls = 0;
let balanceResult: "success" | "invalid" | "http" | "network" = "success";
let releaseBalance: (() => void) | undefined;
try {
  process.env.DEEPSEEK_API_KEY = "fixture";
  delete process.env.AGENT_CONSOLE_MOCK;
  Date.now = () => balanceNow;
  globalThis.fetch = (async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/user/balance");
    assert.ok(options?.signal instanceof AbortSignal);
    balanceCalls++;
    await new Promise<void>((resolve) => {
      releaseBalance = resolve;
    });
    if (balanceResult === "network") throw Error("fixture network failure");
    return new Response(JSON.stringify(balanceResult === "invalid" ? {} : deepseekPayload), {
      status: balanceResult === "http" ? 503 : 200,
    });
  }) as typeof fetch;
  const firstBalance = refreshDeepSeekUsage();
  assert.equal(refreshDeepSeekUsage(), firstBalance, "concurrent requests share the same refresh");
  releaseBalance!();
  await firstBalance;
  const successfulBalance = usage.get("pi:deepseek");
  assert.equal(successfulBalance.balances?.[0].total, 12.3);
  await refreshDeepSeekUsage();
  assert.equal(balanceCalls, 1, "balance refresh remains cached for five minutes");
  for (const outcome of ["invalid", "http", "network"] as const) {
    balanceResult = outcome;
    balanceNow += 5 * 60_000;
    const refresh = refreshDeepSeekUsage();
    releaseBalance!();
    await refresh;
    assert.deepEqual(
      usage.get("pi:deepseek"),
      successfulBalance,
      `${outcome} preserves the successful sample and timestamp`,
    );
  }
  assert.equal(balanceCalls, 4);
} finally {
  globalThis.fetch = balanceFetch;
  Date.now = balanceClock;
  if (balanceKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = balanceKey;
  if (balanceMock === undefined) delete process.env.AGENT_CONSOLE_MOCK;
  else process.env.AGENT_CONSOLE_MOCK = balanceMock;
}
assert.equal(
  historyRows("claude", undefined, {
    windows: [{ label: "5-hour", used: 1, limit: 100 }],
    updatedAt: 11,
    observedAt: 11,
    usageProvider: "claude",
  })[0].timestampSource,
  "received",
);
const quotaWindow = { label: "5-hour", used: 1, limit: 100, unit: "%" };
const nativeReceipt = historyRows("claude", undefined, {
  windows: [quotaWindow],
  updatedAt: 12,
  observedAt: 12,
  usageProvider: "claude",
  sourceSessionId: "session-native",
  sourceEventUuid: "event-a",
})[0];
assert.equal(nativeReceipt.sourceSessionId, "session-native");
assert.equal(nativeReceipt.sourceEventUuid, "event-a");
assert.equal(
  historyRows(
    "claude",
    {
      windows: [quotaWindow],
      updatedAt: 12,
      sourceSessionId: "session-native",
      sourceEventUuid: "event-a",
    },
    {
      windows: [quotaWindow],
      updatedAt: 13,
      observedAt: 13,
      usageProvider: "claude",
      sourceSessionId: "session-native",
      sourceEventUuid: "event-b",
    },
  ).length,
  1,
  "distinct UUID observations append even when quota value is unchanged",
);
assert.equal(
  historyRows(
    "claude",
    {
      windows: [quotaWindow],
      updatedAt: 12,
      sourceSessionId: "session-native-a",
      sourceEventUuid: "event-shared",
    },
    {
      windows: [quotaWindow],
      updatedAt: 13,
      observedAt: 13,
      usageProvider: "claude",
      sourceSessionId: "session-native-b",
      sourceEventUuid: "event-shared",
    },
  ).length,
  1,
  "same UUID in another native session remains a distinct observation",
);
const emitted: any[] = [];
codexTranslator((e) => emitted.push(e))({
  type: "turn.completed",
  usage: { input_tokens: 5_700_000, output_tokens: 3000 },
});
assert.ok(!emitted.some((e) => e.type === "context_usage"));
assert.ok(emitted.some((e) => e.type === "token_usage" && e.input_tokens === 5_700_000));
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
} finally {
  if (prior === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prior;
  fs.rmSync(root, { recursive: true, force: true });
}
assert.equal(parseLabels("[123]", 1), undefined);
const calls: string[] = [];
const complete = createLabelCompletion([
  {
    id: "haiku",
    call: async () => {
      calls.push("haiku");
      throw Error("quota exhausted");
    },
  },
  {
    id: "router",
    call: async () => {
      calls.push("router");
      return "not json";
    },
  },
  {
    id: "codex",
    call: async () => {
      calls.push("codex");
      return '["Running the test suite"]';
    },
  },
]);
const validate = (s: string | undefined) => {
  try {
    return JSON.parse(s!);
  } catch {}
};
assert.deepEqual(await complete("fixture", "labels", validate), ["Running the test suite"]);
assert.deepEqual(calls, ["haiku", "router", "codex"]);
calls.length = 0;
await complete("fixture", "labels", validate);
assert.deepEqual(calls, ["router", "codex"]); // thrown failures are cooled down; one unusable reply does not bench its engine
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
let sent: any;
try {
  process.env.OPENROUTER_API_KEY = "fixture-only";
  globalThis.fetch = (async (_url: any, opts: any) => {
    sent = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Fixture label" } }] }), {
      status: 200,
    });
  }) as typeof fetch;
  assert.equal(await askRouter("fixture", "labels"), "Fixture label");
  assert.deepEqual(
    sent.models,
    ["nvidia/nemotron-3-super-120b-a12b:free"],
    "fallback is the same Nemotron model, free tier only",
  );
  assert.equal(sent.reasoning.effort, "none"); // prevent free reasoning models consuming the label's entire output budget
  const originalNvidia = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = "fixture-only";
  let url = "";
  globalThis.fetch = (async (u: any, opts: any) => {
    url = String(u);
    sent = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Nvidia label" } }] }), {
      status: 200,
    });
  }) as typeof fetch;
  assert.equal(await askNvidia("fixture", "labels"), "Nvidia label");
  assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(
    sent.model,
    process.env.AGENT_CONSOLE_LABEL_NVIDIA_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b",
  );
  assert.equal(
    NVIDIA_LABEL_MODELS.length > 1 || !!process.env.AGENT_CONSOLE_LABEL_NVIDIA_MODEL,
    true,
    "more than one NIM model before OpenRouter",
  );
  await askNvidia("fixture", "labels", "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(
    sent.model,
    "nvidia/nemotron-3-ultra-550b-a55b",
    "each fallback engine asks its own NIM model",
  );
  assert.equal(sent.chat_template_kwargs.enable_thinking, false);
  if (originalNvidia === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = originalNvidia;
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
}
console.log(
  "PASS context vs cumulative usage, Codex tailing, provider allowances, no invented limits, validated helper fallback and cooldown",
);
