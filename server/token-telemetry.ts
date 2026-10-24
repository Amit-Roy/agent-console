import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { accountingSamples } from "./accounting-log.ts";
import { type GithubRequest, githubRequest } from "./github-triage.ts";
import { raisedItems } from "./session-prs.ts";
import { safeTriageText } from "./triage-comment.ts";

export const TELEMETRY_MARKER = "<!-- agent-console-telemetry -->";
export const TELEMETRY_VERSION = 1;
export const TELEMETRY_VERSION_MARKER = `<!-- agent-console-telemetry-version:${TELEMETRY_VERSION} -->`;
export const NO_USAGE_TEXT = "No agent usage recorded.";
const MAX_REFS = 5;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---- Linkage: one function decides which GitHub items a thread belongs to. ----
export type ThreadFacts = {
  id: string;
  issueRun?: { repo: string; number: number; branch?: string; pr?: number };
  branch?: string; // git branch checked out in the thread's cwd (manual threads)
  defaultRepo?: string; // owner/name of the cwd's origin; resolves bare #n
  texts?: string[]; // user messages
  raised?: { repo: string; number: number }[]; // PRs and issues the thread opened with `gh pr create` / `gh issue create`, from its log
};
export type LinkItem = { repo: string; number: number; head?: string };
export type LinkRequest = {
  version?: number;
  thread: ThreadFacts;
  repos: string[];
  item?: LinkItem;
};
export type LinkResponse = {
  version: 1;
  items: { repo: string; number: number; via: "issue-run" | "pr-run" | "reference" | "raised" }[];
  linked: boolean;
  branch?: string;
};

const NOT_A_FEATURE_BRANCH = new Set(["main", "master", "HEAD", "develop"]);

type LinkVia = LinkResponse["items"][number]["via"];
type LinkCollector = { allowed: Set<string>; items: LinkResponse["items"] };
const GITHUB_URL_REF =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d{1,9})(?![\d])/g;
const BARE_REF = /(?<![\w/&#])#(\d{1,9})(?!\w)/g;

function addLinkItem(collector: LinkCollector, repo: unknown, number: unknown, via: LinkVia) {
  if (
    typeof repo !== "string" ||
    !collector.allowed.has(repo) ||
    !Number.isSafeInteger(number) ||
    (number as number) <= 0
  )
    return;
  if (!collector.items.some((entry) => entry.repo === repo && entry.number === number))
    collector.items.push({ repo, number: number as number, via });
}

function referencesIn(facts: ThreadFacts) {
  const refs: { repo: string; number: number }[] = [];
  const texts = Array.isArray(facts.texts)
    ? facts.texts.filter((text) => typeof text === "string")
    : [];
  for (const text of texts) {
    for (const match of text.matchAll(GITHUB_URL_REF))
      refs.push({ repo: match[1], number: Number(match[2]) });
    if (typeof facts.defaultRepo === "string")
      for (const match of text.matchAll(BARE_REF))
        refs.push({ repo: facts.defaultRepo, number: Number(match[1]) });
  }
  return refs;
}

function itemLinked(
  collector: LinkCollector,
  item: LinkItem | undefined,
  branch: string | undefined,
) {
  if (!item || !collector.allowed.has(item.repo)) return false;
  return (
    collector.items.some((entry) => entry.repo === item.repo && entry.number === item.number) ||
    (typeof item.head === "string" &&
      !!branch &&
      !NOT_A_FEATURE_BRANCH.has(branch) &&
      item.head === branch)
  );
}

/**
 * Rules, in order: (1) automation IssueRun gives its issue and PR; (2) `#n` (default repo) or a github.com issue/pull URL in
 * user messages, at most five, allowlisted repos only; (3) with `item` given, a thread branch equal to the PR head ref (never
 * main/master); (4) PRs and issues the thread itself opened with `gh pr create` or `gh issue create`, whatever directory or worktree it ran in. Tolerant: unknown request fields and malformed facts are ignored.
 */
export function linkThread(req: LinkRequest): LinkResponse {
  const allowed = new Set(
    (Array.isArray(req?.repos) ? req.repos : []).filter(
      (repo) => typeof repo === "string" && REPO.test(repo),
    ),
  );
  const facts = req?.thread ?? ({} as ThreadFacts);
  const collector: LinkCollector = { allowed, items: [] };
  const run = facts.issueRun;
  if (run) {
    addLinkItem(collector, run.repo, run.number, "issue-run");
    addLinkItem(collector, run.repo, run.pr, "pr-run");
  }
  for (const ref of referencesIn(facts).slice(0, MAX_REFS))
    addLinkItem(collector, ref.repo, ref.number, "reference");
  for (const pr of Array.isArray(facts.raised) ? facts.raised.slice(0, 20) : [])
    addLinkItem(collector, pr?.repo, pr?.number, "raised");
  const branch =
    typeof facts.branch === "string" && !NOT_A_FEATURE_BRANCH.has(facts.branch)
      ? facts.branch
      : run?.branch;
  const linked = itemLinked(collector, req?.item, branch);
  return { version: 1, items: collector.items, linked, ...(branch ? { branch } : {}) };
}

// ---- Rendering ----
export type TelemetryRun = {
  thread: string;
  title?: string;
  provider: string;
  model?: string;
  createdAt?: number;
  samples: ReturnType<typeof accountingSamples> | null; // null: no log to read
};
export type RenderRequest = {
  version?: number;
  repo?: string;
  number?: number;
  runs: TelemetryRun[];
};
export type RenderResponse = { version: 1; body: string; measured: boolean };

const fmt = (n: number) => n.toLocaleString("en-US");
type Sum = { input: number; cached: number; output: number; turns: number; measuredTurns: number };
type Sample = ReturnType<typeof accountingSamples>[number];
const counter = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const hasTokens = (sample: Sample | undefined) =>
  counter(sample?.in) != null && counter(sample?.out) != null;
function summarize(samples: TelemetryRun["samples"]): Sum {
  const s: Sum = { input: 0, cached: 0, output: 0, turns: 0, measuredTurns: 0 };
  for (const sample of samples ?? []) {
    s.turns++;
    if (typeof sample.in !== "number" || typeof sample.out !== "number") continue; // never guess a missing side
    s.measuredTurns++;
    s.input += sample.in;
    s.output += sample.out;
    s.cached += typeof sample.cache === "number" ? sample.cache : 0;
  }
  return s;
}

export function renderTelemetry(req: RenderRequest): RenderResponse {
  const runs = Array.isArray(req?.runs)
    ? req.runs.filter((r) => r && typeof r.thread === "string")
    : [];
  const head = [TELEMETRY_MARKER, TELEMETRY_VERSION_MARKER, "", "### Agent token usage", ""];
  if (!runs.length)
    return { version: 1, body: [...head, NO_USAGE_TEXT].join("\n"), measured: false };
  const lines = [
    ...head,
    "| Thread | Provider | Model | Input | Cached input | Output | Turns |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  const total: Sum = { input: 0, cached: 0, output: 0, turns: 0, measuredTurns: 0 };
  let measured = false;
  for (const run of runs) {
    const s = summarize(run.samples);
    const label = safeTriageText(
      run.title ? `${run.title} (${run.thread.slice(0, 8)})` : run.thread.slice(0, 8),
    );
    const cells =
      s.measuredTurns === 0
        ? ["unmeasured", "unmeasured", "unmeasured"]
        : [fmt(s.input), fmt(s.cached), fmt(s.output)];
    const turns =
      s.measuredTurns === s.turns
        ? String(s.turns)
        : `${s.turns} (${s.turns - s.measuredTurns} unmeasured)`;
    lines.push(
      `| ${label} | ${safeTriageText(run.provider)} | ${safeTriageText(run.model ?? "unknown")} | ${cells.join(" | ")} | ${turns} |`,
    );
    if (s.measuredTurns) measured = true;
    for (const k of ["input", "cached", "output", "turns", "measuredTurns"] as const)
      total[k] += s[k];
  }
  const cells = measured
    ? [fmt(total.input), fmt(total.cached), fmt(total.output)]
    : ["unmeasured", "unmeasured", "unmeasured"];
  lines.push(
    `| **Total** | | | ${cells.join(" | ")} | ${total.turns} |`,
    "",
    "Input includes cached input. Counts are provider-reported; turns without telemetry are marked unmeasured and excluded from sums.",
  );
  return { version: 1, body: lines.join("\n"), measured };
}

// ---- Upsert service ----
export type TelemetryOptions = {
  repos: () => string[];
  dataDir: string;
  github?: GithubRequest;
  threads?: () => (ThreadFacts & {
    provider: string;
    model?: string;
    title?: string;
    createdAt?: number;
    cwd?: string;
    archived?: number;
  })[];
  git?: (cwd: string, ...args: string[]) => Promise<string>;
  debounceMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

const defaultGit = (cwd: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (e, out) =>
      e ? reject(e) : resolve(out.trim()),
    ),
  );

export function parseRemote(url: string): string | undefined {
  return /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

// Log the failure class only: GitHub and git messages can echo request details.
const why = (e: unknown) =>
  (e as any)?.status ? `http ${(e as any).status}` : String((e as any)?.name ?? "Error");

type TelemetryThread = ReturnType<NonNullable<TelemetryOptions["threads"]>>[number];
type LogScan = {
  size: number;
  mtimeMs: number;
  texts: string[];
  raised: ThreadFacts["raised"];
  samples?: ReturnType<typeof accountingSamples>;
};
type GitInfo = { branch: string; defaultRepo?: string };
type TelemetryContext = {
  options: TelemetryOptions;
  github: GithubRequest;
  git: (cwd: string, ...args: string[]) => Promise<string>;
  delay: number;
  threads: () => TelemetryThread[];
  // Logs are append-only: a log whose size and mtime are unchanged yields the same facts and samples, so scan it once.
  scans: Map<string, LogScan>;
  actor: Promise<string> | undefined;
  gitInfo: Map<string, { at: number; info: Promise<GitInfo | undefined> }>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  pending: Set<Promise<unknown>>;
};

function telemetryLog(
  context: TelemetryContext,
  event: string,
  fields: Record<string, unknown> = {},
) {
  try {
    context.options.log?.(event, fields);
  } catch {}
}
function readThreadLog(context: TelemetryContext, id: string) {
  try {
    return fs.readFileSync(path.join(context.options.dataDir, "logs", `${id}.jsonl`), "utf8");
  } catch {
    return null;
  }
}
function ledgerSample(row: any): Sample | undefined {
  if (
    row.accounting !== 2 ||
    row.provider !== "codex" ||
    typeof row.thread !== "string" ||
    !Number.isFinite(row.ts)
  )
    return undefined;
  return {
    ts: row.ts,
    accounting: 2,
    in: counter(row.in),
    out: counter(row.out),
    cache: counter(row.cache),
  };
}
// App-server usage reaches the turn ledger without being written to the conversation log.
function codexLedger(context: TelemetryContext) {
  const ledger = new Map<string, Map<number, Sample>>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(context.options.dataDir, "turns.jsonl"), "utf8");
  } catch {
    return ledger;
  }
  for (const line of raw.split("\n")) {
    try {
      const row = JSON.parse(line);
      const sample = ledgerSample(row);
      if (!sample) continue;
      const turns = ledger.get(row.thread) ?? new Map<number, Sample>();
      if (hasTokens(sample) || !hasTokens(turns.get(row.ts))) turns.set(row.ts, sample);
      ledger.set(row.thread, turns);
    } catch {} // An incomplete append must not hide earlier completed turns.
  }
  return ledger;
}
function userTexts(raw: string) {
  const texts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"user_input"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "user_input" && typeof event.text === "string")
        texts.push(event.text.slice(0, 4000));
    } catch {}
  }
  return texts;
}
function scanLog(context: TelemetryContext, id: string): LogScan | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(context.options.dataDir, "logs", `${id}.jsonl`));
  } catch {
    context.scans.delete(id);
    return null;
  }
  const hit = context.scans.get(id);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit;
  const raw = readThreadLog(context, id);
  if (raw == null) {
    context.scans.delete(id);
    return null;
  }
  const scan = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    texts: userTexts(raw),
    raised: raisedItems(raw),
  };
  context.scans.set(id, scan);
  return scan;
}
function githubLogin(context: TelemetryContext) {
  context.actor ??= context
    .github("GET", "user")
    .then((user) => {
      if (typeof user?.login !== "string" || !user.login) throw new Error("Missing GitHub actor");
      return user.login;
    })
    .catch((error) => {
      context.actor = undefined;
      throw error;
    });
  return context.actor;
}
async function findComment(context: TelemetryContext, repo: string, number: number) {
  const me = await githubLogin(context);
  for (let page = 1; page <= 20; page++) {
    const comments = await context.github(
      "GET",
      `repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(comments)) throw new Error("Invalid GitHub comments response");
    const hit = comments.find(
      (comment) =>
        comment.user?.login === me &&
        typeof comment.body === "string" &&
        comment.body.split("\n")[0] === TELEMETRY_MARKER &&
        Number.isSafeInteger(comment.id),
    );
    if (hit) return hit;
    if (comments.length < 100) return undefined;
  }
  throw new Error("Too many comments to locate telemetry comment");
}
function factsOf(context: TelemetryContext, thread: TelemetryThread): ThreadFacts {
  const scan = scanLog(context, thread.id);
  return {
    id: thread.id,
    issueRun: thread.issueRun,
    branch: thread.branch,
    defaultRepo: thread.defaultRepo,
    texts: scan?.texts ?? [],
    raised: scan?.raised ?? [],
  };
}
// Branch and origin repo come from git in the thread's cwd; both are best effort.
// Many threads share a cwd, and forking git from this process is costly: cache per cwd, refresh when a turn ends there.
async function enrich(context: TelemetryContext, thread: TelemetryThread, fresh = false) {
  if (!thread.cwd || thread.issueRun) return thread;
  const { cwd } = thread;
  let hit = context.gitInfo.get(cwd);
  if (fresh || !hit || Date.now() - hit.at >= 10 * 60_000) {
    hit = {
      at: Date.now(),
      info: Promise.all([
        context.git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
        context.git(cwd, "remote", "get-url", "origin"),
      ]).then(
        ([branch, remote]) => ({ branch, defaultRepo: parseRemote(remote) }),
        () => undefined,
      ),
    };
    context.gitInfo.set(cwd, hit);
  }
  const info = await hit.info;
  return info ? { ...thread, ...info } : thread;
}
async function prepared(context: TelemetryContext, raw: TelemetryThread, fresh = false) {
  const thread = await enrich(context, raw, fresh);
  return { thread, facts: factsOf(context, thread) };
}
function threadSamples(
  context: TelemetryContext,
  thread: TelemetryThread,
  ledger: Map<string, Map<number, Sample>>,
) {
  const scan = scanLog(context, thread.id);
  if (scan && !scan.samples) {
    const log = readThreadLog(context, thread.id);
    if (log != null)
      scan.samples = accountingSamples(log, {
        id: thread.id,
        provider: thread.provider,
        model: thread.model,
        createdAt: thread.createdAt,
      });
  }
  let samples = scan?.samples ?? null;
  const stored = thread.provider === "codex" ? ledger.get(thread.id) : undefined;
  if (stored) {
    const turns = new Map(samples?.map((sample) => [sample.ts, sample]));
    for (const [ts, sample] of stored) {
      if (ts < (thread.createdAt ?? 0)) continue;
      if (hasTokens(sample) || !hasTokens(turns.get(ts))) turns.set(ts, sample);
    }
    samples = [...turns.values()];
  }
  return samples;
}
async function upsertComment(
  context: TelemetryContext,
  target: { repo: string; number: number },
  existing: any,
  body: string,
) {
  if (existing) {
    if (existing.body === body) return { status: "unchanged" as const };
    await context.github("PATCH", `repos/${target.repo}/issues/comments/${existing.id}`, { body });
    return { status: "updated" as const };
  }
  await context.github("POST", `repos/${target.repo}/issues/${target.number}/comments`, { body });
  return { status: "created" as const };
}
type SyncRequest = { repo: string; number: number; head?: string; createOnly?: boolean };
/** Render and upsert the one telemetry comment for an issue or PR. Threads are matched by linkThread. */
async function syncItem(context: TelemetryContext, req: SyncRequest) {
  const repos = context.options.repos(); // read once: the production source re-reads its config file on every call
  if (!repos.includes(req.repo)) return { status: "skipped" as const };
  const existing = await findComment(context, req.repo, req.number);
  if (existing && req.createOnly) return { status: "unchanged" as const };
  const runs: TelemetryRun[] = [];
  const ledger = codexLedger(context);
  for (const raw of context.threads()) {
    const { thread, facts } = await prepared(context, raw);
    if (!linkThread({ thread: facts, repos, item: req }).linked) continue;
    runs.push({
      thread: thread.id,
      title: thread.title,
      provider: thread.provider,
      model: thread.model,
      createdAt: thread.createdAt,
      samples: threadSamples(context, thread, ledger),
    });
  }
  const { body } = renderTelemetry({ repo: req.repo, number: req.number, runs });
  if (body.length > 60_000) throw new Error("Telemetry comment exceeds size limit");
  return upsertComment(context, req, existing, body);
}
/** Issues, plus PR head ref when the item is a PR. */
async function syncByNumber(
  context: TelemetryContext,
  repo: string,
  number: number,
  createOnly = false,
) {
  let head: string | undefined;
  try {
    const pr = await context.github("GET", `repos/${repo}/pulls/${number}`);
    head = typeof pr?.head?.ref === "string" ? pr.head.ref : undefined;
  } catch (error) {
    if ((error as any)?.status !== 404) throw error;
  }
  return syncItem(context, { repo, number, head, createOnly });
}
// Debounced, coalesced per item; failures are logged, never thrown.
function scheduleSync(context: TelemetryContext, repo: string, number: number) {
  const key = `${repo}#${number}`;
  clearTimeout(context.timers.get(key));
  const timer = setTimeout(() => {
    context.timers.delete(key);
    const job = syncByNumber(context, repo, number)
      .then(
        (result) =>
          telemetryLog(context, "telemetry_sync", { repo, number, status: result.status }),
        (error) => telemetryLog(context, "telemetry_failed", { repo, number, error: why(error) }),
      )
      .finally(() => context.pending.delete(job));
    context.pending.add(job);
  }, context.delay);
  timer.unref?.();
  context.timers.set(key, timer);
}
async function addBranchTargets(
  context: TelemetryContext,
  found: LinkResponse,
  defaultRepo: string | undefined,
  repos: string[],
  targets: Map<string, LinkResponse["items"][number]>,
) {
  const repo = found.items[0]?.repo ?? defaultRepo;
  if (!found.branch || !repo || !repos.includes(repo)) return;
  const owner = repo.split("/")[0];
  const prs = await context.github(
    "GET",
    `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${found.branch}`)}`,
  );
  for (const pr of Array.isArray(prs) ? prs : [])
    if (Number.isSafeInteger(pr?.number))
      targets.set(`${repo}#${pr.number}`, { repo, number: pr.number, via: "pr-run" });
}
/** A turn finished on this thread: schedule an upsert for every item it links to. Never throws. */
async function threadTurnEnded(context: TelemetryContext, source: TelemetryThread) {
  try {
    const { thread, facts } = await prepared(context, source, true);
    const repos = context.options.repos();
    const found = linkThread({ thread: facts, repos });
    const targets = new Map(found.items.map((entry) => [`${entry.repo}#${entry.number}`, entry]));
    await addBranchTargets(context, found, thread.defaultRepo, repos, targets);
    for (const target of targets.values()) scheduleSync(context, target.repo, target.number);
  } catch (error) {
    telemetryLog(context, "telemetry_link_failed", { thread: source.id, error: why(error) });
  }
}
/** Webhook: post "No agent usage recorded." (or the real table) once if no telemetry comment exists. */
async function ensureComment(context: TelemetryContext, repo: string, number: number) {
  try {
    return await syncByNumber(context, repo, number, true);
  } catch (error) {
    telemetryLog(context, "telemetry_failed", { repo, number, error: why(error) });
    return { status: "failed" as const };
  }
}
type BackfillCounts = {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
};
async function backfillItem(
  context: TelemetryContext,
  repo: string,
  number: number,
  counts: BackfillCounts,
) {
  try {
    const result = await syncByNumber(context, repo, number);
    if (result.status in counts) counts[result.status as "created" | "updated" | "unchanged"]++;
  } catch (error) {
    counts.failed++;
    telemetryLog(context, "telemetry_failed", { repo, number, error: why(error) });
  }
}
/** One-time backfill: sync every open issue and PR. Returns counts. */
async function backfill(context: TelemetryContext, repo: string, opts: { dryRun?: boolean } = {}) {
  if (!context.options.repos().includes(repo)) throw new Error("Repository not allowed");
  const counts: BackfillCounts = { scanned: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
  for (let page = 1; page <= 100; page++) {
    const items = await context.github(
      "GET",
      `repos/${repo}/issues?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(items)) throw new Error("Invalid GitHub issues response");
    for (const item of items) {
      if (!Number.isSafeInteger(item?.number)) continue;
      counts.scanned++;
      if (!opts.dryRun) await backfillItem(context, repo, item.number, counts);
    }
    if (items.length < 100) break;
  }
  return counts;
}
async function flushTelemetry(context: TelemetryContext) {
  for (const [key, timer] of context.timers) {
    clearTimeout(timer);
    context.timers.delete(key);
    const [repo, number] = [
      key.slice(0, key.indexOf("#")),
      Number(key.slice(key.indexOf("#") + 1)),
    ];
    await syncByNumber(context, repo, number).catch((error) =>
      telemetryLog(context, "telemetry_failed", { repo, number, error: why(error) }),
    );
  }
  await Promise.all(context.pending);
}
function closeTelemetry(context: TelemetryContext) {
  context.scans.clear();
  context.gitInfo.clear();
  for (const timer of context.timers.values()) clearTimeout(timer);
  context.timers.clear();
}

export function createTelemetryService(options: TelemetryOptions) {
  const threadsFile = path.join(options.dataDir, "threads.json");
  const context: TelemetryContext = {
    options,
    github: options.github ?? githubRequest,
    git: options.git ?? defaultGit,
    delay: options.debounceMs ?? 20_000,
    threads: options.threads ?? (() => JSON.parse(fs.readFileSync(threadsFile, "utf8"))),
    scans: new Map<string, LogScan>(),
    actor: undefined,
    gitInfo: new Map(),
    timers: new Map(),
    pending: new Set(),
  };
  return {
    syncItem: (req: SyncRequest) => syncItem(context, req),
    syncByNumber: (repo: string, number: number, createOnly = false) =>
      syncByNumber(context, repo, number, createOnly),
    threadTurnEnded: (thread: TelemetryThread) => threadTurnEnded(context, thread),
    ensureComment: (repo: string, number: number) => ensureComment(context, repo, number),
    backfill: (repo: string, opts: { dryRun?: boolean } = {}) => backfill(context, repo, opts),
    flush: () => flushTelemetry(context),
    close: () => closeTelemetry(context),
  };
}
