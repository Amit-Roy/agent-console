import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnoseJob, readJobError } from "../server/automation/job.ts";

const now = 100_000;
const row: any = { id: "failed-worker", title: "Issue seven", provider: "pi", model: "model", status: "idle", updatedAt: 20, issueRun: { key: "Owner/Repo#7", repo: "Owner/Repo", number: 7, effort: "bau", role: "work", recoveries: 2, stalled: 30, missingPr: 10 } };
let events: any[] = [
  { seq: 1, ts: 1, step: "worker", kind: "fail", ref: "OWNER/REPO#7", msg: "token=private worker failed" },
  { seq: 2, ts: 2, step: "pr", kind: "fail", ref: "owner/repo#7", msg: "no open PR for branch worker" },
  { seq: 3, ts: 3, step: "review", kind: "fail", ref: "other/repo#7", msg: "unrelated" },
];
const deps = { threads: () => [row], events: () => events, now: () => now };
const request = { v: 1, repo: "OWNER/REPO", number: 7 };
const result = diagnoseJob(request, deps);
assert.equal(result.v, 1); assert.equal(result.repo, "owner/repo");
assert.equal(result.state, "blocked"); assert.match(result.summary, /recovery limit/i);
assert.deepEqual(result.limits, { reviews: 3, nudges: 2, recoveries: 2 });
assert.equal(result.threads[0].id, "failed-worker"); assert.equal(result.events.length, 2);
assert.equal(result.events[0].seq, 2, "events newest first");
assert.doesNotMatch(JSON.stringify(result), /private|unrelated/);
assert.equal(result.workflow.find(s => s.id === "pr")?.state, "failed");
assert.equal(result.workflow.find(s => s.id === "merge")?.state, "unobserved");
assert.match(result.historyNote, /not proof/i);
events.push({ seq: 4, ts: 4, step: "merge", kind: "ok", ref: "owner/repo#7", msg: "PR #8 merged" });
assert.equal(diagnoseJob(request, deps).state, "completed", "new merge evidence supersedes stalled siblings");
events.pop();
row.issueRun.outcome = "merged";
assert.match(diagnoseJob(request, deps).threads[0].reason, /PR merged/, "terminal merged outcome wins over copied stale worker metadata");
delete row.issueRun.outcome;
row.status = "running";
assert.equal(diagnoseJob(request, deps).state, "active", "current running state wins over historical stalls");
row.status = "idle"; row.quotaPaused = { provider: "pi", windowLabel: "weekly", resetsAt: 400 };
assert.equal(diagnoseJob(request, deps).state, "paused");
delete row.quotaPaused; delete row.issueRun.stalled; delete row.issueRun.missingPr; row.issueRun.recoveries = 0;
events = [];
assert.equal(diagnoseJob(request, deps).state, "idle");
assert.match(diagnoseJob(request, deps).summary, /not recorded|not known/i);
row.issueRun.reviews = 3;
assert.equal(diagnoseJob(request, deps).state, "idle", "last review may still be awaiting judgment; count alone is not failure evidence");
events = [{ seq: 4, ts: 4, step: "review", kind: "info", ref: "owner/repo#7", msg: "3 reviews without a merge: a person decides" }];
assert.equal(diagnoseJob(request, deps).state, "blocked", "recorded terminal cap event explains stopped automation");
assert.equal(diagnoseJob(request, deps).workflow.find(s => s.id === "review")?.state, "failed");
events = [{ seq: 4, ts: 4, step: "worker", kind: "fail", run: "work:failed-worker", msg: "linked by run" }, { seq: 5, ts: 5, step: "worker", kind: "fail", run: "work:failed-worker", ref: "owner/repo#8", msg: "different issue" }];
assert.equal(diagnoseJob(request, deps).events.length, 1);
assert.equal(diagnoseJob(request, deps).events[0].msg, "linked by run");
events = Array.from({ length: 250 }, (_, i) => ({ seq: i + 1, ts: i, step: "worker", kind: "ok", ref: "owner/repo#7" }));
assert.equal(diagnoseJob(request, deps).events.length, 200);
assert.equal(diagnoseJob(request, deps).historyTruncated, true);
assert.throws(() => diagnoseJob({ ...request, v: 2 }, deps), /version/i);
assert.throws(() => diagnoseJob({ ...request, repo: "../repo" }, deps), /repository/i);
assert.throws(() => diagnoseJob({ ...request, number: 0 }, deps), /number/i);
assert.throws(() => diagnoseJob({ ...request, number: 8 }, deps), /No automation evidence/i);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-job-error-"));
try {
  fs.mkdirSync(path.join(root, "logs"));
  const file = path.join(root, "logs", "worker.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", text: "x".repeat(70_000) }) + "\n" + [
    { type: "console_error", text: "HTTP 429 token=private quota exceeded", ts: 55 },
    { type: "user_input", text: "secret user prompt" },
    { type: "tool_result", text: "secret tool payload" },
    { type: "result", is_error: true },
  ].map(e => JSON.stringify(e)).join("\n") + "\n{partial");
  assert.deepEqual(readJobError(root, "worker"), { type: "console_error", message: "HTTP 429 token=[redacted] quota exceeded", ts: 55 });
  fs.appendFileSync(file, "\n" + JSON.stringify({ type: "result", is_error: true, error: { message: "Latest failure" }, ts: 60 }));
  assert.equal(readJobError(root, "worker")?.message, "Latest failure");
  assert.equal(readJobError(root, "../worker"), undefined);
  assert.equal(readJobError(root, "missing"), undefined);
  fs.symlinkSync(file, path.join(root, "logs", "symlink.jsonl"));
  assert.equal(readJobError(root, "symlink"), undefined);
  const withError = diagnoseJob(request, { ...deps, lastError: () => readJobError(root, "worker") });
  assert.equal(withError.threads[0].lastError.message, "Latest failure");
  assert.doesNotMatch(JSON.stringify(withError), /secret user prompt|secret tool payload/);
  delete row.issueRun.repo;
  assert.doesNotThrow(() => diagnoseJob(request, deps), "legacy metadata without repo must not crash event diagnostics");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("automation job diagnostics: passed");
