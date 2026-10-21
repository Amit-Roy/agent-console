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
const { resumeDue, DEFAULTS } = await import("../server/window-dispatch.ts");

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

// Test 5: resumeDue uses the Deep-issue gate: last 180 min of a window below 60% used, last 90 min otherwise, never at 90%+
const now0 = Date.now();
const cfg = { ...DEFAULTS, enabled: true, dryRun: false };
const win = (used: number, minutesLeft: number, label = "5-hour") => ({ label, used, limit: 100, unit: "%", resetsAt: now0 + minutesLeft * 60_000 });
const at = (windows: any[]) => ({ windows, updatedAt: now0 });
assert.deepEqual(resumeDue({ claude: at([win(10, 175)]) }, now0, cfg), ["claude"], "low-usage window resumes 180 min before its end");
assert.deepEqual(resumeDue({ claude: at([win(10, 185)]) }, now0, cfg), [], "not before 180 min left");
assert.deepEqual(resumeDue({ codex: at([win(70, 120)]) }, now0, cfg), [], "a busier window waits for the last 90 min");
assert.deepEqual(resumeDue({ codex: at([win(70, 85)]) }, now0, cfg), ["codex"], "busier window resumes in its last 90 min");
assert.deepEqual(resumeDue({ codex: at([win(95, 30)]) }, now0, cfg), [], "a window at maxUsedPct has no room");
assert.deepEqual(resumeDue({ claude: at([win(10, 60), win(100, 3 * 24 * 60, "7-day")]) }, now0, cfg), [], "an exhausted 7-day window blocks");
assert.deepEqual(resumeDue({ "claude:nefro": at([win(10, 60)]), pi: at([win(10, 60)]) }, now0, cfg), ["claude:nefro"], "premium usage keys only");
assert.deepEqual(resumeDue({ claude: at([win(10, 175)]) }, now0, { ...cfg, lowUsageLeadMinutes: 120 }), [], "lead time follows the dispatch config");
pass("resumeDue follows the Deep-issue window gate");

// Test 6: a quota-paused thread resumes once, for any window label on its provider
const resumeThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateQuotaExhausted(threads, resumeThread, "codex");
assert.ok(threads.get(resumeThread)?.quotaPaused, "Thread should be quota-paused");
resumedThreads.length = 0;
assert.equal(threads.resumeQuotaPaused("codex"), 1, "One thread resumed");
assert.ok(!threads.get(resumeThread)?.quotaPaused, "quotaPaused cleared after resumption");
assert.deepEqual(resumedThreads, [resumeThread], "The quota-paused thread receives a resume message");
assert.equal(threads.resumeQuotaPaused("codex"), 0, "Second resume call resumes nothing");
pass("Quota-paused thread resumed once");

// Test 7: Archived thread should NOT be resumed even if quota-paused
// Clear quotaPaused from test 1's thread so it doesn't interfere
const t1 = threads.get(claudeThread);
if (t1?.quotaPaused) delete t1.quotaPaused;
const archivedResumeThread = createThread(threads, "claude", "sonnet");
recordExhaustedUsage("claude");
simulateQuotaExhausted(threads, archivedResumeThread, "claude");
threads.archive(archivedResumeThread, true);
assert.equal(threads.resumeQuotaPaused("claude"), 0, "Archived thread should not be resumed; no other quota-paused threads exist");
assert.ok(!threads.get(archivedResumeThread)?.quotaPaused, "quotaPaused should be cleared on archive");
pass("Archived thread not resumed; quotaPaused cleared on archive");

// Test 8: only the given provider's threads are resumed
const multiThread = createThread(threads, "codex", "gpt-6.1-sol");
recordExhaustedUsage("codex");
simulateQuotaExhausted(threads, multiThread, "codex");
recordExhaustedUsage("claude");
const multiThread2 = createThread(threads, "claude", "sonnet");
simulateQuotaExhausted(threads, multiThread2, "claude");
resumedThreads.length = 0;
assert.equal(threads.resumeQuotaPaused("codex"), 1);
assert.ok(!threads.get(multiThread)?.quotaPaused, "Codex thread quotaPaused cleared");
assert.ok(threads.get(multiThread2)?.quotaPaused, "Claude thread still quota-paused");
assert.deepEqual(resumedThreads, [multiThread], "Only codex thread resumed");
pass("Multiple providers - only affected provider's threads resumed");

// Test 9: a running thread does not make resumeQuotaPaused throw or lose the other resumes
const busyThread = createThread(threads, "codex");
const idleThread = createThread(threads, "codex");
for (const id of [busyThread, idleThread]) threads.get(id)!.quotaPaused = { provider: "codex", windowLabel: "weekly", resetsAt: Date.now() + 1000 };
threads.get(busyThread)!.status = "running";
assert.doesNotThrow(() => threads.resumeQuotaPaused("codex", "weekly"));
assert.ok(!threads.get(busyThread)?.quotaPaused && !threads.get(idleThread)?.quotaPaused, "both pauses cleared");
pass("Running quota-paused thread does not abort resume");

// An active premium owner holds its paused sibling without consuming the saved pause.
const heldSibling = createThread(threads, "codex");
const unrelatedSibling = createThread(threads, "codex");
const pausedOwner = createThread(threads, "codex");
for (const id of [heldSibling, unrelatedSibling, pausedOwner]) threads.get(id)!.quotaPaused = { provider: "codex", windowLabel: "assignment", resetsAt: Date.now() + 1000 };
let ownerRunning = true;
const eligible = (t: { id: string }) => t.id === pausedOwner || !ownerRunning || t.id !== heldSibling;
resumedThreads.length = 0;
assert.equal(threads.resumeQuotaPaused("codex", "assignment", eligible), 2, "owner and unrelated issue resume while assignment holds its sibling");
assert.deepEqual(resumedThreads, [unrelatedSibling, pausedOwner]);
assert.ok(threads.get(heldSibling)!.quotaPaused, "held sibling retains its pending quota resume");
ownerRunning = false;
assert.equal(threads.resumeQuotaPaused("codex", "assignment", eligible), 1, "held sibling resumes after owner releases issue");
assert.deepEqual(resumedThreads, [unrelatedSibling, pausedOwner, heldSibling]);
assert.ok(!threads.get(heldSibling)!.quotaPaused);
pass("Premium ownership defers sibling quota resume without losing it");

threads.shutdown();
fs.rmSync(data, { recursive: true, force: true });
console.log("All quota resumption tests passed");
