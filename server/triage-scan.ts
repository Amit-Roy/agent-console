import { findComment, notifyItem, repoContext } from "./triage-github.ts";
import { enqueue } from "./triage-queue.ts";
import { cachedAssessment, hasPendingJob, matchesAssessment } from "./triage-store.ts";
import {
  type Kind,
  type ReconcileTotals,
  type TriageContext,
  triageSourceMarker,
} from "./triage-types.ts";

async function scanIssue(ctx: TriageContext, repo: string, issue: any, totals: ReconcileTotals) {
  if (issue.state !== "open" || !Number.isSafeInteger(issue.number) || issue.number <= 0) return;
  totals.scanned++;
  if (hasPendingJob(ctx, repo, issue.number)) return;
  const kind: Kind = issue.pull_request ? "pull_request" : "issue";
  const pull =
    kind === "pull_request"
      ? await ctx.github("GET", `repos/${repo}/pulls/${issue.number}`)
      : undefined;
  const assessment = cachedAssessment(
    ctx,
    repo,
    issue.number,
    triageSourceMarker(issue, pull, await repoContext(ctx, repo)),
    ctx.revision(),
  );
  const comment = await findComment(ctx, repo, issue.number);
  if (matchesAssessment(issue, comment, assessment)) {
    // Triage comment present; fewer than two comments means no telemetry comment yet (cheap check, no extra API call).
    if (typeof issue.comments === "number" && issue.comments < 2)
      await notifyItem(ctx, repo, issue.number, kind);
    return;
  }
  if (enqueue(ctx, repo, issue.number, kind, "reconcile")) totals.queued++;
}

async function scanRepo(ctx: TriageContext, repo: string, totals: ReconcileTotals) {
  for (let page = 1; page <= 100; page++) {
    const items = await ctx.github(
      "GET",
      `repos/${repo}/issues?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(items)) throw new Error("Invalid GitHub issues response");
    for (const issue of items) await scanIssue(ctx, repo, issue, totals);
    if (items.length < 100) break;
    if (page === 100) throw new Error("Too many open items to reconcile safely");
  }
}

async function scan(ctx: TriageContext, selectedRepo?: string): Promise<ReconcileTotals> {
  const totals: ReconcileTotals = { scanned: 0, queued: 0 };
  for (const repo of selectedRepo ? [selectedRepo] : ctx.repos) await scanRepo(ctx, repo, totals);
  return totals;
}

export function reconcile(ctx: TriageContext, repo?: string) {
  if (repo !== undefined && !ctx.repos.has(repo))
    return Promise.reject(new Error("Repository not allowed"));
  const key = repo ?? "*";
  const existing = ctx.reconciling.get(key) ?? ctx.reconciling.get("*");
  if (existing) return existing;
  const pending = scan(ctx, repo).finally(() => {
    ctx.reconciling.delete(key);
  });
  ctx.reconciling.set(key, pending);
  return pending;
}
