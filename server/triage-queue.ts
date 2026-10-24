import { randomUUID } from "node:crypto";
import { notifyItem } from "./triage-github.ts";
import { processJob } from "./triage-job.ts";
import {
  claimDueJob,
  hasQueuedJob,
  insertJob,
  markFinished,
  markRetry,
  markRunning,
  nextAttemptAt,
  signalIdle,
} from "./triage-store.ts";
import { type Job, type Kind, logEvent, type TriageContext } from "./triage-types.ts";

export function enqueue(
  ctx: TriageContext,
  repo: string,
  number: number,
  kind: Kind,
  reason: Job["reason"],
  delivery = randomUUID(),
) {
  if (ctx.closing) throw new Error("Shutting down");
  if (reason !== "webhook" && hasQueuedJob(ctx, repo, number)) return false;
  const inserted = insertJob(ctx, { repo, number, kind, reason, delivery });
  schedule(ctx);
  return inserted;
}

function recordFailure(ctx: TriageContext, job: Job) {
  const attempt = job.attempts + 1;
  const retry = attempt < 3;
  const delay = ctx.retries[Math.min(attempt - 1, ctx.retries.length - 1)] ?? 120_000;
  markRetry(ctx, job, retry, delay);
  logEvent(ctx, retry ? "retry" : "failed", { repo: job.repo, number: job.number, attempt });
}

async function runJob(ctx: TriageContext, job: Job) {
  try {
    const result = await processJob(ctx, job);
    // Webhook jobs already notified on receipt; every other path (lost webhook, reconcile, repair) must not skip it.
    if (result.status === "done" && job.reason !== "webhook")
      await notifyItem(ctx, job.repo, job.number, job.kind);
    markFinished(ctx, job, result);
    logEvent(ctx, result.status, {
      repo: job.repo,
      number: job.number,
      model: result.model ?? null,
    });
  } catch {
    recordFailure(ctx, job);
  }
}

function fireTimer(ctx: TriageContext) {
  ctx.timer = undefined;
  if (ctx.closing) return;
  const job = claimDueJob(ctx);
  if (!job) {
    schedule(ctx);
    return;
  }
  markRunning(ctx, job);
  ctx.active = runJob(ctx, job).finally(() => {
    ctx.active = undefined;
    schedule(ctx);
  });
}

export function schedule(ctx: TriageContext) {
  if (ctx.closing || ctx.active) return;
  if (ctx.timer) clearTimeout(ctx.timer);
  const soonest = nextAttemptAt(ctx);
  if (soonest === null) {
    signalIdle(ctx);
    return;
  }
  ctx.timer = setTimeout(
    () => fireTimer(ctx),
    Math.min(2_147_483_647, Math.max(0, soonest - Date.now())),
  );
  ctx.timer.unref();
}
