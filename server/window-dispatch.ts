import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "./auth.ts";
import { EFFORT_LABELS, PRIORITY_LABELS, githubRequest, type GithubRequest } from "./github-triage.ts";
import type { ProviderUsage, UsageWindow } from "./usage.ts";

// Subscription quota resets every 5 hours whether or not it was used. Near the end of a window, hand open issues to
// the provider whose quota would otherwise expire. This module only plans; `dryRun` (the default) never starts work.

export type Effort = "trivial" | "bau" | "deep";
export interface Route { provider: string; model: string; effort: string }
export interface Config {
  enabled: boolean;      // false = plan and log only
  dryRun: boolean;
  leadMinutes: number;   // assign only inside the last N minutes of a 5-hour window
  maxUsedPct: number;    // skip a window that is already this full: nothing would be wasted
  perWindow: number;     // issues handed to one provider per window
  repos: string[];
}
export interface Issue { repo: string; number: number; title: string; labels: string[] }
export interface Decision { key: string; issue: Issue; effort: Effort; route: Route; window?: { provider: string; resetsAt: number; used: number }; reason: string }

export const DEFAULTS: Config = { enabled: false, dryRun: true, leadMinutes: 90, maxUsedPct: 90, perWindow: 2, repos: ["Amit-Roy/agent-console"] };

// Issue #10: BAU = Sonnet medium or Sol low; Deep = Opus medium or Sol high; Trivial = any cheap Pi model, reviewed by a better one.
export const ROUTES: Record<Effort, Route[]> = {
  deep: [{ provider: "claude", model: "opus", effort: "medium" }, { provider: "codex", model: "gpt-6.1-sol", effort: "high" }],
  bau: [{ provider: "claude", model: "sonnet", effort: "medium" }, { provider: "codex", model: "gpt-6.1-sol", effort: "low" }],
  trivial: [{ provider: "pi", model: "default", effort: "default" }],
};
export const REVIEWERS: Route[] = [{ provider: "claude", model: "sonnet", effort: "medium" }, { provider: "codex", model: "gpt-6.1-sol", effort: "low" }];

export const issueKey = (i: Pick<Issue, "repo" | "number">) => `${i.repo}#${i.number}`;

export function effortOf(labels: string[]): Effort | undefined {
  const hit = (Object.entries(EFFORT_LABELS) as [Effort, string][]).filter(([, l]) => labels.includes(l));
  return hit.length === 1 ? hit[0][0] : undefined;
}
const rank = (labels: string[]) => { const i = Object.values(PRIORITY_LABELS).findIndex(l => labels.includes(l)); return i < 0 ? 9 : i; };

export function fiveHour(u: ProviderUsage | undefined, now: number): (UsageWindow & { resetsAt: number }) | undefined {
  const w = u?.windows.find(x => x.label === "5-hour" && x.resetsAt);
  return w && w.resetsAt! > now ? w as UsageWindow & { resetsAt: number } : undefined;
}

// A provider has expiring quota when its window ends within the lead time. `full` marks a window at or above maxUsedPct:
// big work skips it, but trivial work (small, reviewed) does not need the room check.
export function expiring(u: ProviderUsage | undefined, now: number, cfg: Config) {
  const w = fiveHour(u, now);
  if (!w || w.resetsAt - now > cfg.leadMinutes * 60_000) return undefined;
  const pct = w.limit ? w.used / w.limit * 100 : 100;
  return { resetsAt: w.resetsAt, used: pct, full: pct >= cfg.maxUsedPct };
}

/** Pure: which open issues to start now. `done` holds keys already assigned (any window). */
export function plan(input: { now: number; usage: Record<string, ProviderUsage>; issues: Issue[]; done: Set<string>; cfg?: Partial<Config> }): Decision[] {
  const cfg = { ...DEFAULTS, ...input.cfg };
  const open = input.issues
    .filter(i => !input.done.has(issueKey(i)) && effortOf(i.labels))
    .sort((a, b) => rank(a.labels) - rank(b.labels) || a.number - b.number);
  const room = new Map<string, { resetsAt: number; used: number; full: boolean; left: number }>();
  for (const p of ["claude", "codex"]) {
    const e = expiring(input.usage[p], input.now, cfg);
    if (e) room.set(p, { ...e, left: cfg.perWindow });
  }
  const out: Decision[] = [];
  // Deep work first: it needs the most quota, so it gets first pick of what is expiring.
  for (const effort of ["deep", "bau", "trivial"] as Effort[]) {
    for (const issue of open.filter(i => effortOf(i.labels) === effort)) {
      // Trivial work runs on Pi but needs a Sonnet/Sol reviewer, so it also draws on an expiring window.
      const pool = effort === "trivial" ? REVIEWERS : ROUTES[effort];
      const route = pool.find(r => { const w = room.get(r.provider); return !!w && w.left > 0 && (effort === "trivial" || !w.full); });
      if (!route) continue;
      const w = room.get(route.provider)!;
      w.left--;
      out.push({
        key: issueKey(issue), issue, effort,
        route: effort === "trivial" ? ROUTES.trivial[0] : route,
        window: { provider: route.provider, resetsAt: w.resetsAt, used: Math.round(w.used) },
        reason: effort === "trivial"
          ? `${route.provider} window ends in ${Math.round((w.resetsAt - input.now) / 60_000)} min at ${Math.round(w.used)}% used; reviewer ${route.model}`
          : `${route.provider} window ends in ${Math.round((w.resetsAt - input.now) / 60_000)} min at ${Math.round(w.used)}% used`,
      });
    }
  }
  return out;
}

/** Repos whose work is applied locally before it is pushed (issue #10); everything else, and all trivial work, goes through a PR. */
export const DIRECT_REPOS = ["agent-console", "dotfiles", "brain"];

const MAX_THREAD_TITLE = 30; // same width the sidebar shows for auto titles (issue #11: Android)
/** Short repo label for thread names: the name itself when short, else initials of a hyphenated name, else its first 10 characters. */
export function topicOf(repo: string): string {
  const name = repo.split("/")[1] ?? repo;
  if (name.length <= 10) return name;
  const initials = name.split(/[-_.]/).filter(Boolean).map(w => w[0]).join("");
  return initials.length >= 2 && initials.length <= 6 ? initials : name.slice(0, 10);
}

/** Thread name: `<repo>:<issue#> <short desc>`, at most 30 characters. Created as a user-chosen title, so the auto-namer and later renames never touch it. */
export function threadTitle(issue: Pick<Issue, "repo" | "number" | "title">): string {
  const prefix = `${topicOf(issue.repo)}:${issue.number} `;
  const room = Math.max(8, MAX_THREAD_TITLE - prefix.length);
  const words = issue.title.replace(/^\s*(?:\[[^\]]*\]|\w+:)\s*/, "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let desc = "";
  for (const w of words) { if ((desc + " " + w).trim().length > room) break; desc = (desc + " " + w).trim(); }
  return `${prefix}${desc || words[0]?.slice(0, room) || "issue"}`;
}

export function issuePrompt(d: Decision, branch: string, base: string): string {
  const { issue, effort } = d, repo = issue.repo.split("/")[1];
  const direct = effort !== "trivial" && DIRECT_REPOS.includes(repo);
  return [
    `Work GitHub issue ${issue.repo}#${issue.number}: ${issue.title}`,
    `Read it first: gh issue view ${issue.number} --repo ${issue.repo} --comments. The triage comment holds the book of work.`,
    `You are in your own git worktree on branch ${branch} (from ${base}). Never touch the main checkout.`,
    direct
      ? `When done and verified, commit, rebase onto origin/${base} and push to ${base}. Reference the issue (Refs #${issue.number}).`
      : `When done and verified, push the branch and open a pull request into ${base} that references the issue. Do not merge it.${effort === "trivial" ? " A Sonnet or Sol review must approve it before merge: say so in the PR body and stop." : ""}`,
    `Unattended run: do not ask questions. End with a short summary: what changed, how it was checked, what is left.`,
  ].join("\n\n");
}

export type IssueRun = { key: string; repo: string; number: number; effort: string; role: "work" | "review"; branch?: string; base?: string; pr?: number; reviewedAt?: number };
export interface IssueRunner {
  create(opts: { provider: string; model: string; effort: string; cwd: string; mode: "bypassPermissions"; title: string; issueRun: IssueRun }): { id: string };
  send(id: string, text: string): void;
}
/** Work that goes through a PR may not push to the default branch: the worktree's pre-push hook refuses it. */
export function installPrOnlyHook(cwd: string, base: string, git: (cwd: string, ...args: string[]) => string) {
  git(cwd, "config", "extensions.worktreeConfig", "true");
  const hooks = path.join(git(cwd, "rev-parse", "--absolute-git-dir"), "ac-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh
# agent-console: this worktree opens pull requests; it never pushes to ${base}.
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/${base}" ]; then
    echo "Blocked: push a branch and open a pull request; ${base} only changes by merged PR." >&2
    exit 1
  fi
done
exit 0
`, { mode: 0o755 });
  git(cwd, "config", "--worktree", "core.hooksPath", hooks);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "issue";

/** Start one decision: a worktree on a new branch, then a thread titled for the issue working in it. */
export function startIssue(d: Decision, runner: IssueRunner, dirs = { repos: path.join(os.homedir(), "repos"), worktrees: path.join(os.homedir(), "worktrees") }, git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 }).trim()) {
  const name = d.issue.repo.split("/")[1];
  const main = path.join(dirs.repos, name);
  if (!fs.existsSync(path.join(main, ".git"))) throw new Error(`No local checkout of ${d.issue.repo} at ${main}`);
  git(main, "fetch", "-q", "origin");
  const base = git(main, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
  const branch = `issue-${d.issue.number}-${slug(d.issue.title)}`;
  const cwd = path.join(dirs.worktrees, `${name}-issue-${d.issue.number}`);
  fs.mkdirSync(dirs.worktrees, { recursive: true });
  if (!fs.existsSync(cwd)) git(main, "worktree", "add", "-q", "-b", branch, cwd, `origin/${base}`);
  if (!(d.effort !== "trivial" && DIRECT_REPOS.includes(name))) installPrOnlyHook(cwd, base, git);
  const thread = runner.create({ ...d.route, cwd, mode: "bypassPermissions", title: threadTitle(d.issue), issueRun: { key: d.key, repo: d.issue.repo, number: d.issue.number, effort: d.effort, role: "work", branch, base } });
  runner.send(thread.id, issuePrompt(d, branch, base));
  return { thread: thread.id, cwd, branch };
}

export function loadConfig(file = path.join(DATA_DIR, "window-dispatch.json")): Config {
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const num = (v: unknown, d: number, min: number, max: number) => Number.isFinite(v) ? Math.min(max, Math.max(min, v as number)) : d;
  return {
    enabled: raw.enabled === true,
    dryRun: raw.dryRun !== false,
    leadMinutes: num(raw.leadMinutes, DEFAULTS.leadMinutes, 5, 300),
    maxUsedPct: num(raw.maxUsedPct, DEFAULTS.maxUsedPct, 1, 100),
    perWindow: num(raw.perWindow, DEFAULTS.perWindow, 1, 10),
    repos: Array.isArray(raw.repos) && raw.repos.every((r: unknown) => typeof r === "string" && /^[\w-]+\/(?!\.)[\w.-]+$/.test(r)) && raw.repos.length ? raw.repos : DEFAULTS.repos,
  };
}

export async function openIssues(repos: string[], github: GithubRequest = githubRequest): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const repo of repos) {
    const items = await github("GET", `repos/${repo}/issues?state=open&per_page=100`);
    if (!Array.isArray(items)) throw new Error("Invalid GitHub issues response");
    for (const i of items) {
      if (i.pull_request || !Number.isSafeInteger(i.number)) continue;
      out.push({ repo, number: i.number, title: String(i.title ?? ""), labels: (i.labels || []).map((l: any) => typeof l === "string" ? l : l?.name).filter(Boolean) });
    }
  }
  return out;
}

/** Append-only ledger: decisions and the keys they cover. Dry runs are logged but never block a later real run. */
export function createDispatcher(opts: { usage: () => Record<string, ProviderUsage>; github?: GithubRequest; dir?: string; now?: () => number; start?: (d: Decision) => Promise<void> | void }) {
  const dir = opts.dir ?? DATA_DIR;
  const ledger = path.join(dir, "window-dispatch.jsonl");
  const now = opts.now ?? Date.now;
  const read = () => { try { return fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  async function tick() {
    const cfg = loadConfig(path.join(dir, "window-dispatch.json"));
    if (!cfg.enabled) return [];
    const issues = await openIssues(cfg.repos, opts.github);
    const rows = read();
    const done = new Set<string>(rows.filter(r => !r.dryRun).map(r => r.key));
    const live = !cfg.dryRun && !!opts.start;
    const seen = new Set<string>(rows.filter(r => r.dryRun && r.window?.resetsAt).map(r => `${r.key}@${r.window.resetsAt}`));
    const decisions = plan({ now: now(), usage: opts.usage(), issues, done, cfg })
      .filter(d => live || !seen.has(`${d.key}@${d.window?.resetsAt}`));
    for (const d of decisions) {
      // Logged before the start so a crash cannot start the same issue twice; a failed start stays in the ledger with its error and is not retried.
      const row = { ts: now(), dryRun: !live, key: d.key, effort: d.effort, route: d.route, window: d.window, reason: d.reason };
      fs.appendFileSync(ledger, JSON.stringify(row) + "\n", { mode: 0o600 });
      if (!live) continue;
      try { await opts.start!(d); }
      catch (e: any) { fs.appendFileSync(ledger, JSON.stringify({ ...row, error: String(e?.message ?? e).slice(0, 300) }) + "\n", { mode: 0o600 }); }
    }
    return decisions;
  }
  return { tick };
}
