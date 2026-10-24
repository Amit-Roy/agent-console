import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Run, Task, TaskInput } from "../schedules.ts";
import type { StepId } from "./contracts.ts";
import type { EventLog } from "./events.ts";

// The nightly "dream": an agent consolidates the shared brain. The server does the two jobs an agent should not grade itself on.
//   gather (before the run): one signal file with what changed since the last good dream
//   verify (after the run):  brain lint passes, and the agent touched nothing outside wiki/, ops/ and tags/

export const DREAM_TASK_ID = "dream";
export const DREAM_TITLE = "Dream: brain consolidation";
export const DREAM_LIMIT_MIN = 90;
const DAY_MS = 86_400_000;
const SECTION_CAP = 20_000; // characters kept per section of the signal file
const SESSION_CAP = 200;
const ALLOWED_PREFIXES = ["wiki/", "ops/", "tags/"];
const TAG_PREFIX = "tags/";

type RecentSession = { id: string; provider: string; title: string; mtime: number; lines: number };
export interface DreamDeps {
  /** Root of the brain repository, from the same place providers/brain.ts finds it. */
  brainRoot: string;
  brainBin: string;
  /** The console's data directory: the signal file lives under <dataDir>/dream/. */
  dataDir: string;
  sessions: { recent(query: { since: number; limit?: number }): Promise<RecentSession[]> };
  events: Pick<EventLog, "record">;
  now?: () => number;
}

interface Started {
  head: string;
}

const clip = (text: string) =>
  text.length > SECTION_CAP
    ? `${text.slice(0, SECTION_CAP)}\n[... cut at ${SECTION_CAP} characters]`
    : text;

function runTool(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const out = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 << 20,
  });
  return {
    status: out.status ?? -1,
    text: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim(),
    failed: out.error?.message,
  };
}

/** Entries of wiki/log.md ("## [YYYY-MM-DD] op | title" plus detail lines) dated on or after `sinceDate`. */
export function logEntriesSince(logText: string, sinceDate: string): string {
  const entries = logText.split(/^(?=## \[\d{4}-\d{2}-\d{2}\])/m);
  const kept = entries.filter((entry) => {
    const date = /^## \[(\d{4}-\d{2}-\d{2})\]/.exec(entry)?.[1];
    return date !== undefined && date >= sinceDate;
  });
  return kept.join("").trim();
}

/** Paths from `git diff --name-only -z` / `git ls-files -z` output. */
const nulList = (text: string) => text.split("\0").filter(Boolean);

interface DreamContext extends DreamDeps {
  signalFile: string;
  promptFile: string;
  started: Map<string, Started>; // run id -> state at the start of that run
}

const gitIn = (ctx: DreamContext, ...args: string[]) =>
  runTool("git", ["-C", ctx.brainRoot, ...args], ctx.brainRoot);
const lintIn = (ctx: DreamContext) =>
  runTool(ctx.brainBin, ["lint"], ctx.brainRoot, {
    ...process.env,
    BRAIN_DIR: ctx.brainRoot,
    BRAIN_NO_NUDGE: "1",
  });
const nowOf = (ctx: DreamContext) => (ctx.now ?? Date.now)();

function note(
  ctx: DreamContext,
  step: StepId,
  kind: "start" | "ok" | "fail",
  run: Run,
  msg?: string,
  data?: Record<string, unknown>,
) {
  ctx.events.record({ step, kind, run: run.id, ref: DREAM_TASK_ID, msg, data });
}

/** Where this dream's window starts: the last successful run, else 24 hours ago. */
function windowStart(ctx: DreamContext, task: Task, run: Run): number {
  const last = task.runs.findLast((past) => past.id !== run.id && past.status === "done");
  return last?.at ?? nowOf(ctx) - DAY_MS;
}

function sessionsSection(sessions: RecentSession[], timeZone: string): string {
  if (!sessions.length) return "None.";
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  });
  return sessions
    .map(
      (session) =>
        `- ${session.id} | ${session.provider} | ${session.title} | ${format.format(session.mtime)} | ${session.lines} lines`,
    )
    .join("\n");
}

function readLog(ctx: DreamContext, sinceDate: string): string {
  try {
    const text = fs.readFileSync(path.join(ctx.brainRoot, "wiki", "log.md"), "utf8");
    return logEntriesSince(text, sinceDate);
  } catch {
    return "";
  }
}

function writeAtomic(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, body, { mode: 0o600 });
  fs.renameSync(partial, file);
}

async function gather(ctx: DreamContext, task: Task, run: Run): Promise<void> {
  const since = windowStart(ctx, task, run);
  const sinceIso = new Date(since).toISOString();
  const head = gitIn(ctx, "rev-parse", "HEAD");
  if (head.status !== 0)
    throw new Error(`The brain repository has no HEAD: ${head.text || head.failed}`);
  const sessions = await ctx.sessions.recent({ since, limit: SESSION_CAP });
  const commits = gitIn(
    ctx,
    "log",
    "--name-only",
    "--date=short",
    "--format=commit %h %ad %s",
    `--since=${sinceIso}`,
  );
  const lintOut = lintIn(ctx);
  const body = [
    "# Dream signal",
    "",
    `Generated: ${new Date(nowOf(ctx)).toISOString()}`,
    `Window: sessions and changes since ${sinceIso}`,
    `Brain repository: ${ctx.brainRoot}`,
    `Starting HEAD: ${head.text}`,
    "",
    `## Sessions since ${sinceIso} (${sessions.length}, newest first)`,
    sessionsSection(sessions, task.tz),
    "",
    `## wiki/log.md entries since ${sinceIso.slice(0, 10)}`,
    clip(readLog(ctx, sinceIso.slice(0, 10))) || "None.",
    "",
    "## Brain commits since the window start (git log --name-only)",
    clip(commits.text) || "None.",
    "",
    `## brain lint (exit ${lintOut.status})`,
    clip(lintOut.text) || "No output.",
    "",
  ].join("\n");
  writeAtomic(ctx.signalFile, body);
  ctx.started.set(run.id, { head: head.text });
  note(
    ctx,
    "dream_gather",
    "ok",
    run,
    `${sessions.length} sessions since ${sinceIso.slice(0, 16)}Z`,
    {
      sessions: sessions.length,
      since,
    },
  );
}

/** Schedules.onRunStart: gather, then the agent step opens. A failure here fails the run before any thread starts. */
async function start(ctx: DreamContext, task: Task, run: Run): Promise<void> {
  note(ctx, "dream_gather", "start", run);
  try {
    await gather(ctx, task, run);
  } catch (err: any) {
    note(ctx, "dream_gather", "fail", run, err?.message || "The signal file could not be written.");
    throw err;
  }
  note(ctx, "dream_run", "start", run, `${task.model} ${task.effort ?? ""}`.trim());
}

/** Changed paths since the run began: committed or not, tracked or new. */
function changedPaths(ctx: DreamContext, head: string): { paths: string[]; error?: string } {
  const diff = gitIn(ctx, "diff", "--name-only", "-z", head);
  const fresh = gitIn(ctx, "ls-files", "--others", "--exclude-standard", "-z");
  const broken = [diff, fresh].find((result) => result.status !== 0);
  if (broken) return { paths: [], error: `git failed: ${broken.text || broken.failed}` };
  return { paths: [...new Set([...nulList(diff.text), ...nulList(fresh.text)])].sort() };
}

function verifyProblems(ctx: DreamContext, begin: Started | undefined) {
  const problems: string[] = [];
  const lintOut = lintIn(ctx);
  if (lintOut.status !== 0) problems.push(`brain lint exit ${lintOut.status}`);
  let paths: string[] = [];
  if (!begin) problems.push("starting HEAD unknown (the server restarted during the run)");
  else {
    const changed = changedPaths(ctx, begin.head);
    paths = changed.paths;
    if (changed.error) problems.push(changed.error);
  }
  const outside = paths.filter(
    (file) => !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
  if (outside.length) problems.push(`changed outside wiki/, ops/, tags/: ${outside.join(", ")}`);
  return { problems, paths, outside };
}

function verify(ctx: DreamContext, run: Run): void {
  const begin = ctx.started.get(run.id);
  ctx.started.delete(run.id);
  note(ctx, "dream_verify", "start", run);
  const { problems, paths, outside } = verifyProblems(ctx, begin);
  // pagesChanged: files under wiki/ and ops/; tagsChanged: files under tags/
  const tagsChanged = paths.filter((file) => file.startsWith(TAG_PREFIX)).length;
  const pagesChanged = paths.length - tagsChanged - outside.length;
  const data = {
    cost: run.cost,
    tokens: run.tokens,
    ms: run.ms,
    pagesChanged,
    tagsChanged,
    ...(outside.length ? { outside } : {}),
  };
  if (problems.length) note(ctx, "dream_verify", "fail", run, problems.join("; "), data);
  else
    note(ctx, "dream_verify", "ok", run, `${pagesChanged} pages, ${tagsChanged} tag files`, data);
}

/** Schedules.onRunEnd: close the agent step with its cost, then verify what it changed. */
function end(ctx: DreamContext, run: Run): void {
  const detail = { cost: run.cost, tokens: run.tokens, ms: run.ms };
  if (run.status === "done") note(ctx, "dream_run", "ok", run, "agent finished", detail);
  else note(ctx, "dream_run", "fail", run, run.reason || "the run did not finish", detail);
  verify(ctx, run);
}

export function createDream(deps: DreamDeps) {
  const signalFile = path.join(deps.dataDir, "dream", "signal.md");
  const promptFile = path.join(deps.brainRoot, "config", "dream-prompt.md");
  const ctx: DreamContext = { ...deps, signalFile, promptFile, started: new Map() };
  /** The built-in task, for Schedules.ensureTask. */
  const spec: TaskInput = {
    title: DREAM_TITLE,
    prompt: `Run the brain dream consolidation. Follow ${promptFile} exactly. Signal file: ${signalFile}.`,
    provider: "claude",
    model: "sonnet",
    effort: "high",
    mode: "bypassPermissions",
    cwd: deps.brainRoot,
    repeat: "daily",
    time: "04:30",
    enabled: true,
    saveOutput: true,
    limitMin: DREAM_LIMIT_MIN,
  };
  return {
    spec,
    signalFile,
    promptFile,
    onRunStart: (task: Task, run: Run) => start(ctx, task, run),
    onRunEnd: (_task: Task, run: Run) => end(ctx, run),
  };
}
export type Dream = ReturnType<typeof createDream>;
