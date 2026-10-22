import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FLOW } from "../server/automation/contracts.ts";
import { createEventLog, redact } from "../server/automation/events.ts";
import { automationApi, scanHooks } from "../server/automation/snapshot.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-automation-"));
const MIN = 60_000;
let now = 1_800_000_000_000;
try {
  // --- the log: the one place every stage writes -------------------------------------------------------------
  const log = createEventLog({ file: path.join(dir, "events.jsonl"), now: () => now, maxBytes: 4000 });

  // secrets never reach disk
  assert.equal(redact("push to https://x-access-token:SEKRET@github.com/o/r failed"), "push to https://[redacted]@github.com/o/r failed");
  for (const secret of ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz", "sk-ant-api03-abcdefghijklmnop", "nvapi-abcdefghijklmnopqrstuvwx", "Bearer abc.def-ghi_jkl"])
    assert.ok(!redact(`error ${secret} end`).includes(secret.slice(-12)), secret);
  log.record({ step: "worktree", kind: "fail", ref: "o/r#1", msg: "fatal: https://x-access-token:SEKRET@github.com", data: { out: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", nested: { h: "Bearer zzz.yyy" }, n: 3 } });
  const raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  assert.ok(!/SEKRET|ghp_abc|zzz\.yyy/.test(raw), "nothing secret on disk");
  assert.equal(log.read({}).events[0].data?.n, 3, "non-string data is kept");

  // runs: start without an end is active, then abandoned once it is old
  now += MIN;
  log.record({ step: "dispatcher", kind: "start", run: "r1", ref: "o/r#2" });
  log.record({ step: "review", kind: "start", run: "r2", ref: "o/r#3" });
  log.record({ step: "review", kind: "ok", run: "r2", ref: "o/r#3", msg: "approved" });
  log.record({ step: "opener", kind: "info", msg: "tick" });

  const cfg = { dispatch: { enabled: true, dryRun: false, leadMinutes: 90, maxUsedPct: 90, perWindow: 2, repos: ["o/r"], authors: ["me"] }, opener: { enabled: true, dryRun: false, from: "23:00", to: "07:00", providers: ["claude"], tz: "Asia/Kolkata" } };
  const worktrees = path.join(dir, "wt");
  // a dispatched worktree with its pre-push hook, the way startIssue lays it out
  const wt = path.join(worktrees, "webapp-issue-7"), gitdir = path.join(dir, "main.git", "worktrees", "webapp-issue-7");
  fs.mkdirSync(path.join(gitdir, "ac-hooks"), { recursive: true }); fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, "ac-hooks", "pre-push"), `#!/bin/sh\nif [ "$remote_ref" = "refs/heads/main" ]; then exit 1; fi\n`);
  fs.mkdirSync(path.join(worktrees, "webapp-review-7"), { recursive: true }); // no hook: reviewers are detached
  assert.deepEqual(scanHooks(worktrees), [{ worktree: "webapp-issue-7", path: wt, hook: "pre-push", protects: "main" }]);

  const api = automationApi({ log, now: () => now, config: () => cfg, hooks: () => scanHooks(worktrees), runs: () => [{ thread: "T1", key: "o/r#2", role: "work", effort: "bau", state: "running", title: "r:2 x" }], schedules: () => [{ id: "s1", title: "Digest", schedule: "Daily 09:00", enabled: true }] });
  let snap = api.snapshot({});
  assert.equal(snap.v, 1); assert.equal(snap.now, now);
  const step = (id: string) => snap.steps.find(s => s.id === id)!;
  assert.equal(step("dispatcher").state, "active"); assert.equal(step("dispatcher").open, 1);
  assert.equal(step("review").state, "ok"); assert.equal(step("review").lastMsg, "approved");
  assert.equal(step("worktree").state, "failed"); assert.equal(step("worktree").failures, 1);
  assert.equal(step("router").state, "idle");
  assert.equal(step("opener").state, "ok", "an info event is activity, not failure");
  // the graph is complete and consistent
  const ids = new Set(FLOW.nodes.map(n => n.id));
  assert.deepEqual(snap.flow, FLOW); assert.equal(snap.steps.length, FLOW.nodes.length);
  for (const e of FLOW.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from}->${e.to}`);
  assert.ok(FLOW.nodes.every(n => n.icon && n.label));
  // every step sits in exactly one pipeline; the PR workflow runs issue -> labels -> PR -> premium review and merge
  const placed = FLOW.pipelines.flatMap(p => p.phases.flatMap(ph => ph.steps));
  assert.deepEqual([...placed].sort(), [...ids].sort(), "each step drawn once");
  assert.deepEqual(FLOW.pipelines.map(p => p.id), ["pr", "windows", "monitor"]);
  assert.deepEqual(FLOW.pipelines[0].phases.map(ph => ph.steps[0]), ["triage", "dispatcher", "review"]);
  assert.ok(FLOW.edges.some(e => e.from === "redo" && e.to === "review"), "redo loops back to review");
  // failures with step and (already redacted) message
  assert.equal(snap.failures[0].step, "worktree"); assert.ok(!snap.failures[0].msg.includes("SEKRET"));
  // triggers, hooks, runs, config
  assert.ok(snap.triggers.some(t => t.kind === "webhook")); assert.ok(snap.triggers.some(t => t.kind === "timer" && /dispatch/i.test(t.label)));
  assert.ok(snap.triggers.some(t => t.kind === "cron" && t.label === "Digest"));
  assert.equal(snap.hooks.length, 1); assert.equal(snap.runs[0].thread, "T1");
  assert.equal(snap.config.dispatch.dryRun, false); assert.deepEqual(snap.config.dispatch.authors, ["me"]);

  // an unfinished run left alone for 30 minutes is abandoned, not active
  now += 31 * MIN; snap = api.snapshot({});
  assert.equal(step("dispatcher").state, "abandoned"); assert.equal(step("dispatcher").open, 0);
  // a restart closes open runs explicitly
  log.record({ step: "router", kind: "start", run: "r9" });
  const closed = log.recoverOpenRuns(); assert.ok(closed.includes("r9"));
  assert.equal(api.snapshot({}).steps.find(s => s.id === "router")!.state, "abandoned");
  // disabled config shows as disabled, not failed
  const off = automationApi({ log, now: () => now, config: () => ({ ...cfg, dispatch: { ...cfg.dispatch, enabled: false }, opener: { ...cfg.opener, enabled: false } }), hooks: () => [], runs: () => [], schedules: () => [] }).snapshot({});
  assert.equal(off.steps.find(s => s.id === "dispatcher")!.state, "disabled"); assert.equal(off.steps.find(s => s.id === "opener")!.state, "disabled");
  assert.equal(off.steps.find(s => s.id === "triage")!.state !== "disabled", true, "triage is the webhook worker's, not ours to switch off");

  // request/response contract: unknown fields ignored, newer versions refused
  assert.doesNotThrow(() => api.snapshot({ v: 1, since: 0, limit: 5, future: "ignored" } as any));
  assert.throws(() => api.snapshot({ v: 2 } as any), /unsupported/i);
  // step logs: newest first, paged, per step
  for (let i = 0; i < 5; i++) { now += 1000; log.record({ step: "worker", kind: "info", msg: `line ${i}` }); }
  const p1 = api.log({ step: "worker", limit: 2 });
  assert.deepEqual(p1.entries.map(e => e.msg), ["line 4", "line 3"]); assert.ok(p1.next);
  const p2 = api.log({ step: "worker", limit: 2, before: p1.next });
  assert.deepEqual(p2.entries.map(e => e.msg), ["line 2", "line 1"]);
  assert.throws(() => api.log({ step: "nope" as any }), /unknown step/i);
  // the log rotates instead of growing, and keeps reading across the rotation
  for (let i = 0; i < 80; i++) log.record({ step: "worker", kind: "info", msg: "x".repeat(100) + i });
  assert.ok(fs.existsSync(path.join(dir, "events.jsonl.1")), "rotated");
  assert.ok(fs.statSync(path.join(dir, "events.jsonl")).size < 4000 + 400);
  assert.equal(api.log({ step: "worker", limit: 1 }).entries[0].msg?.endsWith("79"), true);
  assert.equal(fs.statSync(path.join(dir, "events.jsonl")).mode & 0o077, 0, "private");
  // a reopened log continues the sequence
  const again = createEventLog({ file: path.join(dir, "events.jsonl"), now: () => now, maxBytes: 4000 });
  const last = again.read({ limit: 1 }).events[0].seq; again.record({ step: "worker", kind: "info", msg: "after restart" });
  assert.equal(again.read({ limit: 1 }).events[0].seq, last + 1);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("PASS automation: redacted rotating event log, derived step states, abandoned runs, triggers/hooks/failures, paged step logs, versioned contract");
