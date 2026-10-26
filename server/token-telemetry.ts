import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { accountingReplayer, type accountingSamples } from "./accounting-log.ts";
import { type GithubRequest, githubRequest } from "./github-triage.ts";
import { raisedReplayer } from "./session-prs.ts";
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
type MaybePromise<T> = T | Promise<T>;
export type TelemetryOptions = {
  repos: () => string[];
  dataDir: string;
  github?: GithubRequest;
  threads?: () => MaybePromise<
    (ThreadFacts & {
      provider: string;
      model?: string;
      title?: string;
      createdAt?: number;
      cwd?: string;
      archived?: number;
    })[]
  >;
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

type TelemetryThread = Awaited<ReturnType<NonNullable<TelemetryOptions["threads"]>>>[number];
type LogScan = {
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
  threads: () => TelemetryThread[] | Promise<TelemetryThread[]>;
  // Logs are append-only: each keeps a byte offset and the parse state so later scans read only appended bytes.
  scans: Map<string, TailSlot>;
  ledger: TailSlot;
  lastSweep: number;
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
// ---- Incremental tail reader: later scans read only appended bytes, asynchronously and in chunks. ----
const CHUNK_BYTES = 128 * 1024;
const ANCHOR_BYTES = 64;
const IDLE_EVICT_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 60_000;
type LineConsumer = { key: string; impl: { feed(line: string): void } };
type FileTail = {
  ino: number;
  offset: number; // start of the first line not yet completed by a newline
  anchor: Buffer; // bytes just before offset, to notice in-place rewrites
  tail: Buffer; // the unterminated last line
  tailFed: boolean; // tail parsed as a complete JSON line, as a full read would
  mtimeMs: number;
  consumers: Map<string, LineConsumer>;
};
type TailSlot = { state?: FileTail; chain: Promise<unknown>; touched: number };
type WantedConsumer = { name: string; key: string; make: () => LineConsumer["impl"] };
class TailReset extends Error {}

const newSlot = (): TailSlot => ({ chain: Promise.resolve(), touched: Date.now() });
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const sameLine = (grown: string, fed: string) =>
  grown.startsWith(fed) && /^[ \t\r]*$/.test(grown.slice(fed.length));

async function readAt(handle: fs.promises.FileHandle, pos: number, len: number) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await handle.read(buf, got, len - got, pos + got);
    if (!bytesRead) throw new TailReset();
    got += bytesRead;
  }
  return buf;
}
function nextAnchor(previous: Buffer, buf: Buffer, end: number) {
  const piece = buf.subarray(Math.max(0, end - ANCHOR_BYTES), end);
  return piece.length >= ANCHOR_BYTES
    ? Buffer.from(piece)
    : Buffer.concat([previous.subarray(-(ANCHOR_BYTES - piece.length)), piece]);
}
/** Feed whole lines in [from, to) in chunks, yielding between chunks. Returns the unterminated rest. */
async function pumpLines(
  handle: fs.promises.FileHandle,
  from: number,
  to: number,
  anchor: Buffer,
  onLines: (lines: string[]) => void,
) {
  let carry = Buffer.alloc(0);
  let pos = from;
  while (pos < to) {
    const chunk = await readAt(handle, pos, Math.min(CHUNK_BYTES, to - pos));
    pos += chunk.length;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const newline = buf.lastIndexOf(10);
    if (newline < 0) {
      carry = Buffer.from(buf);
      continue;
    }
    anchor = nextAnchor(anchor, buf, newline + 1);
    onLines(buf.toString("utf8", 0, newline).split("\n"));
    carry = Buffer.from(buf.subarray(newline + 1));
    await yieldLoop();
  }
  return { carry, anchor };
}
const feedAll = (consumers: Iterable<LineConsumer>, lines: string[]) => {
  for (const consumer of consumers) for (const line of lines) consumer.impl.feed(line);
};
async function catchUp(handle: fs.promises.FileHandle, state: FileTail, added: LineConsumer[]) {
  await pumpLines(handle, 0, state.offset, Buffer.alloc(0), (lines) => feedAll(added, lines));
  if (state.tailFed) feedAll(added, [state.tail.toString("utf8")]);
}
async function advance(handle: fs.promises.FileHandle, state: FileTail, size: number) {
  const fed = state.tailFed ? state.tail.toString("utf8") : null;
  let skip = fed;
  const onLines = (lines: string[]) => {
    if (skip != null && lines.length) {
      if (!sameLine(lines.shift() as string, skip)) throw new TailReset();
      skip = null;
    }
    feedAll(state.consumers.values(), lines);
  };
  const { carry, anchor } = await pumpLines(handle, state.offset, size, state.anchor, onLines);
  state.offset = size - carry.length;
  state.anchor = anchor;
  state.tail = carry;
  if (skip != null) {
    if (!sameLine(carry.toString("utf8"), skip)) throw new TailReset();
    return;
  }
  state.tailFed = false;
  if (!carry.length) return;
  const text = carry.toString("utf8");
  try {
    JSON.parse(text);
  } catch {
    return; // incomplete append: a full read would skip it too, and it is read again once complete
  }
  feedAll(state.consumers.values(), [text]);
  state.tailFed = true;
}
async function stillSame(handle: fs.promises.FileHandle, state: FileTail) {
  const expected = Buffer.concat([state.anchor, state.tail]);
  if (!expected.length) return true;
  const head = await readAt(handle, state.offset - state.anchor.length, expected.length);
  return head.equals(expected);
}
function usableState(state: FileTail | undefined, fileStat: fs.Stats): FileTail | undefined {
  if (!state || state.ino !== fileStat.ino) return undefined;
  const have = state.offset + state.tail.length;
  if (fileStat.size < have || (fileStat.size === have && fileStat.mtimeMs !== state.mtimeMs))
    return undefined;
  return state;
}
const hasAll = (state: FileTail, wanted: WantedConsumer[]) =>
  wanted.every((w) => state.consumers.get(w.name)?.key === w.key);
async function syncOnce(
  slot: TailSlot,
  file: string,
  wanted: WantedConsumer[],
  fileStat: fs.Stats,
) {
  let state = usableState(slot.state, fileStat);
  if (state && fileStat.size === state.offset + state.tail.length && hasAll(state, wanted))
    return state;
  const handle = await fs.promises.open(file, "r");
  try {
    if (state && !(await stillSame(handle, state))) state = undefined;
    state ??= {
      ino: fileStat.ino,
      offset: 0,
      anchor: Buffer.alloc(0),
      tail: Buffer.alloc(0),
      tailFed: false,
      mtimeMs: fileStat.mtimeMs,
      consumers: new Map(),
    };
    slot.state = state;
    const added: LineConsumer[] = [];
    for (const w of wanted) {
      if (state.consumers.get(w.name)?.key === w.key) continue;
      const consumer = { key: w.key, impl: w.make() };
      state.consumers.set(w.name, consumer);
      added.push(consumer);
    }
    if (added.length && (state.offset || state.tailFed)) await catchUp(handle, state, added);
    await advance(handle, state, fileStat.size);
    state.mtimeMs = fileStat.mtimeMs;
    return state;
  } finally {
    await handle.close();
  }
}
async function syncTail(slot: TailSlot, file: string, wanted: WantedConsumer[]) {
  slot.touched = Date.now();
  for (let attempt = 0; ; attempt++) {
    let fileStat: fs.Stats;
    try {
      fileStat = await fs.promises.stat(file);
    } catch {
      slot.state = undefined;
      return null;
    }
    try {
      return await syncOnce(slot, file, wanted, fileStat);
    } catch (error) {
      slot.state = undefined;
      if (error instanceof TailReset && attempt < 2) continue; // file shrank or was rewritten: rescan
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  }
}
/** Serialize passes over one file so concurrent callers share one offset. */
function queued<T>(slot: TailSlot, job: () => Promise<T>): Promise<T> {
  const run = slot.chain.then(job, job);
  slot.chain = run.catch(() => undefined);
  return run;
}
function sweepIdle(context: TelemetryContext) {
  const now = Date.now();
  if (now - context.lastSweep < SWEEP_EVERY_MS) return;
  context.lastSweep = now;
  for (const [id, slot] of context.scans)
    if (now - slot.touched > IDLE_EVICT_MS) context.scans.delete(id);
}

function ledgerConsumer() {
  const ledger = new Map<string, Map<number, Sample>>();
  return {
    ledger,
    feed(line: string) {
      try {
        const row = JSON.parse(line);
        const sample = ledgerSample(row);
        if (!sample) return;
        const turns = ledger.get(row.thread) ?? new Map<number, Sample>();
        if (hasTokens(sample) || !hasTokens(turns.get(row.ts))) turns.set(row.ts, sample);
        ledger.set(row.thread, turns);
      } catch {} // An incomplete append must not hide earlier completed turns.
    },
  };
}
// App-server usage reaches the turn ledger without being written to the conversation log.
async function codexLedger(context: TelemetryContext) {
  const file = path.join(context.options.dataDir, "turns.jsonl");
  const state = await queued(context.ledger, () =>
    syncTail(context.ledger, file, [{ name: "ledger", key: "", make: ledgerConsumer }]),
  );
  return (
    (state?.consumers.get("ledger")?.impl as ReturnType<typeof ledgerConsumer> | undefined)
      ?.ledger ?? new Map<string, Map<number, Sample>>()
  );
}
function textsConsumer() {
  const texts: string[] = [];
  return {
    texts,
    feed(line: string) {
      if (!line.includes('"user_input"')) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "user_input" && typeof event.text === "string")
          texts.push(event.text.slice(0, 4000));
      } catch {}
    },
  };
}
type SampleMeta = { id: string; provider: string; model?: string; createdAt?: number };
async function scanLog(
  context: TelemetryContext,
  id: string,
  meta?: SampleMeta,
): Promise<LogScan | null> {
  sweepIdle(context);
  const slot = context.scans.get(id) ?? newSlot();
  context.scans.set(id, slot);
  const wanted: WantedConsumer[] = [
    { name: "texts", key: "", make: textsConsumer },
    { name: "raised", key: "", make: raisedReplayer },
  ];
  if (meta)
    wanted.push({
      name: "samples",
      key: JSON.stringify([meta.provider, meta.model, meta.createdAt]),
      make: () => accountingReplayer(meta),
    });
  const file = path.join(context.options.dataDir, "logs", `${id}.jsonl`);
  const state = await queued(slot, () => syncTail(slot, file, wanted));
  if (!state) {
    context.scans.delete(id);
    return null;
  }
  const impl = (name: string) => state.consumers.get(name)?.impl as any;
  return {
    texts: [...impl("texts").texts],
    raised: [...impl("raised").raised],
    samples: meta ? [...impl("samples").samples] : undefined,
  };
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
async function factsOf(context: TelemetryContext, thread: TelemetryThread): Promise<ThreadFacts> {
  const scan = await scanLog(context, thread.id);
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
  return { thread, facts: await factsOf(context, thread) };
}
async function threadSamples(
  context: TelemetryContext,
  thread: TelemetryThread,
  ledger: Map<string, Map<number, Sample>>,
) {
  const scan = await scanLog(context, thread.id, {
    id: thread.id,
    provider: thread.provider,
    model: thread.model,
    createdAt: thread.createdAt,
  });
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
  const ledger = await codexLedger(context);
  for (const raw of await context.threads()) {
    const { thread, facts } = await prepared(context, raw);
    if (!linkThread({ thread: facts, repos, item: req }).linked) continue;
    runs.push({
      thread: thread.id,
      title: thread.title,
      provider: thread.provider,
      model: thread.model,
      createdAt: thread.createdAt,
      samples: await threadSamples(context, thread, ledger),
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
  context.ledger = newSlot();
  context.gitInfo.clear();
  for (const timer of context.timers.values()) clearTimeout(timer);
  context.timers.clear();
}

// threads.json is large and rewritten rarely compared with how often syncs run: parse it only when it changes.
function cachedThreads(file: string) {
  let cached: { key: string; threads: TelemetryThread[] } | undefined;
  return async () => {
    const fileStat = await fs.promises.stat(file);
    const key = `${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
    if (cached?.key === key) return cached.threads;
    const threads = JSON.parse(await fs.promises.readFile(file, "utf8"));
    cached = { key, threads };
    return threads as TelemetryThread[];
  };
}

export function createTelemetryService(options: TelemetryOptions) {
  const threadsFile = path.join(options.dataDir, "threads.json");
  const context: TelemetryContext = {
    options,
    github: options.github ?? githubRequest,
    git: options.git ?? defaultGit,
    delay: options.debounceMs ?? 20_000,
    threads: options.threads ?? cachedThreads(threadsFile),
    scans: new Map<string, TailSlot>(),
    ledger: newSlot(),
    lastSweep: Date.now(),
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
