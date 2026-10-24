import type { EventLog } from "./automation/events.ts";
import type { RouteResponse } from "./automation/router.ts";
import type { GithubRequest } from "./github-triage.ts";
import type { Git, IssueRun, IssueRunner } from "./window-dispatch.ts";

export const MAX_REVIEWS = 3;
export const MAX_NUDGES = 2;
export const MAX_RECOVERIES = 2;
export const VERDICT = /^\s*Review:\s*(APPROVED|CHANGES REQUESTED)\b/i;
export type Marker = { mark(threadId: string, patch: Partial<IssueRun>): void };
export interface ReviewDeps {
  github?: GithubRequest;
  runner: IssueRunner & Marker;
  canReview?: (thread: ThreadLike) => boolean; // Explicit premium ownership supersedes automatic review and redo.
  canResume?: (thread: ThreadLike) => boolean; // Capacity and live-dispatch gates for resuming existing workers.
  rerouteWorker?: (req: { thread: string }) => { model: string } | undefined;
  premium?: (req: {
    repo: string;
    number: number;
    exclude?: { provider: string; model: string }[];
  }) => Promise<{ thread: string } | undefined>;
  route: (effort: IssueRun["effort"]) => RouteResponse; // the router's answer for a review of this effort
  events?: EventLog;
  threads?: () => ThreadLike[];
  dataDir?: string;
  dirs?: { repos: string; worktrees: string };
  git?: Git;
  applied?: (repoName: string, sha: string) => boolean | Promise<boolean>; // is the local checkout of a local-apply repo at the merge commit?
  log?: (msg: string) => void;
  now?: () => number;
}
export type ThreadLike = {
  id: string;
  provider?: string;
  model?: string;
  status?: string;
  background?: number;
  archived?: number;
  cwd?: string;
  quotaPaused?: unknown;
  issueRun?: IssueRun;
};
export type WorkThread = ThreadLike & { issueRun: IssueRun };

/** Shared state and resolved dependencies of one reviewer. Every module mutates the same sets through this object. */
export interface ReviewContext {
  deps: ReviewDeps;
  github: GithubRequest;
  dirs: { repos: string; worktrees: string };
  git: Git;
  applied: (repoName: string, sha: string) => boolean | Promise<boolean>;
  log: (msg: string) => void;
  now: () => number;
  events: EventLog | undefined;
  claimed: Set<string>; // a review is starting or has started for this worker
  reported: Set<string>; // events already written once per worker (no PR, PR found, deferred...)
  reconciling: Set<string>;
  judging: Set<string>; // a reviewer's end is being judged: the sweep must not judge it twice
  resuming: Set<string>;
}

export function once(ctx: ReviewContext, key: string, action: () => void) {
  if (!ctx.reported.has(key)) {
    ctx.reported.add(key);
    action();
  }
}
