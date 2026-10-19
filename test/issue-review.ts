import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReviewer, reviewPrompt } from "../server/issue-review.ts";
import { startIssue, installPrOnlyHook, REVIEWERS, ROUTES } from "../server/window-dispatch.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-review-"));
const run = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
const tick = () => new Promise(r => setTimeout(r, 30));
try {
  // an origin with a default branch, and a local checkout the way ~/repos has it
  const origin = path.join(root, "origin.git"); fs.mkdirSync(origin); run(origin, "init", "-q", "--bare", "-b", "main");
  const repos = path.join(root, "repos"), main = path.join(repos, "webapp"); fs.mkdirSync(repos);
  execFileSync("git", ["clone", "-q", origin, main], { stdio: "ignore" });
  fs.writeFileSync(path.join(main, "a"), "1"); run(main, "add", "a"); run(main, "commit", "-qm", "init"); run(main, "push", "-q", "origin", "HEAD:main"); run(main, "remote", "set-head", "origin", "main");
  const dirs = { repos, worktrees: path.join(root, "wt") };

  // PR-only: the worktree hook refuses a push to the default branch but allows a branch push
  const created: any[] = [], sent: any[] = [], marks: any[] = [];
  const runner = { create: (o: any) => { created.push(o); return { id: "T" + created.length }; }, send: (id: string, text: string) => sent.push({ id, text }), mark: (id: string, patch: any) => marks.push({ id, patch }) };
  const dec = (effort: any, repo = "o/webapp"): any => ({ key: `${repo}#42`, issue: { repo, number: 42, title: "Fix totals", labels: [] }, effort, route: ROUTES.trivial[0], reason: "" });
  const started = startIssue(dec("trivial"), runner, dirs);
  fs.writeFileSync(path.join(started.cwd, "b"), "2"); run(started.cwd, "add", "b"); run(started.cwd, "commit", "-qm", "work");
  assert.throws(() => run(started.cwd, "push", "origin", "HEAD:main"), /Blocked|pre-push|failed/, "default branch is refused");
  assert.equal(run(origin, "rev-parse", "main"), run(main, "rev-parse", "origin/main"), "origin main did not move");
  run(started.cwd, "push", "-q", "origin", `HEAD:refs/heads/${started.branch}`); // a branch for the PR is fine
  assert.equal(created[0].issueRun.role, "work"); assert.equal(created[0].issueRun.branch, started.branch);
  assert.ok(fs.existsSync(path.join(main, ".git", "worktrees")), "worktree registered");
  // the main checkout keeps working normally
  run(main, "commit", "-q", "--allow-empty", "-m", "local"); run(main, "push", "-q", "origin", "HEAD:main");
  // direct repos (agent-console, dotfiles, brain) may push default for BAU/Deep, never for trivial
  const direct = path.join(root, "hooks-direct"); fs.mkdirSync(direct);
  const hookless = startIssue({ ...dec("bau"), key: "o/webapp#43", issue: { repo: "o/webapp", number: 43, title: "Other", labels: [] } }, runner, dirs);
  assert.ok(fs.existsSync(path.join(run(hookless.cwd, "rev-parse", "--absolute-git-dir"), "ac-hooks", "pre-push")), "non-direct repo BAU is also PR-only");

  // review starts when a trivial worker's turn ends and its branch has a PR
  const prs: any[] = [];
  const gh = async (_m: string, url: string) => { assert.match(url, /pulls\?state=open&head=o%3A/); return prs; };
  const work = { id: "W1", issueRun: created[0].issueRun };
  const logs: string[] = [];
  const rv = createReviewer({ github: gh as any, runner, dirs, log: m => logs.push(m), reviewer: () => REVIEWERS[0] });
  rv.turnEnded(work, { is_error: true }); await tick(); assert.equal(created.length, 2, "errored turns are not reviewed");
  rv.turnEnded({ id: "W1", issueRun: { ...created[0].issueRun, effort: "bau" } }, {}); await tick(); assert.equal(created.length, 2, "only trivial work is reviewed");
  rv.turnEnded(work, {}); await tick(); assert.equal(created.length, 2, "no PR yet, no review");
  prs.push({ number: 7 });
  rv.turnEnded(work, {}); await tick();
  assert.equal(created.length, 3);
  const r = created[2];
  assert.equal(r.title, "webapp:42 review PR#7"); assert.equal(r.issueRun.role, "review"); assert.equal(r.issueRun.pr, 7);
  assert.deepEqual([r.provider, r.model, r.effort], ["claude", "sonnet", "medium"]);
  assert.equal(run(r.cwd, "rev-parse", "HEAD"), run(started.cwd, "rev-parse", "HEAD"), "reviewer sees the PR head");
  assert.equal(run(r.cwd, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached: no branch to push from");
  assert.equal(marks.at(-1).id, "W1"); assert.equal(marks.at(-1).patch.pr, 7); assert.ok(marks.at(-1).patch.reviewedAt);
  assert.match(sent.at(-1).text, /Review: APPROVED[^]*gh pr merge 7 --repo o\/webapp --squash/);
  // once per worker: a later turn does not start a second review
  rv.turnEnded({ ...work, issueRun: { ...work.issueRun, reviewedAt: Date.now() } }, {}); await tick(); assert.equal(created.length, 3);
  rv.turnEnded(work, {}); await tick(); assert.equal(created.length, 3, "and this process remembers it even before the thread is marked");
  // prompts apply local repos after merge
  assert.match(reviewPrompt({ ...work.issueRun, repo: "o/agent-console" }, 3, "main"), /restart-when-idle/);
  assert.match(reviewPrompt({ ...work.issueRun, repo: "o/webapp" }, 3, "main"), /Nothing else to apply/);
  // a failure to set up is logged, not thrown, and can be retried
  const bad = createReviewer({ github: (async () => { throw new Error("gh down"); }) as any, runner, dirs, log: m => logs.push(m) });
  bad.turnEnded({ id: "W9", issueRun: created[0].issueRun }, {}); await tick(); assert.match(logs.at(-1)!, /could not start: gh down/);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("PASS issue review: PR-only hook, review of trivial PRs by a better model, once per worker, failures contained");
