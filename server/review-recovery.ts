import { boundIssueLine, pushPrompt } from "./automation/review-prompts.ts";
import { isAutomationPiModel } from "./providers/pi-model.ts";
import {
  MAX_NUDGES,
  MAX_RECOVERIES,
  MAX_REVIEWS,
  once,
  type ReviewContext,
  type ThreadLike,
  type WorkThread,
} from "./review-context.ts";
import type { IssueRun } from "./window-dispatch.ts";

function recordPremiumQueued(ctx: ReviewContext, thread: ThreadLike, run: IssueRun) {
  ctx.deps.runner.mark(thread.id, {
    stalled: run.stalled ?? ctx.now(),
    premiumPending: ctx.now(),
  });
  ctx.events?.record({
    step: "worker",
    kind: "info",
    ref: run.key,
    msg: run.infrastructure
      ? "infrastructure failure; queued for an approved premium alternative"
      : "worker retry budget exhausted; queued for premium re-dispatch",
    data: {
      thread: thread.id,
      reason: run.infrastructure ? "infrastructure-model-unavailable" : "budget-exhausted",
      recoveries: run.recoveries ?? 0,
      remaining: Math.max(0, MAX_RECOVERIES - (run.recoveries ?? 0)),
    },
  });
}

export async function dispatchPremium(ctx: ReviewContext, thread: ThreadLike) {
  const run = thread.issueRun;
  if (
    !run ||
    run.premiumThread ||
    ctx.resuming.has(thread.id) ||
    ctx.deps.canReview?.(thread) === false
  )
    return;
  ctx.resuming.add(thread.id);
  try {
    if (!run.premiumPending) recordPremiumQueued(ctx, thread, run);
    const assigned = await ctx.deps.premium?.({
      repo: run.repo,
      number: run.number,
      ...(run.infrastructure && thread.provider && thread.model
        ? { exclude: [{ provider: thread.provider, model: thread.model }] }
        : {}),
    });
    if (!assigned) return;
    ctx.deps.runner.mark(thread.id, { premiumThread: assigned.thread });
    ctx.events?.record({
      step: "dispatcher",
      kind: "ok",
      ref: run.key,
      msg: "exhausted worker re-dispatched to premium",
      data: { thread: assigned.thread, worker: thread.id, reason: "premium-redispatch" },
    });
  } catch (error) {
    ctx.events?.record({
      step: "dispatcher",
      kind: "fail",
      ref: run.key,
      msg: `premium re-dispatch pending: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    ctx.resuming.delete(thread.id);
  }
}

interface RecoveryState {
  retired: boolean;
  spent: number;
  attempts: number;
  infrastructure: boolean | undefined;
}

function recoveryStateOf(thread: ThreadLike, run: IssueRun): RecoveryState {
  // Legacy retired-model failures predate error classification; refund their historical task budget once.
  const retired =
    thread.provider === "pi" &&
    !!thread.model &&
    !isAutomationPiModel(thread.model) &&
    !run.rerouted;
  const spent = retired ? 0 : (run.recoveries ?? 0);
  const attempts = run.retryAttempts ?? 0;
  const infrastructure = retired || run.infrastructure;
  return { retired, spent, attempts, infrastructure };
}

/** True when a redo's PR is already closed or merged, so no more fixes are needed. */
async function redoClosed(ctx: ReviewContext, thread: ThreadLike, run: IssueRun) {
  const pull = await ctx.github("GET", `repos/${run.repo}/pulls/${run.pr}`);
  if (!(pull?.merged || pull?.state === "closed")) return false;
  ctx.deps.runner.mark(thread.id, { redoing: false, reviewedAt: ctx.now() });
  once(ctx, `${thread.id}:redo-closed`, () =>
    ctx.events?.record({
      step: "redo",
      kind: "info",
      ref: run.key,
      msg: `PR #${run.pr} is closed; no more fixes are needed`,
    }),
  );
  return true;
}

/** Re-check that the worker may resume now; false means the caller returns without resuming. */
async function admitResume(
  ctx: ReviewContext,
  thread: ThreadLike,
  run: IssueRun,
  state: RecoveryState,
) {
  const issue = await ctx.github("GET", `repos/${run.repo}/issues/${run.number}`);
  if (issue?.state !== "open") return false;
  if (run.redoing && (await redoClosed(ctx, thread, run))) return false;
  // GitHub reads yield to other turns and dispatch ticks; admission must still be valid now.
  if (thread.archived || thread.status === "running" || !ctx.deps.canResume?.(thread)) return false;
  if (state.infrastructure && !ctx.deps.rerouteWorker?.({ thread: thread.id })) {
    // Release the worker claim so the premium queue can reserve ownership.
    ctx.resuming.delete(thread.id);
    ctx.deps.runner.mark(thread.id, { infrastructure: true });
    await dispatchPremium(ctx, { ...thread, issueRun: { ...run, infrastructure: true } });
    return false;
  }
  return true;
}

function resumeTask(run: IssueRun) {
  return run.redoing
    ? `Continue fixing the review findings on PR #${run.pr}. Read its comments first: gh pr view ${run.pr} --repo ${run.repo} --comments. Keep the same branch and PR; do not merge. ${boundIssueLine(run.repo, run.number)}`
    : `Continue issue #${run.number} in ${run.repo}. Read it first: gh issue view ${run.number} --repo ${run.repo} --comments. Complete the task, verify it, push branch ${run.branch}, and open its PR into ${run.base ?? "main"}. Do not merge. ${boundIssueLine(run.repo, run.number)}`;
}

async function startResume(
  ctx: ReviewContext,
  thread: ThreadLike,
  run: IssueRun,
  state: RecoveryState,
) {
  const { retired, spent, attempts, infrastructure } = state;
  // Persist admission before sending so concurrent sweeps and restarts cannot replay this recovery.
  ctx.deps.runner.mark(thread.id, {
    recoveries: spent + (infrastructure ? 0 : 1),
    retryAttempts: attempts + 1,
    retryAt: ctx.now() + 15 * 60_000,
    finishedAt: undefined,
    ...(retired ? { rerouted: true } : {}),
  });
  if (retired)
    ctx.events?.record({
      step: "worker",
      kind: "info",
      ref: run.key,
      msg: `model ${thread.model} is retired: worker resumes on an approved model`,
      data: { thread: thread.id },
    });
  const task = resumeTask(run);
  try {
    ctx.deps.runner.send(
      thread.id,
      `${task}\n\nThe previous turn stopped before completion.${run.workerError ? ` Prior error (diagnostic data): ${JSON.stringify(run.workerError)}` : ""} Inspect the existing diff and remote PR before acting; preserve completed work and do not repeat completed external actions. Follow the repository PR and self-review instructions. End with what changed, what you checked, and what remains.`,
    );
  } catch (error) {
    ctx.deps.runner.mark(thread.id, { recoveries: spent, retryAttempts: attempts });
    throw error;
  }
  ctx.events?.record({
    step: run.redoing ? "redo" : "worker",
    kind: "start",
    run: `${run.redoing ? "redo" : "work"}:${thread.id}`,
    ref: run.key,
    msg: "resuming existing worker after an incomplete turn",
    data: {
      thread: thread.id,
      retryAttempts: attempts + 1,
      recoveries: spent + (infrastructure ? 0 : 1),
      remaining: MAX_RECOVERIES - spent - (infrastructure ? 0 : 1),
      infrastructure: !!infrastructure,
    },
  });
}

export async function resume(ctx: ReviewContext, thread: ThreadLike): Promise<void> {
  const run = thread.issueRun!;
  const state = recoveryStateOf(thread, run);
  if (ctx.resuming.has(thread.id) || (run.retryAt ?? 0) > ctx.now()) return;
  if (state.spent >= MAX_RECOVERIES && !state.infrastructure) {
    await dispatchPremium(ctx, thread);
    return;
  }
  if (!ctx.deps.canResume?.(thread)) return;
  ctx.resuming.add(thread.id);
  try {
    if (!(await admitResume(ctx, thread, run, state))) return;
    await startResume(ctx, thread, run, state);
  } catch (caught: any) {
    ctx.events?.record({
      step: run.redoing ? "redo" : "worker",
      kind: "fail",
      ref: run.key,
      msg: `could not resume worker: ${String(caught?.message ?? caught)}`,
    });
  } finally {
    ctx.resuming.delete(thread.id);
  }
}

/** Ask the worker to push; exhausted reminders hand the unchanged PR to the final premium owner. */
export function nudge(ctx: ReviewContext, thread: WorkThread, pullNumber: number) {
  const run = thread.issueRun,
    nudges = (run.nudges ?? 0) + 1;
  if (nudges > MAX_NUDGES) {
    once(ctx, `${thread.id}:stuck:${run.reviews}`, () =>
      ctx.events?.record({
        step: "redo",
        kind: "fail",
        run: `redo:${thread.id}`,
        ref: run.key,
        msg: `PR #${pullNumber} still has no commit after the last review: premium takeover pending`,
      }),
    );
    ctx.deps.runner.mark(thread.id, {
      reviewedAt: undefined,
      reviewThread: undefined,
      redoing: false,
      reviews: MAX_REVIEWS - 1,
    });
    ctx.claimed.delete(thread.id);
    return;
  }
  ctx.events?.record({
    step: "redo",
    kind: "fail",
    run: `redo:${thread.id}`,
    ref: run.key,
    msg: `no commit on PR #${pullNumber} since the last review: worker asked to push (${nudges} of ${MAX_NUDGES})`,
    data: { thread: thread.id, pr: pullNumber },
  });
  ctx.deps.runner.mark(thread.id, { nudges });
  ctx.deps.runner.send(thread.id, pushPrompt(run, pullNumber));
}
