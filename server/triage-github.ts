import { TRIAGE_COMMENT_MARKER } from "./triage-comment.ts";
import {
  type Job,
  type Kind,
  labelNames,
  logEvent,
  MANAGED,
  type TriageContext,
} from "./triage-types.ts";

export function actorLogin(ctx: TriageContext): Promise<string> {
  return (ctx.actor ??= ctx
    .github("GET", "user")
    .then((user) => {
      if (typeof user?.login !== "string" || !user.login) throw new Error("Missing GitHub actor");
      return user.login;
    })
    .catch((error) => {
      ctx.actor = undefined;
      throw error;
    }));
}

function labelSpec(name: string) {
  const isEffort = name.startsWith("Eff:");
  return {
    name,
    color: isEffort ? "1d76db" : "d93f0b",
    description: isEffort ? "Estimated implementation effort" : "Suggested delivery priority",
  };
}

export async function ensureLabel(ctx: TriageContext, repo: string, name: string) {
  try {
    await ctx.github("GET", `repos/${repo}/labels/${encodeURIComponent(name)}`);
  } catch (error) {
    if ((error as any)?.status !== 404) throw error;
    try {
      await ctx.github("POST", `repos/${repo}/labels`, labelSpec(name));
    } catch (createError) {
      // Another worker or a maintainer can create the same label concurrently.
      if ((createError as any)?.status !== 422) throw createError;
      await ctx.github("GET", `repos/${repo}/labels/${encodeURIComponent(name)}`);
    }
  }
}

function isTriageComment(comment: any, login: string): boolean {
  return (
    comment.user?.login === login &&
    typeof comment.body === "string" &&
    comment.body.split("\n")[0] === TRIAGE_COMMENT_MARKER &&
    Number.isSafeInteger(comment.id)
  );
}

export async function findComment(ctx: TriageContext, repo: string, number: number) {
  const login = await actorLogin(ctx);
  for (let page = 1; page <= 100; page++) {
    const comments = await ctx.github(
      "GET",
      `repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(comments)) throw new Error("Invalid GitHub comments response");
    const comment = comments.find((candidate) => isTriageComment(candidate, login));
    if (comment) return comment;
    if (comments.length < 100) return undefined;
  }
  throw new Error("Too many comments to safely locate triage assessment");
}

async function readContextText(ctx: TriageContext, repo: string): Promise<string | undefined> {
  for (const file of ["PRODUCT.md", "README.md"]) {
    try {
      const found = await ctx.github("GET", `repos/${repo}/contents/${file}`);
      if (typeof found?.content === "string" && found.encoding === "base64") {
        return Buffer.from(found.content, "base64").toString("utf8").slice(0, 6_000);
      }
    } catch (error) {
      if ((error as any)?.status !== 404) break;
    }
  }
  return undefined;
}

export async function repoContext(ctx: TriageContext, repo: string): Promise<string> {
  const cached = ctx.repoContexts.get(repo);
  if (cached && Date.now() - cached.fetched < 10 * 60_000) return cached.text;
  const text = (await readContextText(ctx, repo)) ?? cached?.text ?? "";
  ctx.repoContexts.set(repo, { text, fetched: Date.now() });
  return text;
}

export async function notifyItem(ctx: TriageContext, repo: string, number: number, kind: Kind) {
  if (!ctx.options.onItem) return;
  try {
    await ctx.options.onItem({ repo, number, kind });
  } catch {
    logEvent(ctx, "on_item_failed");
  }
}

// GitHub returns 410 for deleted issues; no retry can restore them.
export function readIssue(ctx: TriageContext, endpoint: string) {
  return ctx.github("GET", endpoint).catch((error) => {
    if (error?.status === 410) return null;
    throw error;
  });
}

export async function listPullFiles(ctx: TriageContext, job: Job): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const rows = await ctx.github(
      "GET",
      `repos/${job.repo}/pulls/${job.number}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(rows)) throw new Error("Invalid GitHub files response");
    for (const row of rows) if (typeof row?.filename === "string") files.push(row.filename);
    if (rows.length < 100) break;
  }
  return files;
}

async function removeLabel(ctx: TriageContext, endpoint: string, label: string) {
  try {
    await ctx.github("DELETE", `${endpoint}/labels/${encodeURIComponent(label)}`);
  } catch (error) {
    if ((error as any)?.status !== 404) throw error;
  }
}

export async function applyLabels(
  ctx: TriageContext,
  job: Job,
  endpoint: string,
  current: any,
  desired: string[],
) {
  for (const label of desired) await ensureLabel(ctx, job.repo, label);
  // Add first so a failed retry never leaves an item without its selected labels.
  if (!desired.every((label) => labelNames(current).includes(label)))
    await ctx.github("POST", `${endpoint}/labels`, { labels: desired });
  for (const label of labelNames(current)) {
    if (MANAGED.has(label) && !desired.includes(label)) await removeLabel(ctx, endpoint, label);
  }
}

export async function upsertComment(ctx: TriageContext, job: Job, endpoint: string, body: string) {
  // Re-read after label writes: a previous POST may have succeeded before its response was lost.
  const existingComment = await findComment(ctx, job.repo, job.number);
  if (existingComment) {
    if (existingComment.body !== body)
      await ctx.github("PATCH", `repos/${job.repo}/issues/comments/${existingComment.id}`, {
        body,
      });
  } else await ctx.github("POST", `${endpoint}/comments`, { body });
}
