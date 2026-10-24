import path from "node:path";
import { redact } from "./automation/events.ts";
import { reviewPrompt } from "./automation/review-prompts.ts";
import { githubRequest } from "./github-triage.ts";
import {
  MAX_NUDGES,
  MAX_RECOVERIES,
  MAX_REVIEWS,
  type ReviewContext,
  type ReviewDeps,
  type ThreadLike,
} from "./review-context.ts";
import { attemptReview } from "./review-launch.ts";
import { sweepThreads } from "./review-sweep.ts";
import { reviewEnded } from "./review-verdict.ts";
import { errorClass } from "./turn-timing.ts";
import { defaultDirs, defaultGit, type Git } from "./window-dispatch.ts";

// Trivial and BAU work runs on Pi, so a premium model (Sonnet or Sol, chosen by the router) reviews the PR before it merges.
// When the worker's turn ends and its branch has an open PR, a reviewer thread starts in a detached worktree of the PR head.
// The reviewer may fix small things, merges only what it approves, and never merges a PR that touches a protected path unless it is a premium reviewer. The PR
// author and the reviewer share one GitHub account, so the verdict is a PR comment, not a formal approval.
// A "Review: CHANGES REQUESTED" verdict goes back to the worker, which fixes the branch; its next turn end starts another review.
// Reviews reserve a slot while running. No verdict returns the slot after a cooldown; the final slot owns premium completion.
// A PR with no commit after the last verdict is not reviewed again: the worker is asked to push, MAX_NUDGES times at most.
// A worker with no PR is resumed MAX_RECOVERIES times; then the premium assigner owns completion.
// The logic lives in review-launch.ts (start a review), review-verdict.ts (judge it), review-recovery.ts (resume, premium, nudge)
// and review-sweep.ts (catch up); they share one ReviewContext.

export type { ReviewDeps };
export { MAX_NUDGES, MAX_RECOVERIES, MAX_REVIEWS, reviewPrompt };

function defaultApplied(dirs: { repos: string }, git: Git) {
  return async (name: string, sha: string) => {
    try {
      await git(path.join(dirs.repos, name), "merge-base", "--is-ancestor", sha, "HEAD");
      return true;
    } catch {
      return false;
    }
  };
}

function contextOf(deps: ReviewDeps): ReviewContext {
  const dirs = deps.dirs ?? defaultDirs();
  const git = deps.git ?? defaultGit;
  return {
    deps,
    github: deps.github ?? githubRequest,
    dirs,
    git,
    applied: deps.applied ?? defaultApplied(dirs, git),
    log: deps.log ?? ((message) => console.warn(message)),
    now: deps.now ?? Date.now,
    events: deps.events,
    claimed: new Set<string>(),
    reported: new Set<string>(),
    reconciling: new Set<string>(),
    judging: new Set<string>(),
    resuming: new Set<string>(),
  };
}

/** Classify a failed worker turn: a rate limit, outage or retired model is an infrastructure failure. */
function isInfrastructureFailure(workerError: string | undefined) {
  return (
    !!workerError &&
    (["rate_limit", "overloaded", "timeout", "network", "server_error"].includes(
      errorClass(workerError),
    ) ||
      /function not found|model[^\n]*(?:retired|not found|unavailable|not supported)|stream[^\n]*(?:truncat|premature|ended|closed)|unexpected end of (?:json|stream)/i.test(
        workerError,
      ))
  );
}

function recordRedoEnd(ctx: ReviewContext, thread: ThreadLike, event: { is_error?: boolean }) {
  const run = thread.issueRun!;
  ctx.events?.record({
    step: "redo",
    kind: event?.is_error ? "fail" : "ok",
    run: `redo:${thread.id}`,
    ref: run.key,
    msg: event?.is_error
      ? "worker turn ended with an error; waiting to resume fixes"
      : "worker turn ended; its push is checked before the next review",
  });
}

function recordWorkerEnd(ctx: ReviewContext, thread: ThreadLike, event: { is_error?: boolean }) {
  const run = thread.issueRun!;
  const runId = `work:${thread.id}`;
  // An errored turn may still have pushed its PR (a provider limit late in the turn): the PR is reviewed all the same.
  if (event?.is_error)
    ctx.events?.record({
      step: "worker",
      kind: "fail",
      run: runId,
      ref: run.key,
      msg: "turn ended with an error",
    });
  else
    ctx.events?.record({ step: "worker", kind: "ok", run: runId, ref: run.key, msg: "turn ended" });
  if (run.redoing) recordRedoEnd(ctx, thread, event);
}

/** Called when an issue run's turn ends. */
function turnEnded(
  ctx: ReviewContext,
  thread: ThreadLike,
  event: { is_error?: boolean; error?: string },
) {
  const run = thread.issueRun;
  if (!run || run.role === "debug") return; // a debugging thread is judged by a person, not by the review pipeline
  if (run.role === "review") return reviewEnded(ctx, thread, event);
  const workerError = event.is_error
    ? redact(event.error || "Worker turn ended with an error; inspect the thread log.").slice(
        0,
        1000,
      )
    : undefined;
  const infrastructure = isInfrastructureFailure(workerError);
  ctx.deps.runner.mark(thread.id, { workerError, infrastructure });
  recordWorkerEnd(ctx, thread, event);
  if (run.redoing && event?.is_error) {
    ctx.deps.runner.mark(thread.id, {
      finishedAt: ctx.now(),
      redoing: true,
      retryAt: ctx.now() + 15 * 60_000,
    });
    return; // Recover the worker before spending another review on an unchanged branch.
  }
  // A stalled worker only runs again when a person sends it a turn: that turn's PR is reviewed and recovery restarts.
  ctx.deps.runner.mark(thread.id, {
    finishedAt: ctx.now(),
    redoing: false,
    stalled: undefined,
    missingPr: undefined,
    recoveries: run.stalled ? 0 : run.recoveries,
    premiumPending: undefined,
    premiumThread: undefined,
  });
  if (run.effort === "deep") return; // The sweep recovers Deep workers; their successful turns need no review.
  return attemptReview(ctx, {
    ...thread,
    issueRun: {
      ...run,
      finishedAt: ctx.now(),
      redoing: false,
      stalled: undefined,
      missingPr: undefined,
      recoveries: run.stalled ? 0 : run.recoveries,
      workerError,
      infrastructure,
    },
  });
}

export function createReviewer(deps: ReviewDeps) {
  const ctx = contextOf(deps);
  return {
    turnEnded: (thread: ThreadLike, event: { is_error?: boolean; error?: string }) =>
      turnEnded(ctx, thread, event),
    sweep: (threads: ThreadLike[]) => sweepThreads(ctx, threads),
  };
}
