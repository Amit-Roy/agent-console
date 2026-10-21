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
  let prs: any[] = [], files: string[] = ["src/a.ts"], pull: any = { merged: false }, comments: any[] = [], headAt = now;
  const gh = async (_m: string, url: string) => {
    if (/\/issues\/\d+\/comments/.test(url)) return comments;
    if (/\/pulls\?state=open&head=/.test(url)) return prs;
    if (/\/pulls\/\d+\/files/.test(url)) return files?.map(filename => ({ filename })) ?? null;
    if (/\/pulls\/\d+$/.test(url)) return pull;
    if (/\/commits\/\w+$/.test(url)) return { commit: { committer: { date: new Date(headAt).toISOString() } } };
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
  // an errored turn is a failure; without a PR nothing is reviewed
  rv.turnEnded(worker("bau", "WE", { key: "o/webapp#99" }), { is_error: true }); await tick();
  assert.ok(steps("worker").some(m => m.startsWith("fail:")), "failed worker turn is a failure"); assert.equal(count(), 2);
  // BAU is reviewed like Trivial; no PR yet means nothing starts and the gap is reported once
  rv.turnEnded(worker("bau"), {}); await tick(); assert.equal(count(), 2);
  rv.turnEnded(worker("bau"), {}); await tick();
  assert.equal(ev.read({ step: "pr" as any }).events.filter(e => e.kind === "fail" && e.ref === "o/webapp#42").length, 1, "reported once, not every retry");
  // a PR without a Self-review section is a (soft) failure of that step; with one it passes
  prs = [{ number: 7, body: "Fixes totals" }];
  await rv.sweep([{ id: "W1", status: "idle", issueRun: { ...created[0].issueRun, effort: "bau", finishedAt: now } }] as any);
  assert.equal(count(), 3);
  assert.ok(steps("pr").includes("ok:PR #7"), "PR found"); assert.ok(steps("self_review").some(m => m.startsWith("fail:")), "no Self-review section");
  const r = created[2];
  assert.equal(r.title, "webapp:42 review PR#7"); assert.equal(r.issueRun.role, "review"); assert.equal(r.issueRun.pr, 7);
  assert.deepEqual([r.provider, r.model, r.effort], ["claude", "sonnet", "medium"], "the router's choice");
  assert.equal(run(r.cwd, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
  assert.equal(run(r.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"), path.join(r.cwd, ".git"), "review has private Git metadata");
  assert.equal(run(r.cwd, "remote", "get-url", "origin"), origin, "review fixups target actual upstream");
  assert.ok(fs.existsSync(path.join(run(r.cwd, "rev-parse", "--absolute-git-dir"), "ac-hooks", "pre-push")), "a reviewer cannot push the default branch either");
  assert.equal(run(r.cwd, "rev-parse", "HEAD"), run(started.cwd, "rev-parse", "HEAD"), "reviewer sees the PR head");
  assert.match(sent.at(-1).text, /gh pr merge 7 --repo o\/webapp --squash/); assert.match(sent.at(-1).text, /at most 20 changed lines/);
  assert.ok(steps("review").some(m => m.startsWith("ok:") || m.startsWith("info:")) || ev.read({ step: "review" as any }).events.some(e => e.kind === "start"), "review start recorded");
  assert.ok(marks.some(m => m.id === "W1" && m.patch.pr === 7 && m.patch.reviewedAt));
  // once per worker: two turn ends racing the setup start one review, and a marked worker is not reviewed again
  rv.turnEnded(worker("bau", "WR"), {}); rv.turnEnded(worker("bau", "WR"), {}); await tick(); assert.equal(count(), 4, "one review, not two"); created.pop();
  rv.turnEnded(worker("bau", "W1", { reviewedAt: now }), {}); await tick(); assert.equal(count(), 3);
  await rv.sweep([{ id: "W1", status: "idle", issueRun: { ...created[0].issueRun, effort: "bau", finishedAt: now, reviewedAt: now } }] as any); assert.equal(count(), 3);

  // a PR with a Self-review section passes that step; a protected path is not merged by a Pi reviewer
  const premiumRouting = routing;
  routing = () => ({ v: 1, decision: "route", route: { provider: "pi", model: "m", effort: "low" }, alternatives: [], why: "" });
  prs = [{ number: 8, body: "x\n\n## Self-review\nchecked; failed first: t" }]; files = ["server/window-dispatch.ts"];
  await rv.sweep([{ id: "W2", status: "idle", issueRun: { ...created[0].issueRun, key: "o/webapp#44", number: 44, effort: "trivial", finishedAt: now } }] as any);
  assert.notEqual(created.at(-1).cwd, r.cwd, "each review receives a fresh private checkout");
  assert.ok(steps("self_review").includes("ok:Self-review section present"));
  assert.match(sent.at(-1).text, /Do not merge it/); assert.doesNotMatch(sent.at(-1).text, /gh pr merge 8/);
  // a premium reviewer may merge the same protected path
  routing = premiumRouting;
  await rv.sweep([{ id: "W2b", status: "idle", issueRun: { ...created[0].issueRun, key: "o/webapp#48", number: 48, effort: "trivial", finishedAt: now } }] as any);
  assert.match(sent.at(-1).text, /gh pr merge 8 --repo o\/webapp --squash/); assert.doesNotMatch(sent.at(-1).text, /Do not merge it/);
  // Incomplete file lists still block merging for every reviewer provider.
  for (const provider of ["claude", "codex", "pi"]) {
    routing = () => ({ v: 1, decision: "route", route: { provider, model: "m", effort: "low" }, alternatives: [], why: "" });
    for (const unavailable of [false, true]) {
      files = unavailable ? null as any : Array.from({ length: 100 }, (_, i) => `src/${i}.ts`);
      await rv.sweep([{ id: `files-${provider}-${unavailable}`, status: "idle", issueRun: { ...created[0].issueRun, effort: "trivial", finishedAt: now } }] as any);
      assert.match(sent.at(-1).text, /Do not merge it/);
      assert.doesNotMatch(sent.at(-1).text, /gh pr merge 8/);
    }
  }
  routing = premiumRouting;
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
  assert.ok(steps("review").some(m => /^fail:reviewer posted no verdict on PR #7/.test(m)), "a reviewer that posts no verdict failed");
  rv.turnEnded(reviewer("o/webapp"), { is_error: true }); await tick();
  assert.ok(steps("review").some(m => m.startsWith("fail:")));

  // a worker whose turn errored after it opened its PR (a provider limit late in the turn) is still reviewed
  prs = [{ number: 40, body: "## Self-review\nok", head: { sha: "h40" } }];
  const errBefore = count();
  rv.turnEnded({ id: "WX", issueRun: { ...created[0].issueRun, key: "o/webapp#15", number: 15, effort: "bau" } } as any, { is_error: true }); await tick();
  assert.equal(count(), errBefore + 1, "errored worker with an open PR gets a reviewer");
  assert.equal(created.at(-1).issueRun.worker, "WX"); assert.equal(created.at(-1).issueRun.reviews, 1);
  // the same worker, back from a redo that pushed, is reviewed again by this server: the first review's claim is released
  comments = [{ body: "Review: CHANGES REQUESTED\nx", created_at: new Date(now).toISOString() }]; headAt = now + 1000;
  rv.turnEnded({ id: "RX", issueRun: { key: "o/webapp#15", repo: "o/webapp", number: 15, effort: "bau", role: "review", pr: 40, branch: created[0].issueRun.branch, worker: "WX", startedAt: now, reviews: 1 } } as any, {}); await tick();
  rv.turnEnded({ id: "WX", issueRun: { ...created[0].issueRun, key: "o/webapp#15", number: 15, effort: "bau", reviews: 1, redoing: true } } as any, {}); await tick();
  assert.equal(count(), errBefore + 2, "a redone worker gets a second review"); assert.equal(created.at(-1).issueRun.reviews, 2);
  created.pop(); comments = [];
  // a worker that died before marking finishedAt (an older build) is picked up by the sweep
  await rv.sweep([{ id: "WY", status: "idle", issueRun: { ...created[0].issueRun, key: "o/webapp#16", number: 16, effort: "bau" } }] as any);
  assert.equal(count(), errBefore + 2, "sweep reviews idle workers without finishedAt");

  // the review loop: changes requested -> the worker redoes the branch -> another review -> approved and merged
  const redo = (extra: any = {}) => ({ id: "RV", status: "idle", issueRun: { key: "o/webapp#50", repo: "o/webapp", number: 50, effort: "bau", role: "review", pr: 9, branch: "issue-50", base: "main", worker: "W50", startedAt: now, reviews: 1, ...extra } }) as any;
  pull = { merged: false, state: "open" };
  comments = [{ body: "Review: CHANGES REQUESTED\nsrc/a.ts:3 — off by one — use <=", created_at: new Date(now).toISOString() }];
  const sentBefore = sent.length;
  rv.turnEnded(redo(), {}); await tick();
  assert.equal(sent.length, sentBefore + 1); assert.equal(sent.at(-1).id, "W50", "findings go back to the worker thread");
  assert.match(sent.at(-1).text, /off by one/); assert.match(sent.at(-1).text, /git push origin HEAD:refs\/heads\/issue-50/); assert.match(sent.at(-1).text, /do not open a new PR/);
  assert.ok(marks.some(m => m.id === "W50" && m.patch.redoing === true && "reviewedAt" in m.patch && m.patch.reviewedAt === undefined), "worker is cleared for another review");
  assert.ok(marks.some(m => m.id === "RV" && m.patch.outcome === "changes"), "the reviewer's end is judged once");
  assert.ok(ev.read({ step: "redo" as any }).events.some(e => e.kind === "start"));
  rv.turnEnded(redo({ outcome: "changes" }), {}); await tick(); assert.equal(sent.length, sentBefore + 1, "an already judged reviewer is not judged again");
  // the worker ends its turn without pushing: no review of the same commit; it is asked to push, then a person decides
  headAt = now - 1000;
  const w50 = (extra: any = {}) => ({ id: "W50", issueRun: { ...created[0].issueRun, key: "o/webapp#50", number: 50, effort: "bau", reviews: 1, redoing: true, ...extra } }) as any;
  const nb = count(), ns = sent.length;
  rv.turnEnded(w50(), {}); await tick();
  assert.equal(count(), nb, "an unchanged branch is not reviewed again"); assert.equal(sent.at(-1).id, "W50"); assert.match(sent.at(-1).text, /no new commit since the reviewer requested changes/);
  assert.ok(marks.some(m => m.id === "W50" && m.patch.nudges === 1)); assert.ok(steps("redo").some(m => /^fail:no commit on PR #40 since the last review: worker asked to push \(1 of 2\)/.test(m)));
  rv.turnEnded(w50({ nudges: 1 }), {}); await tick(); assert.equal(sent.length, ns + 2);
  rv.turnEnded(w50({ nudges: 2 }), {}); await tick();
  assert.equal(sent.length, ns + 2, "no third reminder"); assert.equal(count(), nb);
  assert.ok(steps("redo").some(m => /still has no commit after the last review: a person decides/.test(m)));
  assert.ok(marks.some(m => m.id === "W50" && m.patch.reviewedAt), "the worker is parked");
  // the worker pushes its fixes; the next review records the redo and starts review number 2
  headAt = now + 1000;
  const rb = count();
  rv.turnEnded({ id: "W50", issueRun: { ...created[0].issueRun, key: "o/webapp#50", number: 50, effort: "bau", reviews: 1, redoing: true } } as any, {}); await tick();
  assert.ok(steps("redo").includes("ok:worker pushed new commits to PR #40"), "redo end recorded");
  assert.equal(count(), rb + 1); assert.equal(created.at(-1).issueRun.reviews, 2); assert.match(created.at(-1).title, /review PR#40 #2/);
  // an old verdict (before this reviewer started) does not count: no verdict -> retry, the worker is cleared for a fresh reviewer
  comments = [{ body: "Review: CHANGES REQUESTED\nold", created_at: new Date(now - 3_600_000).toISOString() }];
  rv.turnEnded(redo({ reviews: 2 }), {}); await tick();
  assert.ok(steps("review").some(m => /^fail:reviewer posted no verdict on PR #9/.test(m)));
  assert.ok(marks.some(m => m.id === "W50" && "reviewedAt" in m.patch && m.patch.reviewedAt === undefined && !("redoing" in m.patch)));
  // after MAX_REVIEWS a person decides: no more redo
  comments = [{ body: "Review: CHANGES REQUESTED\nstill wrong", created_at: new Date(now).toISOString() }];
  const s3 = sent.length;
  rv.turnEnded(redo({ reviews: 3 }), {}); await tick();
  assert.equal(sent.length, s3, "no redo after the cap"); assert.ok(ev.read({ step: "redo" as any }).events.some(e => /a person decides/.test(e.msg ?? "")));
  await rv.sweep([{ id: "W51", status: "idle", issueRun: { ...created[0].issueRun, key: "o/webapp#51", number: 51, effort: "bau", reviews: 3 } }] as any);
  assert.ok(steps("review").some(m => /3 reviews without a merge/.test(m)), "the worker is not reviewed a fourth time");
  // An approved PR with a failed merge reports the blocker; no worker redo is needed.
  comments = [{ body: "Review: APPROVED", created_at: new Date(now).toISOString() }];
  rv.turnEnded(redo({ reviews: 1 }), {}); await tick();
  assert.ok(steps("merge").some(m => /approved but not merged/.test(m))); assert.ok(steps("merge").every(m => !/a person merges/.test(m))); assert.equal(sent.length, s3);
  // a reviewer whose end was missed (restart) is judged by the sweep
  pull = { merged: true, merge_commit_sha: "x" };
  await rv.sweep([redo({ reviews: 1 })]);
  assert.ok(marks.some(m => m.id === "RV" && m.patch.outcome === "merged"));
  pull = { merged: false };
  // a reviewer from before the redo loop names no worker: the sweep finds it by issue and PR, and a missing verdict retries it
  comments = [];
  await rv.sweep([{ id: "OLD", status: "idle", issueRun: { key: "o/webapp#60", repo: "o/webapp", number: 60, effort: "bau", role: "review", pr: 61, branch: "b60" } },
    { id: "W60", status: "idle", issueRun: { key: "o/webapp#60", repo: "o/webapp", number: 60, effort: "bau", role: "work", pr: 61, branch: "b60", reviewedAt: now } }] as any);
  assert.ok(marks.some(m => m.id === "W60" && "reviewedAt" in m.patch && m.patch.reviewedAt === undefined), "old reviewer without a verdict sends its worker back to review");
  // the turn-end handler and the sweep never judge one reviewer twice
  comments = [{ body: "Review: CHANGES REQUESTED\nx", created_at: new Date(now).toISOString() }]; pull = { merged: false, state: "open" };
  const s4 = sent.length;
  const twice = redo({ reviews: 1 }); twice.id = "RV2";
  rv.turnEnded(twice, {}); await rv.sweep([twice]); await tick();
  assert.equal(sent.length, s4 + 1, "one redo, not two");
  pull = { merged: false };

  const archivedCount = count();
  await rv.sweep([{ id: "archived", archived: now, status: "idle", issueRun: { ...created[0].issueRun, finishedAt: now } }]);
  assert.equal(count(), archivedCount, "archived workers cannot start a new review");

  // A real worker keeps the same ID through review, redo, and another review.
  const loopWorker: any = { id: "LOOP", status: "idle", issueRun: { ...created[0].issueRun, effort: "bau" } };
  const loopCreated: any[] = [];
  let rejectSend = false;
  const loopRunner = {
    create(o: any) { loopCreated.push(o); return { id: `LR${loopCreated.length}` }; },
    mark(id: string, patch: any) {
      const state = id === loopWorker.id ? loopWorker.issueRun : loopCreated[Number(id.slice(2)) - 1]?.issueRun;
      if (state) Object.assign(state, patch);
    },
    send() { if (rejectSend) throw new Error("worker unavailable"); },
  };
  const loop = createReviewer({ github: gh as any, runner: loopRunner, dirs, events: ev, route: routing, now: () => now });
  prs = [{ number: 40, body: "## Self-review\nok" }];
  pull = { merged: false, state: "open" };
  comments = [{ body: "Review: CHANGES REQUESTED\nFix totals", created_at: new Date(now).toISOString() }];
  await loop.sweep([loopWorker]);
  assert.equal(loopCreated.length, 1);
  const loopReview: any = { id: "LR1", status: "idle", issueRun: loopCreated[0].issueRun };
  rejectSend = true;
  await loop.sweep([loopReview]);
  assert.equal(loopReview.issueRun.outcome, undefined, "failed handoff remains retryable");
  rejectSend = false;
  await loop.sweep([loopReview]);
  loop.turnEnded(loopWorker, {}); await tick();
  assert.equal(loopCreated.length, 2, "same worker starts its second review without restarting server");

  comments = [];
  await loop.sweep([{ id: "LR2", status: "idle", issueRun: loopCreated[1].issueRun }]);
  await loop.sweep([loopWorker]);
  assert.equal(loopCreated.length, 3, "same worker retries a reviewer that posted no verdict");

  // Missing PRs resume the existing worker, with durable backoff and a strict cap.
  prs = [];
  const recovering: any = { id: "RECOVER", status: "idle", provider: "pi", issueRun: { ...created[0].issueRun, effort: "bau" } };
  let resumed = 0, allowed = true, issueState = "open";
  let issueRead: (() => Promise<void>) | undefined;
  const recoveryDeps = {
    github: (async (method: string, url: string) => {
      if (/\/issues\/\d+$/.test(url)) { await issueRead?.(); return { state: issueState }; }
      return gh(method, url);
    }) as any,
    runner: { ...runner, mark(id: string, patch: any) { if (id === recovering.id) Object.assign(recovering.issueRun, patch); }, send(id: string, text: string) { assert.equal(id, recovering.id); assert.match(text, /preserve completed work/); resumed++; recovering.status = "running"; } },
    dirs, events: ev, route: routing, canResume: () => allowed, now: () => now,
  };
  let recovery = createReviewer(recoveryDeps);
  allowed = false;
  await recovery.sweep([recovering]); assert.equal(resumed, 0, "disabled dispatch cannot resume work");
  allowed = true; issueState = "closed";
  await recovery.sweep([recovering]); assert.equal(resumed, 0, "closed issue cannot resume work");
  issueState = "open";
  let releaseIssue!: () => void, issueStarted!: () => void;
  const startedIssue = new Promise<void>(resolve => { issueStarted = resolve; });
  issueRead = () => { issueStarted(); return new Promise<void>(resolve => { releaseIssue = resolve; }); };
  const pendingRecovery = recovery.sweep([recovering]);
  await startedIssue; allowed = false; releaseIssue(); await pendingRecovery;
  assert.equal(resumed, 0, "capacity is rechecked after asynchronous GitHub reads");
  issueRead = undefined; allowed = true;
  await Promise.all([recovery.sweep([recovering]), recovery.sweep([recovering])]);
  assert.equal(resumed, 1, "concurrent sweeps resume once");
  assert.equal(recovering.issueRun.recoveries, 1);
  recovering.status = "idle";
  recovery = createReviewer(recoveryDeps);
  await recovery.sweep([recovering]); assert.equal(resumed, 1, "restart preserves backoff");
  now += 15 * 60_000;
  await recovery.sweep([recovering]); assert.equal(resumed, 2);
  recovering.status = "idle"; now += 15 * 60_000;
  await createReviewer(recoveryDeps).sweep([recovering]); assert.equal(resumed, 2, "restart preserves recovery cap");
  assert.ok(recovering.issueRun.stalled, "an exhausted worker is marked stalled");
  const stalledLogs = () => ev.read({ step: "worker" as any }).events.filter(e => /a person decides/.test(e.msg ?? "")).length;
  const stalledOnce = stalledLogs(), noPrLogs = () => steps("pr").filter(m => /no open PR/.test(m)).length, noPrOnce = noPrLogs();
  assert.ok(recovering.issueRun.missingPr, "the missing PR is logged durably");
  await createReviewer(recoveryDeps).sweep([recovering]); now += 15 * 60_000;
  await createReviewer(recoveryDeps).sweep([recovering]);
  assert.equal(resumed, 2); assert.equal(stalledLogs(), stalledOnce, "a stalled worker is not logged again after a restart");
  assert.equal(noPrLogs(), noPrOnce, "a restart does not log the missing PR again");

  // A worker whose Pi model was retired upstream spent its recoveries on 404s: it gets one fresh budget.
  recovering.issueRun.stalled = undefined; recovering.model = "nvidia/nvidia/nemotron-3-super-120b-a12b";
  await createReviewer(recoveryDeps).sweep([recovering]);
  assert.equal(resumed, 3, "a retired model resets the recovery budget");
  assert.equal(recovering.issueRun.recoveries, 1); assert.equal(recovering.issueRun.rerouted, true);
  recovering.status = "idle"; now += 15 * 60_000; recovering.issueRun.recoveries = 2;
  await createReviewer(recoveryDeps).sweep([recovering]);
  assert.equal(resumed, 3, "the budget resets only once per worker"); assert.ok(recovering.issueRun.stalled);

  // A person's turn on a stalled worker clears the stall, so its PR is reviewed and recovery restarts.
  const personal = createReviewer(recoveryDeps);
  personal.turnEnded(recovering, {}); await tick();
  assert.equal(recovering.issueRun.stalled, undefined); assert.equal(recovering.issueRun.recoveries, 0);
  recovering.issueRun.recoveries = 0; recovering.issueRun.retryAt = 0; recovering.issueRun.stalled = undefined; delete recovering.model;
  recovering.issueRun.redoing = true; recovering.issueRun.pr = 40;
  await recovery.sweep([recovering]); assert.equal(resumed, 4, "failed redo resumes worker before another review");

  recovering.status = "idle"; recovering.issueRun.recoveries = 0; recovering.issueRun.retryAt = 0;
  recovering.issueRun.redoing = true; pull = { merged: true, state: "closed" };
  await recovery.sweep([recovering]); assert.equal(resumed, 4, "merged redo PR never receives more fixes");

  // A premium assignment can claim the issue while PR evidence is still loading.
  let reviewAllowed = true, releaseFiles!: () => void, filesStarted!: () => void;
  const waitingFiles = new Promise<void>(resolve => { filesStarted = resolve; });
  const racing = createReviewer({
    github: async (method, endpoint) => {
      if (/\/pulls\/\d+\/files/.test(endpoint)) {
        filesStarted();
        await new Promise<void>(resolve => { releaseFiles = resolve; });
      }
      return gh(method, endpoint);
    },
    runner, dirs, route: routing, canReview: () => reviewAllowed,
  });
  prs = [{ number: 7, body: "## Self-review\nchecked" }];
  const beforeAssignment = count();
  const pendingReview = racing.sweep([{ ...worker("bau", "assignment-race"), status: "idle" }] as any);
  await waitingFiles;
  reviewAllowed = false;
  releaseFiles();
  await pendingReview;
  assert.equal(count(), beforeAssignment, "assignment claim during GitHub wait prevents a second agent");
  await racing.sweep([{ ...worker("bau", "assignment-race"), status: "idle" }] as any);
  assert.equal(count(), beforeAssignment, "active assignment also prevents a new review at entry");

  // Ownership acquired during verdict reads must also prevent a push nudge.
  reviewAllowed = true;
  let releaseCommit!: () => void, commitStarted!: () => void;
  const waitingCommit = new Promise<void>(resolve => { commitStarted = resolve; });
  const racingNudge = createReviewer({
    github: async (_method, endpoint) => {
      if (/\/pulls\?/.test(endpoint)) return [{ number: 7, head: { sha: "abc" } }];
      if (/\/commits\//.test(endpoint)) {
        commitStarted();
        await new Promise<void>(resolve => { releaseCommit = resolve; });
        return { commit: { committer: { date: new Date(now).toISOString() } } };
      }
      if (/\/comments/.test(endpoint)) return [{ body: "Review: CHANGES REQUESTED", created_at: new Date(now + 1000).toISOString() }];
      throw new Error(`unexpected ${endpoint}`);
    }, runner, dirs, route: routing, canReview: () => reviewAllowed,
  });
  const sendsBeforeAssignment = sent.length;
  const pendingNudge = racingNudge.sweep([{ ...worker("bau", "nudge-assignment-race", { reviews: 1 }), status: "idle" }] as any);
  await waitingCommit;
  reviewAllowed = false;
  releaseCommit();
  await pendingNudge;
  assert.equal(sent.length, sendsBeforeAssignment, "assignment claim during verdict wait prevents worker nudge");

  // setup failures are logged, contained and retried
  const bad = createReviewer({ github: (async () => { throw new Error("gh down"); }) as any, runner, dirs, log: m => logs.push(m), route: routing, events: ev });
  bad.turnEnded(worker("bau", "W9"), {}); await tick(); assert.match(logs.at(-1)!, /could not start: gh down/);
  assert.ok(steps("review").some(m => /^fail:.*gh down/.test(m)));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("PASS issue review: PR-only hooks, BAU and Trivial reviewed via the router, Deep skipped, deferral and sweep, protected paths, errored workers with a PR, verdicts, redo loop and cap, merge and apply events");
