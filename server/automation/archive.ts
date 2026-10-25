import { type GithubRequest, githubRequest } from "../github-triage.ts";
import type { IssueRun } from "../window-dispatch.ts";

type AutoThread = {
  id: string;
  status?: string;
  background?: number;
  archived?: number;
  issueRun?: IssueRun;
};
type Dependencies = {
  threads: {
    list(): AutoThread[];
    get(id: string): AutoThread | undefined;
    archive(id: string, archived: boolean): void;
    setIssueRun(id: string, patch: Partial<IssueRun>): void;
  };
  github?: GithubRequest;
  now?: () => number;
  log?: (message: string) => void;
};

type Outcome = { outcome?: string; mergedPr?: number };
type Reader = (endpoint: string) => Promise<any>;
type ArchiverContext = {
  deps: Dependencies;
  github: GithubRequest;
  now: () => number;
};

function groupByIssue(threads: AutoThread[]): Map<string, AutoThread[]> {
  const groups = new Map<string, AutoThread[]>();
  for (const thread of threads) {
    const run = thread.issueRun;
    if (!run) continue;
    const repo = run.repo?.trim().replace(/\/+$/, "").toLowerCase();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(run.number) || run.number <= 0)
      continue;
    const key = `${repo}#${run.number}`;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  return groups;
}

// Cache both successful and failed reads across siblings in this issue group.
function cachedReader(github: GithubRequest): Reader {
  const requests = new Map<string, Promise<any>>();
  return (endpoint: string) => {
    if (!requests.has(endpoint)) requests.set(endpoint, github("GET", endpoint));
    return requests.get(endpoint)!;
  };
}

async function issueIsClosed(read: Reader, repo: string, number: number): Promise<boolean> {
  try {
    const issue = await read(`repos/${repo}/issues/${number}`);
    return issue?.state === "closed";
  } catch {
    /* A separate PR read can still establish completion. */
    return false;
  }
}

async function findMergedKnownPr(
  read: Reader,
  repo: string,
  group: AutoThread[],
): Promise<number | undefined> {
  for (const prNumber of new Set(
    group
      .map((thread) => thread.issueRun!.pr)
      .filter((num) => Number.isSafeInteger(num) && num! > 0),
  )) {
    try {
      const pull = await read(`repos/${repo}/pulls/${prNumber}`);
      if (pull?.merged === true || pull?.merged_at) return prNumber;
    } catch {
      /* An unavailable PR must not prevent checking another known PR. */
    }
  }
  return undefined;
}

// Include merged PRs and paginate: a legacy worker may predate many closed PRs.
async function findMergedBranchPr(
  read: Reader,
  repo: string,
  branch: string,
  base: string | undefined,
): Promise<number | undefined> {
  for (let page = 1; ; page++) {
    const endpoint = `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}${base ? `&base=${encodeURIComponent(base)}` : ""}&per_page=100&page=${page}`;
    const prs = await read(endpoint);
    if (!Array.isArray(prs)) return undefined;
    const merged = prs.find(
      (candidate) =>
        (candidate?.merged === true || candidate?.merged_at) &&
        Number.isSafeInteger(candidate.number),
    );
    if (merged) return merged.number;
    if (prs.length < 100) return undefined;
  }
}

async function findMergedByBranch(
  read: Reader,
  repo: string,
  group: AutoThread[],
): Promise<number | undefined> {
  const branches = new Map<string, { branch: string; base?: string }>();
  for (const thread of group) {
    const { branch, base } = thread.issueRun!;
    if (branch) branches.set(`${branch}\n${base ?? ""}`, { branch, base });
  }
  for (const { branch, base } of branches.values()) {
    try {
      const merged = await findMergedBranchPr(read, repo, branch, base);
      if (merged !== undefined) return merged;
    } catch {
      /* Retry an unavailable branch next sweep. */
    }
  }
  return undefined;
}

async function resolveOutcome(
  ctx: ArchiverContext,
  repo: string,
  group: AutoThread[],
): Promise<Outcome> {
  const number = group[0].issueRun!.number;
  const read = cachedReader(ctx.github);
  if (await issueIsClosed(read, repo, number)) return { outcome: "issue_closed" };
  const knownPr = await findMergedKnownPr(read, repo, group);
  if (knownPr !== undefined) return { outcome: "merged", mergedPr: knownPr };
  const branchPr = await findMergedByBranch(read, repo, group);
  if (branchPr !== undefined) return { outcome: "merged", mergedPr: branchPr };
  return {};
}

function archiveGroup(ctx: ArchiverContext, group: AutoThread[], result: Outcome) {
  const { deps } = ctx;
  for (const thread of group) {
    // Re-read after network waits: a user or background child may have resumed this thread.
    const live = deps.threads.get(thread.id);
    if (!live?.issueRun || live.archived || live.status === "running" || live.background) continue;
    try {
      deps.threads.setIssueRun(thread.id, {
        outcome: result.outcome,
        finishedAt: live.issueRun.finishedAt ?? ctx.now(),
        redoing: false,
        ...(result.mergedPr ? { pr: result.mergedPr } : {}),
      });
      deps.threads.archive(thread.id, true);
    } catch {
      deps.log?.(`Could not archive automation thread ${thread.id}; retrying next sweep.`);
    }
  }
}

async function reconcileArchive(ctx: ArchiverContext) {
  for (const [key, group] of groupByIssue(ctx.deps.threads.list())) {
    if (group.every((thread) => thread.archived)) continue;
    const repo = key.slice(0, key.lastIndexOf("#"));
    const result = await resolveOutcome(ctx, repo, group);
    if (result.outcome) archiveGroup(ctx, group, result);
  }
}

/** Reconcile persisted workers and reviewers with GitHub, including runs created before PR tracking. */
export function createAutomationArchiver(deps: Dependencies) {
  const ctx: ArchiverContext = {
    deps,
    github: deps.github ?? githubRequest,
    now: deps.now ?? Date.now,
  };
  let pending: Promise<void> | undefined;

  return {
    sweep(): Promise<void> {
      if (!pending)
        pending = reconcileArchive(ctx).finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
