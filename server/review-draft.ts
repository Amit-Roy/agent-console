import { redact } from "./automation/events.ts";
import { DIRECT_REPOS } from "./automation/policy.ts";
import { once, type ReviewContext, type WorkThread } from "./review-context.ts";
import { guardRejections } from "./session-prs.ts";

// Small models loop when pr-evidence-guard rejects their PR body (#18): they keep guessing formats and never open a PR.
// After MAX_GUARD_REJECTIONS the reviewer opens the worker's pushed branch as a draft PR and comments the guard error,
// so review takes over. The guard also refuses drafts from agents, so the worker cannot open one itself.
export const MAX_GUARD_REJECTIONS = 2;
const MAX_ERROR_CHARS = 6000;

/** A code fence longer than any backtick run inside the text, so the error cannot close it early. */
function fenced(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function draftBody(number: number, count: number) {
  return [
    `Refs #${number}`,
    "",
    "## What",
    `- Draft opened by agent-console: the PR evidence guard rejected the worker's PR body ${count} times.`,
    "",
    "## Self-review",
    "- Not done: the worker stopped before producing a guard-valid body.",
    "- The guard error is in the first PR comment; the review owner completes the evidence.",
  ].join("\n");
}

/** The draft is open either way: a failed comment is reported, and review still takes over. */
async function commentGuardError(
  ctx: ReviewContext,
  run: WorkThread["issueRun"],
  pr: number,
  rejected: { count: number; last: string },
) {
  try {
    await ctx.github("POST", `repos/${run.repo}/issues/${pr}/comments`, {
      body: `The PR evidence guard rejected the worker's PR body ${rejected.count} times. Last guard error:\n\n${fenced(redact(rejected.last).slice(0, MAX_ERROR_CHARS))}`,
    });
  } catch (caught: any) {
    ctx.events?.record({
      step: "pr",
      kind: "fail",
      ref: run.key,
      msg: `could not comment the guard error on draft PR #${pr}: ${String(caught?.message ?? caught)}`,
    });
  }
}

/** Open the looping worker's branch as a draft PR with the guard error in a comment. Undefined when not due or not possible. */
export async function openRejectedDraft(ctx: ReviewContext, thread: WorkThread) {
  const run = thread.issueRun;
  if (run.effort === "deep" && DIRECT_REPOS.includes(run.repo.split("/")[1])) return undefined;
  const rejected = guardRejections(ctx.deps.transcript?.(thread.id) ?? "");
  if (rejected.count < MAX_GUARD_REJECTIONS) return undefined;
  try {
    const issue = await ctx.github("GET", `repos/${run.repo}/issues/${run.number}`);
    const pull = await ctx.github("POST", `repos/${run.repo}/pulls`, {
      title: `${String(issue?.title ?? `Issue #${run.number}`)} (draft: PR evidence pending)`,
      head: run.branch,
      base: run.base ?? "main",
      body: draftBody(run.number, rejected.count),
      draft: true,
    });
    if (!Number.isSafeInteger(pull?.number)) throw new Error("GitHub returned no PR number");
    await commentGuardError(ctx, run, pull.number, rejected);
    ctx.events?.record({
      step: "pr",
      kind: "ok",
      ref: run.key,
      msg: `draft PR #${pull.number} opened after ${rejected.count} PR evidence guard rejections`,
      data: { thread: thread.id, pr: pull.number },
    });
    return pull;
  } catch (caught: any) {
    // Nothing pushed yet, or GitHub refused: the missing-PR recovery stays in charge.
    once(ctx, `${thread.id}:draft`, () =>
      ctx.events?.record({
        step: "pr",
        kind: "fail",
        ref: run.key,
        msg: `could not open a draft PR: ${String(caught?.message ?? caught)}`,
      }),
    );
    return undefined;
  }
}
