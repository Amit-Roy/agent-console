import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./auth.ts";
import type { EventLog } from "./automation/events.ts";
import { DIRECT_REPOS } from "./automation/policy.ts";
import { boundIssueLine, selfReviewBlock, skillDir } from "./automation/review-prompts.ts";
import { route as routeWork } from "./automation/router.ts";
import {
  EFFORT_LABELS,
  type GithubRequest,
  githubRequest,
  PRIORITY_LABELS,
} from "./github-triage.ts";
import { fitTitle, MAX_TITLE } from "./providers/title.ts";
import type { ProviderUsage, UsageWindow } from "./usage.ts";

export { DIRECT_REPOS };

// Subscription quota resets every 5 hours whether or not it was used. Near the end of a window, hand open issues to
// the provider whose quota would otherwise expire. This module only plans; `dryRun` (the default) never starts work.

export type Effort = "trivial" | "bau" | "deep";
export interface Route {
  provider: string;
  model: string;
  effort: string;
}
export interface Config {
  enabled: boolean; // false = plan and log only
  dryRun: boolean;
  leadMinutes: number; // assign only inside the last N minutes of a 5-hour window
  lowUsagePct: number; // a window used less than this opens earlier: more quota would otherwise expire
  lowUsageLeadMinutes: number; // lead time for such a window
  maxUsedPct: number; // skip a window that is already this full: nothing would be wasted
  perWindow: number; // issues handed to one provider per window
  repos: string[];
  routing: { mode: "shadow" | "live"; bauOnPi: boolean }; // shadow: the router only reports its choice; live: it decides. bauOnPi: BAU runs on Pi (turn on once BAU PRs are reviewed)
  authors: string[]; // only issues opened by these GitHub logins are dispatched: issue text steers an unattended agent
}
export interface Issue {
  repo: string;
  number: number;
  title: string;
  labels: string[];
}
export interface Decision {
  key: string;
  issue: Issue;
  effort: Effort;
  route: Route;
  premium?: boolean;
  window?: { provider: string; resetsAt: number; used: number };
  reason: string;
}

export const DEFAULTS: Config = {
  enabled: false,
  dryRun: true,
  leadMinutes: 90,
  lowUsagePct: 60,
  lowUsageLeadMinutes: 180,
  maxUsedPct: 90,
  perWindow: 2,
  repos: ["example-owner/agent-console"],
  authors: ["example-owner"],
  routing: { mode: "shadow", bauOnPi: false },
};

// Issue #10: BAU = Sonnet medium or Sol low; Deep = Opus medium or Sol high; Trivial = any cheap Pi model, reviewed by a better one.
export const ROUTES: Record<Effort, Route[]> = {
  deep: [
    { provider: "claude", model: "opus", effort: "medium" },
    { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
  ],
  bau: [
    { provider: "claude", model: "sonnet", effort: "medium" },
    { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
  ],
  trivial: [{ provider: "pi", model: "default", effort: "default" }],
};
// Spare premium slots (no Deep work left) run the next issue at low effort.
export const FILL: Route[] = [
  { provider: "claude", model: "sonnet", effort: "low" },
  { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
];
export const REVIEWERS: Route[] = [
  { provider: "claude", model: "sonnet", effort: "medium" },
  { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
];

export const issueKey = (i: Pick<Issue, "repo" | "number">) => `${i.repo}#${i.number}`;

export function effortOf(labels: string[]): Effort | undefined {
  const hit = (Object.entries(EFFORT_LABELS) as [Effort, string][]).filter(([, l]) =>
    labels.includes(l),
  );
  return hit.length === 1 ? hit[0][0] : undefined;
}
const rank = (labels: string[]) => {
  const i = Object.values(PRIORITY_LABELS).findIndex((l) => labels.includes(l));
  return i < 0 ? 9 : i;
};
const EFFORT_ORDER: Effort[] = ["deep", "bau", "trivial"];

export function fiveHour(
  u: ProviderUsage | undefined,
  now: number,
): (UsageWindow & { resetsAt: number }) | undefined {
  const w = u?.windows.find((x) => x.label === "5-hour" && x.resetsAt);
  return w && w.resetsAt! > now ? (w as UsageWindow & { resetsAt: number }) : undefined;
}

// A provider has expiring quota when its window ends within the lead time, longer for a window used below lowUsagePct.
// `full` marks a window at or above maxUsedPct: big work skips it, but trivial work (small, reviewed) does not need the room check.
export function expiring(u: ProviderUsage | undefined, now: number, cfg: Config) {
  const w = fiveHour(u, now);
  if (!w) return undefined;
  const pct = w.limit ? (w.used / w.limit) * 100 : 100;
  const lead =
    pct < cfg.lowUsagePct ? Math.max(cfg.leadMinutes, cfg.lowUsageLeadMinutes) : cfg.leadMinutes;
  if (w.resetsAt - now > lead * 60_000) return undefined;
  return { resetsAt: w.resetsAt, used: pct, full: pct >= cfg.maxUsedPct };
}

/** Pure: premium usage keys (claude, claude:<account>, codex) whose quota-paused threads may continue now. Same gate as Deep
 *  work: the 5-hour window is expiring and below maxUsedPct, and no window is still exhausted. */
export function resumeDue(
  usage: Record<string, ProviderUsage>,
  now: number,
  cfg: Config,
): string[] {
  return Object.entries(usage)
    .filter(([p, u]) => {
      if (
        !/^(claude|codex)(:|$)/.test(p) ||
        u.windows.some((w) => w.used >= w.limit && (!w.resetsAt || w.resetsAt > now))
      )
        return false;
      const e = expiring(u, now, cfg);
      return !!e && !e.full;
    })
    .map(([p]) => p);
}

type Room = Map<string, { resetsAt: number; used: number; full: boolean; left: number }>;

const minutesLeft = (window: { resetsAt: number }, nowMs: number) =>
  Math.round((window.resetsAt - nowMs) / 60_000);

function openIssuesByRank(input: { issues: Issue[]; done: Set<string> }): Issue[] {
  return input.issues
    .filter(
      (issue) =>
        !input.done.has(issueKey(issue)) &&
        !issue.labels.includes("manual") &&
        effortOf(issue.labels),
    )
    .sort(
      (first, second) => rank(first.labels) - rank(second.labels) || first.number - second.number,
    );
}

function buildRoom(usage: Record<string, ProviderUsage>, nowMs: number, cfg: Config): Room {
  const room: Room = new Map();
  for (const provider of ["claude", "codex"]) {
    const window = expiring(usage[provider], nowMs, cfg);
    if (window) room.set(provider, { ...window, left: cfg.perWindow });
  }
  return room;
}

// Deep work first: it needs the most quota, so it gets first pick of what is expiring.
// Premium slots left without Deep work take the next issue by priority, then effort. Work that would otherwise run on Pi
// gets the low-effort FILL routes; BAU kept off Pi keeps its own BAU route.
function planPremiumWindows(
  open: Issue[],
  room: Room,
  cfg: Config,
  nowMs: number,
  out: Decision[],
): Set<Issue> {
  const piWork = (effort: Effort) =>
    effort === "trivial" ||
    (effort === "bau" && cfg.routing.mode === "live" && cfg.routing.bauOnPi);
  const byPriority = open
    .filter((issue) => effortOf(issue.labels) !== "deep")
    .sort(
      (first, second) =>
        rank(first.labels) - rank(second.labels) ||
        EFFORT_ORDER.indexOf(effortOf(first.labels)!) -
          EFFORT_ORDER.indexOf(effortOf(second.labels)!) ||
        first.number - second.number,
    );
  const fill = new Set<Issue>();
  const deepIssues = open.filter((issue) => effortOf(issue.labels) === "deep");
  for (const issue of [...deepIssues, ...byPriority]) {
    const effort = effortOf(issue.labels)!;
    const pool = effort === "deep" ? ROUTES.deep : piWork(effort) ? FILL : ROUTES.bau;
    const route = pool.find((candidate) => {
      const window = room.get(candidate.provider);
      return !!window && window.left > 0 && !window.full;
    });
    if (!route) continue;
    const window = room.get(route.provider)!;
    window.left--;
    fill.add(issue);
    out.push({
      key: issueKey(issue),
      issue,
      effort,
      route,
      premium: pool === FILL,
      window: {
        provider: route.provider,
        resetsAt: window.resetsAt,
        used: Math.round(window.used),
      },
      reason: `${route.provider} window ends in ${minutesLeft(window, nowMs)} min at ${Math.round(window.used)}% used${effort === "deep" ? "" : "; no Deep work left"}`,
    });
  }
  return fill;
}

// Trivial work runs on Pi but needs a Sonnet/Sol reviewer, so it also draws on an expiring window, even a full one.
function planReviewedTrivial(issue: Issue, room: Room, nowMs: number, out: Decision[]) {
  const route = REVIEWERS.find((candidate) => {
    const window = room.get(candidate.provider);
    return !!window && window.left > 0;
  });
  if (!route) return;
  const window = room.get(route.provider)!;
  window.left--;
  out.push({
    key: issueKey(issue),
    issue,
    effort: "trivial",
    route: ROUTES.trivial[0],
    window: { provider: route.provider, resetsAt: window.resetsAt, used: Math.round(window.used) },
    reason: `${route.provider} window ends in ${minutesLeft(window, nowMs)} min at ${Math.round(window.used)}% used; reviewer ${route.model}`,
  });
}

function planRemainingIssue(
  issue: Issue,
  effort: Effort,
  ctx: { room: Room; cfg: Config; nowMs: number; piLeft: { count: number }; out: Decision[] },
) {
  // Live Pi workers use their own capacity; premium review can wait until the PR is ready.
  if (
    ctx.cfg.routing.mode === "live" &&
    (effort === "trivial" || (effort === "bau" && ctx.cfg.routing.bauOnPi))
  ) {
    if (ctx.piLeft.count-- > 0)
      ctx.out.push({
        key: issueKey(issue),
        issue,
        effort,
        route: ROUTES.trivial[0],
        reason: "Pi work is independent of premium reset windows",
      });
    return;
  }
  if (effort !== "trivial") return; // BAU had its premium chance above
  planReviewedTrivial(issue, ctx.room, ctx.nowMs, ctx.out);
}

/** Pure: which open issues to start now. `done` holds keys already assigned (any window). */
export function plan(input: {
  now: number;
  usage: Record<string, ProviderUsage>;
  issues: Issue[];
  done: Set<string>;
  cfg?: Partial<Config>;
}): Decision[] {
  const cfg = { ...DEFAULTS, ...input.cfg };
  const open = openIssuesByRank(input);
  const room = buildRoom(input.usage, input.now, cfg);
  const out: Decision[] = [];
  const fill = planPremiumWindows(open, room, cfg, input.now, out);
  const ctx = { room, cfg, nowMs: input.now, piLeft: { count: cfg.perWindow }, out };
  for (const effort of ["bau", "trivial"] as Effort[])
    for (const issue of open.filter(
      (candidate) => effortOf(candidate.labels) === effort && !fill.has(candidate),
    ))
      planRemainingIssue(issue, effort, ctx);
  return out;
}

/** Short repo label for thread names: the name itself when short, else initials of a hyphenated name, else its first 10 characters. */
export function topicOf(repo: string): string {
  const name = repo.split("/")[1] ?? repo;
  if (name.length <= 10) return name;
  const initials = name
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  return initials.length >= 2 && initials.length <= 6 ? initials : name.slice(0, 10);
}

/** Thread name: `<repo>:<issue#> <short desc>`, at most 20 characters. Created as a user-chosen title, so the auto-namer and later renames never touch it. */
export function threadTitle(issue: Pick<Issue, "repo" | "number" | "title">): string {
  const text =
    issue.title
      .replace(/^\s*(?:\[[^\]]*\]|\w+:)\s*/, "")
      .replace(/\s+/g, " ")
      .trim() || "issue";
  let topic = Array.from(topicOf(issue.repo))
    .slice(0, Math.max(1, MAX_TITLE - String(issue.number).length - 7))
    .join("");
  // Reserve a short description in both budgets, even for wide repository names.
  const sample = Array.from(text).slice(0, 5).join("").trimEnd();
  let prefix = `${topic}:${issue.number} `;
  while (
    Array.from(topic).length > 1 &&
    fitTitle({ prefix, text: sample }).title !== prefix + sample
  ) {
    topic = Array.from(topic).slice(0, -1).join("");
    prefix = `${topic}:${issue.number} `;
  }
  return fitTitle({ prefix, text }).title;
}

function evidenceGuardBlock(repo: string): string {
  return [
    `PR evidence: before gh pr create, read /home/coder/repos/brain/skills/pr-evidence/SKILL.md and build the body with the tools it names. Check the exact body with pr-evidence-guard validate-body <body-file> before each gh pr create.`,
    `If the guard rejects the body twice, stop retrying. Fix nothing more: open the PR with gh pr create --draft --repo ${repo} using the best body you have, then add the guard's error text with gh pr comment so a reviewer sees what is missing. Never bypass the guard with APIs or scripts. Never end the run without an open PR.`,
  ].join("\n");
}

export function issuePrompt(d: Decision, branch: string, base: string): string {
  const { issue, effort } = d,
    repo = issue.repo.split("/")[1];
  const direct = effort === "deep" && DIRECT_REPOS.includes(repo);
  return [
    `Work GitHub issue ${issue.repo}#${issue.number}: ${issue.title}`,
    `Read it first: gh issue view ${issue.number} --repo ${issue.repo} --comments. The triage comment holds the book of work.`,
    boundIssueLine(issue.repo, issue.number),
    `List every acceptance criterion from the issue and the triage comment. The job is done only when each acceptance criterion is met and checked with evidence (a test, command output, a measurement, or a screenshot). Do not stop at a partial slice.`,
    `If an acceptance criterion truly cannot be done in this run (it needs another repository, a manual human step, or a measurement only possible after deploy), open a follow-up issue for exactly that part with gh issue create --repo ${issue.repo} and link it, instead of leaving it silent.`,
    `You are in your own private Git checkout on branch ${branch} (from ${base}). Never touch the main checkout.`,
    direct
      ? `When done and verified, commit, rebase onto origin/${base} and push to ${base}. Put \`Closes #${issue.number}\` in the commit message only when every acceptance criterion is met; otherwise put \`Refs #${issue.number}\` plus the follow-up issue links.`
      : `When done and verified, push the branch and open a pull request into ${base} that references the issue. The PR body must contain \`Closes #${issue.number}\` only when every acceptance criterion is met; otherwise it must contain \`Refs #${issue.number}\` plus the follow-up issue links. Do not merge it.${effort !== "deep" ? " A Sonnet or Sol review must approve it before merge: say so in the PR body and stop." : ""}`,
    selfReviewBlock(skillDir(), base),
    ...(direct ? [] : [evidenceGuardBlock(issue.repo)]),
    `Unattended run: do not ask questions. End with a short summary: what changed, how it was checked, a checklist of each acceptance criterion with its evidence, and any follow-up issue links.`,
  ].join("\n\n");
}

export type IssueRun = {
  key: string;
  repo: string;
  number: number;
  effort: string;
  role: "work" | "review" | "debug";
  branch?: string;
  base?: string;
  pr?: number;
  reviewedAt?: number;
  finishedAt?: number;
  premiumAssignment?: boolean; // Explicit premium owner started through the issue dialog.
  recoveries?: number; // Bounded resumptions of incomplete worker turns, preserved across restarts.
  retryAttempts?: number; // Delivered retries, including infrastructure retries that do not spend task budget.
  workerError?: string; // Redacted error from the latest worker turn, used as retry context.
  infrastructure?: boolean; // The latest failed turn needs another approved model, without spending task budget.
  premiumPending?: number; // Exhausted worker queued for the premium assigner, independently of the dispatch ledger.
  premiumThread?: string; // Durable assignment receipt; prevents another premium dispatch after restart.
  retryAt?: number; // Earliest time another worker recovery may start.
  rerouted?: boolean; // work: its recoveries were reset once because its Pi model was retired upstream
  stalled?: number; // Work: recoveries ran out; eligible for premium re-dispatch.
  missingPr?: number; // work: when "no open PR" was logged, so a restart does not log it again
  reviews?: number; // Reserved review slots; attempts without a verdict return their slot after a cooldown.
  reviewThread?: string; // Work: the reviewer holding its current slot; rejects late refunds from older reviewers.
  takeover?: boolean; // Review: the final slot owns fixes, final review, and merge instead of another worker redo.
  redoing?: boolean; // work: the worker is fixing review findings
  nudges?: number; // work: times the worker was asked to push because the PR had no commit after the last verdict
  worker?: string; // review: the worker thread whose PR this reviews
  startedAt?: number; // review: when the reviewer started; its verdict comment is newer
  verdictAfter?: number; // Review: only comments created after this existing GitHub comment ID belong to this attempt.
  outcome?: string; // review: set once the end of the reviewer's turn has been judged
};
export interface IssueRunner {
  create(opts: {
    provider: string;
    model: string;
    effort: string;
    cwd: string;
    mode: "bypassPermissions";
    title: string;
    issueRun: IssueRun;
  }): { id: string };
  send(id: string, text: string): void;
}
/** Work that goes through a PR may not push to the default branch: the worktree's pre-push hook refuses it. */
export async function installPrOnlyHook(cwd: string, base: string, git: Git) {
  await git(cwd, "config", "extensions.worktreeConfig", "true");
  const hooks = path.join(await git(cwd, "rev-parse", "--absolute-git-dir"), "ac-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(
    path.join(hooks, "pre-push"),
    `#!/bin/sh
# agent-console: this worktree opens pull requests; it never pushes to ${base}.
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/${base}" ]; then
    echo "Blocked: push a branch and open a pull request; ${base} only changes by merged PR." >&2
    exit 1
  fi
done
exit 0
`,
    { mode: 0o755 },
  );
  await git(cwd, "config", "--worktree", "core.hooksPath", hooks);
}
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "issue";

// Async: clones and fetches take tens of seconds, and a synchronous call would freeze every request and stream on the server.
export type Git = (cwd: string, ...args: string[]) => string | Promise<string>;
const run = promisify(execFile);
export const defaultGit = async (cwd: string, ...args: string[]) =>
  (
    await run("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 << 20,
    })
  ).stdout.trim();
export const defaultDirs = () => ({
  repos: process.env.AGENT_CONSOLE_REPOS || path.join(os.homedir(), "repos"),
  worktrees: process.env.AGENT_CONSOLE_WORKTREES || path.join(os.homedir(), "worktrees"),
});

type CheckoutContext = { git: Git; cwd: string; branch: string; remote: string };

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

async function verifyPrivateCheckout(ctx: CheckoutContext, checkBranch = true) {
  const { git, cwd } = ctx;
  const metadata = path.join(cwd, ".git");
  if (
    fs.lstatSync(cwd).isSymbolicLink() ||
    !fs.lstatSync(metadata).isDirectory() ||
    fs.lstatSync(metadata).isSymbolicLink()
  )
    throw new Error(`Refusing non-private checkout at ${cwd}`);
  if (
    fs.realpathSync(await git(cwd, "rev-parse", "--show-toplevel")) !== cwd ||
    fs.realpathSync(await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")) !==
      metadata
  )
    throw new Error(`Refusing shared Git metadata at ${cwd}`);
  if (
    (checkBranch && (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")) !== ctx.branch) ||
    (await git(cwd, "remote", "get-url", "origin")) !== ctx.remote
  )
    throw new Error(`Refusing stale checkout at ${cwd}`);
}

async function cloneCheckout(ctx: CheckoutContext, main: string, base: string) {
  const { git, cwd } = ctx;
  // Transport cloning copies committed objects only, with no hardlinks or alternates to the live repository.
  // Only the default branch is copied: local agent branches would drag their whole history into every clone.
  await git(
    main,
    "clone",
    "-q",
    "--no-local",
    "--no-hardlinks",
    "--no-checkout",
    "--single-branch",
    "--branch",
    base,
    main,
    cwd,
  );
  try {
    await git(cwd, "remote", "set-url", "origin", ctx.remote);
    await git(cwd, "remote", "set-branches", "origin", "*");
    await git(cwd, "fetch", "-q", "origin");
    await git(cwd, "checkout", "-q", "-b", ctx.branch, `origin/${base}`);
    await verifyPrivateCheckout(ctx);
  } catch (error) {
    fs.rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

async function reuseCheckout(ctx: CheckoutContext) {
  try {
    await verifyPrivateCheckout(ctx);
  } catch (error: any) {
    throw new Error(`Refusing existing checkout: ${error.message}`);
  }
}

function claimCheckoutMarker(cwd: string, exists: boolean) {
  const marker = path.join(cwd, ".git", "agent-console-auto");
  if (!exists) fs.writeFileSync(marker, "private-checkout-v1\n", { mode: 0o600, flag: "wx" });
  else if (
    !fs.lstatSync(marker).isFile() ||
    fs.lstatSync(marker).isSymbolicLink() ||
    fs.readFileSync(marker, "utf8") !== "private-checkout-v1\n"
  )
    throw new Error("Refusing unowned private checkout");
}

/** Create a private clone with its own Git metadata. Shared worktrees are never reused. */
export async function addWorktree(o: {
  repo: string;
  dirs: { repos: string; worktrees: string };
  dirName: string;
  branch: string;
  git?: Git;
  step?: (id: "fetch" | "clone") => void;
}) {
  const git = o.git ?? defaultGit;
  const main = path.join(o.dirs.repos, o.repo);
  if (!fs.existsSync(path.join(main, ".git")))
    throw new Error(`No local checkout of ${o.repo} at ${main}`);
  if (path.basename(o.dirName) !== o.dirName || o.dirName === "." || o.dirName === "..")
    throw new Error("Invalid private checkout name");
  o.step?.("fetch");
  await git(main, "fetch", "-q", "origin");
  const base = (await git(main, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(
    /^origin\//,
    "",
  );
  const remote = await git(main, "remote", "get-url", "origin");
  o.step?.("clone");
  fs.mkdirSync(o.dirs.worktrees, { recursive: true });
  const cwd = path.join(fs.realpathSync(o.dirs.worktrees), o.dirName);
  const exists = pathExists(cwd);
  const ctx: CheckoutContext = { git, cwd, branch: o.branch, remote };
  if (exists) await reuseCheckout(ctx);
  else await cloneCheckout(ctx, main, base);
  claimCheckoutMarker(cwd, exists);
  const created = !exists;
  return {
    cwd,
    base,
    branch: o.branch,
    created,
    remove: async () => {
      if (!created) return;
      try {
        await verifyPrivateCheckout(ctx, false);
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Start one decision: a worktree on a new branch, then a thread titled for the issue working in it. */
export async function startIssue(
  d: Decision,
  runner: IssueRunner,
  dirs = defaultDirs(),
  git: Git = defaultGit,
) {
  const name = d.issue.repo.split("/")[1];
  const attempt = randomUUID().slice(0, 8);
  const { cwd, base, branch } = await addWorktree({
    repo: name,
    dirs,
    dirName: `${name}-issue-${d.issue.number}-${attempt}`,
    branch: `issue-${d.issue.number}-${slug(d.issue.title)}-${attempt}`,
    git,
  });
  if (!(d.effort === "deep" && DIRECT_REPOS.includes(name)))
    await installPrOnlyHook(cwd, base, git);
  const thread = runner.create({
    ...d.route,
    cwd,
    mode: "bypassPermissions",
    title: threadTitle(d.issue),
    issueRun: {
      key: d.key,
      repo: d.issue.repo,
      number: d.issue.number,
      effort: d.effort,
      role: "work",
      branch,
      base,
    },
  });
  runner.send(thread.id, issuePrompt(d, branch, base));
  return { thread: thread.id, cwd, branch };
}

export function loadConfig(file = path.join(DATA_DIR, "window-dispatch.json")): Config {
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const num = (v: unknown, d: number, min: number, max: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v as number)) : d;
  return {
    enabled: raw.enabled === true,
    dryRun: raw.dryRun !== false,
    leadMinutes: num(raw.leadMinutes, DEFAULTS.leadMinutes, 5, 300),
    lowUsagePct: num(raw.lowUsagePct, DEFAULTS.lowUsagePct, 0, 100),
    lowUsageLeadMinutes: num(raw.lowUsageLeadMinutes, DEFAULTS.lowUsageLeadMinutes, 5, 300),
    maxUsedPct: num(raw.maxUsedPct, DEFAULTS.maxUsedPct, 1, 100),
    perWindow: num(raw.perWindow, DEFAULTS.perWindow, 1, 10),
    routing: {
      mode: raw.routing?.mode === "live" ? "live" : "shadow",
      bauOnPi: raw.routing?.bauOnPi === true,
    },
    authors:
      Array.isArray(raw.authors) &&
      raw.authors.length &&
      raw.authors.every((a: unknown) => typeof a === "string" && /^[\w-]{1,39}$/.test(a))
        ? raw.authors
        : DEFAULTS.authors,
    repos:
      Array.isArray(raw.repos) &&
      raw.repos.every((r: unknown) => typeof r === "string" && /^[\w-]+\/(?!\.)[\w.-]+$/.test(r)) &&
      raw.repos.length
        ? raw.repos
        : DEFAULTS.repos,
  };
}

export async function openIssues(
  repos: string[],
  github: GithubRequest = githubRequest,
  authors: string[] = DEFAULTS.authors,
): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const repo of repos) {
    const items = await github("GET", `repos/${repo}/issues?state=open&per_page=100`);
    if (!Array.isArray(items)) throw new Error("Invalid GitHub issues response");
    for (const i of items) {
      if (i.pull_request || !Number.isSafeInteger(i.number) || !authors.includes(i.user?.login))
        continue;
      out.push({
        repo,
        number: i.number,
        title: String(i.title ?? ""),
        labels: (i.labels || [])
          .map((l: any) => (typeof l === "string" ? l : l?.name))
          .filter(Boolean),
      });
    }
  }
  return out;
}

type DispatcherOptions = {
  usage: () => Record<string, ProviderUsage>;
  github?: GithubRequest;
  dir?: string;
  now?: () => number;
  start?: (d: Decision) => Promise<{ thread?: string } | void> | { thread?: string } | void;
  events?: EventLog;
  active?: () => { provider: string; role: string }[];
  failures?: () => Record<string, number>;
};
type DispatcherContext = {
  opts: DispatcherOptions;
  dir: string;
  ledger: string;
  now: () => number;
};

function readLedger(ctx: DispatcherContext): any[] {
  try {
    return fs
      .readFileSync(ctx.ledger, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const appendLedger = (ctx: DispatcherContext, row: object) =>
  fs.appendFileSync(ctx.ledger, JSON.stringify(row) + "\n", { mode: 0o600 });

// Shadow-routes one planned decision; in live mode the router may defer it or replace its route.
function applyRouter(
  ctx: DispatcherContext,
  cfg: Config,
  decision: Decision,
  active: { provider: string; role: string }[],
) {
  const routed = routeWork({
    role: "work",
    effort: decision.effort,
    premium: decision.premium,
    usage: ctx.opts.usage(),
    active,
    now: ctx.now(),
    flags: { bauOnPi: cfg.routing.bauOnPi },
    failures: ctx.opts.failures?.(),
  });
  const shadow = { decision: routed.decision, route: routed.route, why: routed.why };
  ctx.opts.events?.record({
    step: "router",
    kind: routed.decision === "defer" ? "info" : "ok",
    ref: decision.key,
    msg: `${cfg.routing.mode}: ${routed.decision}${routed.route ? ` ${routed.route.provider}/${routed.route.model}` : ""} — ${routed.why}`,
    data: { legacy: decision.route, router: routed.route },
  });
  let picked = decision;
  if (cfg.routing.mode === "live" && routed.decision === "route") {
    picked = { ...decision, route: routed.route! };
    active.push({ provider: picked.route.provider, role: "work" });
  }
  const deferred = cfg.routing.mode === "live" && routed.decision === "defer";
  return { picked, shadow, deferred };
}

async function startDecisionLive(ctx: DispatcherContext, decision: Decision, row: object) {
  const events = ctx.opts.events;
  const worktreeRun = `worktree:${decision.key}`;
  events?.record({ step: "worktree", kind: "start", run: worktreeRun, ref: decision.key });
  try {
    const started = await ctx.opts.start!(decision);
    events?.record({ step: "worktree", kind: "ok", run: worktreeRun, ref: decision.key });
    events?.record({
      step: "worker",
      kind: "start",
      run: `work:${(started as any)?.thread ?? decision.key}`,
      ref: decision.key,
      msg: `${decision.route.provider}/${decision.route.model}`,
      data: { thread: (started as any)?.thread },
    });
  } catch (error: any) {
    const message = String(error?.message ?? error).slice(0, 300);
    appendLedger(ctx, { ...row, error: message });
    events?.record({
      step: "worktree",
      kind: "fail",
      run: worktreeRun,
      ref: decision.key,
      msg: message,
    });
  }
}

async function dispatchPlanned(
  ctx: DispatcherContext,
  cfg: Config,
  planned: Decision[],
  live: boolean,
) {
  const picked: Decision[] = [];
  let deferred = 0;
  const active = [...(ctx.opts.active?.() ?? [])];
  for (const decision of planned) {
    const routed = applyRouter(ctx, cfg, decision, active);
    if (routed.deferred) {
      deferred++;
      continue; // not marked done: the next tick tries again
    }
    const chosen = routed.picked;
    picked.push(chosen);
    // Logged before the start so a crash cannot start the same issue twice; a failed start stays in the ledger with its error and is not retried.
    const row = {
      ts: ctx.now(),
      dryRun: !live,
      key: chosen.key,
      effort: chosen.effort,
      route: chosen.route,
      window: chosen.window,
      reason: chosen.reason,
      shadow: routed.shadow,
    };
    appendLedger(ctx, row);
    if (live) await startDecisionLive(ctx, chosen, row);
  }
  return { picked, deferred };
}

function summaryMessage(cfg: Config, pickedCount: number, deferred: number): string {
  return `picked ${pickedCount}${deferred ? `, deferred ${deferred}` : ""}${pickedCount || deferred ? "" : ` (no eligible Pi work or premium window in its last ${cfg.leadMinutes} min, or ${cfg.lowUsageLeadMinutes} min below ${cfg.lowUsagePct}% used, with room)`}`;
}

async function dispatchTick(ctx: DispatcherContext) {
  const cfg = loadConfig(path.join(ctx.dir, "window-dispatch.json"));
  if (!cfg.enabled) return [];
  const events = ctx.opts.events;
  const run = `tick:${ctx.now()}`;
  events?.record({ step: "dispatcher", kind: "start", run, msg: "tick" });
  try {
    const issues = await openIssues(cfg.repos, ctx.opts.github, cfg.authors);
    const rows = readLedger(ctx);
    const done = new Set<string>(rows.filter((row) => !row.dryRun).map((row) => row.key));
    const live = !cfg.dryRun && !!ctx.opts.start;
    const seen = new Set<string>(
      rows.filter((row) => row.dryRun).map((row) => `${row.key}@${row.window?.resetsAt}`),
    );
    const planned = plan({ now: ctx.now(), usage: ctx.opts.usage(), issues, done, cfg }).filter(
      (decision) => live || !seen.has(`${decision.key}@${decision.window?.resetsAt}`),
    );
    const { picked, deferred } = await dispatchPlanned(ctx, cfg, planned, live);
    events?.record({
      step: "dispatcher",
      kind: "ok",
      run,
      msg: summaryMessage(cfg, picked.length, deferred),
    });
    return picked;
  } catch (error: any) {
    events?.record({ step: "dispatcher", kind: "fail", run, msg: String(error?.message ?? error) });
    throw error;
  }
}

/** Append-only ledger: decisions and the keys they cover. Dry runs are logged but never block a later real run. */
export function createDispatcher(opts: DispatcherOptions) {
  const dir = opts.dir ?? DATA_DIR;
  const ctx: DispatcherContext = {
    opts,
    dir,
    ledger: path.join(dir, "window-dispatch.jsonl"),
    now: opts.now ?? Date.now,
  };
  return { tick: () => dispatchTick(ctx) };
}
