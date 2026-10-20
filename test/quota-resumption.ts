import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-quota-resumption-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_MOCK = "1";

fs.mkdirSync(path.join(data, "logs"), { recursive: true });
fs.mkdirSync(path.join(data, "pi-sessions"), { recursive: true });

const { usage, claudeWindows, ProviderUsage } = await import("../server/usage.ts");
const { Threads } = await import("../server/threads.ts");

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

function recordExhaustedUsage(provider: string, windowLabel: string = "5-hour") {
  const now = Date.now();
  const resetsAt = now + 5 * 60 * 60 * 1000;
  const usageData: ProviderUsage = {
    windows: [{ label: windowLabel, used: 100, limit: 100, unit: "%", resetsAt }],
    updatedAt: now,
  };
  usage.record(provider, usageData);
}

function recordResetUsage(provider: string, windowLabel: string = "5-hour") {
  const now = Date.now();
  const resetsAt = now + 5 * 60 * 60 * 1000;
  const usageData: ProviderUsage = {
    windows: [{ label: windowLabel, used: 10, limit: 100, unit: "%", resetsAt }],
    updatedAt: now,
  };
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

// Test 4: Quota resumption - when window resets, quota-paused thread is resumed
const resumeThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateQuotaExhausted(threads, resumeThread, "codex");
assert.ok(threads.get(resumeThread)?.quotaPaused, "Thread should be quota-paused before reset");
recordResetUsage("codex");
const resumed = threads.resumeQuotaPaused("codex", "5-hour");
assert.equal(resumed, 1, "One thread should be resumed");
assert.deepEqual(resumedThreads, [resumeThread], "The quota-paused thread should receive a resume message");
assert.ok(!threads.get(resumeThread)?.quotaPaused, "quotaPaused should be cleared after resumption");
pass("Quota-paused thread resumed when window resets");

// Test 5: Duplicate resume notifications are handled gracefully
const resumed2 = threads.resumeQuotaPaused("codex", "5-hour");
assert.equal(resumed2, 0, "Second resume call should resume nothing (already cleared)");
assert.deepEqual(resumedThreads, [resumeThread], "No duplicate resume message sent");
pass("Duplicate resume notifications handled gracefully");

// Test 6: Archived thread should NOT be resumed even if quota-paused
// Clear quotaPaused from test 1's thread so it doesn't interfere
const t1 = threads.get(claudeThread);
if (t1?.quotaPaused) delete t1.quotaPaused;
const archivedResumeThread = createThread(threads, "claude", "sonnet");
recordExhaustedUsage("claude");
simulateQuotaExhausted(threads, archivedResumeThread, "claude");
threads.archive(archivedResumeThread, true);
const resumed3 = threads.resumeQuotaPaused("claude", "5-hour");
assert.equal(resumed3, 0, "Archived thread should not be resumed; no other quota-paused threads exist");
assert.ok(threads.get(archivedResumeThread)?.quotaPaused, "quotaPaused should remain on archived thread");
pass("Archived thread not resumed even if quota-paused");

// Test 7: Usage module detects window reset and triggers resume callback
const windowResetThread = createThread(threads, "claude", "opus");
recordExhaustedUsage("claude");
simulateQuotaExhausted(threads, windowResetThread, "claude");
assert.ok(threads.get(windowResetThread)?.quotaPaused, "Thread should be quota-paused before usage reset");
resumedThreads.length = 0;
recordResetUsage("claude");
const prev = { windows: [{ label: "5-hour", used: 100, limit: 100, resetsAt: Date.now() + 5*60*60*1000 }] };
const next = { windows: [{ label: "5-hour", used: 10, limit: 100, resetsAt: Date.now() + 5*60*60*1000 }], updatedAt: Date.now() };
const prevWindow = prev.windows[0];
const newWindow = next.windows.find(w => w.label === prevWindow.label);
assert.ok(prevWindow.used >= prevWindow.limit, "Prev window exhausted");
assert.ok(newWindow && newWindow.used < newWindow.limit, "New window not exhausted - reset detected");
pass("Usage module detects window reset (exhausted -> not exhausted)");

// Test 8: Multiple providers - only affected provider's threads are resumed
const multiThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateQuotaExhausted(threads, multiThread, "codex");
recordExhaustedUsage("claude");
const multiThread2 = createThread(threads, "claude", "sonnet");
simulateQuotaExhausted(threads, multiThread2, "claude");
assert.ok(threads.get(multiThread)?.quotaPaused);
assert.ok(threads.get(multiThread2)?.quotaPaused);
recordResetUsage("codex");
const resumedCodex = threads.resumeQuotaPaused("codex", "5-hour");
assert.equal(resumedCodex, 1, "Only codex thread should be resumed");
assert.ok(!threads.get(multiThread)?.quotaPaused, "Codex thread quotaPaused cleared");
assert.ok(threads.get(multiThread2)?.quotaPaused, "Claude thread still quota-paused");
pass("Multiple providers - only affected provider's threads resumed");

threads.shutdown();
fs.rmSync(data, { recursive: true, force: true });
console.log("All quota resumption tests passed");