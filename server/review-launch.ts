import { randomUUID } from "node:crypto";
import path from "node:path";
import { DIRECT_REPOS, isProtected, mayMergeProtected } from "./automation/policy.ts";
import { reviewPrompt, takeoverPrompt, threadBrief } from "./automation/review-prompts.ts";
import type { RouteResponse } from "./automation/router.ts";
import {
  MAX_REVIEWS,
  once,
  type ReviewContext,
  type ThreadLike,
  type WorkThread,
} from "./review-context.ts";
import { nudge, resume } from "./review-recovery.ts";
import { discussionOf, retryReview, reviewerVerdicts } from "./review-verdict.ts";
import { addWorktree, type IssueRun, installPrOnlyHook, topicOf } from "./window-dispatch.ts";

type ReviewRoute = NonNullable<RouteResponse["route"]>;

/** Did the worker push after the newest verdict? "none" when there is no verdict yet (a first review, or a retry). */
async function pushedSinceVerdict(
  ctx: ReviewContext,
  run: IssueRun,
  pull: any,
): Promise<"none" | "yes" | "no"> {
  const [commit, comments] = await Promise.all([
    ctx.github("GET", `repos/${run.repo}/commits/${pull.head?.sha}`),
    discussionOf(ctx, run, pull.number),
  ]);
  const verdicts = (await reviewerVerdicts(ctx, comments)).map((comment: any) =>
    Date.parse(comment.created_at),
  );
  const pushed = Date.parse(commit?.commit?.committer?.date ?? "");
  if (!verdicts.length || !Number.isFinite(pushed)) return "none";
  return verdicts.some((stamp) => stamp > pushed) ? "no" : "yes";
}

/** No open PR for the worker's branch: record it once, and resume the worker when the caller asked for recovery. */
async function handleMissingPull(
  ctx: ReviewContext,
  thread: WorkThread,
  run: IssueRun,
  recover: boolean,
) {
  if (!run.missingPr)
    once(ctx, `${thread.id}:nopr`, () => {
      ctx.deps.runner.mark(thread.id, { missingPr: ctx.now() });
      ctx.events?.record({
        step: "pr",
        kind: "fail",
        ref: run.key,
        msg: `no open PR for branch ${run.branch}`,
      });
    });
  if (recover) await resume(ctx, thread);
}

function recordPullFound(ctx: ReviewContext, thread: WorkThread, run: IssueRun, pull: any) {
  once(ctx, `${thread.id}:pr`, () =>
    ctx.events?.record({ step: "pr", kind: "ok", ref: run.key, msg: `PR #${pull.number}` }),
  );
  once(ctx, `${thread.id}:self`, () =>
    /^#{1,4}\s*Self-review\b/im.test(String(pull.body ?? ""))
      ? ctx.events?.record({
          step: "self_review",
          kind: "ok",
          ref: run.key,
          msg: "Self-review section present",
        })
      : ctx.events?.record({
          step: "self_review",
          kind: "fail",
          ref: run.key,
          msg: `PR #${pull.number} has no Self-review section`,
        }),
  );
}

/** After an earlier review: false when the worker must push first (its turn end comes back to review). */
async function followsPush(ctx: ReviewContext, thread: WorkThread, run: IssueRun, pull: any) {
  const pushed = await pushedSinceVerdict(ctx, run, pull);
  if (ctx.deps.canReview?.(thread) === false) return false;
  if (pushed === "no") {
    nudge(ctx, thread, pull.number);
    return false;
  }
  if (pushed === "yes")
    once(ctx, `${thread.id}:pushed:${run.reviews}`, () =>
      ctx.events?.record({
        step: "redo",
        kind: "ok",
        run: `redo:${thread.id}`,
        ref: run.key,
        msg: `worker pushed new commits to PR #${pull.number}`,
      }),
    );
  return true;
}

/** Read the PR's files and discussion. Undefined when review ownership changed meanwhile. */
async function inspectPull(
  ctx: ReviewContext,
  thread: WorkThread,
  run: IssueRun,
  pull: any,
  route: ReviewRoute,
) {
  const files = await ctx.github(
    "GET",
    `repos/${run.repo}/pulls/${pull.number}/files?per_page=100`,
  );
  if (ctx.deps.canReview?.(thread) === false) return undefined;
  const names: string[] = Array.isArray(files)
    ? files.map((file: any) => String(file.filename))
    : [];
  const guarded =
    !Array.isArray(files) ||
    names.length >= 100 ||
    (isProtected(names) && !mayMergeProtected(route.provider)); // too many files to list: treat as protected
  const discussion = await discussionOf(ctx, run, pull.number);
  if (ctx.deps.canReview?.(thread) === false) return undefined;
  const verdictAfter = Math.max(0, ...discussion.map((comment) => Number(comment.id) || 0));
  return { guarded, verdictAfter };
}

/** A detached worktree of the PR head. Undefined when review ownership changed meanwhile. */
async function prepareWorktree(
  ctx: ReviewContext,
  thread: WorkThread,
  run: IssueRun,
  name: string,
) {
  const attemptId = randomUUID().slice(0, 8);
  const worktree = await addWorktree({
    repo: name,
    dirs: ctx.dirs,
    dirName: `${name}-review-${run.number}-${attemptId}`,
    branch: `review-${run.number}-${attemptId}`,
    git: ctx.git,
  });
  const { cwd } = worktree;
  await ctx.git(cwd, "fetch", "-q", "origin", run.branch!);
  await ctx.git(cwd, "checkout", "-q", "--detach", `origin/${run.branch}`);
  const base = run.base ?? worktree.base;
  await installPrOnlyHook(cwd, base, ctx.git); // Review fixes target the PR branch, never the default branch.
  if (ctx.deps.canReview?.(thread) === false) {
    await worktree.remove();
    return undefined;
  }
  return { cwd, base };
}

interface ReviewPlan {
  run: IssueRun;
  pull: any;
  route: ReviewRoute;
  takeover: boolean;
  reviews: number;
  verdictAfter: number;
  guarded: boolean;
  cwd: string;
  base: string;
}

/** Create the reviewer thread, reserve the worker's slot and record the start. */
function startReviewer(ctx: ReviewContext, thread: WorkThread, plan: ReviewPlan) {
  const { run, pull, route, takeover, reviews, verdictAfter, guarded, cwd } = plan;
  const made = ctx.deps.runner.create({
    ...route,
    cwd,
    mode: "bypassPermissions",
    title: `${topicOf(run.repo)}:${run.number} ${takeover ? "premium takeover" : "review"} PR#${pull.number}${reviews > 1 ? ` #${reviews}` : ""}`,
    issueRun: {
      ...run,
      role: "review",
      pr: pull.number,
      worker: thread.id,
      startedAt: ctx.now(),
      verdictAfter,
      reviewedAt: undefined,
      finishedAt: undefined,
      reviews,
      redoing: undefined,
      takeover,
      reviewThread: undefined,
    },
  });
  ctx.deps.runner.mark(thread.id, {
    pr: pull.number,
    reviewedAt: ctx.now(),
    reviews,
    nudges: 0,
    reviewThread: made.id,
    retryAt: undefined,
  });
  ctx.events?.record({
    step: "review",
    kind: "start",
    run: `review:${made.id}`,
    ref: run.key,
    msg: `${takeover ? "premium takeover: " : ""}${route.provider}/${route.model}${guarded ? " (merge authorization or file list unverified)" : ""}`,
    data: { thread: made.id, pr: pull.number },
  });
  return made;
}

/** Send the review prompt; a failed send returns the reserved slot and rethrows. */
function sendReviewPrompt(
  ctx: ReviewContext,
  thread: WorkThread,
  plan: ReviewPlan,
  madeId: string,
) {
  const { run, pull, takeover, reviews, guarded, base } = plan;
  const related = (ctx.deps.threads?.() ?? [thread]).filter(
    (sibling) =>
      sibling.issueRun?.repo.toLowerCase() === run.repo.toLowerCase() &&
      sibling.issueRun.number === run.number,
  );
  const context = JSON.stringify({
    threads: related.map((sibling) =>
      threadBrief(
        sibling,
        ctx.deps.dataDir ? path.join(ctx.deps.dataDir, "logs", `${sibling.id}.jsonl`) : undefined,
      ),
    ),
    events: ctx.events
      ?.all()
      .filter((entry) => entry.ref?.toLowerCase() === run.key.toLowerCase())
      .slice(-50),
  });
  try {
    ctx.deps.runner.send(
      madeId,
      takeover
        ? takeoverPrompt(run, pull.number, base, { protected: guarded }, context)
        : reviewPrompt(run, pull.number, base, { protected: guarded }),
    );
  } catch (error) {
    retryReview(ctx, { id: madeId }, { ...run, reviews, worker: thread.id });
    ctx.deps.runner.mark(madeId, { outcome: "error" });
    throw error;
  }
}

function recordDeferral(ctx: ReviewContext, thread: WorkThread, run: IssueRun, why: string) {
  once(ctx, `${thread.id}:defer:${why}`, () =>
    ctx.events?.record({ step: "review", kind: "info", ref: run.key, msg: `deferred: ${why}` }),
  );
}

async function review(ctx: ReviewContext, thread: WorkThread, recover: boolean): Promise<boolean> {
  const run = thread.issueRun,
    name = run.repo.split("/")[1],
    owner = run.repo.split("/")[0];
  const takeover = (run.reviews ?? 0) >= MAX_REVIEWS - 1;
  const prs = await ctx.github(
    "GET",
    `repos/${run.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.branch}`)}`,
  );
  if (ctx.deps.canReview?.(thread) === false) return false;
  const pull = Array.isArray(prs) ? prs[0] : undefined;
  if (!pull || !Number.isSafeInteger(pull.number)) {
    await handleMissingPull(ctx, thread, run, recover);
    return false;
  }
  if (run.effort === "deep") return false; // Deep workers own their PR; missing-PR recovery still applies.
  recordPullFound(ctx, thread, run, pull);
  if ((run.reviews ?? 0) > 0 && !takeover && !(await followsPush(ctx, thread, run, pull)))
    return false; // its turn end comes back here
  const answer = ctx.deps.route(run.effort);
  if (answer.decision !== "route" || !answer.route) {
    recordDeferral(ctx, thread, run, answer.why);
    return false;
  }
  const route = answer.route;
  if (takeover && !mayMergeProtected(route.provider)) return false;
  const inspected = await inspectPull(ctx, thread, run, pull, route);
  if (!inspected) return false;
  const prepared = await prepareWorktree(ctx, thread, run, name);
  if (!prepared) return false;
  const reviews = (run.reviews ?? 0) + 1;
  const plan: ReviewPlan = { run, pull, route, takeover, reviews, ...inspected, ...prepared };
  const made = startReviewer(ctx, thread, plan);
  sendReviewPrompt(ctx, thread, plan, made.id);
  return true;
}

/** True when this worker's turn end may start a review now. */
function isReviewDue(ctx: ReviewContext, thread: ThreadLike) {
  const run = thread.issueRun;
  if (ctx.deps.canReview?.(thread) === false || thread.archived || !run) return false;
  if (run.role !== "work") return false;
  if (run.effort === "deep" && DIRECT_REPOS.includes(run.repo.split("/")[1]) && !run.workerError)
    return false;
  return !(
    run.reviewedAt ||
    run.stalled ||
    !run.branch ||
    (run.retryAt ?? 0) > ctx.now() ||
    ctx.claimed.has(thread.id)
  );
}

export async function attemptReview(ctx: ReviewContext, thread: ThreadLike, recover = false) {
  const run = thread.issueRun;
  if (!isReviewDue(ctx, thread) || !run) return;
  if ((run.reviews ?? 0) >= MAX_REVIEWS) {
    once(ctx, `${thread.id}:max`, () =>
      ctx.events?.record({
        step: "review",
        kind: "info",
        ref: run.key,
        msg: "premium takeover already used; no duplicate owner will start",
      }),
    );
    return;
  }
  ctx.claimed.add(thread.id); // a second turn ending while the first review is being set up must not start another
  try {
    if (!(await review(ctx, thread as WorkThread, recover))) ctx.claimed.delete(thread.id);
  } catch (caught: any) {
    ctx.claimed.delete(thread.id);
    const why = String(caught?.message ?? caught);
    ctx.log(`Review of ${run.key} could not start: ${why}`);
    ctx.events?.record({
      step: "review",
      kind: "fail",
      ref: run.key,
      msg: `could not start: ${why}`,
    });
  }
}
