import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { AdmissionUnavailable, ModelRateLimit, MODEL_REQUEST_INTERVAL_MS } from "../server/providers/model-rate-limit.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-model-rate-limit-"));
const gates: ModelRateLimit[] = [];
const make = (name: string, options: Record<string, any> = {}) => {
  const gate = new ModelRateLimit({ path: path.join(dir, name), intervalMs: 35, ...options });
  gates.push(gate);
  return gate;
};
try {
  assert.equal(MODEL_REQUEST_INTERVAL_MS, 1100);
  assert.throws(() => make("bad", { intervalMs: 0 }), /positive integers/);
  const gate = make("priority", { intervalMs: 150 }); // slow enough that queued requests are still waiting when the next is added
  assert.equal(fs.statSync(path.join(dir, "priority")).mode & 0o777, 0o600);
  await gate.acquire();
  const order: string[] = [];
  const low = gate.acquire({ priority: "label" }).then(() => order.push("label"));
  const medium = gate.acquire({ priority: "triage" }).then(() => order.push("triage"));
  const high = gate.acquire({ priority: "interactive" }).then(() => order.push("interactive"));
  await Promise.all([low, medium, high]);
  assert.deepEqual(order, ["interactive", "triage", "label"]);

  // A long interval keeps the next request queued when it is cancelled, however late a loaded host resolves the first.
  const slow = make("cancel", { intervalMs: 5000 });
  const inspect = new DatabaseSync(path.join(dir, "cancel"));
  await slow.acquire();
  const before = inspect.prepare("SELECT next_at FROM admission").get();
  const cancel = new AbortController();
  const pending = slow.acquire({ signal: cancel.signal, priority: "interactive" });
  cancel.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(inspect.prepare("SELECT next_at FROM admission").get(), before);
  const already = new AbortController();
  already.abort();
  await assert.rejects(gate.acquire(already.signal), { name: "AbortError" });
  inspect.close();

  const providers = make("providers", { intervalMs: 10 });
  const until = providers.report429("1", "nvidia");
  let nvidiaStarted = 0;
  const nvidia = providers.acquire({ provider: "nvidia" }).then(() => { nvidiaStarted = Date.now(); });
  await providers.acquire({ provider: "openrouter" });
  assert.equal(nvidiaStarted, 0, "NVIDIA cooldown must not block OpenRouter");
  await nvidia;
  assert.ok(nvidiaStarted >= until);
  // A cooldown published after enqueue must also be rechecked at admission.
  // Pause the worker queue to make the enqueue/cooldown/admission order deterministic under CPU load.
  const recheck = make("recheck", { intervalMs: 150 });
  await recheck.acquire();
  const recheckQueue = (recheck as any).queue;
  recheckQueue.pause();
  const queued = recheck.acquire({ provider: "nvidia", priority: "interactive" });
  assert.equal(recheckQueue.size, 1, "request is queued before cooldown publication");
  const recheckUntil = recheck.report429("0.3", "nvidia");
  recheckQueue.start();
  await queued;
  assert.ok(Date.now() >= recheckUntil);
  assert.ok(providers.report429("invalid", "other") >= Date.now() + 29_900);
  assert.ok(providers.report429("9999999", "other") <= Date.now() + 900_000);

  const minute = make("minute", { intervalMs: 5, openRouterMinuteLimit: 2, openRouterWindowMs: 400 });
  const start = Date.now();
  await minute.acquire({ provider: "openrouter" });
  await minute.acquire({ provider: "openrouter" });
  let thirdDone = false;
  const third = minute.acquire({ provider: "openrouter" }).then(() => { thirdDone = true; });
  await minute.acquire({ provider: "nvidia" });
  assert.equal(thirdDone, false, "Minute quota waits outside the global queue");
  await third;
  assert.ok(Date.now() >= start + 400);

  let clock = Date.parse("2026-10-19T23:59:59Z");
  const daily = make("daily", { intervalMs: 1, openRouterDayLimit: 3, now: () => clock });
  daily.syncOpenRouterQuota({ used: 2, limit: 1000 });
  await daily.acquire({ provider: "openrouter" });
  daily.syncOpenRouterQuota({ used: 1, limit: 1000 });
  await assert.rejects(daily.acquire({ provider: "openrouter" }), (error: unknown) => {
    assert.ok(error instanceof AdmissionUnavailable);
    assert.equal(error.code, "MODEL_PROVIDER_QUOTA_EXHAUSTED");
    assert.equal(error.retryAt, Date.parse("2026-10-20T00:00:00Z"));
    return true;
  });
  clock = Date.parse("2026-10-20T00:00:00Z");
  await daily.acquire({ provider: "openrouter" });
  daily.syncOpenRouterQuota({ used: 0, limit: 1 });
  await assert.rejects(daily.acquire({ provider: "openrouter" }), AdmissionUnavailable);

  const persisted = make("restart", { intervalMs: 90 });
  const admitted = Date.now();
  await persisted.acquire();
  persisted.close();
  const restored = make("restart", { intervalMs: 90 });
  await restored.acquire();
  assert.ok(Date.now() >= admitted + 90, "Restart cannot reset the global clock");

  // An admission does not remain occupied for the lifetime of a streamed response.
  const streaming = make("streaming", { intervalMs: 10 });
  await streaming.acquire();
  let responseFinished = false;
  const response = delay(100).then(() => { responseFinished = true; });
  await streaming.acquire();
  assert.equal(responseFinished, false);
  await response;
  console.log("model-rate-limit: priorities, provider cooldowns, rolling/day quotas, cancellation, restart and streaming passed");
} finally {
  for (const gate of gates) gate.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
