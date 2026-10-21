import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { accountingSamples } from "./accounting-log.ts";
import { safeTriageText } from "./triage-comment.ts";
import { raisedItems } from "./session-prs.ts";
import { githubRequest, type GithubRequest } from "./github-triage.ts";

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
  branch?: string;       // git branch checked out in the thread's cwd (manual threads)
  defaultRepo?: string;  // owner/name of the cwd's origin; resolves bare #n
  texts?: string[];      // user messages
  raised?: { repo: string; number: number }[]; // PRs and issues the thread opened with `gh pr create` / `gh issue create`, from its log
};
export type LinkItem = { repo: string; number: number; head?: string };
export type LinkRequest = { version?: number; thread: ThreadFacts; repos: string[]; item?: LinkItem };
export type LinkResponse = { version: 1; items: { repo: string; number: number; via: "issue-run" | "pr-run" | "reference" | "raised" }[]; linked: boolean; branch?: string };

const NOT_A_FEATURE_BRANCH = new Set(["main", "master", "HEAD", "develop"]);

/**
 * Rules, in order: (1) automation IssueRun gives its issue and PR; (2) `#n` (default repo) or a github.com issue/pull URL in
 * user messages, at most five, allowlisted repos only; (3) with `item` given, a thread branch equal to the PR head ref (never
 * main/master); (4) PRs and issues the thread itself opened with `gh pr create` or `gh issue create`, whatever directory or worktree it ran in. Tolerant: unknown request fields and malformed facts are ignored.
 */
export function linkThread(req: LinkRequest): LinkResponse {
  const allowed = new Set((Array.isArray(req?.repos) ? req.repos : []).filter(r => typeof r === "string" && REPO.test(r)));
  const t = req?.thread ?? ({} as ThreadFacts);
  const items: LinkResponse["items"] = [];
  const add = (repo: unknown, number: unknown, via: LinkResponse["items"][number]["via"]) => {
    if (typeof repo !== "string" || !allowed.has(repo) || !Number.isSafeInteger(number) || (number as number) <= 0) return;
    if (!items.some(i => i.repo === repo && i.number === number)) items.push({ repo, number: number as number, via });
  };
  const run = t.issueRun;
  if (run) { add(run.repo, run.number, "issue-run"); add(run.repo, run.pr, "pr-run"); }
  const refs: { repo: string; number: number }[] = [];
  const texts = Array.isArray(t.texts) ? t.texts.filter(x => typeof x === "string") : [];
  for (const text of texts) {
    for (const m of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d{1,9})(?![\d])/g)) refs.push({ repo: m[1], number: Number(m[2]) });
    if (typeof t.defaultRepo === "string") for (const m of text.matchAll(/(?<![\w/&#])#(\d{1,9})(?!\w)/g)) refs.push({ repo: t.defaultRepo, number: Number(m[1]) });
  }
  for (const ref of refs.slice(0, MAX_REFS)) add(ref.repo, ref.number, "reference");
  for (const pr of Array.isArray(t.raised) ? t.raised.slice(0, 20) : []) add(pr?.repo, pr?.number, "raised");
  const branch = typeof t.branch === "string" && !NOT_A_FEATURE_BRANCH.has(t.branch) ? t.branch : run?.branch;
  const item = req?.item;
  let linked = false;
  if (item && allowed.has(item.repo)) {
    linked = items.some(i => i.repo === item.repo && i.number === item.number)
      || (typeof item.head === "string" && !!branch && !NOT_A_FEATURE_BRANCH.has(branch) && item.head === branch);
  }
  return { version: 1, items, linked, ...(branch ? { branch } : {}) };
}

// ---- Rendering ----
export type TelemetryRun = {
  thread: string; title?: string; provider: string; model?: string; createdAt?: number;
  samples: ReturnType<typeof accountingSamples> | null; // null: no log to read
};
export type RenderRequest = { version?: number; repo?: string; number?: number; runs: TelemetryRun[] };
export type RenderResponse = { version: 1; body: string; measured: boolean };

const fmt = (n: number) => n.toLocaleString("en-US");
type Sum = { input: number; cached: number; output: number; turns: number; measuredTurns: number };
type Sample = ReturnType<typeof accountingSamples>[number];
const counter = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const hasTokens = (sample: Sample | undefined) => counter(sample?.in) != null && counter(sample?.out) != null;
function summarize(samples: TelemetryRun["samples"]): Sum {
  const s: Sum = { input: 0, cached: 0, output: 0, turns: 0, measuredTurns: 0 };
  for (const sample of samples ?? []) {
    s.turns++;
    if (typeof sample.in !== "number" || typeof sample.out !== "number") continue; // never guess a missing side
    s.measuredTurns++; s.input += sample.in; s.output += sample.out; s.cached += typeof sample.cache === "number" ? sample.cache : 0;
  }
  return s;
}

export function renderTelemetry(req: RenderRequest): RenderResponse {
  const runs = Array.isArray(req?.runs) ? req.runs.filter(r => r && typeof r.thread === "string") : [];
  const head = [TELEMETRY_MARKER, TELEMETRY_VERSION_MARKER, "", "### Agent token usage", ""];
  if (!runs.length) return { version: 1, body: [...head, NO_USAGE_TEXT].join("\n"), measured: false };
  const lines = [...head, "| Thread | Provider | Model | Input | Cached input | Output | Turns |", "| --- | --- | --- | ---: | ---: | ---: | ---: |"];
  const total: Sum = { input: 0, cached: 0, output: 0, turns: 0, measuredTurns: 0 };
  let measured = false;
  for (const run of runs) {
    const s = summarize(run.samples);
    const label = safeTriageText(run.title ? `${run.title} (${run.thread.slice(0, 8)})` : run.thread.slice(0, 8));
    const cells = s.measuredTurns === 0
      ? ["unmeasured", "unmeasured", "unmeasured"]
      : [fmt(s.input), fmt(s.cached), fmt(s.output)];
    const turns = s.measuredTurns === s.turns ? String(s.turns) : `${s.turns} (${s.turns - s.measuredTurns} unmeasured)`;
    lines.push(`| ${label} | ${safeTriageText(run.provider)} | ${safeTriageText(run.model ?? "unknown")} | ${cells.join(" | ")} | ${turns} |`);
    if (s.measuredTurns) measured = true;
    for (const k of ["input", "cached", "output", "turns", "measuredTurns"] as const) total[k] += s[k];
  }
  const cells = measured ? [fmt(total.input), fmt(total.cached), fmt(total.output)] : ["unmeasured", "unmeasured", "unmeasured"];
  lines.push(`| **Total** | | | ${cells.join(" | ")} | ${total.turns} |`, "",
    "Input includes cached input. Counts are provider-reported; turns without telemetry are marked unmeasured and excluded from sums.");
  return { version: 1, body: lines.join("\n"), measured };
}

// ---- Upsert service ----
export type TelemetryOptions = {
  repos: () => string[];
  dataDir: string;
  github?: GithubRequest;
  threads?: () => (ThreadFacts & { provider: string; model?: string; title?: string; createdAt?: number; cwd?: string; archived?: number })[];
  git?: (cwd: string, ...args: string[]) => Promise<string>;
  debounceMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

const defaultGit = (cwd: string, ...args: string[]) => new Promise<string>((resolve, reject) =>
  execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (e, out) => e ? reject(e) : resolve(out.trim())));

export function parseRemote(url: string): string | undefined {
  return /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

// Log the failure class only: GitHub and git messages can echo request details.
const why = (e: unknown) => (e as any)?.status ? `http ${(e as any).status}` : String((e as any)?.name ?? "Error");

export function createTelemetryService(options: TelemetryOptions) {
  const github = options.github ?? githubRequest;
  const git = options.git ?? defaultGit;
  const delay = options.debounceMs ?? 20_000;
  const log = (event: string, fields: Record<string, unknown> = {}) => { try { options.log?.(event, fields); } catch {} };
  const threadsFile = path.join(options.dataDir, "threads.json");
  const threads = options.threads ?? (() => JSON.parse(fs.readFileSync(threadsFile, "utf8")));
  const logFile = (id: string) => path.join(options.dataDir, "logs", `${id}.jsonl`);
  const readLog = (id: string) => { try { return fs.readFileSync(logFile(id), "utf8"); } catch { return null; } };
  // App-server usage reaches the turn ledger without being written to the conversation log.
  function codexLedger() {
    const ledger = new Map<string, Map<number, Sample>>();
    let raw: string;
    try { raw = fs.readFileSync(path.join(options.dataDir, "turns.jsonl"), "utf8"); } catch { return ledger; }
    for (const line of raw.split("\n")) {
      try {
        const row = JSON.parse(line);
        if (row.accounting !== 2 || row.provider !== "codex" || typeof row.thread !== "string" || !Number.isFinite(row.ts)) continue;
        const sample: Sample = { ts: row.ts, accounting: 2, in: counter(row.in), out: counter(row.out), cache: counter(row.cache) };
        const turns = ledger.get(row.thread) ?? new Map<number, Sample>();
        if (hasTokens(sample) || !hasTokens(turns.get(row.ts))) turns.set(row.ts, sample);
        ledger.set(row.thread, turns);
      } catch {} // An incomplete append must not hide earlier completed turns.
    }
    return ledger;
  }
  // Logs are append-only: a log whose size and mtime are unchanged yields the same facts and samples, so scan it once.
  type LogScan = { size: number; mtimeMs: number; texts: string[]; raised: ThreadFacts["raised"]; samples?: ReturnType<typeof accountingSamples> };
  const scans = new Map<string, LogScan>();
  function scanLog(id: string): LogScan | null {
    let st: fs.Stats;
    try { st = fs.statSync(logFile(id)); } catch { scans.delete(id); return null; }
    const hit = scans.get(id);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
    const raw = readLog(id);
    if (raw == null) { scans.delete(id); return null; }
    const texts: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.includes('"user_input"')) continue;
      try { const ev = JSON.parse(line); if (ev.type === "user_input" && typeof ev.text === "string") texts.push(ev.text.slice(0, 4000)); } catch {}
    }
    const scan = { size: st.size, mtimeMs: st.mtimeMs, texts, raised: raisedItems(raw) };
    scans.set(id, scan);
    return scan;
  }
  let actor: Promise<string> | undefined;
  const login = () => actor ??= github("GET", "user").then(u => {
    if (typeof u?.login !== "string" || !u.login) throw new Error("Missing GitHub actor");
    return u.login;
  }).catch(e => { actor = undefined; throw e; });

  async function findComment(repo: string, number: number) {
    const me = await login();
    for (let page = 1; page <= 20; page++) {
      const comments = await github("GET", `repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) throw new Error("Invalid GitHub comments response");
      const hit = comments.find(c => c.user?.login === me && typeof c.body === "string" && c.body.split("\n")[0] === TELEMETRY_MARKER && Number.isSafeInteger(c.id));
      if (hit) return hit;
      if (comments.length < 100) return undefined;
    }
    throw new Error("Too many comments to locate telemetry comment");
  }

  function factsOf(t: ReturnType<NonNullable<typeof options.threads>>[number]): ThreadFacts {
    const scan = scanLog(t.id);
    return { id: t.id, issueRun: t.issueRun, branch: t.branch, defaultRepo: t.defaultRepo, texts: scan?.texts ?? [], raised: scan?.raised ?? [] };
  }

  // Branch and origin repo come from git in the thread's cwd; both are best effort.
  // Many threads share a cwd, and forking git from this process is costly: cache per cwd, refresh when a turn ends there.
  const gitInfo = new Map<string, { at: number; info: Promise<{ branch: string; defaultRepo?: string } | undefined> }>();
  async function enrich(t: ReturnType<NonNullable<typeof options.threads>>[number], fresh = false) {
    if (!t.cwd || t.issueRun) return t;
    let hit = gitInfo.get(t.cwd);
    if (fresh || !hit || Date.now() - hit.at >= 10 * 60_000) {
      hit = { at: Date.now(), info: Promise.all([git(t.cwd, "rev-parse", "--abbrev-ref", "HEAD"), git(t.cwd, "remote", "get-url", "origin")])
        .then(([branch, remote]) => ({ branch, defaultRepo: parseRemote(remote) }), () => undefined) };
      gitInfo.set(t.cwd, hit);
    }
    const info = await hit.info;
    return info ? { ...t, ...info } : t;
  }

  async function prepared(raw: ReturnType<NonNullable<typeof options.threads>>[number], fresh = false) {
    const t = await enrich(raw, fresh);
    return { t, facts: factsOf(t) };
  }

  /** Render and upsert the one telemetry comment for an issue or PR. Threads are matched by linkThread. */
  async function syncItem(req: { repo: string; number: number; head?: string; createOnly?: boolean }) {
    const repos = options.repos(); // read once: the production source re-reads its config file on every call
    if (!repos.includes(req.repo)) return { status: "skipped" as const };
    const existing = await findComment(req.repo, req.number);
    if (existing && req.createOnly) return { status: "unchanged" as const };
    const runs: TelemetryRun[] = [];
    const ledger = codexLedger();
    for (const raw of threads()) {
      const { t, facts } = await prepared(raw);
      if (!linkThread({ thread: facts, repos, item: req }).linked) continue;
      const scan = scanLog(t.id);
      if (scan && !scan.samples) { const log = readLog(t.id); if (log != null) scan.samples = accountingSamples(log, { id: t.id, provider: t.provider, model: t.model, createdAt: t.createdAt }); }
      let samples = scan?.samples ?? null;
      const stored = t.provider === "codex" ? ledger.get(t.id) : undefined;
      if (stored) {
        const turns = new Map(samples?.map(sample => [sample.ts, sample]));
        for (const [ts, sample] of stored) {
          if (ts < (t.createdAt ?? 0)) continue;
          if (hasTokens(sample) || !hasTokens(turns.get(ts))) turns.set(ts, sample);
        }
        samples = [...turns.values()];
      }
      runs.push({ thread: t.id, title: t.title, provider: t.provider, model: t.model, createdAt: t.createdAt, samples });
    }
    const { body } = renderTelemetry({ repo: req.repo, number: req.number, runs });
    if (body.length > 60_000) throw new Error("Telemetry comment exceeds size limit");
    if (existing) {
      if (existing.body === body) return { status: "unchanged" as const };
      await github("PATCH", `repos/${req.repo}/issues/comments/${existing.id}`, { body });
      return { status: "updated" as const };
    }
    await github("POST", `repos/${req.repo}/issues/${req.number}/comments`, { body });
    return { status: "created" as const };
  }

  /** Issues, plus PR head ref when the item is a PR. */
  async function syncByNumber(repo: string, number: number, createOnly = false) {
    let head: string | undefined;
    try { const pr = await github("GET", `repos/${repo}/pulls/${number}`); head = typeof pr?.head?.ref === "string" ? pr.head.ref : undefined; } catch (e) { if ((e as any)?.status !== 404) throw e; }
    return syncItem({ repo, number, head, createOnly });
  }

  // Debounced, coalesced per item; failures are logged, never thrown.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<unknown>>();
  function schedule(repo: string, number: number) {
    const key = `${repo}#${number}`;
    clearTimeout(timers.get(key));
    const timer = setTimeout(() => {
      timers.delete(key);
      const job = syncByNumber(repo, number).then(r => log("telemetry_sync", { repo, number, status: r.status }), e => log("telemetry_failed", { repo, number, error: why(e) }))
        .finally(() => pending.delete(job));
      pending.add(job);
    }, delay);
    timer.unref?.();
    timers.set(key, timer);
  }

  /** A turn finished on this thread: schedule an upsert for every item it links to. Never throws. */
  async function threadTurnEnded(thread: ReturnType<NonNullable<typeof options.threads>>[number]) {
    try {
      const { t, facts } = await prepared(thread, true);
      const repos = options.repos();
      const found = linkThread({ thread: facts, repos });
      const targets = new Map(found.items.map(i => [`${i.repo}#${i.number}`, i]));
      const repo = found.items[0]?.repo ?? t.defaultRepo;
      if (found.branch && repo && repos.includes(repo)) {
        const owner = repo.split("/")[0];
        const prs = await github("GET", `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${found.branch}`)}`);
        for (const pr of Array.isArray(prs) ? prs : []) if (Number.isSafeInteger(pr?.number)) targets.set(`${repo}#${pr.number}`, { repo, number: pr.number, via: "pr-run" });
      }
      for (const i of targets.values()) schedule(i.repo, i.number);
    } catch (e) { log("telemetry_link_failed", { thread: thread.id, error: why(e) }); }
  }

  /** Webhook: post "No agent usage recorded." (or the real table) once if no telemetry comment exists. */
  async function ensureComment(repo: string, number: number) {
    try { return await syncByNumber(repo, number, true); }
    catch (e) { log("telemetry_failed", { repo, number, error: why(e) }); return { status: "failed" as const }; }
  }

  /** One-time backfill: sync every open issue and PR. Returns counts. */
  async function backfill(repo: string, opts: { dryRun?: boolean } = {}) {
    if (!options.repos().includes(repo)) throw new Error("Repository not allowed");
    const counts = { scanned: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
    for (let page = 1; page <= 100; page++) {
      const items = await github("GET", `repos/${repo}/issues?state=open&per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error("Invalid GitHub issues response");
      for (const item of items) {
        if (!Number.isSafeInteger(item?.number)) continue;
        counts.scanned++;
        if (opts.dryRun) continue;
        try { const r = await syncByNumber(repo, item.number); if (r.status in counts) counts[r.status as "created" | "updated" | "unchanged"]++; }
        catch (e) { counts.failed++; log("telemetry_failed", { repo, number: item.number, error: why(e) }); }
      }
      if (items.length < 100) break;
    }
    return counts;
  }

  async function flush() { for (const [k, t] of timers) { clearTimeout(t); timers.delete(k); const [repo, n] = [k.slice(0, k.indexOf("#")), Number(k.slice(k.indexOf("#") + 1))]; await syncByNumber(repo, n).catch(e => log("telemetry_failed", { repo, number: n, error: why(e) })); } await Promise.all(pending); }
  function close() { scans.clear(); gitInfo.clear(); for (const t of timers.values()) clearTimeout(t); timers.clear(); }
  return { syncItem, syncByNumber, threadTurnEnded, ensureComment, backfill, flush, close };
}
