import type { TriageDecision } from "./providers/triage-model.ts";
import { EFFORT_LABELS, PRIORITY_LABELS, renderTriageComment } from "./triage-comment.ts";
import {
  applyLabels,
  findComment,
  listPullFiles,
  readIssue,
  repoContext,
  upsertComment,
} from "./triage-github.ts";
import { cachedAssessment, matchesAssessment, saveAssessment } from "./triage-store.ts";
import {
  type CachedAssessment,
  type Job,
  managedLabels,
  type TriageContext,
  triageSourceMarker,
} from "./triage-types.ts";

export type JobResult = { status: "done" | "skipped"; model?: string };
type LoadedItem = {
  issue: any;
  pull: any;
  files: string[];
  draft: boolean;
  head: string | undefined;
};

function skipped(): JobResult {
  return { status: "skipped" };
}

// Read the issue (and pull request details); undefined means the job must be skipped.
async function loadItem(
  ctx: TriageContext,
  job: Job,
  endpoint: string,
): Promise<LoadedItem | undefined> {
  const issue = await readIssue(ctx, endpoint);
  if (!issue || issue.state !== "open") return undefined;
  if ((job.kind === "pull_request") !== Boolean(issue.pull_request)) return undefined;
  if (job.kind !== "pull_request") {
    return { issue, pull: undefined, files: [], draft: false, head: undefined };
  }
  const pull = await ctx.github("GET", `repos/${job.repo}/pulls/${job.number}`);
  if (pull.state !== "open") return undefined;
  const files = await listPullFiles(ctx, job);
  return { issue, pull, files, draft: Boolean(pull.draft), head: pull.head?.sha };
}

function assertValidDecision(decision: TriageDecision) {
  if (
    !Object.hasOwn(EFFORT_LABELS, decision.effort) ||
    !Object.hasOwn(PRIORITY_LABELS, decision.priority) ||
    typeof decision.model !== "string" ||
    !decision.model.length ||
    decision.model.length > 200
  ) {
    throw new Error("Invalid triage decision");
  }
}

async function classifyItem(
  ctx: TriageContext,
  job: Job,
  item: LoadedItem,
  context: string,
  sourceMarker: string,
  currentRevision: string,
): Promise<CachedAssessment> {
  const { issue, pull } = item;
  const decision = await ctx.classify({
    repo: job.repo,
    number: job.number,
    kind: job.kind,
    title: typeof issue.title === "string" ? issue.title : "",
    body: typeof issue.body === "string" ? issue.body : "",
    files: item.files,
    draft: item.draft,
    changedFiles: pull?.changed_files,
    additions: pull?.additions,
    deletions: pull?.deletions,
    ...(context ? { repoContext: context } : {}),
  });
  assertValidDecision(decision);
  if (ctx.revision() !== currentRevision)
    throw new Error("Effort model changed during classification");
  const assessment: CachedAssessment = {
    body: renderTriageComment(decision, sourceMarker),
    effort: decision.effort,
    priority: decision.priority,
    model: decision.model,
  };
  if (assessment.body.length > 65_000) throw new Error("Triage comment exceeds size limit");
  return assessment;
}

// Re-read after classification; undefined means skip, a thrown error means retry later.
async function guardUnchanged(
  ctx: TriageContext,
  job: Job,
  item: LoadedItem,
  endpoint: string,
): Promise<any | undefined> {
  const current = await readIssue(ctx, endpoint);
  if (!current || current.state !== "open") return undefined;
  // Do not undo a maintainer's managed-label edits while the model was running.
  if (managedLabels(current) !== managedLabels(item.issue)) return undefined;
  if (current.title !== item.issue.title || current.body !== item.issue.body)
    throw new Error("Item changed during classification");
  if (job.kind === "pull_request") {
    const currentPull = await ctx.github("GET", `repos/${job.repo}/pulls/${job.number}`);
    if (currentPull.state !== "open") return undefined;
    if (currentPull.head?.sha !== item.head || Boolean(currentPull.draft) !== item.draft)
      throw new Error("Pull request changed during classification");
  }
  return current;
}

export async function processJob(ctx: TriageContext, job: Job): Promise<JobResult> {
  if (!ctx.repos.has(job.repo)) return skipped();
  const endpoint = `repos/${job.repo}/issues/${job.number}`;
  const item = await loadItem(ctx, job, endpoint);
  if (!item) return skipped();
  const context = await repoContext(ctx, job.repo);
  const sourceMarker = triageSourceMarker(item.issue, item.pull, context);
  const existingComment = await findComment(ctx, job.repo, job.number);
  const currentRevision = ctx.revision();
  let assessment = cachedAssessment(ctx, job.repo, job.number, sourceMarker, currentRevision);
  if (matchesAssessment(item.issue, existingComment, assessment)) return skipped();
  assessment ??= await classifyItem(ctx, job, item, context, sourceMarker, currentRevision);
  const current = await guardUnchanged(ctx, job, item, endpoint);
  if (!current) return skipped();
  const desired = [EFFORT_LABELS[assessment.effort], PRIORITY_LABELS[assessment.priority]];
  // Persist before external writes so retries and restarts repair the same assessment.
  saveAssessment(ctx, job, sourceMarker, currentRevision, assessment);
  await applyLabels(ctx, job, endpoint, current, desired);
  await upsertComment(ctx, job, endpoint, assessment.body);
  return { status: "done", model: assessment.model };
}
