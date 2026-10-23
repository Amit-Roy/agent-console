import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import {
  idleCompactionPolicy,
  idleCompactionDeadline,
  IdleCompactionTimers,
} from "../server/idle-compaction.ts";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-idle-policy-"));
const cwd = path.join(home, "project");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
const t = {
  provider: "claude",
  cwd,
  status: "idle",
  sessionId: "fixture",
  context: { used: 50000 },
  lastUserActivityAt: 100,
  lastProviderActivityAt: 1000,
};
try {
  assert.equal(idleCompactionPolicy(t, {}, home).ttlMs, undefined);
  fs.writeFileSync(
    path.join(home, ".claude/settings.json"),
    JSON.stringify({ promptCacheTtl: "1h" }),
  );
  assert.equal(idleCompactionPolicy(t, {}, home).ttlMs, 3600000);
  fs.writeFileSync(
    path.join(cwd, ".claude/settings.json"),
    JSON.stringify({ promptCacheTtl: "5m" }),
  );
  assert.equal(idleCompactionPolicy(t, {}, home).ttlMs, 300000);
  fs.writeFileSync(
    path.join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ promptCacheTtl: "1h" }),
  );
  assert.equal(idleCompactionPolicy(t, {}, home).ttlMs, 3600000);
  assert.equal(
    idleCompactionPolicy(t, { AGENT_CONSOLE_IDLE_COMPACT_CLAUDE_TTL_MS: "600000" }, home).ttlMs,
    600000,
  );
  assert.equal(
    idleCompactionPolicy(t, { AGENT_CONSOLE_IDLE_COMPACT_CLAUDE_TTL_MS: "invalid" }, home).ttlMs,
    undefined,
  );
  assert.equal(
    idleCompactionPolicy(
      t,
      { FORCE_PROMPT_CACHING_5M: "1", AGENT_CONSOLE_IDLE_COMPACT_CLAUDE_TTL_MS: "3600000" },
      home,
    ).ttlMs,
    300000,
  );
  assert.equal(idleCompactionPolicy(t, { AGENT_CONSOLE_IDLE_COMPACT: "0" }, home).ttlMs, undefined);
  assert.equal(idleCompactionPolicy(t, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, home).ttlMs, 300000);
  const nested = path.join(cwd, "sub", "dir");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git"));
  assert.equal(
    idleCompactionPolicy({ ...t, cwd: nested }, {}, home).ttlMs,
    3600000,
    "project settings resolved from git root",
  );
  fs.writeFileSync(
    path.join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ env: { FORCE_PROMPT_CACHING_5M: "1" } }),
  );
  assert.equal(
    idleCompactionPolicy(t, {}, home).ttlMs,
    undefined,
    "ambiguous settings environment remains unknown",
  );
  fs.writeFileSync(
    path.join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ promptCacheTtl: "1h" }),
  );
  assert.equal(idleCompactionPolicy({ ...t, provider: "codex" }, {}, home).ttlMs, undefined);
  assert.equal(idleCompactionPolicy({ ...t, provider: "pi" }, {}, home).ttlMs, undefined);
  const codex = { ...t, provider: "codex", model: "gpt-6.1-sol" };
  for (const model of [
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6.1-sol-2026-10-17",
    "gpt-6-astra-20261017",
  ]) {
    assert.equal(idleCompactionPolicy({ ...codex, model }, {}, home).ttlMs, 1800000);
  }
  assert.equal(idleCompactionPolicy(codex, {}, home).ttlMs, 1800000);
  assert.equal(idleCompactionPolicy(codex, {}, home).source, "openai-default-estimate");
  assert.equal(idleCompactionPolicy({ ...codex, model: "gpt-5.6" }, {}, home).ttlMs, 1800000);
  assert.equal(idleCompactionPolicy({ ...codex, model: "gpt-5.5" }, {}, home).ttlMs, 1800000);
  assert.equal(
    idleCompactionPolicy({ ...codex, model: "gpt-5.5" }, {}, home).source,
    "openai-extended-estimate",
  );
  assert.equal(idleCompactionPolicy({ ...codex, model: "gpt-5.3-codex" }, {}, home).ttlMs, 300000);
  assert.equal(
    idleCompactionPolicy({ ...codex, model: "gpt-5.3-codex" }, {}, home).source,
    "openai-in-memory-estimate",
  );
  assert.equal(idleCompactionPolicy({ ...codex, model: "default" }, {}, home).ttlMs, undefined);
  assert.equal(
    idleCompactionPolicy({ ...codex, model: "default", resolvedModel: "gpt-6.1-astra" }, {}, home)
      .ttlMs,
    1800000,
  );
  for (const model of ["custom", "gpt-7", "gpt-6.99", "gpt-6.1-custom"]) {
    assert.equal(idleCompactionPolicy({ ...codex, model }, {}, home).ttlMs, undefined);
  }
  assert.equal(
    idleCompactionPolicy(codex, { AGENT_CONSOLE_IDLE_COMPACT: "0" }, home).ttlMs,
    undefined,
  );
  assert.equal(
    idleCompactionPolicy(codex, { AGENT_CONSOLE_IDLE_COMPACT_CODEX_TTL_MS: "900000" }, home).ttlMs,
    900000,
  );
  assert.equal(
    idleCompactionPolicy(codex, { AGENT_CONSOLE_IDLE_COMPACT_CODEX_TTL_MS: "invalid" }, home).ttlMs,
    undefined,
  );

  assert.equal(
    idleCompactionPolicy(
      { ...t, provider: "codex" },
      { AGENT_CONSOLE_IDLE_COMPACT_CODEX_TTL_MS: "900000" },
      home,
    ).ttlMs,
    900000,
  );
  assert.equal(
    idleCompactionPolicy(t, { CLAUDE_CONFIG_DIR: home }, home).ttlMs,
    3600000,
    "project local still overrides global directory",
  );
  fs.writeFileSync(path.join(cwd, ".claude/settings.local.json"), "malformed");
  assert.equal(idleCompactionPolicy(t, {}, home).ttlMs, undefined);
  const policy = { ttlMs: 300000, leadMs: 30000, minTokens: 50000 };
  assert.equal(idleCompactionDeadline(t, policy), 271000);
  for (const patch of [
    { status: "running" },
    { archived: 1 },
    { sessionId: undefined },
    { operation: "compact" },
    { idleCompaction: false },
    { context: { used: 49999 } },
    { context: {} },
    { idleCompactionConsumedAt: 100 },
    { lastUserActivityAt: undefined },
  ])
    assert.equal(idleCompactionDeadline({ ...t, ...patch }, policy), undefined);
  assert.equal(idleCompactionDeadline(t, policy, true), undefined);
  assert.equal(
    idleCompactionDeadline({ ...t, waiting: 1 }, policy),
    undefined,
    "never compact a thread awaiting an answer",
  );
  assert.equal(
    idleCompactionDeadline({ ...t, lastUserActivityAt: 2000 }, policy),
    undefined,
    "no compaction from a previous cycle's response after a crash",
  );
  assert.equal(idleCompactionDeadline(t, { ...policy, ttlMs: undefined }), undefined);
  assert.equal(idleCompactionDeadline(t, { ...policy, ttlMs: 30000 }), undefined);
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const timers = new IdleCompactionTimers();
  let calls = 0;
  timers.schedule("a", 2000, () => calls++);
  mock.timers.tick(999);
  assert.equal(calls, 0);
  timers.cancel("a");
  mock.timers.tick(1);
  assert.equal(calls, 0);
  timers.schedule("a", 3000, () => calls++);
  timers.schedule("a", 4000, () => calls++);
  mock.timers.tick(2000);
  assert.equal(calls, 1);
  mock.timers.tick(10000);
  assert.equal(calls, 1);
  timers.schedule("a", Date.now() + 1000, () => calls++);
  timers.shutdown();
  mock.timers.tick(1000);
  assert.equal(calls, 1);
  timers.schedule("past", Date.now() - 1, () => calls++);
  mock.timers.tick(1000);
  assert.equal(calls, 1);
  console.log(
    "PASS idle policy: explicit TTL precedence, unknown providers, eligibility, fake-clock cancellation and future-only timers",
  );
} finally {
  mock.timers.reset();
  fs.rmSync(home, { recursive: true, force: true });
}
