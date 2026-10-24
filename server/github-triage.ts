import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { childEnv } from "./providers/env.ts";
import { classifyTriage } from "./providers/triage-model.ts";
import { assessmentRevision } from "./triage-calibration.ts";
import { schedule } from "./triage-queue.ts";
import { reconcile } from "./triage-scan.ts";
import { openStore, signalIdle, triageStatus } from "./triage-store.ts";
import {
  assertRepoAllowlist,
  type GithubRequest,
  type Options,
  type TriageContext,
} from "./triage-types.ts";
import { handleRequest } from "./triage-webhook.ts";

export {
  EFFORT_LABELS,
  PRIORITY_LABELS,
  renderTriageComment,
  TRIAGE_COMMENT_MARKER,
  TRIAGE_COMMENT_VERSION_MARKER,
} from "./triage-comment.ts";
export type { GithubRequest } from "./triage-types.ts";
export { triageSourceMarker } from "./triage-types.ts";

class GithubError extends Error {
  status?: number;
  constructor(status?: number) {
    super("GitHub API request failed");
    this.status = status;
  }
}

// Never invoke a shell or let webhook fields select a host, executable, or URL.
export const githubRequest: GithubRequest = (method, endpoint, body) =>
  new Promise((resolve, reject) => {
    const args = ["api", "--hostname", "github.com", "--method", method, endpoint];
    if (body !== undefined) args.push("--input", "-");
    const child = execFile(
      "gh",
      args,
      { env: childEnv(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const status = /HTTP\s+(\d{3})/.exec(stderr)?.[1];
          reject(new GithubError(status ? Number(status) : undefined));
          return;
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null);
        } catch {
          reject(new GithubError());
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
  });

function updateRepos(ctx: TriageContext, next: string[]) {
  assertRepoAllowlist(next);
  ctx.repos = new Set(next);
}

function waitForIdle(ctx: TriageContext, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(deadline);
      ctx.idleListeners.delete(done);
      resolve();
    };
    const deadline = setTimeout(() => {
      ctx.idleListeners.delete(done);
      reject(new Error("Triage queue did not become idle"));
    }, timeoutMs);
    ctx.idleListeners.add(done);
    signalIdle(ctx);
  });
}

async function closeService(ctx: TriageContext) {
  if (ctx.closed) return;
  ctx.closing = true;
  if (ctx.timer) clearTimeout(ctx.timer);
  await Promise.allSettled([ctx.active, ...ctx.reconciling.values()].filter(Boolean));
  ctx.database.close();
  ctx.closed = true;
  for (const resolve of ctx.idleListeners) resolve();
}

export function createTriageService(options: Options) {
  if (!options.secret || options.secret.length < 20)
    throw new Error("A webhook secret of at least 20 characters is required");
  assertRepoAllowlist(options.repos);
  const ctx: TriageContext = {
    options,
    repos: new Set(options.repos),
    github: options.github ?? githubRequest,
    classify: options.classify ?? classifyTriage,
    revision: options.assessmentRevision ?? assessmentRevision,
    retries: options.retryDelaysMs ?? [30_000, 120_000],
    database: openStore(options.dbPath),
    actor: undefined,
    closing: false,
    closed: false,
    timer: undefined,
    active: undefined,
    idleListeners: new Set(),
    repoContexts: new Map(),
    reconciling: new Map(),
  };
  schedule(ctx);
  return {
    handler: (req: IncomingMessage, res: ServerResponse) => handleRequest(ctx, req, res),
    status: () => triageStatus(ctx),
    waitForIdle: (timeoutMs?: number) => waitForIdle(ctx, timeoutMs),
    reconcile: (repo?: string) => reconcile(ctx, repo),
    updateRepos: (next: string[]) => updateRepos(ctx, next),
    close: () => closeService(ctx),
  };
}
