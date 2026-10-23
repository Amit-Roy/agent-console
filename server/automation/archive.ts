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

/** Reconcile persisted workers and reviewers with GitHub, including runs created before PR tracking. */
export function createAutomationArchiver(deps: Dependencies) {
  const github = deps.github ?? githubRequest;
  const now = deps.now ?? Date.now;
  let pending: Promise<void> | undefined;

  async function reconcile() {
    const groups = new Map<string, AutoThread[]>();
    for (const thread of deps.threads.list()) {
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
    for (const [key, group] of groups) {
      if (group.every((t) => t.archived)) continue;
      const repo = key.slice(0, key.lastIndexOf("#"));
      const number = group[0].issueRun!.number;
      // Cache both successful and failed reads across siblings in this issue group.
      const requests = new Map<string, Promise<any>>();
      const read = (endpoint: string) => {
        if (!requests.has(endpoint)) requests.set(endpoint, github("GET", endpoint));
        return requests.get(endpoint)!;
      };
      let outcome: string | undefined;
      let mergedPr: number | undefined;
      try {
        const issue = await read(`repos/${repo}/issues/${number}`);
        if (issue?.state === "closed") outcome = "issue_closed";
      } catch {
        /* A separate PR read can still establish completion. */
      }
      if (!outcome) {
        for (const prNumber of new Set(
          group.map((t) => t.issueRun!.pr).filter((n) => Number.isSafeInteger(n) && n! > 0),
        )) {
          try {
            const pr = await read(`repos/${repo}/pulls/${prNumber}`);
            if (pr?.merged === true || pr?.merged_at) {
              outcome = "merged";
              mergedPr = prNumber;
              break;
            }
          } catch {
            /* An unavailable PR must not prevent checking another known PR. */
          }
        }
      }
      if (!outcome) {
        const branches = new Map<string, { branch: string; base?: string }>();
        for (const thread of group) {
          const { branch, base } = thread.issueRun!;
          if (branch) branches.set(`${branch}\n${base ?? ""}`, { branch, base });
        }
        for (const { branch, base } of branches.values()) {
          try {
            // Include merged PRs and paginate: a legacy worker may predate many closed PRs.
            for (let page = 1; ; page++) {
              const endpoint = `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}${base ? `&base=${encodeURIComponent(base)}` : ""}&per_page=100&page=${page}`;
              const prs = await read(endpoint);
              if (!Array.isArray(prs)) break;
              const pr = prs.find(
                (p) => (p?.merged === true || p?.merged_at) && Number.isSafeInteger(p.number),
              );
              if (pr) {
                outcome = "merged";
                mergedPr = pr.number;
                break;
              }
              if (prs.length < 100) break;
            }
          } catch {
            /* Retry an unavailable branch next sweep. */
          }
          if (outcome) break;
        }
      }
      if (!outcome) continue;
      for (const thread of group) {
        // Re-read after network waits: a user or background child may have resumed this thread.
        const live = deps.threads.get(thread.id);
        if (!live?.issueRun || live.archived || live.status === "running" || live.background)
          continue;
        try {
          deps.threads.setIssueRun(thread.id, {
            outcome,
            finishedAt: live.issueRun.finishedAt ?? now(),
            redoing: false,
            ...(mergedPr ? { pr: mergedPr } : {}),
          });
          deps.threads.archive(thread.id, true);
        } catch {
          deps.log?.(`Could not archive automation thread ${thread.id}; retrying next sweep.`);
        }
      }
    }
  }

  return {
    sweep(): Promise<void> {
      if (!pending)
        pending = reconcile().finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
