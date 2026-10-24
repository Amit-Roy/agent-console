import { DIRECT_REPOS } from "./automation/policy.ts";
import { redoPrompt } from "./automation/review-prompts.ts";
import { MAX_REVIEWS, type ReviewContext, type ThreadLike, VERDICT } from "./review-context.ts";
import type { IssueRun } from "./window-dispatch.ts";

export async function discussionOf(
  ctx: ReviewContext,
  run: IssueRun,
  pullNumber: number,
): Promise<any[]> {
  const comments: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await ctx.github(
      "GET",
      `repos/${run.repo}/issues/${pullNumber}/comments?per_page=100${page > 1 ? `&page=${page}` : ""}`,
    );
    if (!Array.isArray(rows)) throw new Error("Could not read the complete review discussion");
    comments.push(...rows);
    if (rows.length < 100) return comments;
  }
  throw new Error("Review discussion exceeds the 2000-comment evidence limit");
}

/** The newest verdict the reviewer posted on the PR after it started, if any. */
async function verdictOf(
  ctx: ReviewContext,
  run: IssueRun,
): Promise<{ approved: boolean; body: string } | undefined> {
  const comments = await discussionOf(ctx, run, run.pr!);
  const mine = (Array.isArray(comments) ? comments : []).filter(
    (comment: any) =>
      VERDICT.test(String(comment?.body ?? "")) &&
      Date.parse(comment.created_at) >= Math.floor((run.startedAt ?? 0) / 1000) * 1000 &&
      (run.verdictAfter === undefined || Number(comment.id) > run.verdictAfter),
  );
  const last = mine.at(-1);
  return (
    last && { approved: /^approved$/i.test(VERDICT.exec(last.body)![1]), body: String(last.body) }
  );
}

/** Return findings to the worker during the two ordinary review rounds. */
function again(ctx: ReviewContext, run: IssueRun, verdict: string) {
  const worker = run.worker;
  if (ctx.deps.canReview?.({ id: worker ?? "", issueRun: run }) === false) return;
  if (!worker) {
    ctx.events?.record({
      step: "redo",
      kind: "fail",
      ref: run.key,
      msg: "reviewer has no worker thread on record; findings cannot be handed back",
    });
    return;
  }
  if ((run.reviews ?? 0) >= MAX_REVIEWS) {
    ctx.events?.record({
      step: "redo",
      kind: "fail",
      ref: run.key,
      msg: "premium takeover ended with unresolved findings; completion is blocked",
    });
    return;
  }
  if ((run.reviews ?? 0) === MAX_REVIEWS - 1) {
    ctx.deps.runner.mark(worker, {
      reviewedAt: undefined,
      reviewThread: undefined,
      redoing: false,
    });
    ctx.claimed.delete(worker);
    ctx.events?.record({
      step: "review",
      kind: "info",
      ref: run.key,
      msg: "two reviews requested changes; premium takeover is pending",
    });
    return;
  }
  ctx.deps.runner.send(worker, redoPrompt(run, run.pr!, verdict));
  ctx.deps.runner.mark(worker, { reviewedAt: undefined, reviewThread: undefined, redoing: true });
  ctx.claimed.delete(worker);
  ctx.events?.record({
    step: "redo",
    kind: "start",
    run: `redo:${worker}`,
    ref: run.key,
    msg: `worker fixes review findings on PR #${run.pr}`,
    data: { thread: worker, pr: run.pr },
  });
}

/** An attempt with no verdict did not review the work. Return its reserved slot without retrying in a hot loop. */
export function retryReview(ctx: ReviewContext, thread: ThreadLike, run: IssueRun) {
  const worker = run.worker;
  if (!worker || ctx.deps.canReview?.({ id: worker, issueRun: run }) === false) return;
  const current = ctx.deps.threads?.().find((other) => other.id === worker)?.issueRun;
  // A delayed event from an older reviewer cannot refund or release a newer review.
  if (current?.reviewThread && current.reviewThread !== thread.id) return;
  ctx.deps.runner.mark(worker, {
    reviewedAt: undefined,
    reviewThread: undefined,
    retryAt: ctx.now() + 15 * 60_000,
    ...(run.reviews !== undefined ? { reviews: Math.max(0, run.reviews - 1) } : {}),
  });
  ctx.claimed.delete(worker);
  ctx.events?.record({
    step: "review",
    kind: "info",
    ref: run.key,
    msg: "no verdict: review slot returned; retry after 15 minutes",
    data: { thread: thread.id, worker },
  });
}

/** The reviewer's turn ended: did it post a verdict, did the PR merge, and for a local-apply repo, did the checkout follow? */
export async function reviewEnded(
  ctx: ReviewContext,
  thread: ThreadLike,
  event: { is_error?: boolean },
) {
  const run = thread.issueRun!;
  if (
    thread.quotaPaused ||
    thread.background ||
    run.outcome ||
    ctx.deps.threads?.().find((other) => other.id === thread.id)?.issueRun?.outcome ||
    ctx.judging.has(thread.id)
  )
    return;
  ctx.judging.add(thread.id);
  try {
    await judge(ctx, thread, run, event);
  } finally {
    ctx.judging.delete(thread.id);
  }
}

function markOutcome(ctx: ReviewContext, thread: ThreadLike, outcome: string) {
  ctx.deps.runner.mark(thread.id, { outcome });
}

/** The PR merged: record it and, for a local-apply repo, whether the checkout follows. */
async function judgeMerged(
  ctx: ReviewContext,
  thread: ThreadLike,
  run: IssueRun,
  pull: any,
  name: string,
  runId: string,
) {
  ctx.events?.record({
    step: "review",
    kind: "ok",
    run: runId,
    ref: run.key,
    msg: "reviewer approved",
  });
  ctx.events?.record({ step: "merge", kind: "ok", ref: run.key, msg: `PR #${run.pr} merged` });
  markOutcome(ctx, thread, "merged");
  if (!DIRECT_REPOS.includes(name)) return;
  const sha = String(pull.merge_commit_sha ?? "");
  if (sha && (await ctx.applied(name, sha)))
    ctx.events?.record({
      step: "apply",
      kind: "ok",
      ref: run.key,
      msg: `${name} checkout is at the merge commit`,
    });
  else
    ctx.events?.record({
      step: "apply",
      kind: "fail",
      ref: run.key,
      msg: `${name} checkout is not at the merge commit yet`,
      data: { pr: run.pr, ...(sha ? { sha } : {}) },
    });
}

function judgeNoVerdict(
  ctx: ReviewContext,
  thread: ThreadLike,
  run: IssueRun,
  event: { is_error?: boolean },
  runId: string,
) {
  ctx.events?.record({
    step: "review",
    kind: "fail",
    run: runId,
    ref: run.key,
    msg: event?.is_error
      ? "reviewer turn ended with an error"
      : `reviewer posted no verdict on PR #${run.pr}`,
  });
  retryReview(ctx, thread, run);
  markOutcome(ctx, thread, event?.is_error ? "error" : "no-verdict");
}

function judgeVerdict(
  ctx: ReviewContext,
  thread: ThreadLike,
  run: IssueRun,
  verdict: { approved: boolean; body: string },
  runId: string,
) {
  if (verdict.approved) {
    ctx.events?.record({
      step: "review",
      kind: "ok",
      run: runId,
      ref: run.key,
      msg: "reviewer approved",
    });
    ctx.events?.record({
      step: "merge",
      kind: "info",
      ref: run.key,
      msg: `PR #${run.pr} approved but not merged: required checks or merge command need attention`,
    });
    markOutcome(ctx, thread, "approved");
    return;
  }
  ctx.events?.record({
    step: "review",
    kind: "ok",
    run: runId,
    ref: run.key,
    msg: "reviewer requested changes",
  });
  again(ctx, run, verdict.body);
  markOutcome(ctx, thread, "changes");
}

async function judge(
  ctx: ReviewContext,
  thread: ThreadLike,
  run: IssueRun,
  event: { is_error?: boolean },
) {
  const name = run.repo.split("/")[1],
    runId = `review:${thread.id}`;
  try {
    const pull = await ctx.github("GET", `repos/${run.repo}/pulls/${run.pr}`);
    if (pull?.merged) {
      await judgeMerged(ctx, thread, run, pull, name, runId);
      return;
    }
    if (pull?.state === "closed") {
      ctx.events?.record({
        step: "merge",
        kind: "info",
        ref: run.key,
        msg: `PR #${run.pr} was closed without merging`,
      });
      markOutcome(ctx, thread, "closed");
      return;
    }
    const verdict = await verdictOf(ctx, run);
    if (!verdict) judgeNoVerdict(ctx, thread, run, event, runId);
    else judgeVerdict(ctx, thread, run, verdict, runId);
  } catch (caught: any) {
    ctx.events?.record({
      step: "merge",
      kind: "fail",
      ref: run.key,
      msg: `could not finish review of PR #${run.pr}: ${String(caught?.message ?? caught)}`,
    });
  }
}
