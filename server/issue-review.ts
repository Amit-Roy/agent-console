import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { githubRequest, type GithubRequest } from "./github-triage.ts";
import { addWorktree, defaultDirs, installPrOnlyHook, topicOf, type IssueRun, type IssueRunner } from "./window-dispatch.ts";
import { DIRECT_REPOS, isProtected } from "./automation/policy.ts";
import { reviewPrompt } from "./automation/review-prompts.ts";
import type { RouteResponse } from "./automation/router.ts";
import type { EventLog } from "./automation/events.ts";

// Trivial and BAU work runs on Pi, so a premium model (Sonnet or Sol, chosen by the router) reviews the PR before it merges.
// When the worker's turn ends and its branch has an open PR, a reviewer thread starts in a detached worktree of the PR head.
// The reviewer may fix small things, merges only what it approves, and never merges a PR that touches a protected path. The PR
// author and the reviewer share one GitHub account, so the verdict is a PR comment, not a formal approval.

export { reviewPrompt };
type Marker = { mark(threadId: string, patch: Partial<IssueRun>): void };
export interface ReviewDeps {
  github?: GithubRequest;
  runner: IssueRunner & Marker;
  route: (effort: IssueRun["effort"]) => RouteResponse; // the router's answer for a review of this effort
  events?: EventLog;
  dirs?: { repos: string; worktrees: string };
  git?: (cwd: string, ...args: string[]) => string;
  applied?: (repoName: string, sha: string) => boolean; // is the local checkout of a local-apply repo at the merge commit?
  log?: (msg: string) => void;
  now?: () => number;
}
type ThreadLike = { id: string; status?: string; archived?: number; issueRun?: IssueRun };

export function createReviewer(deps: ReviewDeps) {
  const github = deps.github ?? githubRequest;
  const dirs = deps.dirs ?? defaultDirs();
  const git = deps.git ?? ((cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 }).trim());
  const applied = deps.applied ?? ((name: string, sha: string) => { try { git(path.join(dirs.repos, name), "merge-base", "--is-ancestor", sha, "HEAD"); return true; } catch { return false; } });
  const log = deps.log ?? (m => console.warn(m));
  const now = deps.now ?? Date.now;
  const ev = deps.events;
  const claimed = new Set<string>();      // a review is starting or has started for this worker
  const reported = new Set<string>();     // events already written once per worker (no PR, PR found, deferred...)
  const once = (key: string, f: () => void) => { if (!reported.has(key)) { reported.add(key); f(); } };

  async function review(t: { id: string; issueRun: IssueRun }): Promise<boolean> {
    const run = t.issueRun, name = run.repo.split("/")[1], owner = run.repo.split("/")[0];
    const prs = await github("GET", `repos/${run.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.branch}`)}`);
    const pr = Array.isArray(prs) ? prs[0] : undefined;
    if (!pr || !Number.isSafeInteger(pr.number)) { once(`${t.id}:nopr`, () => ev?.record({ step: "pr", kind: "fail", ref: run.key, msg: `no open PR for branch ${run.branch}` })); return false; }
    once(`${t.id}:pr`, () => ev?.record({ step: "pr", kind: "ok", ref: run.key, msg: `PR #${pr.number}` }));
    once(`${t.id}:self`, () => /^#{1,4}\s*Self-review\b/mi.test(String(pr.body ?? ""))
      ? ev?.record({ step: "self_review", kind: "ok", ref: run.key, msg: "Self-review section present" })
      : ev?.record({ step: "self_review", kind: "fail", ref: run.key, msg: `PR #${pr.number} has no Self-review section` }));
    const answer = deps.route(run.effort);
    if (answer.decision !== "route" || !answer.route) {
      once(`${t.id}:defer:${answer.why}`, () => ev?.record({ step: "review", kind: "info", ref: run.key, msg: `deferred: ${answer.why}` }));
      return false;
    }
    const files = await github("GET", `repos/${run.repo}/pulls/${pr.number}/files?per_page=100`);
    const names: string[] = Array.isArray(files) ? files.map((f: any) => String(f.filename)) : [];
    const guarded = !Array.isArray(files) || names.length >= 100 || isProtected(names); // too many files to list: treat as protected
    const attempt = randomUUID().slice(0, 8);
    const wt = addWorktree({ repo: name, dirs, dirName: `${name}-review-${run.number}-${attempt}`, branch: `review-${run.number}-${attempt}`, git });
    const { cwd } = wt;
    git(cwd, "fetch", "-q", "origin", run.branch!);
    git(cwd, "checkout", "-q", "--detach", `origin/${run.branch}`);
    const base = run.base ?? wt.base;
    installPrOnlyHook(cwd, base, git); // Review fixes target the PR branch, never the default branch.
    const made = deps.runner.create({ ...answer.route, cwd, mode: "bypassPermissions", title: `${topicOf(run.repo)}:${run.number} review PR#${pr.number}`, issueRun: { ...run, role: "review", pr: pr.number, reviewedAt: undefined, finishedAt: undefined } });
    deps.runner.mark(t.id, { pr: pr.number, reviewedAt: now() });
    ev?.record({ step: "review", kind: "start", run: `review:${made.id}`, ref: run.key, msg: `${answer.route.provider}/${answer.route.model}${guarded ? " (protected paths: no merge)" : ""}`, data: { thread: made.id, pr: pr.number } });
    deps.runner.send(made.id, reviewPrompt(run, pr.number, base, { protected: guarded }));
    return true;
  }

  async function attempt(t: ThreadLike) {
    const run = t.issueRun;
    if (t.archived || !run || run.role !== "work" || run.effort === "deep" || run.reviewedAt || !run.branch || claimed.has(t.id)) return;
    claimed.add(t.id); // a second turn ending while the first review is being set up must not start another
    try { if (!(await review({ id: t.id, issueRun: run }))) claimed.delete(t.id); }
    catch (e: any) {
      claimed.delete(t.id);
      const why = String(e?.message ?? e);
      log(`Review of ${run.key} could not start: ${why}`);
      ev?.record({ step: "review", kind: "fail", ref: run.key, msg: `could not start: ${why}` });
    }
  }

  /** The reviewer's turn ended: did the PR merge, and for a local-apply repo, did the checkout follow? */
  async function reviewEnded(t: ThreadLike, event: { is_error?: boolean }) {
    const run = t.issueRun!, name = run.repo.split("/")[1], id = `review:${t.id}`;
    if (event?.is_error) { ev?.record({ step: "review", kind: "fail", run: id, ref: run.key, msg: "reviewer turn ended with an error" }); return; }
    ev?.record({ step: "review", kind: "ok", run: id, ref: run.key, msg: "reviewer finished" });
    try {
      const pr = await github("GET", `repos/${run.repo}/pulls/${run.pr}`);
      if (!pr?.merged) { ev?.record({ step: "merge", kind: "info", ref: run.key, msg: `PR #${run.pr} not merged (changes requested, protected paths, or still open)` }); return; }
      ev?.record({ step: "merge", kind: "ok", ref: run.key, msg: `PR #${run.pr} merged` });
      if (!DIRECT_REPOS.includes(name)) return;
      const sha = String(pr.merge_commit_sha ?? "");
      if (sha && applied(name, sha)) ev?.record({ step: "apply", kind: "ok", ref: run.key, msg: `${name} checkout is at the merge commit` });
      else ev?.record({ step: "apply", kind: "fail", ref: run.key, msg: `${name} checkout is not at the merge commit yet` });
    } catch (e: any) { ev?.record({ step: "merge", kind: "fail", ref: run.key, msg: `could not read PR #${run.pr}: ${String(e?.message ?? e)}` }); }
  }

  /** Called when an issue run's turn ends. */
  function turnEnded(t: ThreadLike, event: { is_error?: boolean }) {
    const run = t.issueRun;
    if (!run || run.role === "debug") return; // a debugging thread is judged by a person, not by the review pipeline
    if (run.role === "review") { void reviewEnded(t, event); return; }
    const id = `work:${t.id}`;
    if (event?.is_error) { ev?.record({ step: "worker", kind: "fail", run: id, ref: run.key, msg: "turn ended with an error" }); return; }
    ev?.record({ step: "worker", kind: "ok", run: id, ref: run.key, msg: "turn ended" });
    deps.runner.mark(t.id, { finishedAt: now() });
    void attempt({ ...t, issueRun: { ...run, finishedAt: now() } });
  }

  /** Retry workers that finished but have no review yet: a deferred review, a PR opened late, or a restart in between. */
  async function sweep(threads: ThreadLike[]) {
    for (const t of threads) {
      const run = t.issueRun;
      if (!t.archived && run?.role === "work" && run.finishedAt && !run.reviewedAt && t.status !== "running") await attempt(t);
    }
  }
  return { turnEnded, sweep };
}
