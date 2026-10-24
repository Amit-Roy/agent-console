import type { EventLog } from "./automation/events.ts";
import { DIRECT_REPOS } from "./automation/policy.ts";
import { isAutomationPiModel } from "./providers/pi-model.ts";
import { MAX_REVIEWS, type ReviewContext, type ThreadLike } from "./review-context.ts";
import { attemptReview } from "./review-launch.ts";
import { dispatchPremium, resume } from "./review-recovery.ts";
import { reviewEnded } from "./review-verdict.ts";
import type { IssueRun } from "./window-dispatch.ts";

type LoggedEvent = ReturnType<EventLog["all"]>[number];

/** The newest ok or fail apply event per issue. */
function latestApplyEvents(events: EventLog) {
  const latest = new Map<string, LoggedEvent>();
  for (const entry of events.all())
    if (entry.step === "apply" && entry.ref && (entry.kind === "ok" || entry.kind === "fail"))
      latest.set(entry.ref, entry);
  return latest;
}

/** Merged review threads of one issue, when they all agree on a single PR. */
function mergedReviewRun(threads: ThreadLike[], ref: string, failure: LoggedEvent) {
  const candidates = threads.filter((thread) => {
    const candidateRun = thread.issueRun;
    return (
      candidateRun?.key === ref &&
      candidateRun.role === "review" &&
      candidateRun.outcome === "merged" &&
      candidateRun.pr &&
      (failure.data?.pr === undefined || failure.data.pr === candidateRun.pr)
    );
  });
  if (!candidates.length || new Set(candidates.map((thread) => thread.issueRun!.pr)).size !== 1)
    return undefined;
  return candidates[0].issueRun!;
}

/** The merge commit of a failed apply: recorded on the failure, else read from the merged PR. */
async function mergeShaOf(ctx: ReviewContext, run: IssueRun, failure: LoggedEvent) {
  let sha = typeof failure.data?.sha === "string" ? failure.data.sha : "";
  if (!sha) {
    const pull = await ctx.github("GET", `repos/${run.repo}/pulls/${run.pr}`);
    if (!pull?.merged) return "";
    sha = String(pull.merge_commit_sha ?? "");
  }
  return sha;
}

async function reconcileOne(
  ctx: ReviewContext,
  events: EventLog,
  threads: ThreadLike[],
  ref: string,
  failure: LoggedEvent,
) {
  if (failure.kind !== "fail" || ctx.reconciling.has(ref)) return;
  const run = mergedReviewRun(threads, ref, failure);
  if (!run) return;
  const name = run.repo.split("/")[1];
  if (!DIRECT_REPOS.includes(name)) return;
  ctx.reconciling.add(ref);
  try {
    const sha = await mergeShaOf(ctx, run, failure);
    if (!sha || !(await ctx.applied(name, sha))) return;
    events.record({
      step: "apply",
      kind: "ok",
      ref,
      msg: `${name} checkout contains the merge commit`,
      data: { pr: run.pr, sha },
    });
  } catch {
    // A failed read leaves the original failure unresolved for the next sweep.
  } finally {
    ctx.reconciling.delete(ref);
  }
}

/** Recheck pending local applies, including historical failures recorded before merge metadata was kept. */
async function reconcileApplies(ctx: ReviewContext, threads: ThreadLike[]) {
  const events = ctx.events;
  if (!events) return;
  for (const [ref, failure] of latestApplyEvents(events))
    await reconcileOne(ctx, events, threads, ref, failure);
}

/** A stalled or premium-pending worker: resume it on an approved model, or hand it to premium. */
async function recoverStalled(ctx: ReviewContext, thread: ThreadLike, run: IssueRun) {
  if (
    thread.provider === "pi" &&
    thread.model &&
    !isAutomationPiModel(thread.model) &&
    !run.rerouted &&
    !run.premiumThread
  ) {
    const pending = {
      ...run,
      stalled: undefined,
      premiumPending: undefined,
      infrastructure: true,
    };
    ctx.deps.runner.mark(thread.id, pending);
    await resume(ctx, { ...thread, issueRun: pending });
    return;
  }
  await dispatchPremium(ctx, thread);
}

/** Existing jobs parked by the former three-review cap have not received a premium owner yet. */
function awaitsTakeover(ctx: ReviewContext, threads: ThreadLike[], run: IssueRun) {
  return (
    run.role === "work" &&
    (run.reviews ?? 0) >= MAX_REVIEWS &&
    !(ctx.deps.threads?.() ?? threads).some(
      (sibling) =>
        sibling.issueRun?.key === run.key &&
        sibling.issueRun.role === "review" &&
        (sibling.issueRun.takeover || !sibling.issueRun.outcome),
    )
  );
}

async function startTakeover(ctx: ReviewContext, thread: ThreadLike, run: IssueRun) {
  const pending = {
    ...run,
    reviews: MAX_REVIEWS - 1,
    reviewedAt: undefined,
    reviewThread: undefined,
    redoing: false,
  };
  if (ctx.deps.canReview?.(thread) === false) return;
  ctx.deps.runner.mark(thread.id, pending);
  ctx.claimed.delete(thread.id);
  await attemptReview(ctx, { ...thread, issueRun: pending });
}

async function sweepIdle(
  ctx: ReviewContext,
  threads: ThreadLike[],
  thread: ThreadLike,
  run: IssueRun,
) {
  if (run.role === "work" && run.redoing) await resume(ctx, thread);
  else if (run.role === "work" && !run.reviewedAt) await attemptReview(ctx, thread, true);
  else if (run.role === "review" && run.pr && !run.outcome) {
    // Reviewers started before the redo loop do not name their worker: it is the work thread with the same issue and PR.
    const worker =
      run.worker ??
      threads.find(
        (candidate) =>
          candidate.issueRun?.role === "work" &&
          candidate.issueRun.key === run.key &&
          candidate.issueRun.pr === run.pr,
      )?.id;
    await reviewEnded(ctx, { ...thread, issueRun: { ...run, worker } }, {});
  }
}

async function sweepThread(ctx: ReviewContext, threads: ThreadLike[], thread: ThreadLike) {
  const run = thread.issueRun;
  if (thread.archived || thread.status === "running" || thread.background || thread.quotaPaused)
    return;
  if (!run) return;
  if (run.role === "work" && (run.stalled || run.premiumPending)) {
    await recoverStalled(ctx, thread, run);
    return;
  }
  if (awaitsTakeover(ctx, threads, run)) {
    await startTakeover(ctx, thread, run);
    return;
  }
  await sweepIdle(ctx, threads, thread, run);
}

/** Catch up after a restart or a missed turn end: idle workers without a review (deferred, PR opened late, errored turn),
 *  and reviewers whose end was never judged. */
export async function sweepThreads(ctx: ReviewContext, threads: ThreadLike[]) {
  await reconcileApplies(ctx, threads);
  for (const thread of threads) await sweepThread(ctx, threads, thread);
}
