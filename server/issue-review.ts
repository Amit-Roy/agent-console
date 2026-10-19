import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { githubRequest, type GithubRequest } from "./github-triage.ts";
import { DIRECT_REPOS, REVIEWERS, topicOf, type IssueRun, type IssueRunner, type Route } from "./window-dispatch.ts";

// Trivial work runs on a cheap model, so a better one (Sonnet or Sol) reviews the PR before it merges. When the worker's turn
// ends and its branch has an open PR, a reviewer thread starts in a detached worktree of the PR head. The reviewer merges only
// what it approves; the PR author and the reviewer share one GitHub account, so the verdict is a PR comment, not a formal approval.

export function reviewPrompt(run: IssueRun, pr: number, base: string): string {
  const name = run.repo.split("/")[1];
  const applied = DIRECT_REPOS.includes(name)
    ? `${name} is applied locally as soon as it merges: in ~/repos/${name} run git fetch and git merge --ff-only origin/${base} (never stash or discard uncommitted changes there; if the fast-forward is refused, say so and stop).${name === "agent-console" ? " Then run bin/agent-console restart-when-idle from that directory." : ""}`
    : `Nothing else to apply for ${name}.`;
  return [
    `Review pull request #${pr} of ${run.repo}, written by a cheaper model for issue #${run.number}. You are in a detached worktree at the PR head. Do not edit code.`,
    `1. Read the issue and the PR: gh issue view ${run.number} --repo ${run.repo} --comments; gh pr view ${pr} --repo ${run.repo}; gh pr diff ${pr} --repo ${run.repo}.`,
    `2. Check that it does what the issue asks and nothing else, that it is correct, that no secret is added, and run the checks the repo documents (tests, lint).`,
    `3. Post the verdict as a PR comment: gh pr comment ${pr} --repo ${run.repo} --body "..." . The first line is exactly "Review: APPROVED" or "Review: CHANGES REQUESTED", followed by short bullets with file and line for every problem.`,
    `4. If APPROVED: gh pr merge ${pr} --repo ${run.repo} --squash --delete-branch. ${applied} If CHANGES REQUESTED: do not merge; stop.`,
    `Unattended run: do not ask questions. End with a short summary: verdict, what you ran, what you merged.`,
  ].join("\n\n");
}

export interface ReviewDeps {
  github?: GithubRequest;
  runner: IssueRunner & { mark(threadId: string, patch: Partial<IssueRun>): void };
  reviewer?: () => Route; // which of the review models has quota
  dirs?: { repos: string; worktrees: string };
  git?: (cwd: string, ...args: string[]) => string;
  log?: (msg: string) => void;
}

export function createReviewer(deps: ReviewDeps) {
  const github = deps.github ?? githubRequest;
  const dirs = deps.dirs ?? { repos: path.join(os.homedir(), "repos"), worktrees: path.join(os.homedir(), "worktrees") };
  const git = deps.git ?? ((cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 }).trim());
  const log = deps.log ?? (m => console.warn(m));
  const claimed = new Set<string>();

  async function review(thread: { id: string; issueRun: IssueRun }) {
    const run = thread.issueRun, name = run.repo.split("/")[1], owner = run.repo.split("/")[0];
    const prs = await github("GET", `repos/${run.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.branch}`)}`);
    const pr = Array.isArray(prs) ? prs[0]?.number : undefined;
    if (!Number.isSafeInteger(pr)) return false; // no PR yet: the next turn may open one
    const main = path.join(dirs.repos, name);
    git(main, "fetch", "-q", "origin", run.branch!);
    const cwd = path.join(dirs.worktrees, `${name}-review-${run.number}`);
    fs.mkdirSync(dirs.worktrees, { recursive: true });
    if (!fs.existsSync(cwd)) git(main, "worktree", "add", "-q", "--detach", cwd, `origin/${run.branch}`);
    else git(cwd, "checkout", "-q", "--detach", `origin/${run.branch}`);
    const route = (deps.reviewer ?? (() => REVIEWERS[0]))();
    const base = run.base ?? "main";
    const made = deps.runner.create({ ...route, cwd, mode: "bypassPermissions", title: `${topicOf(run.repo)}:${run.number} review PR#${pr}`, issueRun: { ...run, role: "review", pr, reviewedAt: undefined } });
    deps.runner.mark(thread.id, { pr, reviewedAt: Date.now() });
    deps.runner.send(made.id, reviewPrompt(run, pr, base));
    return true;
  }

  /** Called when an issue run's turn ends. Only successful trivial work is reviewed, once per thread. */
  function turnEnded(thread: { id: string; issueRun?: IssueRun }, ev: { is_error?: boolean }) {
    const run = thread.issueRun;
    if (!run || run.role !== "work" || run.effort !== "trivial" || ev?.is_error || run.reviewedAt || !run.branch || claimed.has(thread.id)) return;
    claimed.add(thread.id); // a second turn ending while the first review is being set up must not start another
    review({ id: thread.id, issueRun: run }).then(started => { if (!started) claimed.delete(thread.id); })
      .catch(e => { claimed.delete(thread.id); log(`Review of ${run.key} could not start: ${e?.message ?? e}`); });
  }
  return { turnEnded };
}
