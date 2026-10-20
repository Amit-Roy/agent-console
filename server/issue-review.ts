import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { githubRequest, type GithubRequest } from "./github-triage.ts";
import { addWorktree, defaultDirs, installPrOnlyHook, topicOf, type IssueRun, type IssueRunner } from "./window-dispatch.ts";
import { DIRECT_REPOS, isProtected } from "./automation/policy.ts";
import { pushPrompt, redoPrompt, reviewPrompt } from "./automation/review-prompts.ts";
import type { RouteResponse } from "./automation/router.ts";
import type { EventLog } from "./automation/events.ts";

// Trivial and BAU work runs on Pi, so a premium model (Sonnet or Sol, chosen by the router) reviews the PR before it merges.
// When the worker's turn ends and its branch has an open PR, a reviewer thread starts in a detached worktree of the PR head.
// The reviewer may fix small things, merges only what it approves, and never merges a PR that touches a protected path. The PR
// author and the reviewer share one GitHub account, so the verdict is a PR comment, not a formal approval.
// A "Review: CHANGES REQUESTED" verdict goes back to the worker, which fixes the branch; its next turn end starts another review.
// A reviewer that ends without a verdict is retried. Both loops stop after MAX_REVIEWS reviews of one worker: then a person decides.
// A PR with no commit after the last verdict is not reviewed again: the worker is asked to push, MAX_NUDGES times at most.

export { reviewPrompt };
export const MAX_REVIEWS = 3;
export const MAX_NUDGES = 2;
const VERDICT = /^\s*Review:\s*(APPROVED|CHANGES REQUESTED)\b/i;
type Marker = { mark(threadId: string, patch: Partial<IssueRun>): void };
export interface ReviewDeps {
  github?: GithubRequest;
  runner: IssueRunner & Marker;
  canResume?: (t: ThreadLike) => boolean; // Capacity and live-dispatch gates for resuming existing workers.
  route: (effort: IssueRun["effort"]) => RouteResponse; // the router's answer for a review of this effort
  events?: EventLog;
  dirs?: { repos: string; worktrees: string };
  git?: (cwd: string, ...args: string[]) => string;
  applied?: (repoName: string, sha: string) => boolean; // is the local checkout of a local-apply repo at the merge commit?
  log?: (msg: string) => void;
  now?: () => number;
}
type ThreadLike = { id: string; provider?: string; status?: string; archived?: number; issueRun?: IssueRun };

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
  const judging = new Set<string>();      // a reviewer's end is being judged: the sweep must not judge it twice
  const once = (key: string, f: () => void) => { if (!reported.has(key)) { reported.add(key); f(); } };

  const resuming = new Set<string>();
  async function resume(t: ThreadLike): Promise<void> {
    const run = t.issueRun!;
    if (!deps.canResume?.(t) || resuming.has(t.id) || (run.recoveries ?? 0) >= 2 || (run.retryAt ?? 0) > now()) return;
    resuming.add(t.id);
    try {
      const issue = await github("GET", `repos/${run.repo}/issues/${run.number}`);
      if (issue?.state !== "open") return;
      if (run.redoing) {
        const pr = await github("GET", `repos/${run.repo}/pulls/${run.pr}`);
        if (pr?.merged || pr?.state === "closed") {
          deps.runner.mark(t.id, { redoing: false, reviewedAt: now() });
          once(`${t.id}:redo-closed`, () => ev?.record({ step: "redo", kind: "info", ref: run.key, msg: `PR #${run.pr} is closed; no more fixes are needed` }));
          return;
        }
      }
      // GitHub reads yield to other turns and dispatch ticks; admission must still be valid now.
      if (t.archived || t.status === "running" || !deps.canResume?.(t)) return;
      // Persist admission before sending so concurrent sweeps and restarts cannot replay this recovery.
      deps.runner.mark(t.id, { recoveries: (run.recoveries ?? 0) + 1, retryAt: now() + 15 * 60_000, finishedAt: undefined });
      const task = run.redoing
        ? `Continue fixing the review findings on PR #${run.pr}. Read its comments first: gh pr view ${run.pr} --repo ${run.repo} --comments. Keep the same branch and PR; do not merge.`
        : `Continue issue #${run.number} in ${run.repo}. Read it first: gh issue view ${run.number} --repo ${run.repo} --comments. Complete the task, verify it, push branch ${run.branch}, and open its PR into ${run.base ?? "main"}. Do not merge.`;
      deps.runner.send(t.id, `${task}\n\nThe previous turn stopped before completion. Inspect the existing diff and remote PR before acting; preserve completed work and do not repeat completed external actions. Follow the repository PR and self-review instructions. End with what changed, what you checked, and what remains.`);
      ev?.record({ step: run.redoing ? "redo" : "worker", kind: "start", run: `${run.redoing ? "redo" : "work"}:${t.id}`, ref: run.key, msg: "resuming existing worker after an incomplete turn", data: { thread: t.id } });
    } catch (e: any) {
      ev?.record({ step: run.redoing ? "redo" : "worker", kind: "fail", ref: run.key, msg: `could not resume worker: ${String(e?.message ?? e)}` });
    } finally { resuming.delete(t.id); }
  }

  /** Did the worker push after the newest verdict? "none" when there is no verdict yet (a first review, or a retry). */
  async function pushedSinceVerdict(run: IssueRun, pr: any): Promise<"none" | "yes" | "no"> {
    const [commit, comments] = await Promise.all([github("GET", `repos/${run.repo}/commits/${pr.head?.sha}`), github("GET", `repos/${run.repo}/issues/${pr.number}/comments?per_page=100`)]);
    const verdicts = (Array.isArray(comments) ? comments : []).filter((c: any) => VERDICT.test(String(c?.body ?? ""))).map((c: any) => Date.parse(c.created_at));
    const pushed = Date.parse(commit?.commit?.committer?.date ?? "");
    if (!verdicts.length || !Number.isFinite(pushed)) return "none";
    return verdicts.some(v => v > pushed) ? "no" : "yes";
  }

  /** Ask the worker to commit and push its fixes; after MAX_NUDGES a person decides. */
  function nudge(t: ThreadLike & { issueRun: IssueRun }, pr: number) {
    const run = t.issueRun, nudges = (run.nudges ?? 0) + 1;
    if (nudges > MAX_NUDGES) {
      once(`${t.id}:stuck:${run.reviews}`, () => ev?.record({ step: "redo", kind: "fail", run: `redo:${t.id}`, ref: run.key, msg: `PR #${pr} still has no commit after the last review: a person decides` }));
      deps.runner.mark(t.id, { reviewedAt: now() });
      return;
    }
    ev?.record({ step: "redo", kind: "fail", run: `redo:${t.id}`, ref: run.key, msg: `no commit on PR #${pr} since the last review: worker asked to push (${nudges} of ${MAX_NUDGES})`, data: { thread: t.id, pr } });
    deps.runner.mark(t.id, { nudges });
    deps.runner.send(t.id, pushPrompt(run, pr));
  }

  async function review(t: ThreadLike & { issueRun: IssueRun }, recover: boolean): Promise<boolean> {
    const run = t.issueRun, name = run.repo.split("/")[1], owner = run.repo.split("/")[0];
    const prs = await github("GET", `repos/${run.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.branch}`)}`);
    const pr = Array.isArray(prs) ? prs[0] : undefined;
    if (!pr || !Number.isSafeInteger(pr.number)) { once(`${t.id}:nopr`, () => ev?.record({ step: "pr", kind: "fail", ref: run.key, msg: `no open PR for branch ${run.branch}` })); if (recover) await resume(t); return false; }
    once(`${t.id}:pr`, () => ev?.record({ step: "pr", kind: "ok", ref: run.key, msg: `PR #${pr.number}` }));
    once(`${t.id}:self`, () => /^#{1,4}\s*Self-review\b/mi.test(String(pr.body ?? ""))
      ? ev?.record({ step: "self_review", kind: "ok", ref: run.key, msg: "Self-review section present" })
      : ev?.record({ step: "self_review", kind: "fail", ref: run.key, msg: `PR #${pr.number} has no Self-review section` }));
    if ((run.reviews ?? 0) > 0) {
      const pushed = await pushedSinceVerdict(run, pr);
      if (pushed === "no") { nudge(t, pr.number); return false; } // its turn end comes back here
      if (pushed === "yes") once(`${t.id}:pushed:${run.reviews}`, () => ev?.record({ step: "redo", kind: "ok", run: `redo:${t.id}`, ref: run.key, msg: `worker pushed new commits to PR #${pr.number}` }));
    }
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
    const reviews = (run.reviews ?? 0) + 1;
    const made = deps.runner.create({ ...answer.route, cwd, mode: "bypassPermissions", title: `${topicOf(run.repo)}:${run.number} review PR#${pr.number}${reviews > 1 ? ` #${reviews}` : ""}`, issueRun: { ...run, role: "review", pr: pr.number, worker: t.id, startedAt: now(), reviewedAt: undefined, finishedAt: undefined, reviews, redoing: undefined } });
    deps.runner.mark(t.id, { pr: pr.number, reviewedAt: now(), reviews, nudges: 0 });
    ev?.record({ step: "review", kind: "start", run: `review:${made.id}`, ref: run.key, msg: `${answer.route.provider}/${answer.route.model}${guarded ? " (protected paths: no merge)" : ""}`, data: { thread: made.id, pr: pr.number } });
    deps.runner.send(made.id, reviewPrompt(run, pr.number, base, { protected: guarded }));
    return true;
  }

  async function attempt(t: ThreadLike, recover = false) {
    const run = t.issueRun;
    if (t.archived || !run || run.role !== "work" || run.effort === "deep" || run.reviewedAt || !run.branch || claimed.has(t.id)) return;
    if ((run.reviews ?? 0) >= MAX_REVIEWS) { once(`${t.id}:max`, () => ev?.record({ step: "review", kind: "info", ref: run.key, msg: `${MAX_REVIEWS} reviews without a merge: a person decides` })); return; }
    claimed.add(t.id); // a second turn ending while the first review is being set up must not start another
    try { if (!(await review(t as ThreadLike & { issueRun: IssueRun }, recover))) claimed.delete(t.id); }
    catch (e: any) {
      claimed.delete(t.id);
      const why = String(e?.message ?? e);
      log(`Review of ${run.key} could not start: ${why}`);
      ev?.record({ step: "review", kind: "fail", ref: run.key, msg: `could not start: ${why}` });
    }
  }

  /** The newest verdict the reviewer posted on the PR after it started, if any. */
  async function verdictOf(run: IssueRun): Promise<{ approved: boolean; body: string } | undefined> {
    const comments = await github("GET", `repos/${run.repo}/issues/${run.pr}/comments?per_page=100`);
    const mine = (Array.isArray(comments) ? comments : [])
      .filter((c: any) => VERDICT.test(String(c?.body ?? "")) && Date.parse(c.created_at) >= (run.startedAt ?? 0) - 60_000);
    const last = mine.at(-1);
    return last && { approved: /^approved$/i.test(VERDICT.exec(last.body)![1]), body: String(last.body) };
  }

  /** Send the worker back to the branch: a retry of the review (no verdict) or a redo of the work (changes requested). */
  function again(run: IssueRun, kind: "retry" | "redo", verdict = "") {
    const worker = run.worker;
    if (!worker) { ev?.record({ step: kind === "redo" ? "redo" : "review", kind: "info", ref: run.key, msg: "reviewer has no worker thread on record: a person decides" }); return; }
    if ((run.reviews ?? 0) >= MAX_REVIEWS) { ev?.record({ step: kind === "redo" ? "redo" : "review", kind: "info", ref: run.key, msg: `${MAX_REVIEWS} reviews without a merge: a person decides` }); return; }
    if (kind === "retry") { deps.runner.mark(worker, { reviewedAt: undefined }); claimed.delete(worker); return; } // the next sweep starts a fresh reviewer
    deps.runner.send(worker, redoPrompt(run, run.pr!, verdict));
    deps.runner.mark(worker, { reviewedAt: undefined, redoing: true });
    claimed.delete(worker);
    ev?.record({ step: "redo", kind: "start", run: `redo:${worker}`, ref: run.key, msg: `worker fixes review findings on PR #${run.pr}`, data: { thread: worker, pr: run.pr } });
  }

  /** The reviewer's turn ended: did it post a verdict, did the PR merge, and for a local-apply repo, did the checkout follow? */
  async function reviewEnded(t: ThreadLike, event: { is_error?: boolean }) {
    const run = t.issueRun!;
    if (run.outcome || judging.has(t.id)) return;
    judging.add(t.id);
    try { await judge(t, run, event); } finally { judging.delete(t.id); }
  }
  async function judge(t: ThreadLike, run: IssueRun, event: { is_error?: boolean }) {
    const name = run.repo.split("/")[1], id = `review:${t.id}`;
    const judged = (outcome: string) => deps.runner.mark(t.id, { outcome });
    const archiveIssue = () => deps.runner.archive(run.key);
    if (event?.is_error) { ev?.record({ step: "review", kind: "fail", run: id, ref: run.key, msg: "reviewer turn ended with an error" }); judged("error"); again(run, "retry"); return; }
    try {
      const pr = await github("GET", `repos/${run.repo}/pulls/${run.pr}`);
      if (pr?.merged) {
        ev?.record({ step: "review", kind: "ok", run: id, ref: run.key, msg: "reviewer approved" });
        ev?.record({ step: "merge", kind: "ok", ref: run.key, msg: `PR #${run.pr} merged` });
        judged("merged");
        archiveIssue();
        if (!DIRECT_REPOS.includes(name)) return;
        const sha = String(pr.merge_commit_sha ?? "");
        if (sha && applied(name, sha)) ev?.record({ step: "apply", kind: "ok", ref: run.key, msg: `${name} checkout is at the merge commit` });
        else ev?.record({ step: "apply", kind: "fail", ref: run.key, msg: `${name} checkout is not at the merge commit yet` });
        return;
      }
      if (pr?.state === "closed") { ev?.record({ step: "merge", kind: "info", ref: run.key, msg: `PR #${run.pr} was closed without merging` }); judged("closed"); archiveIssue(); return; }
      const verdict = await verdictOf(run);
      if (!verdict) { ev?.record({ step: "review", kind: "fail", run: id, ref: run.key, msg: `reviewer posted no verdict on PR #${run.pr}` }); judged("no-verdict"); again(run, "retry"); return; }
      if (verdict.approved) {
        ev?.record({ step: "review", kind: "ok", run: id, ref: run.key, msg: "reviewer approved" });
        ev?.record({ step: "merge", kind: "info", ref: run.key, msg: `PR #${run.pr} approved but not merged (protected paths or merge failed): a person merges` });
        judged("approved");
        return;
      }
      ev?.record({ step: "review", kind: "ok", run: id, ref: run.key, msg: "reviewer requested changes" });
      again(run, "redo", verdict.body);
      judged("changes");
    } catch (e: any) { ev?.record({ step: "merge", kind: "fail", ref: run.key, msg: `could not finish review of PR #${run.pr}: ${String(e?.message ?? e)}` }); }
  }

  /** Called when an issue run's turn ends. */
  function turnEnded(t: ThreadLike, event: { is_error?: boolean }) {
    const run = t.issueRun;
    if (!run || run.role === "debug") return; // a debugging thread is judged by a person, not by the review pipeline
    if (run.role === "review") { void reviewEnded(t, event); return; }
    const id = `work:${t.id}`;
    // An errored turn may still have pushed its PR (a provider limit late in the turn): the PR is reviewed all the same.
    if (event?.is_error) ev?.record({ step: "worker", kind: "fail", run: id, ref: run.key, msg: "turn ended with an error" });
    else ev?.record({ step: "worker", kind: "ok", run: id, ref: run.key, msg: "turn ended" });
    if (run.redoing) ev?.record({ step: "redo", kind: event?.is_error ? "fail" : "ok", run: `redo:${t.id}`, ref: run.key, msg: event?.is_error ? "worker turn ended with an error; waiting to resume fixes" : "worker turn ended; its push is checked before the next review" });
    if (run.redoing && event?.is_error) {
      deps.runner.mark(t.id, { finishedAt: now(), redoing: true, retryAt: now() + 15 * 60_000 });
      return; // Recover the worker before spending another review on an unchanged branch.
    }
    deps.runner.mark(t.id, { finishedAt: now(), redoing: false });
    void attempt({ ...t, issueRun: { ...run, finishedAt: now(), redoing: false } });
  }

  /** Catch up after a restart or a missed turn end: idle workers without a review (deferred, PR opened late, errored turn),
   *  and reviewers whose end was never judged. */
  async function sweep(threads: ThreadLike[]) {
    for (const t of threads) {
      const run = t.issueRun;
      if (t.archived || t.status === "running" || !run) continue;
      if (run.role === "work" && run.redoing) await resume(t);
      else if (run.role === "work" && !run.reviewedAt) await attempt(t, true);
      else if (run.role === "review" && run.pr && !run.outcome) {
        // Reviewers started before the redo loop do not name their worker: it is the work thread with the same issue and PR.
        const worker = run.worker ?? threads.find(w => w.issueRun?.role === "work" && w.issueRun.key === run.key && w.issueRun.pr === run.pr)?.id;
        await reviewEnded({ ...t, issueRun: { ...run, worker } }, {});
      }
    }
  }
  return { turnEnded, sweep };
}
