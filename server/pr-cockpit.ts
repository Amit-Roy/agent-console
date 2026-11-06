// PR cockpit library: discovers the PRs a thread owns, snapshots each with ONE GraphQL
// query, caches cards in a PrStore and keeps them fresh with a rate-limit-aware fallback poll.
// Pure library: no routes, no UI, no wiring. All I/O (gh, git, fs, clock) is injected.
//
// PrCard shape (UI contract, keep stable):
//   key           "owner/repo#n" (lowercased repo for dedupe)
//   repo, number, url, title
//   state         "OPEN" | "CLOSED" | "MERGED"
//   isDraft       boolean
//   mergeable     "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
//   mergeStateStatus  GitHub enum string (CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, ...)
//   reviewDecision    "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
//   headSha       head commit oid
//   checks        PrCheck[] {name, status, conclusion, detailsUrl, jobId, runId}
//   checkCounts   {total, passed, failed, pending, skipped}
//   unresolvedThreads  unresolved review thread count
//   commentCount, reviewCount  noise-filtered (agent-console markers, Copilot, empty reviews)
//   images        evidence image URLs from the PR body <img src>
//   deploy        {deployed: sha|null, text: string|null} from pr-ship state, or null
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "./providers/env.ts";

export interface PrCheck {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  jobId: string | null;
  runId: string | null;
}
export interface PrCard {
  key: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  headSha: string;
  checks: PrCheck[];
  checkCounts: { total: number; passed: number; failed: number; pending: number; skipped: number };
  unresolvedThreads: number;
  commentCount: number;
  reviewCount: number;
  images: string[];
  deploy: { deployed: string | null; text: string | null } | null;
}
export interface PrRef {
  repo: string;
  number: number;
}
export interface ThreadInfo {
  id: string;
  cwd?: string;
  issueRun?: { repo: string; number: number; pr?: number; branch?: string };
}
export interface GhResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface CockpitDeps {
  /** Runs `gh <args>` and returns raw stdout (also on non-zero exit when stdout has content). */
  gh(args: string[]): Promise<string>;
  git(cwd: string, args: string[]): Promise<string>;
  sessionPrs(thread: string): Promise<{ repo: string; number: number }[]>;
  issueCrossRefs(repo: string, number: number): Promise<number[]>;
  shipDir: string;
  /** pr-ship state files older than this are not used for discovery. */
  shipMaxAgeMs?: number;
  now(): number;
}

export const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const KEY_RE = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/;
export function parseKey(key: string): PrRef | null {
  const match = KEY_RE.exec(key);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

// ---------- gh transport ----------

export function parseGhResponse(raw: string): GhResponse {
  const split = /\r?\n\r?\n/.exec(raw);
  const head = split ? raw.slice(0, split.index) : raw;
  const body = split ? raw.slice(split.index + split[0].length) : "";
  const lines = head.split(/\r?\n/);
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status, headers, body };
}

/** Pause end (epoch ms) implied by a 403/429 response, or null when it is not a rate limit. */
export function rateLimitPause(res: GhResponse, now: number): number | null {
  const limited =
    res.status === 429 ||
    (res.status === 403 && /rate limit|abuse/i.test(res.body)) ||
    (res.status === 403 && res.headers["x-ratelimit-remaining"] === "0");
  if (!limited) return null;
  const retry = Number(res.headers["retry-after"]);
  if (Number.isFinite(retry) && retry > 0) return now + retry * 1000;
  const reset = Number(res.headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) return Math.max(now + 1000, reset * 1000);
  return now + 60_000;
}

export function defaultDeps(
  partial: Pick<CockpitDeps, "sessionPrs" | "issueCrossRefs" | "shipDir">,
): CockpitDeps {
  const run = (cmd: string, args: string[], cwd?: string) =>
    new Promise<string>((resolve, reject) =>
      execFile(
        cmd,
        args,
        { env: childEnv(), cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => (error && !stdout.trim() ? reject(error) : resolve(stdout)),
      ),
    );
  return {
    ...partial,
    gh: (args) => run("gh", ["api", "--hostname", "github.com", ...args]),
    git: (cwd, args) => run("git", ["-C", cwd, ...args]),
    now: Date.now,
  };
}

class GhHttpError extends Error {
  status: number;
  pauseUntil: number | null;
  constructor(status: number, pauseUntil: number | null) {
    super(`GitHub request failed (${status})`);
    this.status = status;
    this.pauseUntil = pauseUntil;
  }
}

/** One `gh api -i` call; throws GhHttpError on >=400 (304 is returned, not thrown). */
async function ghCall(deps: CockpitDeps, args: string[]): Promise<GhResponse> {
  const res = parseGhResponse(await deps.gh(["-i", ...args]));
  if (res.status >= 400 || res.status === 0)
    throw new GhHttpError(res.status, rateLimitPause(res, deps.now()));
  return res;
}
const ghRest = async (deps: CockpitDeps, endpoint: string): Promise<any> =>
  JSON.parse((await ghCall(deps, [endpoint])).body || "null");

// ---------- source discovery ----------

export function parseRemote(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

const branchCache = new Map<string, Promise<PrRef[]>>();
/** Call on turn end: the thread may have switched branch or opened a PR. */
export function invalidateBranch(cwd: string) {
  branchCache.delete(cwd);
}

async function lookupBranchPrs(cwd: string, deps: CockpitDeps): Promise<PrRef[]> {
  const branch = (await deps.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const repo = parseRemote(await deps.git(cwd, ["remote", "get-url", "origin"]));
  if (!repo || !branch || branch === "HEAD") return [];
  const owner = repo.split("/")[0];
  const found = await ghRest(
    deps,
    `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`,
  );
  return (Array.isArray(found) ? found : [])
    .filter((pull) => Number.isSafeInteger(pull.number))
    .map((pull) => ({ repo, number: pull.number as number }));
}

function branchPrs(cwd: string, deps: CockpitDeps): Promise<PrRef[]> {
  let cached = branchCache.get(cwd);
  if (!cached) {
    cached = lookupBranchPrs(cwd, deps).catch(() => {
      branchCache.delete(cwd);
      return [];
    });
    branchCache.set(cwd, cached);
  }
  return cached;
}

export function shipFileRef(name: string): PrRef | null {
  const match = /^([^_]+)_(.+)-(\d+)\.json$/.exec(name);
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

function shipRefs(deps: CockpitDeps, repos: Set<string>): PrRef[] {
  const maxAge = deps.shipMaxAgeMs ?? 7 * 24 * 3600_000;
  let names: string[] = [];
  try {
    names = fs.readdirSync(deps.shipDir);
  } catch {
    return [];
  }
  const refs: PrRef[] = [];
  for (const name of names) {
    const ref = shipFileRef(name);
    if (!ref || !repos.has(ref.repo.toLowerCase())) continue;
    const age = deps.now() - fs.statSync(path.join(deps.shipDir, name)).mtimeMs;
    if (age <= maxAge) refs.push(ref);
  }
  return refs;
}

async function runRefs(thread: ThreadInfo, deps: CockpitDeps): Promise<PrRef[]> {
  const run = thread.issueRun;
  if (!run) return [];
  const refs: PrRef[] = [];
  if (run.pr) refs.push({ repo: run.repo, number: run.pr });
  const cross = await deps.issueCrossRefs(run.repo, run.number).catch(() => []);
  for (const number of cross) refs.push({ repo: run.repo, number });
  return refs;
}

/** Merge every source for a thread, deduped by `owner/repo#n` (first source wins). */
export async function discoverPrs(thread: ThreadInfo, deps: CockpitDeps): Promise<PrRef[]> {
  const sessions = await deps.sessionPrs(thread.id).catch(() => []);
  const branch = thread.cwd ? await branchPrs(thread.cwd, deps) : [];
  const early = [...(await runRefs(thread, deps)), ...sessions, ...branch];
  const repos = new Set(early.map((ref) => ref.repo.toLowerCase()));
  const merged = new Map<string, PrRef>();
  for (const ref of [...early, ...shipRefs(deps, repos)]) {
    if (Number.isSafeInteger(ref.number) && !merged.has(prKey(ref.repo, ref.number)))
      merged.set(prKey(ref.repo, ref.number), ref);
  }
  return [...merged.values()];
}

// ---------- snapshot ----------

export const SNAPSHOT_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
title state isDraft url mergeable mergeStateStatus reviewDecision headRefOid bodyHTML
reviewThreads(first:100){nodes{isResolved}}
comments(first:100){nodes{body author{login}}}
reviews(first:100){nodes{body state author{login}}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
... on CheckRun{name status conclusion detailsUrl databaseId checkSuite{workflowRun{databaseId}}}
... on StatusContext{context state targetUrl}}}}}}}}}}`;

const MARKER = "<!-- agent-console-";
const isNoise = (item: any) =>
  String(item?.body ?? "").startsWith(MARKER) ||
  String(item?.author?.login ?? "")
    .toLowerCase()
    .startsWith("copilot");
const countComments = (nodes: any[]) => nodes.filter((node) => !isNoise(node)).length;
const countReviews = (nodes: any[]) =>
  nodes.filter((node) => !isNoise(node) && (node.body || node.state === "CHANGES_REQUESTED"))
    .length;

export function extractImages(html: string | null | undefined): string[] {
  const urls: string[] = [];
  for (const match of String(html ?? "").matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["']/gi)) {
    const url = match[1].replace(/&amp;/g, "&");
    if (/^https:\/\//.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

const idFromUrl = (url: string | null, pattern: RegExp) => pattern.exec(url ?? "")?.[1] ?? null;

function mapContext(node: any): PrCheck {
  if (node.__typename === "StatusContext") {
    const pending = node.state === "PENDING" || node.state === "EXPECTED";
    return {
      name: node.context,
      status: pending ? "IN_PROGRESS" : "COMPLETED",
      conclusion: pending ? null : node.state,
      detailsUrl: node.targetUrl ?? null,
      jobId: null,
      runId: null,
    };
  }
  const url = node.detailsUrl ?? null;
  const run = node.checkSuite?.workflowRun?.databaseId;
  return {
    name: node.name,
    status: node.status,
    conclusion: node.conclusion ?? null,
    detailsUrl: url,
    jobId: idFromUrl(url, /\/job\/(\d+)/) ?? (node.databaseId ? String(node.databaseId) : null),
    runId: idFromUrl(url, /\/runs\/(\d+)/) ?? (run ? String(run) : null),
  };
}

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ERROR",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const SKIPPED = new Set(["SKIPPED", "NEUTRAL", "STALE"]);
export function countChecks(checks: PrCheck[]): PrCard["checkCounts"] {
  const counts = { total: checks.length, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const check of checks) {
    const done = check.status === "COMPLETED" && check.conclusion;
    if (!done) counts.pending++;
    else if (FAILED.has(check.conclusion!)) counts.failed++;
    else if (SKIPPED.has(check.conclusion!)) counts.skipped++;
    else counts.passed++;
  }
  return counts;
}

export function readDeploy(shipDir: string, ref: PrRef): PrCard["deploy"] {
  const file = path.join(shipDir, `${ref.repo.replace("/", "_")}-${ref.number}.json`);
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return { deployed: state.deployed ?? null, text: state.deploy_text ?? null };
  } catch {
    return null;
  }
}

export function mapSnapshot(ref: PrRef, pull: any, deploy: PrCard["deploy"]): PrCard {
  const rollup = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const checks: PrCheck[] = (rollup?.contexts?.nodes ?? []).map(mapContext);
  return {
    key: prKey(ref.repo, ref.number),
    repo: ref.repo,
    number: ref.number,
    url: pull.url,
    title: pull.title,
    state: pull.state,
    isDraft: !!pull.isDraft,
    mergeable: pull.mergeable ?? "UNKNOWN",
    mergeStateStatus: pull.mergeStateStatus ?? "UNKNOWN",
    reviewDecision: pull.reviewDecision ?? null,
    headSha: pull.headRefOid,
    checks,
    checkCounts: countChecks(checks),
    unresolvedThreads: (pull.reviewThreads?.nodes ?? []).filter((node: any) => !node.isResolved)
      .length,
    commentCount: countComments(pull.comments?.nodes ?? []),
    reviewCount: countReviews(pull.reviews?.nodes ?? []),
    images: extractImages(pull.bodyHTML),
    deploy,
  };
}

/** ONE `gh api graphql` call (plus a local pr-ship state read). */
export async function fetchSnapshot(ref: PrRef, deps: CockpitDeps): Promise<PrCard> {
  const [owner, name] = ref.repo.split("/");
  const res = await ghCall(deps, [
    "graphql",
    "-f",
    `query=${SNAPSHOT_QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${ref.number}`,
  ]);
  const pull = JSON.parse(res.body)?.data?.repository?.pullRequest;
  if (!pull) throw new Error("Pull request not found.");
  return mapSnapshot(ref, pull, readDeploy(deps.shipDir, ref));
}

// ---------- store + poll ----------

export interface StoreEntry {
  card: PrCard;
  fetchedAt: number;
  sha: string;
  hash: string;
}
export interface PrChange {
  thread: string;
  cards: PrCard[];
}
export interface StoreOptions {
  tickMs?: number;
  pendingPollMs?: number;
  idlePollMs?: number;
  signalQuietMs?: number;
}

export const cardHash = (card: PrCard) =>
  createHash("sha1").update(JSON.stringify(card)).digest("hex");

const checkSignature = (runs: any[]) =>
  runs
    .map((run) => `${run.name}:${run.status}:${run.conclusion ?? ""}`)
    .sort()
    .join("|");
const cardSignature = (card: PrCard) =>
  checkSignature(
    card.checks.map((check) => ({
      name: check.name,
      status: check.status.toLowerCase(),
      conclusion: check.conclusion?.toLowerCase() ?? null,
    })),
  );

export function createPrStore(deps: CockpitDeps, options: StoreOptions = {}) {
  const pendingMs = options.pendingPollMs ?? 30_000;
  const idleMs = options.idlePollMs ?? 600_000;
  const quietMs = options.signalQuietMs ?? 600_000;
  const entries = new Map<string, StoreEntry>();
  const threadKeys = new Map<string, Set<string>>();
  const openThreads = new Set<string>();
  const signals = new Map<string, number>();
  const polledAt = new Map<string, number>();
  const etags = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();
  const listeners = new Set<(change: PrChange) => void>();
  let pausedUntil = 0;
  let budgetUsed = 0;
  let timer: NodeJS.Timeout | undefined;

  const cardsFor = (threadId: string): PrCard[] =>
    [...(threadKeys.get(threadId) ?? [])]
      .map((key) => entries.get(key)?.card)
      .filter((card): card is PrCard => !!card);

  function emitFor(key: string) {
    for (const [thread, keys] of threadKeys)
      if (keys.has(key)) for (const cb of listeners) cb({ thread, cards: cardsFor(thread) });
  }

  function absorb(card: PrCard) {
    const hash = cardHash(card);
    const prev = entries.get(card.key);
    entries.set(card.key, { card, fetchedAt: deps.now(), sha: card.headSha, hash });
    if (prev?.hash !== hash) emitFor(card.key);
  }

  function notePause(error: unknown) {
    if (error instanceof GhHttpError && error.pauseUntil) pausedUntil = error.pauseUntil;
  }

  async function doRefresh(key: string) {
    const ref = parseKey(key);
    if (!ref || deps.now() < pausedUntil) return;
    budgetUsed++;
    try {
      absorb(await fetchSnapshot(ref, deps));
    } catch (error) {
      notePause(error);
    }
  }

  function refresh(key: string): Promise<void> {
    let running = inflight.get(key);
    if (!running) {
      running = doRefresh(key).finally(() => inflight.delete(key));
      inflight.set(key, running);
    }
    return running;
  }

  async function track(thread: ThreadInfo, open = true) {
    if (open) openThreads.add(thread.id);
    else openThreads.delete(thread.id);
    const refs = await discoverPrs(thread, deps);
    threadKeys.set(thread.id, new Set(refs.map((ref) => prKey(ref.repo, ref.number))));
    await Promise.all(refs.map((ref) => refresh(prKey(ref.repo, ref.number))));
  }

  const isOpen = (key: string) =>
    [...threadKeys].some(([thread, keys]) => keys.has(key) && openThreads.has(thread));

  async function pollChecks(key: string, entry: StoreEntry) {
    const ref = parseKey(key)!;
    const args = [`repos/${ref.repo}/commits/${entry.sha}/check-runs?per_page=100`];
    const etag = etags.get(key);
    if (etag) args.unshift("-H", `If-None-Match: ${etag}`);
    try {
      const res = await ghCall(deps, args);
      if (res.status === 304) return; // conditional hit: free, not counted
      budgetUsed++;
      if (res.headers.etag) etags.set(key, res.headers.etag);
      const runs = JSON.parse(res.body)?.check_runs ?? [];
      if (checkSignature(runs) !== cardSignature(entry.card)) await refresh(key);
    } catch (error) {
      if (error instanceof GhHttpError && error.status !== 304) budgetUsed++;
      notePause(error);
    }
  }

  function due(key: string, entry: StoreEntry): boolean {
    const now = deps.now();
    if (now < pausedUntil) return false;
    if (now - (signals.get(key) ?? -Infinity) < quietMs) return false;
    const pending = entry.card.checkCounts.pending > 0 && isOpen(key);
    return now - (polledAt.get(key) ?? 0) >= (pending ? pendingMs : idleMs);
  }

  /** One scheduler pass; exported for tests, driven by the unref'd interval in start(). */
  async function tick() {
    const work: Promise<void>[] = [];
    for (const [key, entry] of entries) {
      if (!due(key, entry)) continue;
      polledAt.set(key, deps.now());
      work.push(pollChecks(key, entry));
    }
    await Promise.all(work);
  }

  return {
    cardsFor,
    track,
    refresh,
    tick,
    noteSignal: (key: string) => void signals.set(key, deps.now()),
    onChange(cb: (change: PrChange) => void) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), options.tickMs ?? 5000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    stats: () => ({ budgetUsed, pausedUntil }),
  };
}
export type PrStore = ReturnType<typeof createPrStore>;
