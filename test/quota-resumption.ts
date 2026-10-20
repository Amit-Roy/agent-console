import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-quota-resumption-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_MOCK = "1";
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "no-brain");
process.env.AGENT_CONSOLE_LABELS = "0";

fs.mkdirSync(path.join(data, "logs"), { recursive: true });
fs.mkdirSync(path.join(data, "pi-sessions"), { recursive: true });

const { usage, ProviderUsage } = await import("../server/usage.ts");
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");

// Preserve provider IDs for quota isolation while keeping readiness and resumed turns local.
const mock = PROVIDERS.get("mock")!;
for (const id of ["claude", "codex"]) PROVIDERS.set(id, { ...mock, id });

function createThread(threads: Threads, provider: string, model = "sonnet"): string {
  const t = threads.create({ provider, cwd: data, model, title: `test-${provider}` });
  return t.id;
}

function simulateQuotaExhausted(threads: Threads, threadId: string, provider: string) {
  const thread = threads.get(threadId);
  if (!thread) throw new Error("Thread not found");
  const ev = { type: "result", is_error: true, subtype: "error", error: { message: "Rate limit exceeded. Try again later." }, duration_ms: 1000 };
  (threads as any).turns.set(threadId, { start: Date.now() - 1000, tools: {} });
  (threads as any).onEvent(thread, ev);
}

function simulateOtherError(threads: Threads, threadId: string) {
  const thread = threads.get(threadId);
  if (!thread) throw new Error("Thread not found");
  const ev = { type: "result", is_error: true, subtype: "error", error: { message: "Network error" }, duration_ms: 1000 };
  (threads as any).turns.set(threadId, { start: Date.now() - 1000, tools: {} });
  (threads as any).onEvent(thread, ev);
}

function recordExhaustedUsage(provider: string, windowLabel: string = "5-hour") {
  const now = Date.now();
  const resetsAt = now + 5 * 60 * 60 * 1000;
  const usageData: ProviderUsage = {
    windows: [{ label: windowLabel, used: 100, limit: 100, unit: "%", resetsAt }],
    updatedAt: now,
  };
  usage.record(provider, usageData);
}

function recordResetUsage(provider: string, windowLabel: string = "5-hour", prevResetsAt?: number) {
  const now = Date.now();
  const resetsAt = now + 5 * 60 * 60 * 1000;
  const usageData: ProviderUsage = {
    windows: [{ label: windowLabel, used: 10, limit: 100, unit: "%", resetsAt }],
    updatedAt: now,
  };
  // If prevResetsAt is provided, use it to simulate the window having already reset
  if (prevResetsAt !== undefined) {
    // First record exhausted usage with prevResetsAt in the past
    const exhaustedData: ProviderUsage = {
      windows: [{ label: windowLabel, used: 100, limit: 100, unit: "%", resetsAt: prevResetsAt }],
      updatedAt: now - 1000,
    };
    usage.record(provider, exhaustedData);
  }
  usage.record(provider, usageData);
}

const threads = new Threads(() => {});

const resumedThreads: string[] = [];
const originalSend = threads.send.bind(threads);
threads.send = (id: string, text: string, opts: any = {}) => {
  if (opts?.auto === "quota-resume") {
    resumedThreads.push(id);
  }
  return originalSend(id, text, opts);
};

let testNum = 0;
function pass(msg: string) { console.log(`PASS Test ${++testNum}: ${msg}`); }

// Test 1: Thread marked as quota-paused when turn ends with rate limit error and quota exhausted
const claudeThread = createThread(threads, "claude");
recordExhaustedUsage("claude");
assert.equal(usage.exhausted("claude"), true, "Quota should be exhausted");
simulateQuotaExhausted(threads, claudeThread, "claude");
const pausedThread = threads.get(claudeThread);
assert.ok(pausedThread?.quotaPaused, "Thread should be marked as quota-paused");
assert.equal(pausedThread.quotaPaused?.provider, "claude");
assert.equal(pausedThread.quotaPaused?.windowLabel, "5-hour");
pass("Thread marked as quota-paused on rate limit error with exhausted quota");

// Test 2: Archived thread should NOT be marked as quota-paused
const archivedThread = createThread(threads, "claude", "opus");
threads.archive(archivedThread, true);
recordExhaustedUsage("claude");
simulateQuotaExhausted(threads, archivedThread, "claude");
assert.ok(!threads.get(archivedThread)?.quotaPaused, "Archived thread should NOT be marked as quota-paused");
pass("Archived thread not marked as quota-paused");

// Test 3: Thread with non-exhausted quota should NOT be marked as quota-paused
const normalThread = createThread(threads, "codex");
recordResetUsage("codex");
assert.equal(usage.exhausted("codex"), false, "Quota should NOT be exhausted");
simulateQuotaExhausted(threads, normalThread, "codex");
assert.ok(!threads.get(normalThread)?.quotaPaused, "Thread should NOT be quota-paused when quota not exhausted");
pass("Thread not quota-paused when quota available");

// Test 4: Non-rate-limit error should NOT mark thread as quota-paused even if quota exhausted
const otherErrorThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateOtherError(threads, otherErrorThread);
assert.ok(!threads.get(otherErrorThread)?.quotaPaused, "Non-rate-limit error should NOT mark thread as quota-paused");
pass("Non-rate-limit error does not mark quota-paused");

// Test 5: Quota resumption - when window resets, quota-paused thread is resumed via usage callback
const resumeThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateQuotaExhausted(threads, resumeThread, "codex");
assert.ok(threads.get(resumeThread)?.quotaPaused, "Thread should be quota-paused before reset");

// Subscribe to window reset and verify the callback triggers resume
let callbackFired = false;
usage.subscribeWindowReset((provider, windowLabel) => {
  callbackFired = true;
  const resumed = threads.resumeQuotaPaused(provider, windowLabel);
  assert.equal(resumed, 1, "One thread should be resumed via callback");
});
// Record reset with prevResetsAt in the past (window already reset)
const prevResetsAt = Date.now() - 1000;
recordResetUsage("codex", "5-hour", prevResetsAt);
assert.ok(callbackFired, "subscribeWindowReset callback should have fired");
assert.ok(!threads.get(resumeThread)?.quotaPaused, "quotaPaused should be cleared after resumption");
assert.deepEqual(resumedThreads, [resumeThread], "The quota-paused thread should receive a resume message");
pass("Quota-paused thread resumed via usage callback on window reset");

// Test 6: Duplicate resume notifications are handled gracefully
const resumed2 = threads.resumeQuotaPaused("codex", "5-hour");
assert.equal(resumed2, 0, "Second resume call should resume nothing (already cleared)");
assert.deepEqual(resumedThreads, [resumeThread], "No duplicate resume message sent");
pass("Duplicate resume notifications handled gracefully");

// Test 7: Archived thread should NOT be resumed even if quota-paused
// Clear quotaPaused from test 1's thread so it doesn't interfere
const t1 = threads.get(claudeThread);
if (t1?.quotaPaused) delete t1.quotaPaused;
const archivedResumeThread = createThread(threads, "claude", "sonnet");
recordExhaustedUsage("claude");
simulateQuotaExhausted(threads, archivedResumeThread, "claude");
threads.archive(archivedResumeThread, true);
const resumed3 = threads.resumeQuotaPaused("claude", "5-hour");
assert.equal(resumed3, 0, "Archived thread should not be resumed; no other quota-paused threads exist");
assert.ok(!threads.get(archivedResumeThread)?.quotaPaused, "quotaPaused should be cleared on archive");
pass("Archived thread not resumed; quotaPaused cleared on archive");

// Test 8: Usage module detects window reset and triggers resume callback (end-to-end)
const windowResetThread = createThread(threads, "claude", "opus");
recordExhaustedUsage("claude");
simulateQuotaExhausted(threads, windowResetThread, "claude");
assert.ok(threads.get(windowResetThread)?.quotaPaused, "Thread should be quota-paused before usage reset");
resumedThreads.length = 0;
callbackFired = false;
usage.subscribeWindowReset((provider, windowLabel) => {
  callbackFired = true;
  const resumed = threads.resumeQuotaPaused(provider, windowLabel);
  assert.equal(resumed, 1, "One thread should be resumed via callback");
});
const prevResetsAt2 = Date.now() - 1000;
recordResetUsage("claude", "5-hour", prevResetsAt2);
assert.ok(callbackFired, "subscribeWindowReset callback should have fired");
assert.ok(!threads.get(windowResetThread)?.quotaPaused, "quotaPaused should be cleared after resumption");
assert.deepEqual(resumedThreads, [windowResetThread], "The quota-paused thread should receive a resume message");
pass("Usage module detects window reset and triggers resume callback end-to-end");

// Test 9: Duplicate record() calls should not fire callback multiple times
const dupThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateQuotaExhausted(threads, dupThread, "codex");
resumedThreads.length = 0;
callbackFired = false;
let callbackCount = 0;
usage.subscribeWindowReset((provider, windowLabel) => {
  callbackCount++;
  callbackFired = true;
  const resumed = threads.resumeQuotaPaused(provider, windowLabel);
  assert.equal(resumed, 1, "One thread should be resumed");
});
const prevResetsAt3 = Date.now() - 1000;
recordResetUsage("codex", "5-hour", prevResetsAt3);
// Call record again with same data - should not fire callback again
recordResetUsage("codex", "5-hour", prevResetsAt3);
assert.ok(callbackFired, "Callback should fire on first call");
assert.equal(callbackCount, 1, "Callback should fire only once for duplicate records");
assert.ok(!threads.get(dupThread)?.quotaPaused, "quotaPaused should be cleared after resumption");
pass("Duplicate record() calls do not fire callback multiple times");

// Test 10: Multiple providers - only affected provider's threads are resumed
const multiThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateQuotaExhausted(threads, multiThread, "codex");
recordExhaustedUsage("claude");
const multiThread2 = createThread(threads, "claude", "sonnet");
simulateQuotaExhausted(threads, multiThread2, "claude");
assert.ok(threads.get(multiThread)?.quotaPaused);
assert.ok(threads.get(multiThread2)?.quotaPaused);
resumedThreads.length = 0;
callbackFired = false;
usage.subscribeWindowReset((provider, windowLabel) => {
  callbackFired = true;
  const resumed = threads.resumeQuotaPaused(provider, windowLabel);
  assert.equal(resumed, 1, "One thread should be resumed via callback");
});
recordResetUsage("codex", "5-hour", Date.now() - 1000);
assert.ok(callbackFired, "Callback should fire for codex window reset");
assert.ok(!threads.get(multiThread)?.quotaPaused, "Codex thread quotaPaused cleared");
assert.ok(threads.get(multiThread2)?.quotaPaused, "Claude thread still quota-paused");
assert.deepEqual(resumedThreads, [multiThread], "Only codex thread resumed");
pass("Multiple providers - only affected provider's threads resumed");

// Test 11: a running thread does not make resumeQuotaPaused throw or lose the other resumes
const busyThread = createThread(threads, "codex");
const idleThread = createThread(threads, "codex");
for (const id of [busyThread, idleThread]) threads.get(id)!.quotaPaused = { provider: "codex", windowLabel: "weekly", resetsAt: Date.now() + 1000 };
threads.get(busyThread)!.status = "running";
assert.doesNotThrow(() => threads.resumeQuotaPaused("codex", "weekly"));
assert.ok(!threads.get(busyThread)?.quotaPaused && !threads.get(idleThread)?.quotaPaused, "both pauses cleared");
pass("Running quota-paused thread does not abort resume");

threads.shutdown();
fs.rmSync(data, { recursive: true, force: true });
console.log("All quota resumption tests passed");
