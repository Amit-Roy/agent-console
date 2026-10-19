import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReviewer } from "../server/issue-review.ts";
import { createEventLog } from "../server/automation/events.ts";
import { route as realRoute } from "../server/automation/router.ts";
import { startIssue, ROUTES } from "../server/window-dispatch.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-review-"));
const run = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tick = () => new Promise(r => setTimeout(r, 30));
let now = 1_800_000_000_000;
try {
  // an origin with a default branch, and a local checkout the way ~/repos has it
  const origin = path.join(root, "origin.git"); fs.mkdirSync(origin); run(origin, "init", "-q", "--bare", "-b", "main");
  const repos = path.join(root, "repos"), main = path.join(repos, "webapp"); fs.mkdirSync(repos);
  execFileSync("git", ["clone", "-q", origin, main], { stdio: "ignore" });
  fs.writeFileSync(path.join(main, "a"), "1"); run(main, "add", "a"); run(main, "commit", "-qm", "init"); run(main, "push", "-q", "origin", "HEAD:main"); run(main, "remote", "set-head", "origin", "main");
  const dirs = { repos, worktrees: path.join(root, "wt") };

  const created: any[] = [], sent: any[] = [], marks: any[] = [];
  const runner = { create: (o: any) => { created.push(o); return { id: "T" + created.length }; }, send: (id: string, text: string) => sent.push({ id, text }), mark: (id: string, patch: any) => marks.push({ id, patch }) };
  const dec = (effort: any, repo = "o/webapp", number = 42): any => ({ key: `${repo}#${number}`, issue: { repo, number, title: "Fix totals", labels: [] }, effort, route: ROUTES.trivial[0], reason: "" });

  // PR-only: a started worktree refuses a push to the default branch but allows a branch push
  const started = startIssue(dec("trivial"), runner, dirs);
  fs.writeFileSync(path.join(started.cwd, "b"), "2"); run(started.cwd, "add", "b"); run(started.cwd, "commit", "-qm", "work");
  assert.throws(() => run(started.cwd, "push", "origin", "HEAD:main"), /Blocked/, "default branch is refused");
  run(started.cwd, "push", "-q", "origin", `HEAD:refs/heads/${started.branch}`);
  assert.equal(created[0].issueRun.role, "work");
  run(main, "commit", "-q", "--allow-empty", "-m", "local"); run(main, "push", "-q", "origin", "HEAD:main"); // the main checkout still works
  const bauStart = startIssue(dec("bau", "o/webapp", 43), runner, dirs);
  assert.ok(fs.existsSync(path.join(run(bauStart.cwd, "rev-parse", "--absolute-git-dir"), "ac-hooks", "pre-push")), "non-direct repo BAU is PR-only too");

  // --- the reviewer ---------------------------------------------------------------------------------------------
  const ev = createEventLog({ file: path.join(root, "ev.jsonl"), now: () => now });
  const steps = (s: string) => ev.read({ step: s as any }).events.map(e => `${e.kind}:${e.msg ?? ""}`);
  let prs: any[] = [], files: string[] = ["src/a.ts"], pull: any = { merged: false };
  const gh = async (_m: string, url: string) => {
    if (/\/pulls\?state=open&head=/.test(url)) return prs;
    if (/\/pulls\/\d+\/files/.test(url)) return files.map(filename => ({ filename }));
    if (/\/pulls\/\d+$/.test(url)) return pull;
    throw new Error("unexpected " + url);
  };
  let routing: any = (effort: any) => realRoute({ role: "review", effort, usage: {}, active: [], now });
  const logs: string[] = [];
  const applied: any[] = [];
  const rv = createReviewer({ github: gh as any, runner, dirs, events: ev, log: m => logs.push(m), route: (e: any) => routing(e), applied: (name: string, sha: string) => { applied.push([name, sha]); return sha === "good"; }, now: () => now });
  const worker = (effort: string, id = "W1", extra = {}) => ({ id, issueRun: { ...created[0].issueRun, effort, ...extra } });
  const count = () => created.length;

  // Deep work is never reviewed by a second model; its worker still leaves events
  rv.turnEnded(worker("deep", "WD"), {}); await tick();
  assert.equal(count(), 2); assert.ok(steps("worker").includes("ok:turn ended"), "worker end is recorded");
  assert.equal(marks.at(-1).patch.finishedAt > 0, true);
  // an errored turn is a failure, not a candidate for review
  rv.turnEnded(worker("bau", "WE"), { is_error: true }); await tick();
  assert.ok(steps("worker").some(m => m.startsWith("fail:")), "failed worker turn is a failure"); assert.equal(count(), 2);
  // BAU is reviewed like Trivial; no PR yet means nothing starts and the gap is reported once
  rv.turnEnded(worker("bau"), {}); await tick(); assert.equal(count(), 2);
  rv.turnEnded(worker("bau"), {}); await tick();
  assert.equal(steps("pr").filter(m => m.startsWith("fail:")).length, 1, "reported once, not every retry");
  // a PR without a Self-review section is a (soft) failure of that step; with one it passes
  prs = [{ number: 7, body: "Fixes totals" }];
  await rv.sweep([{ id: "W1", status: "idle", issueRun: { ...created[0].issueRun, effort: "bau", finishedAt: now } }] as any);
  assert.equal(count(), 3);
  assert.ok(steps("pr").includes("ok:PR #7"), "PR found"); assert.ok(steps("self_review").some(m => m.startsWith("fail:")), "no Self-review section");
  const r = created[2];
  assert.equal(r.title, "webapp:42 review PR#7"); assert.equal(r.issueRun.role, "review"); assert.equal(r.issueRun.pr, 7);
  assert.deepEqual([r.provider, r.model, r.effort], ["claude", "sonnet", "medium"], "the router's choice");
  assert.equal(run(r.cwd, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
  assert.ok(fs.existsSync(path.join(run(r.cwd, "rev-parse", "--absolute-git-dir"), "ac-hooks", "pre-push")), "a reviewer cannot push the default branch either");
  assert.equal(run(r.cwd, "rev-parse", "HEAD"), run(started.cwd, "rev-parse", "HEAD"), "reviewer sees the PR head");
  assert.match(sent.at(-1).text, /gh pr merge 7 --repo o\/webapp --squash/); assert.match(sent.at(-1).text, /at most 20 changed lines/);
  assert.ok(steps("review").some(m => m.startsWith("ok:") || m.startsWith("info:")) || ev.read({ step: "review" as any }).events.some(e => e.kind === "start"), "review start recorded");
  assert.ok(marks.some(m => m.id === "W1" && m.patch.pr === 7 && m.patch.reviewedAt));
  // once per worker, also across the in-memory claim and after the thread is marked
  rv.turnEnded(worker("bau"), {}); await tick(); assert.equal(count(), 3);
  await rv.sweep([{ id: "W1", status: "idle", issueRun: { ...created[0].issueRun, effort: "bau", finishedAt: now, reviewedAt: now } }] as any); assert.equal(count(), 3);

  // a PR with a Self-review section passes that step; a protected path is never merged by the reviewer
  prs = [{ number: 8, body: "x\n\n## Self-review\nchecked; failed first: t" }]; files = ["server/window-dispatch.ts"];
  await rv.sweep([{ id: "W2", status: "idle", issueRun: { ...created[0].issueRun, key: "o/webapp#44", number: 44, effort: "trivial", finishedAt: now } }] as any);
  assert.ok(steps("self_review").includes("ok:Self-review section present"));
  assert.match(sent.at(-1).text, /Do not merge it/); assert.doesNotMatch(sent.at(-1).text, /gh pr merge 8/);
  files = ["src/a.ts"];

  // deferral: no review model has room now; the sweep tries again later
  routing = (effort: any) => realRoute({ role: "review", effort, usage: { claude: { windows: [{ label: "7-day", used: 100, limit: 100, resetsAt: now + 1e9 }], updatedAt: now }, codex: { windows: [{ label: "7-day", used: 100, limit: 100, resetsAt: now + 1e9 }], updatedAt: now } }, active: [], now });
  const before = count();
  const w3 = { id: "W3", status: "idle", issueRun: { ...created[0].issueRun, key: "o/webapp#45", number: 45, effort: "bau", finishedAt: now } } as any;
  await rv.sweep([w3]); assert.equal(count(), before); assert.ok(steps("review").some(m => /^info:deferred/.test(m)));
  routing = (effort: any) => realRoute({ role: "review", effort, usage: {}, active: [], now });
  await rv.sweep([w3]); assert.equal(count(), before + 1, "the next sweep starts it");

  // when the reviewer's turn ends: merged PR -> merge ok; a local-apply repo is checked against the merge commit
  pull = { merged: true, merge_commit_sha: "good" };
  const reviewer = (repo: string) => ({ id: "R1", issueRun: { key: `${repo}#42`, repo, number: 42, effort: "bau", role: "review", pr: 7, branch: "b", base: "main" } });
  rv.turnEnded(reviewer("o/webapp"), {}); await tick();
  assert.ok(steps("merge").includes("ok:PR #7 merged")); assert.equal(applied.length, 0, "a repo that is not applied locally has no apply step");
  rv.turnEnded(reviewer("o/agent-console"), {}); await tick();
  assert.deepEqual(applied.at(-1), ["agent-console", "good"]); assert.ok(steps("apply").some(m => m.startsWith("ok:")));
  pull = { merged: true, merge_commit_sha: "bad" };
  rv.turnEnded(reviewer("o/brain"), {}); await tick();
  assert.ok(steps("apply").some(m => m.startsWith("fail:") && /brain/.test(m)), "local checkout is not at the merge commit");
  pull = { merged: false };
  rv.turnEnded(reviewer("o/webapp"), {}); await tick();
  assert.ok(steps("merge").some(m => /^info:PR #7 not merged/.test(m)));
  rv.turnEnded(reviewer("o/webapp"), { is_error: true }); await tick();
  assert.ok(steps("review").some(m => m.startsWith("fail:")));

  // setup failures are logged, contained and retried
  const bad = createReviewer({ github: (async () => { throw new Error("gh down"); }) as any, runner, dirs, log: m => logs.push(m), route: routing, events: ev });
  bad.turnEnded(worker("bau", "W9"), {}); await tick(); assert.match(logs.at(-1)!, /could not start: gh down/);
  assert.ok(steps("review").some(m => /^fail:.*gh down/.test(m)));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("PASS issue review: PR-only hooks, BAU and Trivial reviewed via the router, Deep skipped, deferral and sweep, protected paths, merge and apply events");
