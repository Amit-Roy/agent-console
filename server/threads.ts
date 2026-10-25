import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexAccounting,
  type ModelUsage,
  piAccounting,
  type SessionAccounting,
} from "./accounting.ts";
import { repairAccounting } from "./accounting-repair.ts";
import { backfill, readTurns, recordTurn, restoreAccounting, type Turn } from "./analytics.ts";
import { DATA_DIR } from "./auth.ts";
import { AUTO_CONTINUE_PROMPT, autoContinueEnabled } from "./auto-continue.ts";
import { redact } from "./automation/events.ts";
import { assertAutomationSandbox } from "./automation/sandbox.ts";
import { CONSOLE_COMMANDS, commandList, parseCommand } from "./commands.ts";
import { recentPreamble, replayPreamble } from "./export.ts";
import { headroom } from "./headroom.ts";
import { HistoryIndex } from "./history.ts";
import { historyWireEvent } from "./history-wire.ts";
import {
  IdleCompactionTimers,
  idleCompactionDeadline,
  idleCompactionPolicy,
} from "./idle-compaction.ts";
import type { ThreadNotice } from "./notifications.ts";
import { brainCommit } from "./providers/brain.ts";
import {
  type ClaudeAccount,
  claudeUsageKey,
  normalizeClaudeAccount,
  requireClaudeAccount,
} from "./providers/claude-accounts.ts";
import { CodexTelemetry } from "./providers/codex-telemetry.ts";
import {
  type Agent,
  type AgentCtx,
  type Command,
  clip,
  DEFAULT_PROVIDER,
  type ExitInfo,
  type Mode,
  PROVIDERS,
  type Provider,
  type ThreadSpec,
} from "./providers/index.ts";
import {
  createLabeler,
  editSketch,
  type Labeler,
  mcpSketch,
  needsLabel,
  readSketch,
} from "./providers/label.ts";
import {
  AUTOMATION_PI_MODELS,
  isAutomationPiModel,
  selectAutomationPiModel,
} from "./providers/pi-model.ts";
import { suggestTitle, titleText } from "./providers/title.ts";
import { type PendingQuestion, Questions } from "./questions.ts";
import { fromProcess, runFacts, TurnClock, TurnTimingStore } from "./turn-timing.ts";
import {
  MAX_ATTACHMENTS,
  removeUploads,
  resolveAttachments,
  threadDir,
  withFileList,
} from "./uploads.ts";
import { claudeWindows, codexWindows, usage } from "./usage.ts";
import { detectUsageStop } from "./usage-stop.ts";
import { type IssueRun, ROUTES } from "./window-dispatch.ts";

export type { Command, Mode };

export interface Thread {
  workState?: { version: 1; foreground: string[]; background: string[]; backgroundCount: number };
  id: string;
  provider: string;
  title: string;
  autoTitle?: boolean; // still carries the folder-name default: the first message renames it (cleared by a manual rename)
  titleLocked?: boolean; // the user chose this title (at creation or by renaming): the title helper never rewrites it. Threads from before this flag count as unlocked
  recent?: string[]; // legacy: the title helper now reads every user message from the thread log
  cwd: string;
  mode: Mode;
  model: string;
  effort?: string;
  advisor?: string;
  claudeAccount?: ClaudeAccount;
  idleCompaction?: boolean;
  idleCompactionTtlMs?: number;
  idleCompactionSource?: string;
  idleCompactionLeadMs?: number;
  idleCompactionMinTokens?: number;
  resolvedModel?: string;
  idleCompactionDueAt?: number;
  lastUserActivityAt?: number;
  lastProviderActivityAt?: number;
  idleCompactionConsumedAt?: number;
  lastRun?: {
    model?: string;
    effort?: string;
    source?: string;
    duration_ms?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    timing?: ReturnType<typeof runFacts>;
  };
  sessionId?: string;
  forkFrom?: string; // forked from a Claude session: the first run continues a copy of it (cleared once the fork has its own session id)
  context?: { used?: number; max?: number; source?: string }; // tokens in the agent's context now, and the model's window when the harness reports it
  replay?: boolean; // forked from an agent with no native fork: the first message carries the earlier conversation as text
  replayLimit?: number; // explicit short handoff instead of native session or full text replay
  status: "idle" | "running";
  waiting?: number; // unanswered blocking requests or persistent async questions
  background?: number; // background subagents still working after the turn ended; their completion wakes the agent
  operation?: "compact";
  lastCompactedAt?: number;
  archived?: number; // when it was archived: it leaves the working list until unarchived or sent to again
  quotaPaused?: { provider: string; windowLabel: string; resetsAt: number }; // paused due to quota exhaustion; auto-resumes late in a later window (see resumeDue)
  schedule?: { task: string; run: string }; // a scheduled task's run: the sidebar files it under its task
  issueRun?: IssueRun; // started by window-dispatch for a GitHub issue
  usageStop?: { provider: string; at: number; resetsAt?: number; text: string }; // last turn ended on a usage limit; cleared when the next turn starts
  replyAt?: number; // when the last non-compaction turn ended
  readAt?: number; // when the user last viewed the thread
  cost: number;
  costMeasured?: boolean;
  createdAt: number;
  updatedAt: number;
}

type Emit = (msg: unknown) => void;

const THREADS_FILE = path.join(DATA_DIR, "threads.json");
const COMMANDS_FILE = path.join(DATA_DIR, "commands.json");
const QUEUES_FILE = path.join(DATA_DIR, "queues.json");
const QUESTIONS_FILE = path.join(DATA_DIR, "questions.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

// Thread ids reach file paths, so only plain names pass: no dots or slashes that could leave the data folder.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const safeId = (threadId: unknown): threadId is string =>
  typeof threadId === "string" && SAFE_ID.test(threadId);

// The only way to build a transcript path.
function logFile(threadId: string): string {
  if (!safeId(threadId)) throw new Error("Invalid thread id.");
  return path.join(LOG_DIR, `${threadId}.jsonl`);
}

// An idle agent keeps its process (warm next turn: ~0.3 s to start instead of ~20 s) for up to IDLE_KILL_MS. Idle processes are
// capped at IDLE_MAX, oldest killed first, and all but the newest two go early when available memory drops under IDLE_MEM_FLOOR.
const IDLE_KILL_MS = Number(process.env.AGENT_CONSOLE_IDLE_MS ?? 30 * 60 * 1000);
const IDLE_MAX = Number(process.env.AGENT_CONSOLE_IDLE_MAX ?? 8);
const IDLE_MEM_FLOOR = 0.2;
// Pre-warm: opening/focusing a thread spawns its idle agent so the first send skips the harness cold start. Spawning sends no
// prompt and makes no model request (verified per harness). At most WARM_MAX unused processes; unused ones are reaped sooner.
const WARM_MAX = Number(process.env.AGENT_CONSOLE_WARM_MAX ?? 2);
const WARM_IDLE_MS = 10 * 60 * 1000;
// Background tasks keep an idle thread's agent alive and block restart-when-idle. Claude caps a background command at 2 hours
// and a working subagent reports progress, so tasks silent for longer than this are hung: the sweep kills the agent.
const BACKGROUND_STALE_MS = Number(
  process.env.AGENT_CONSOLE_BACKGROUND_STALE_MS ?? 135 * 60 * 1000,
);
// A running turn streams tokens, tool results or progress; a foreground tool call is capped at 10 minutes. A turn silent for longer
// than this, with no blocking question waiting on the user, is hung and would block restart-when-idle forever: the sweep ends it.
const TURN_STALE_MS = Number(process.env.AGENT_CONSOLE_TURN_STALE_MS ?? 30 * 60 * 1000);

// First-party turn timing (metadata only, never sent anywhere). Unavailable storage must never affect a turn.
let timing: TurnTimingStore | undefined;
try {
  timing = new TurnTimingStore(path.join(DATA_DIR, "latency.sqlite"));
} catch {
  console.warn("Turn timing storage is unavailable.");
}
export const turnTiming = () => timing;
const timed = (fn: () => void) => {
  try {
    fn();
  } catch {}
};

// Chatter the UI never shows. Dropped before it is logged or sent (and filtered from older logs): a long Claude thread was 15% of it.
const NOISE = new Set([
  "system/thinking_tokens",
  "system/status",
  "system/hook_started",
  "system/hook_response",
  "system/task_updated",
  "system/background_tasks_changed",
  "tool_progress",
]);
const kindOf = (e: any) => `${e?.type}${e?.subtype ? "/" + e.subtype : ""}`;
const PAGE = Number(process.env.AGENT_CONSOLE_PAGE) || 40; // events the UI gets when it opens a thread; older ones load on request
const PAGE_BYTES = Number(process.env.AGENT_CONSOLE_PAGE_BYTES) || 96_000; // sent JSON per page: a page widened back to its turn's start can exceed 150 events
const RESULT_CLIP = 4000; // tool output in replayed history (the card shows at most 8000 anyway, and live output is already clipped at 20000)
const MAX_QUEUE = 20;

interface Queued {
  id: string;
  text: string;
  attachments: unknown; // [{id,n}] as sent by the browser; resolved when the message is actually sent
  revision: number;
  editing?: boolean;
  questionAnswer?: true;
  at?: number; // when it was queued: queue wait in turn timing
}
const attachList = (q: Queued): any[] => (Array.isArray(q.attachments) ? q.attachments : []);
// The newest Claude rate-limit event in a log. Boot restores one per thread: read only the tail, never the transcript.
function lastClaudeWindows(file: string, provider: string) {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    for (const span of [64 * 1024, 4 * 1024 * 1024]) {
      const start = Math.max(0, size - span),
        buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const found = scanWindowsTail(buf, start, provider);
      if (found) return found;
      if (start === 0) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

// Newest usable rate-limit line in one tail buffer; `start` is the buffer's offset in the file.
function scanWindowsTail(buf: Buffer, start: number, provider: string) {
  for (
    let hit = buf.lastIndexOf('"unifiedWindows"');
    hit !== -1;
    hit = buf.lastIndexOf('"unifiedWindows"', hit - 1)
  ) {
    const from = buf.lastIndexOf(10, hit) + 1;
    if (from === 0 && start > 0) break; // the line began before this window
    const found = parseWindowsLine(buf, from, hit, provider);
    if (found) return found;
    if (from === 0) break;
    hit = from;
  }
  return undefined;
}

function parseWindowsLine(buf: Buffer, from: number, hit: number, provider: string) {
  const lineEnd = buf.indexOf(10, hit);
  try {
    const event = JSON.parse(buf.toString("utf8", from, lineEnd === -1 ? buf.length : lineEnd));
    if (
      Number.isFinite(event.observedAt) &&
      event.usageProvider === provider &&
      claudeWindows(event).length
    )
      return event;
  } catch {}
  return undefined;
}

// Boot: record the newest Claude rate-limit event from this thread's log.
function recordClaudeUsage(thread: Thread) {
  const key = claudeUsageKey(thread.claudeAccount);
  const last = lastClaudeWindows(logFile(thread.id), key);
  if (!last || !Number.isFinite(last.observedAt) || last.usageProvider !== key) return;
  usage.record(last.usageProvider, { windows: claudeWindows(last) }, last.observedAt, {
    observedAt: last.observedAt,
    usageProvider: last.usageProvider,
    ...(typeof last.session_id === "string" && typeof last.uuid === "string"
      ? { sourceSessionId: last.session_id, sourceEventUuid: last.uuid }
      : {}),
  });
}

// Fold one Codex telemetry sample into the thread's context window facts.
function applyCodexSample(thread: Thread, sample: any) {
  const context = sample.context;
  if (!context) return;
  if (!("reset" in context)) {
    thread.context = { ...thread.context, ...context };
    return;
  }
  thread.context = { max: thread.context?.max, source: context.source };
  thread.lastCompactedAt = sample.observedAt || thread.lastCompactedAt;
}

// A saved thread after a restart: nothing survives, so it is idle. False drops it (unknown Claude account).
function reviveThread(thread: Thread): boolean {
  thread.status = "idle"; // nothing survives a server restart
  delete thread.waiting;
  delete thread.operation;
  delete thread.background;
  thread.provider ||= DEFAULT_PROVIDER;
  thread.readAt ??= thread.replyAt ?? thread.updatedAt;
  if (thread.provider === "claude") {
    try {
      thread.claudeAccount = normalizeClaudeAccount(thread.claudeAccount);
    } catch {
      console.warn("Skipped a thread with an unknown Claude account.");
      return false;
    }
  }
  if (thread.provider === "codex" && thread.context?.source !== "codex/last_request")
    delete thread.context;
  return true;
}

function sanitizeQueued(items: Queued[]): Queued[] {
  return items
    .filter(
      (item) =>
        typeof item.id === "string" && typeof item.text === "string" && item.text.length <= 100_000,
    )
    .slice(0, MAX_QUEUE)
    .map((item) => ({
      ...item,
      revision: Number.isSafeInteger(item.revision) ? item.revision : 0,
      editing: item.editing === true,
    }));
}

type SendOptions = {
  auto?: "brain" | "subagent" | "quota-resume" | "continue";
  attachments?: unknown;
  mode?: "steer" | "queue";
  delivery?: "queued";
  questionAnswer?: true;
  queuedAt?: number;
  instructions?: string;
  scheduled?: string;
};

type CreateOptions = {
  claudeAccount?: string;
  provider?: string;
  cwd: string;
  mode?: Mode;
  model?: string;
  effort?: string;
  title?: string;
  schedule?: Thread["schedule"];
  issueRun?: Thread["issueRun"];
};

type ThreadPatch = {
  claudeAccount?: string;
  mode?: Mode;
  model?: string;
  effort?: string;
  advisor?: string;
  title?: string;
  idleCompaction?: boolean;
};

// The attachment fields a transcript event carries.
function attachmentSummary(attachments: ReturnType<typeof resolveAttachments>) {
  if (!attachments.length) return {};
  return {
    attachments: attachments.map((file) => ({
      id: file.id,
      name: file.name,
      kind: file.kind,
      media_type: file.media_type,
      size: file.size,
      ...(file.n ? { n: file.n } : {}),
    })),
  };
}

function userInputEvent(
  text: string,
  opts: SendOptions,
  attachments: ReturnType<typeof resolveAttachments>,
) {
  return {
    type: "user_input",
    text,
    ts: Date.now(),
    ...(opts.auto ? { auto: opts.auto } : {}),
    ...(opts.delivery ? { delivery: opts.delivery } : {}),
    ...(opts.questionAnswer ? { questionAnswer: true } : {}),
    ...(opts.scheduled ? { scheduled: opts.scheduled } : {}),
    ...attachmentSummary(attachments),
  };
}

// Validate a requested Claude account switch; a change is refused once a session exists.
function accountSelection(thread: Thread, requested: string | undefined) {
  if (requested === undefined)
    return { accountChanged: false, selectedAccount: undefined as ClaudeAccount | undefined };
  if (thread.provider !== "claude")
    throw new Error("Account selection is available only for Claude threads.");
  const account = normalizeClaudeAccount(requested);
  const accountChanged = account !== normalizeClaudeAccount(thread.claudeAccount);
  if (accountChanged && (thread.status === "running" || thread.sessionId || thread.forkFrom))
    throw new Error(
      "Choose the Claude account in a new thread. Existing sessions keep their original account.",
    );
  requireClaudeAccount(account);
  return { accountChanged, selectedAccount: account as ClaudeAccount | undefined };
}

// Drop patch fields the provider does not offer.
function sanitizePatch(prov: ReturnType<typeof PROVIDERS.get>, patch: ThreadPatch) {
  if (patch.mode && !prov?.modes.includes(patch.mode)) patch.mode = undefined;
  if (patch.model && !prov?.models().includes(patch.model)) patch.model = undefined;
  if (patch.advisor && patch.advisor !== "default" && !prov?.advisors?.includes(patch.advisor))
    patch.advisor = undefined;
}

// Tool output in replayed history is clipped to what the card shows.
function clipToolResults(entry: any) {
  if (entry?.type !== "user" || !Array.isArray(entry.message?.content)) return entry;
  return {
    ...entry,
    message: { ...entry.message, content: entry.message.content.map(clipResultBlock) },
  };
}

function clipResultBlock(block: any) {
  const clippable =
    block?.type === "tool_result" &&
    typeof block.content === "string" &&
    block.content.length > RESULT_CLIP;
  return clippable ? { ...block, content: clip(block.content, RESULT_CLIP) } : block;
}

// Too big: begin at the earliest later user message that fits, else just the newest PAGE events (mid-turn, like an unaligned page).
function pageCut(
  items: { e: any; size: number }[],
  total: number,
  maxBytes: number,
  limit: number,
) {
  let rest = total;
  const cut = items.findIndex(
    (item) => (rest -= item.size) + item.size <= maxBytes && item.e?.type === "user_input",
  );
  return cut < 0 ? Math.max(0, items.length - limit) : cut;
}

// The accounting row for a finished turn.
function turnRow(thread: Thread, event: any, turn: TurnState, measured: any): Turn {
  const row: Turn = {
    ts: turn.start,
    thread: thread.id,
    provider: thread.provider,
    model: thread.lastRun?.model || thread.model,
    effort: thread.effort,
    ms: event.duration_ms,
    accounting: 2,
  };
  if (Object.keys(turn.tools).length) row.tools = turn.tools;
  if (event.is_error) row.err = 1;
  if (measured) Object.assign(row, measured);
  else if (thread.provider === "codex") Object.assign(row, codexAccounting(turn.usage, row.model!));
  else if (event.usageModels) Object.assign(row, piAccounting(event.usageModels));
  return row;
}

// One prompt from several queued messages. "[Image #n]" is numbered per message, so renumber to keep the references unambiguous.
function mergeQueued(items: Queued[]): {
  text: string;
  attachments: unknown;
  questionAnswer?: true;
} {
  if (items.length === 1)
    return {
      text: items[0].text,
      attachments: items[0].attachments,
      ...(items[0].questionAnswer ? { questionAnswer: true } : {}),
    };
  let next = 0;
  const attachments: any[] = [];
  const parts = items.map((item) => {
    const renumber = new Map<number, number>();
    for (const a of attachList(item)) {
      if (Number.isInteger(a?.n)) renumber.set(a.n, ++next);
      attachments.push(Number.isInteger(a?.n) ? { ...a, n: renumber.get(a.n) } : a);
    }
    return renumber.size
      ? item.text.replace(/\[Image #(\d+)\]/g, (m, k) =>
          renumber.has(+k) ? `[Image #${renumber.get(+k)}]` : m,
        )
      : item.text;
  });
  return {
    text: parts.filter((x) => x.trim()).join("\n\n"),
    attachments,
    ...(items.every((item) => item.questionAnswer) ? { questionAnswer: true } : {}),
  };
}
const queuePreview = ({ id, text, revision, editing }: Queued) => ({
  id,
  text: text.slice(0, 200),
  revision,
  editing: !!editing,
});

// what the usage dashboard needs to know about the turn in flight
interface TurnState {
  start: number;
  tools: Record<string, number>;
  usage?: any;
  models?: ModelUsage[];
  clock?: TurnClock;
  failureCode?: string; // codexErrorInfo kind of that console_error
  failure?: string; // newest console_error text; Codex and Pi report a failed turn there, not on the result
  bgTools?: Set<string>; // run_in_background tool calls that have not returned yet
}

const QUOTA_ERROR =
  /\b429\b|rate.?limit|too many requests|usage.?limit|quota|hit your (?:\w+ )?limit|limit reached|reached (?:your|the) (?:\w+[- ])?limit/i;

interface Live {
  foreground?: Set<string>;
  backgroundTools?: Set<string>;
  taskTools?: Map<string, string>;
  agent: Agent;
  aborted: boolean;
  proxyUrl?: string;
  recycleRouting?: boolean;
  warm?: boolean; // spawned ahead of a send and not used yet
  held?: any[]; // events from a starting or warm agent, replayed once a send uses it
  interrupting?: NodeJS.Timeout; // Stop asked the harness to end the turn; swallow events until its result
  rewarm?: boolean; // start a warm replacement once this process has exited
  compactConfirmed?: boolean;
  compactWait?: NodeJS.Timeout;
  spawnAt?: number; // process lifecycle for turn timing: spawn -> first process output, and why it ended
  readyAt?: number;
  heardAt?: number; // last event from the process, including progress noise
  exitReason?: string;
  model?: string; // resolved model id the process announced
  wakes?: string[]; // subagent results waiting for the agent to be free (harnesses that do not wake themselves)
}

// One event on its way through onEvent: steps may replace the event, and a failed result leaves its error for the issue-run hook
interface EventFlow {
  event: any;
  compacting: boolean; // the thread was compacting when the event arrived
  issueError?: string;
}

// The text of an error value: a string, or an object's string `message`
function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined;
}

// What an issue run reports for a failed turn: the result's errors and the turn's console failure, redacted and capped
function resultError(event: any, failure: string | undefined): string | undefined {
  const errors = [
    errorMessage(event.error),
    ...(Array.isArray(event.errors) ? event.errors.slice(0, 20).map(errorMessage) : []),
    failure,
  ].filter((error): error is string => typeof error === "string" && !!error.trim());
  return errors.length ? redact([...new Set(errors)].join("\n")).slice(0, 1000) : undefined;
}

// The command text the labeler reads for a tool call
function toolSketch(block: any): string {
  if (block.name === "Bash") return String(block.input.command ?? "");
  if (block.name === "Read") return readSketch(block.input);
  if (block.name === "Edit") return editSketch(block.input);
  return mcpSketch(block.name, block.input);
}

function prepareIssueRun(thread: Thread, prov: Provider) {
  assertAutomationSandbox(thread);
  // A model removed from the approved list (retired upstream) is re-selected, not kept: the run continues on a working model.
  if (thread.provider === "pi")
    thread.model = selectAutomationPiModel(
      prov.models(),
      isAutomationPiModel(thread.model) ? thread.model : undefined,
    );
}

// Claude and Codex go through Headroom unless the environment already points them at another endpoint
function headroomProxyUrl(provider: string) {
  const proxy = headroom.url();
  const inherited = (
    provider === "claude" ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL
  )?.replace(/\/+$/, "");
  const managed = provider === "claude" ? headroom.state().url : `${headroom.state().url}/v1`;
  return ["claude", "codex"].includes(provider) && (!inherited || inherited === managed)
    ? proxy
    : undefined;
}

function startSpec(thread: Thread): ThreadSpec {
  return {
    id: thread.id,
    cwd: thread.cwd,
    mode: thread.mode,
    model: thread.model,
    effort: thread.effort,
    advisor: thread.advisor,
    claudeAccount: thread.claudeAccount,
    sessionId: thread.sessionId,
    forkFrom: thread.sessionId ? undefined : thread.forkFrom,
    issueRun: thread.issueRun,
  };
}

type ForkPick = { model?: string; effort?: string; mode?: string; claudeAccount?: string };

// The other agent a fork switches to, checked ready; undefined when the fork stays on the source's agent
function forkTarget(src: Thread, provider?: string): Provider | undefined {
  if (!provider || provider === src.provider) return undefined;
  const target = PROVIDERS.get(provider);
  if (!target) throw new Error("Unknown provider.");
  const status = target.status();
  if (!status.ok) throw new Error(`${target.label} is not ready. ${status.hint ?? ""}`.trim());
  if (!target.defaultModel()) throw new Error(`${target.label} has no models available.`);
  return target;
}

function forkAccount(src: Thread, target: Provider | undefined) {
  if (!target && src.provider === "claude")
    return { claudeAccount: normalizeClaudeAccount(src.claudeAccount) };
  return target?.id === "claude" ? { claudeAccount: "sunny" as const } : {};
}

// The fork before the caller's picks: another agent starts on its defaults, the same agent keeps the source's settings
function forkedThread(src: Thread, target: Provider | undefined, recent: boolean): Thread {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    provider: target?.id ?? src.provider,
    title: `${src.title.replace(/\s*\(fork\)$/, "").slice(0, 70)} (fork)`,
    cwd: src.cwd,
    mode: target ? (target.modes.includes(src.mode) ? src.mode : target.defaultMode) : src.mode,
    model: target ? target.defaultModel() : src.model,
    effort: target ? "default" : src.effort,
    advisor: target ? undefined : src.advisor,
    ...forkAccount(src, target),
    context: target || recent ? undefined : src.context,
    status: "idle",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    readAt: now,
  };
}

// Copy the history and uploads so the fork reads whole. True when there was history to copy.
function copyForkFiles(src: Thread, child: Thread): boolean {
  const hasHistory = fs.existsSync(logFile(src.id));
  if (hasHistory) fs.copyFileSync(logFile(src.id), logFile(child.id));
  if (fs.existsSync(threadDir(src.id)))
    fs.cpSync(threadDir(src.id), threadDir(child.id), { recursive: true });
  return hasHistory;
}

// How the fork carries the conversation on: a native Claude fork, a copied Pi session, or the history replayed as text
function carryForkSession(
  src: Thread,
  child: Thread,
  how: { recent: boolean; replayAll: boolean; hasHistory: boolean },
) {
  if (how.recent) {
    if (how.hasHistory) {
      child.replay = true;
      child.replayLimit = 6000;
    }
    return;
  }
  if (!how.replayAll && src.provider === "claude") {
    if (src.sessionId) child.forkFrom = src.sessionId;
    return;
  }
  if (!how.replayAll && src.provider === "pi") {
    const dir = path.join(DATA_DIR, "pi-sessions", src.id);
    if (fs.existsSync(dir))
      fs.cpSync(dir, path.join(DATA_DIR, "pi-sessions", child.id), { recursive: true });
    return;
  }
  if (how.hasHistory) child.replay = true;
}

export class Threads {
  private questions = new Questions();
  private idleCompactionTimers = new IdleCompactionTimers();
  private closed = false;
  private historyIndex = new HistoryIndex();
  private titling = new Map<string, number>(); // per thread: the newest title request, so a slow older answer cannot overwrite it
  private threads = new Map<string, Thread>();
  private live = new Map<string, Live>();
  private turns = new Map<string, TurnState>(); // the turn in flight, per thread
  private continueArmed = new Set<string>(); // threads whose newest turn came from the user: one auto-continue allowed
  // Replaying every Claude log takes a few hundred ms; only a finished turn needs the baselines, so boot leaves it to warmAccounting()
  private restoredAccounting?: SessionAccounting;
  private get accounting() {
    return (this.restoredAccounting ??= restoreAccounting([...this.threads.values()]));
  }
  warmAccounting() {
    void this.accounting;
  }
  private queues = new Map<string, Queued[]>(); // messages to send, in order, once the running turn ends
  private emit: Emit;
  private notificationTurns = new Set<string>();
  private onNotification?: (notice: ThreadNotice) => void;
  private labeler: Labeler; // plain-English labels for shell commands that arrive without a description
  private commands: Record<string, Command[]> = {}; // per provider: each harness has its own slash commands and skills
  onTurnEnd?: (t: Thread, ev: any) => void; // a scheduled run's turn ended (Schedules records the run)
  onIssueTurnEnd?: (t: Thread, ev: any) => void; // an issue run's turn ended (window-dispatch starts the review of trivial work)
  onTurnDone?: (t: Thread, ev: any) => void; // any thread's turn finished (token telemetry comments)
  constructor(emit: Emit, onNotification?: (notice: ThreadNotice) => void) {
    this.onNotification = onNotification;
    this.emit = emit;
    this.labeler = createLabeler((job, label) => {
      if (this.threads.has(job.thread))
        this.publish(job.thread, { type: "tool_label", tool_use_id: job.id, label });
    });
    this.loadCommands();
    this.loadThreads();
    this.loadQuestions();
    try {
      backfill([...this.threads.values()]);
    } catch {} // usage history from logs written before the dashboard existed
    this.loadCosts();
    this.loadQueues();
    for (const thread of this.threads.values()) this.refreshIdleCompaction(thread);
  }

  private loadCommands() {
    try {
      const cached = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
      this.commands = Array.isArray(cached) ? { claude: cached } : cached; // older versions cached a bare Claude list
    } catch {}
  }

  private loadThreads() {
    try {
      for (const saved of JSON.parse(fs.readFileSync(THREADS_FILE, "utf8")) as Thread[])
        if (reviveThread(saved)) {
          saved.workState = { version: 1, foreground: [], background: [], backgroundCount: 0 };
          this.threads.set(saved.id, saved);
        }
    } catch {}
  }

  private loadQuestions() {
    try {
      const saved = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
      for (const [threadId, requests] of Object.entries(saved)) {
        if (!this.threads.has(threadId) || !Array.isArray(requests)) continue;
        this.restoreAsyncQuestions(threadId, requests);
      }
    } catch {}
  }

  private restoreAsyncQuestions(threadId: string, requests: any[]) {
    for (const request of requests) {
      if (request?.async !== true) continue;
      try {
        this.questions.add(threadId, request);
      } catch {}
    }
    const count = this.questions.list(threadId).length;
    if (count) this.threads.get(threadId)!.waiting = count;
  }

  private loadCosts() {
    try {
      repairAccounting(DATA_DIR, true); // startup precedes new turns; preserves an exclusive original backup
      const rows = readTurns(0, Date.now(), Number.MAX_SAFE_INTEGER).filter(
        (row) => row.accounting === 2,
      );
      for (const thread of this.threads.values()) {
        const known = rows.filter((row) => row.thread === thread.id && row.cost != null);
        thread.cost = known.reduce((sum, row) => sum + row.cost!, 0);
        thread.costMeasured = known.length > 0;
      }
    } catch {
      /* malformed/incomplete legacy history must not stop the console */
    }
  }

  private loadQueues() {
    try {
      for (const [threadId, items] of Object.entries(
        JSON.parse(fs.readFileSync(QUEUES_FILE, "utf8")),
      ) as [string, Queued[]][]) {
        if (!this.threads.has(threadId) || !Array.isArray(items)) continue;
        this.queues.set(threadId, sanitizeQueued(items));
      }
      setImmediate(() => {
        for (const threadId of this.queues.keys()) this.drain(threadId);
      });
    } catch {}
  }

  // Rate limits and Codex context from provider logs. Each thread keeps its saved context meanwhile, so boot defers this until
  // after the server listens; open tabs get the refreshed usage and threads as events.
  restoreTelemetry() {
    for (const thread of this.threads.values()) {
      try {
        if (thread.provider === "claude") recordClaudeUsage(thread);
        if (thread.provider === "codex") this.restoreCodexTelemetry(thread);
      } catch {} // one unreadable log must not stop the rest
    }
  }

  private restoreCodexTelemetry(thread: Thread) {
    const samples = thread.sessionId ? new CodexTelemetry(thread.sessionId).read() : [];
    for (const sample of samples) applyCodexSample(thread, sample);
    const quota = samples.findLast((sample) => sample.rateLimits);
    if (quota) usage.record("codex", { windows: codexWindows(quota.rateLimits) }, quota.observedAt);
    if (!samples.length) return;
    this.refreshIdleCompaction(thread);
    this.emit({ t: "thread", thread });
  }

  private refreshIdleCompaction(t: Thread) {
    this.idleCompactionTimers.cancel(t.id);
    const policy = idleCompactionPolicy(t);
    t.idleCompactionTtlMs = policy.ttlMs;
    t.idleCompactionSource = policy.source;
    t.idleCompactionLeadMs = policy.leadMs;
    t.idleCompactionMinTokens = policy.minTokens;
    delete t.idleCompactionDueAt;
    const deadline = idleCompactionDeadline(t, policy, !!this.queues.get(t.id)?.length);
    if (t.background) return; // compaction restarts the agent process, which would kill its background subagents
    if (this.closed || deadline == null || deadline <= Date.now()) return;
    t.idleCompactionDueAt = deadline;
    const cycle = t.lastUserActivityAt;
    this.idleCompactionTimers.schedule(t.id, deadline, () => {
      const current = this.threads.get(t.id);
      if (this.closed || current !== t || t.lastUserActivityAt !== cycle || t.background) return;
      const currentPolicy = idleCompactionPolicy(t);
      if (idleCompactionDeadline(t, currentPolicy, !!this.queues.get(t.id)?.length) !== deadline) {
        this.refreshIdleCompaction(t);
        return;
      }
      // A stalled event loop must not buy compaction after the estimated cache expiry.
      t.idleCompactionConsumedAt = cycle;
      delete t.idleCompactionDueAt;
      this.persist();
      if (Date.now() >= t.lastProviderActivityAt! + currentPolicy.ttlMs!) {
        this.touch(t);
        return;
      }
      try {
        this.compact(t.id);
      } catch {
        this.touch(t);
      } // consume failed attempts; never create a paid retry loop
    });
  }

  getCommands(): Record<string, Command[]> {
    return Object.fromEntries(
      [...PROVIDERS.keys()].map((id) => [id, commandList(this.commands[id])]),
    );
  }

  list(): Thread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string) {
    return this.threads.get(id);
  }
  /** Snapshot only transcript-derived catalog text for the private cleanup pipe. */
  redactionCatalog() {
    return [...this.threads.values()].map(({ id: identifier, title, recent }) => ({
      id: identifier,
      title,
      ...(recent === undefined ? {} : { recent: [...recent] }),
    }));
  }

  /** Apply only fields that have not changed since the cleanup snapshot. */
  applyRedactionCatalog(
    before: { id: string; title: string; recent?: string[] }[],
    after: { id: string; title: string; recent?: string[] }[],
  ) {
    const changes = before.map((entry, index) => ({
      entry,
      cleaned: after[index],
      live: this.threads.get(entry.id),
    }));
    const stable = changes.every(
      ({ entry, live }) =>
        live &&
        live.title === entry.title &&
        JSON.stringify(live.recent) === JSON.stringify(entry.recent),
    );
    if (!stable || before.length !== this.threads.size) return false;
    for (const { live, cleaned } of changes) {
      live!.title = cleaned.title;
      live!.recent = cleaned.recent;
    }
    this.persist();
    for (const { live } of changes) this.emit({ t: "thread", thread: live! });
    return true;
  }

  getQuestions(): Record<string, PendingQuestion[]>;
  getQuestions(id: string): PendingQuestion[];
  getQuestions(id?: string) {
    return id === undefined ? this.questions.all() : this.questions.list(id);
  }

  answer(thread: string, id: string, answers: unknown, skip = false) {
    const request = this.questions.list(thread).find((q) => q.id === id);
    const result = this.questions.answer(
      thread,
      id,
      answers,
      this.live.get(thread)?.agent,
      skip,
      undefined,
      request?.async
        ? (reply) => {
            if (!reply.skip) {
              const text = request.questions
                .map((q) => `${q.question}\n${reply.answers[q.id].join(", ")}`)
                .join("\n\n");
              this.send(thread, text, { mode: "steer", questionAnswer: true });
            }
            return true;
          }
        : undefined,
    );
    this.publish(thread, result.event);
    this.updateWaiting(thread);
  }

  private updateWaiting(id: string) {
    const t = this.threads.get(id);
    if (!t) return;
    const count = this.questions.list(id).length;
    if (count) t.waiting = count;
    else delete t.waiting;
    const durable: Record<string, PendingQuestion[]> = {};
    for (const [key, requests] of Object.entries(this.questions.all())) {
      const asyncRequests = requests.filter((q) => q.async);
      if (asyncRequests.length) durable[key] = asyncRequests;
    }
    fs.writeFileSync(QUESTIONS_FILE + ".tmp", JSON.stringify(durable), { mode: 0o600 });
    fs.renameSync(QUESTIONS_FILE + ".tmp", QUESTIONS_FILE);
    this.refreshIdleCompaction(t);
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  private cancelQuestions(id: string, includeAsync = false) {
    const pending = this.questions.list(id).filter((q) => includeAsync || !q.async);
    for (const request of pending) {
      this.questions.remove(id, request.id);
      this.publish(id, {
        type: "question_answer",
        id: request.id,
        cancelled: true,
        ts: Date.now(),
      });
    }
    if (pending.length) this.updateWaiting(id);
  }
  private persist() {
    fs.writeFileSync(
      THREADS_FILE,
      JSON.stringify(
        [...this.threads.values()].map(({ workState: _workState, ...thread }) => thread),
        null,
        1,
      ),
      {
        mode: 0o600,
      },
    );
  }
  private touch(t: Thread) {
    t.updatedAt = Date.now();
    this.refreshIdleCompaction(t);
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  create(opts: CreateOptions): Thread {
    const prov = PROVIDERS.get(opts.provider || DEFAULT_PROVIDER);
    if (!prov) throw new Error("Unknown provider.");
    const status = prov.status();
    if (!status.ok) throw new Error(`${prov.label} is not ready. ${status.hint ?? ""}`.trim());
    const mode = opts.mode && prov.modes.includes(opts.mode) ? opts.mode : prov.defaultMode;
    const model =
      opts.issueRun && prov.id === "pi"
        ? selectAutomationPiModel(prov.models(), opts.model === "default" ? undefined : opts.model)
        : opts.model && prov.models().includes(opts.model)
          ? opts.model
          : prov.defaultModel();
    if (!model) throw new Error(`${prov.label} has no models available.`);
    if (opts.issueRun)
      assertAutomationSandbox({ id: "preflight", cwd: opts.cwd, issueRun: opts.issueRun });
    const thread = this.newThread(prov, opts, mode, model);
    this.threads.set(thread.id, thread);
    this.refreshIdleCompaction(thread);
    this.persist();
    this.emit({ t: "thread", thread });
    return thread;
  }

  private newThread(
    prov: NonNullable<ReturnType<typeof PROVIDERS.get>>,
    opts: CreateOptions,
    mode: Mode,
    model: string,
  ): Thread {
    const now = Date.now();
    const title = opts.title?.trim();
    return {
      id: crypto.randomUUID(),
      provider: prov.id,
      ...(prov.id === "claude" ? { claudeAccount: requireClaudeAccount(opts.claudeAccount) } : {}),
      title: title || path.basename(opts.cwd) || "thread",
      autoTitle: !title,
      ...(title ? { titleLocked: true } : {}),
      cwd: opts.cwd,
      mode,
      model,
      effort: this.validEffort(prov, model, opts.effort),
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
      ...(opts.issueRun ? { issueRun: opts.issueRun } : {}),
      status: "idle",
      cost: 0,
      createdAt: now,
      updatedAt: now,
      readAt: now,
    };
  }

  private validEffort(prov: any, model: string, effort?: string): string {
    if (!effort || effort === "default") return "default";
    if (!prov?.modelDetails?.()[model]?.efforts.includes(effort))
      throw new Error("Unsupported effort for this model.");
    return effort;
  }

  /** Soonest-known reset of the fullest future window in the ledger, if any. */
  private windowReset(providerKey: string): number | undefined {
    const now = Date.now();
    const windows = (usage.get(providerKey)?.windows ?? []).filter(
      (w) => w.resetsAt && w.resetsAt > now,
    );
    windows.sort((a, b) => b.used / (b.limit || 1) - a.used / (a.limit || 1));
    return windows[0]?.resetsAt;
  }

  // Viewing is not activity: updatedAt stays so ordering is unchanged
  markRead(id: string) {
    const t = this.threads.get(id);
    if (!t) return;
    t.readAt = Date.now();
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  // Filing a thread away is not activity: updatedAt stays, so it keeps its place in either list
  archive(id: string, archived: boolean) {
    const t = this.threads.get(id);
    if (!t || !!t.archived === archived) return;
    if (archived) t.archived = Date.now();
    else delete t.archived;
    // Clearing quotaPaused on archive prevents stale resume on unarchive
    if (archived) delete t.quotaPaused;
    if (archived && this.live.get(id)?.warm) this.kill(id, "archive");
    this.refreshIdleCompaction(t);
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  /** Resume all non-archived threads quota-paused on the given provider (usage key), optionally only those paused by one window. */
  resumeQuotaPaused(
    provider: string,
    windowLabel?: string,
    eligible?: (thread: Thread) => boolean,
  ) {
    let resumed = 0;
    for (const t of this.threads.values()) {
      if (t.archived || (eligible && !eligible(t))) continue;
      if (
        t.quotaPaused?.provider === provider &&
        (!windowLabel || t.quotaPaused.windowLabel === windowLabel)
      ) {
        delete t.quotaPaused;
        if (t.status === "running") continue; // the user already continued it; send would throw and abort the other resumes
        try {
          this.send(t.id, "Continue.", { auto: "quota-resume" });
          resumed++;
        } catch (error) {
          console.error(
            `[quota-resume] ${t.id}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
    return resumed;
  }

  update(threadId: string, patch: ThreadPatch) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const prov = PROVIDERS.get(thread.provider);
    const { accountChanged, selectedAccount } = accountSelection(thread, patch.claudeAccount);
    sanitizePatch(prov, patch);
    const effort =
      patch.model || patch.effort
        ? this.validEffort(prov, patch.model || thread.model, patch.effort || "default")
        : thread.effort;
    const settingsChanged = Boolean(patch.mode || patch.model || patch.effort || patch.advisor);
    if (thread.status === "running" && settingsChanged)
      throw new Error("Stop the running turn before changing mode, model or effort.");
    const before = this.settingsOf(thread);
    this.applyPatch(thread, patch, selectedAccount, effort);
    if (accountChanged) this.kill(threadId, "settings", true);
    if (settingsChanged) this.reconfigure(thread, before);
    this.touch(thread);
  }

  private settingsOf(thread: Thread) {
    return {
      mode: thread.mode,
      model: thread.model,
      effort: thread.effort,
      advisor: thread.advisor,
    };
  }

  private applyPatch(
    thread: Thread,
    patch: ThreadPatch,
    selectedAccount: ClaudeAccount | undefined,
    effort: string | undefined,
  ) {
    if (selectedAccount) thread.claudeAccount = selectedAccount;
    if (patch.mode) thread.mode = patch.mode;
    if (patch.model && patch.model !== thread.model) {
      delete thread.context;
      delete thread.resolvedModel;
    } // the old model's window is no longer authoritative
    if (patch.model) thread.model = patch.model;
    thread.effort = effort;
    if (patch.advisor) thread.advisor = patch.advisor;
    if (typeof patch.idleCompaction === "boolean") thread.idleCompaction = patch.idleCompaction;
    if (!patch.title) return;
    thread.title = patch.title.slice(0, 80);
    thread.autoTitle = false;
    thread.titleLocked = true;
  }

  private reconfigure(
    thread: Thread,
    before: Pick<Thread, "mode" | "model" | "effort" | "advisor">,
  ) {
    const live = this.live.get(thread.id),
      after = this.settingsOf(thread);
    // the idle process takes the new settings in place, or restarts with new flags (history kept via the harness's session)
    if (!live?.agent.alive || live.interrupting || !live.agent.configure?.(before, after))
      this.kill(thread.id, "settings", true);
  }

  /** Replace a failed worker's model without moving its checkout, branch, or conversation. */
  rerouteIssueWorker(req: { thread: string }): { model: string } | undefined {
    const t = this.threads.get(req.thread);
    if (!t || t.issueRun?.role !== "work" || t.status !== "idle" || t.background || t.archived)
      return;
    const approved =
      t.provider === "pi"
        ? AUTOMATION_PI_MODELS
        : Object.values(ROUTES)
            .flat()
            .filter((route) => route.provider === t.provider)
            .map((route) => route.model);
    const available = PROVIDERS.get(t.provider)?.models() ?? [];
    const model = approved.find((model) => model !== t.model && available.includes(model));
    if (!model) return;
    this.update(t.id, { model });
    return { model };
  }

  // A new thread that carries on from this one. Claude forks its session, Pi gets a copy of its session directory, and agents with
  // no fork (Codex) replay the earlier conversation as text in the first message. The history and uploads are copied so the fork reads whole.
  // With `provider` set to another agent the fork switches harness: its native session cannot carry over, so it always replays text.
  // The same holds for another Claude account, whose profile cannot read this account's sessions. `pick` sets the fork's model,
  // effort, permission mode and Claude account; anything left out keeps the source's choice.
  fork(sourceId: string, provider?: string, recent = false, pick: ForkPick = {}): Thread {
    const src = this.threads.get(sourceId);
    if (!src) throw new Error("Unknown thread");
    const target = forkTarget(src, provider);
    if (src.status === "running")
      throw new Error("Wait for the current turn to finish before forking.");
    const child = forkedThread(src, target, recent);
    this.applyForkPick(child, src, target ?? PROVIDERS.get(src.provider), pick);
    const otherAccount =
      !target &&
      src.provider === "claude" &&
      child.claudeAccount !== normalizeClaudeAccount(src.claudeAccount);
    if (otherAccount) child.context = undefined;
    const hasHistory = copyForkFiles(src, child);
    carryForkSession(src, child, { recent, replayAll: !!target || otherAccount, hasHistory });
    this.threads.set(child.id, child);
    this.persist();
    this.emit({ t: "thread", thread: child });
    return child;
  }

  // The fork's own choices of model, effort, permission mode and Claude account, where the agent offers them
  private applyForkPick(child: Thread, src: Thread, prov: Provider | undefined, pick: ForkPick) {
    if (pick.model && prov?.models().includes(pick.model)) child.model = pick.model;
    if (pick.effort || child.model !== src.model)
      child.effort = this.validEffort(prov, child.model, pick.effort ?? child.effort);
    if (pick.mode && prov?.modes.includes(pick.mode as Mode)) child.mode = pick.mode as Mode;
    if (child.provider === "claude" && pick.claudeAccount !== undefined)
      child.claudeAccount = requireClaudeAccount(pick.claudeAccount);
  }

  remove(id: string) {
    if (!safeId(id) || !this.threads.has(id)) return;
    this.cancelQuestions(id, true);
    this.kill(id, "remove");
    this.queues.delete(id);
    this.emitQueue(id);
    this.idleCompactionTimers.cancel(id);
    this.threads.delete(id);
    this.titling.delete(id);
    this.persist();
    fs.rmSync(logFile(id), { force: true });
    fs.rmSync(path.join(DATA_DIR, "pi-sessions", id), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, "auto-runtime", id), { recursive: true, force: true });
    removeUploads(id);
    this.emit({ t: "removed", thread: id });
  }

  // A console event in the thread's transcript (a scheduled run's report card)
  note(id: string, ev: unknown) {
    if (this.threads.has(id)) this.publish(id, ev);
  }

  history(id: string): unknown[] {
    try {
      return fs
        .readFileSync(logFile(id), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => !NOISE.has(kindOf(e)));
    } catch {
      return [];
    }
  }

  // What the UI gets when it opens a thread: the newest PAGE events (or the PAGE before `before`), starting on a user message so a
  // page never opens mid-turn, with long tool output clipped. `start > 0` means there is older history to ask for.
  // With `since` (the last line a cached view holds) it is only the lines after that, or a full page when too many arrived meanwhile.
  // `small` (phones) gets 60% of the events and half the bytes: less to download and draw on every open and older page.
  page(threadId: string, before?: number, since?: number, small = false) {
    const limit = small ? Math.ceil(PAGE * 0.6) : PAGE,
      maxBytes = small ? PAGE_BYTES / 2 : PAGE_BYTES;
    const at = performance.now();
    const file = logFile(threadId);
    const delta =
      since != null && before == null ? this.historyIndex.after(file, since, PAGE) : null;
    const page = delta || this.historyIndex.read(file, before, limit);
    let items = page.events
      .map((entry, offset) => ({ line: page.start + offset, entry }))
      .filter(({ entry }) => !NOISE.has(kindOf(entry)))
      .map(({ line, entry }) => {
        const wire = historyWireEvent(clipToolResults(entry));
        return { line, e: wire, size: JSON.stringify(wire).length };
      });
    let start = page.start;
    const total = items.reduce((sum, item) => sum + item.size, 0);
    if (!delta && total > maxBytes && items.length > 1) {
      const cut = pageCut(items, total, maxBytes, limit);
      if (cut > 0) {
        start = items[cut].line;
        items = items.slice(cut);
      }
    }
    return {
      ...page,
      start,
      events: items.map((item) => item.e),
      questions: this.questions.list(threadId),
      workState: this.workState(threadId),
      ...(delta ? { delta: true } : {}),
      server_ms: Math.round((performance.now() - at) * 10) / 10,
    };
  }

  private log(id: string, ev: unknown) {
    fs.appendFileSync(logFile(id), JSON.stringify(ev) + "\n", {
      mode: 0o600,
    });
  }

  private publish(id: string, ev: any, persistIt = true) {
    if (!persistIt) return void this.emit({ t: "event", thread: id, event: ev });
    if (ev && typeof ev === "object" && ev.ts == null) ev.ts = Date.now(); // server receive time: logs stay analyzable whatever the harness stamps
    this.log(id, ev);
    this.emit({
      t: "event",
      thread: id,
      event: ev,
      seq: this.historyIndex.count(logFile(id)),
    });
  }

  private setCommands(provider: string, list: Command[]) {
    if (JSON.stringify(list) === JSON.stringify(this.commands[provider])) return;
    this.commands[provider] = list;
    fs.writeFileSync(COMMANDS_FILE, JSON.stringify(this.commands), { mode: 0o600 });
    this.emit({ t: "commands", provider, commands: commandList(list) });
  }

  private notify(t: Thread, kind: ThreadNotice["kind"]) {
    try {
      this.onNotification?.({ kind, thread: t.id, title: t.title });
    } catch {
      /* notification transport cannot interrupt a turn */
    }
  }

  private start(thread: Thread, warm = false): Live {
    const prov = PROVIDERS.get(thread.provider);
    if (!prov) throw new Error(`Unknown provider "${thread.provider}".`);
    if (thread.issueRun) prepareIssueRun(thread, prov);
    const proxyUrl = headroomProxyUrl(thread.provider);
    const live: Live = {
      agent: undefined as unknown as Agent,
      aborted: false,
      spawnAt: Date.now(),
      warm,
      held: [],
      proxyUrl,
    };
    timed(() =>
      timing?.recordProcess({ thread: thread.id, provider: thread.provider, kind: "spawn" }),
    );
    const ctx: AgentCtx = {
      event: (event) => this.agentEvent(thread, live, event),
      commands: (list) => {
        this.markReady(thread, live);
        this.setCommands(thread.provider, list);
      },
      exited: (info) => this.agentExited(thread, live, prov, info),
    };
    live.agent = prov.start(startSpec(thread), ctx);
    this.live.set(thread.id, live);
    if (!warm) this.release(thread, live);
    return live;
  }

  // The first output from the process: record how long it took to start
  private markReady(thread: Thread, live: Live) {
    if (live.readyAt != null) return;
    live.readyAt = Date.now();
    timed(() =>
      timing?.recordProcess({
        thread: thread.id,
        provider: thread.provider,
        kind: "ready",
        ms: live.readyAt! - live.spawnAt!,
      }),
    );
  }

  // Every event from the agent process: held while it starts or stays warm, swallowed after an abort or until an interrupt's result
  private agentEvent(thread: Thread, live: Live, event: any) {
    if (event?.type === "rate_limit_event" && thread.provider === "claude") {
      event = {
        ...event,
        observedAt: Date.now(),
        usageProvider: claudeUsageKey(thread.claudeAccount),
      };
    }
    if (fromProcess(event)) this.markReady(thread, live);
    live.heardAt = Date.now();
    if (live.aborted) return;
    if (live.interrupting) {
      if (event.type === "result") {
        clearTimeout(live.interrupting);
        live.interrupting = undefined;
      }
      return;
    }
    if (live.held) {
      if (live.held.length < 500) live.held.push(event);
    } else if (this.live.get(thread.id) === live) this.onEvent(thread, event);
  }

  private recordExit(thread: Thread, live: Live, info: ExitInfo) {
    timed(() =>
      timing?.recordProcess({
        thread: thread.id,
        provider: thread.provider,
        kind: "exit",
        ms: Date.now() - live.spawnAt!,
        code: info.code,
        signal: info.signal,
        reason: live.exitReason ?? (info.aborted || live.aborted ? "stop" : "crash"),
      }),
    );
  }

  private agentExited(thread: Thread, live: Live, prov: Provider, info: ExitInfo) {
    this.recordExit(thread, live, info);
    const current = this.live.get(thread.id) === live;
    if (current) {
      this.live.delete(thread.id);
      this.emitWorkState(thread);
    }
    if (live.rewarm) {
      live.rewarm = false;
      setImmediate(() => this.warm(thread.id));
    } // the old process no longer holds the session
    if (current && thread.background) {
      delete thread.background;
      this.emit({ t: "thread", thread });
    }
    if (!current || thread.status !== "running") return; // a replaced or aborted agent's exit says nothing about the new turn
    const notifyFailure =
      !thread.operation &&
      !info.aborted &&
      !live.aborted &&
      this.notificationTurns.delete(thread.id);
    this.notificationTurns.delete(thread.id);
    this.cancelQuestions(thread.id);
    thread.status = "idle";
    delete thread.operation;
    if (!info.aborted && !live.aborted) {
      this.publish(thread.id, {
        type: "console_error",
        text: `${prov.label} exited (${info.signal ?? info.code}). ${info.stderr.trim().slice(-500)}`,
      });
    }
    if (notifyFailure) this.notify(thread, "failed");
    this.endTiming(thread, { subtype: "exited", is_error: true });
    this.touch(thread);
    if (parseCommand(this.queues.get(thread.id)?.[0]?.text || "")?.name === "compact")
      this.drain(thread.id);
  }

  private release(t: Thread, live: Live) {
    const held = live.held ?? [];
    live.held = undefined;
    live.warm = false;
    for (const event of held)
      if (!live.aborted && this.live.get(t.id) === live) this.onEvent(t, event);
  }

  // Spawn the thread's agent ahead of the first send. No prompt is written, so no tokens are spent.
  warm(id: string): boolean {
    const t = this.threads.get(id);
    if (
      WARM_MAX < 1 ||
      this.closed ||
      !t ||
      t.archived ||
      t.status !== "idle" ||
      t.operation ||
      this.live.get(id)?.agent.alive
    )
      return false;
    if (!PROVIDERS.get(t.provider)?.status().ok) return false;
    const unused = [...this.live].filter(([, l]) => l.warm).map(([other]) => other); // oldest first
    for (const other of unused.slice(0, Math.max(0, unused.length - WARM_MAX + 1)))
      this.kill(other, "warm-cap");
    try {
      this.start(t, true);
      return true;
    } catch {
      return false;
    }
  }

  // Canonical events from any harness. We only interpret the two that change thread state.
  // The steps run in a fixed order (usage before result accounting, idle hooks last); a step returning true ends the event there.
  private onEvent(thread: Thread, event: any) {
    const flow: EventFlow = { event, compacting: thread.operation === "compact" };
    this.noteWorkState(thread, event);
    if (this.noteBackgroundTasks(thread, event)) return;
    this.noteConsoleError(thread, event);
    if (event.type === "subagent_wake") return this.wake(thread, String(event.text || ""));
    this.noteSelfStartedTurn(thread, event, flow.compacting);
    if (NOISE.has(kindOf(event))) return;
    this.noteResolvedModel(thread, event);
    if (this.noteQuestion(thread, flow) || this.noteProviderUsage(thread, flow.event)) return;
    this.noteRateLimit(thread, flow);
    if (this.noteRunSettings(thread, flow.event) || this.noteContextUsage(thread, flow.event))
      return;
    this.noteSession(thread, flow.event);
    this.noteCompactBoundary(thread, flow.event);
    this.noteTurnContent(thread, flow.event);
    if (flow.event.type === "result" && this.noteResult(thread, flow)) return;
    this.publish(thread.id, flow.event, flow.event.type !== "stream_event");
    this.afterIdleResult(thread, flow);
    this.noteAssistant(thread, flow.event);
  }

  private workState(id: string) {
    const live = this.live.get(id);
    return {
      version: 1 as const,
      foreground: [...(live?.foreground ?? [])],
      background: [...(live?.backgroundTools ?? [])],
      backgroundCount: live
        ? Math.max(this.threads.get(id)?.background ?? 0, live.backgroundTools?.size ?? 0)
        : 0,
    };
  }

  private emitWorkState(thread: Thread) {
    thread.workState = this.workState(thread.id);
    this.emit({ t: "thread", thread });
  }

  private noteWorkState(thread: Thread, event: any) {
    if (event.parent_tool_use_id) return;
    const live = this.live.get(thread.id);
    if (!live) return;
    const foreground = (live.foreground ??= new Set());
    const background = (live.backgroundTools ??= new Set());
    const tasks = (live.taskTools ??= new Map());
    let changed = false;
    for (const block of event.message?.content ?? []) {
      if (event.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
        foreground.add(block.id);
        changed = true;
      } else if (event.type === "user" && block.type === "tool_result") {
        changed = foreground.delete(block.tool_use_id) || changed;
        if (!background.has(block.tool_use_id))
          for (const [task, tool] of tasks) if (tool === block.tool_use_id) tasks.delete(task);
      }
    }
    if (
      event.type === "system" &&
      event.subtype === "task_started" &&
      typeof event.tool_use_id === "string"
    ) {
      if (typeof event.task_id === "string") tasks.set(event.task_id, event.tool_use_id);
      if (event.is_backgrounded) {
        foreground.delete(event.tool_use_id);
        background.add(event.tool_use_id);
        changed = true;
      }
    }
    if (event.type === "system" && event.subtype === "task_notification") {
      const id = event.tool_use_id ?? tasks.get(event.task_id);
      tasks.delete(event.task_id);
      if (id) for (const [task, tool] of tasks) if (tool === id) tasks.delete(task);
      if (id && background.delete(id)) {
        thread.background = Math.max(0, (thread.background ?? 0) - 1);
        changed = true;
      }
    }
    if (
      event.type === "system" &&
      event.subtype === "background_tasks_changed" &&
      Array.isArray(event.tasks)
    ) {
      background.clear();
      for (const task of event.tasks) {
        const id = task.tool_use_id ?? tasks.get(task.task_id);
        if (typeof id === "string") background.add(id);
      }
      for (const [task, tool] of tasks)
        if (!foreground.has(tool) && !background.has(tool)) tasks.delete(task);
    }
    if (changed) this.emitWorkState(thread);
  }

  // Claude's background task count shows on the thread; an empty list lets idle compaction plan again. Never logged.
  private noteBackgroundTasks(thread: Thread, event: any): boolean {
    if (
      event.type !== "system" ||
      event.subtype !== "background_tasks_changed" ||
      !Array.isArray(event.tasks)
    )
      return false;
    const count = event.tasks.length;
    if ((thread.background ?? 0) !== count) {
      if (count) thread.background = count;
      else delete thread.background;
      this.emit({ t: "thread", thread });
      if (!count) this.refreshIdleCompaction(thread);
    }
    this.emitWorkState(thread);
    return true;
  }

  // The newest console error is the turn's failure: Codex and Pi report a failed turn there, not on the result
  private noteConsoleError(thread: Thread, event: any) {
    if (event.type !== "console_error" || typeof event.text !== "string") return;
    const turn = this.turns.get(thread.id);
    if (!turn) return;
    turn.failure = event.text;
    turn.failureCode = typeof event.code === "string" ? event.code : undefined;
  }

  // Claude starts a turn by itself when a background subagent finishes after the turn ended: show it as running
  private noteSelfStartedTurn(thread: Thread, event: any, compacting: boolean) {
    if (event.type !== "system" || event.subtype !== "init") return;
    if (thread.status !== "idle" || thread.provider !== "claude" || compacting) return;
    thread.status = "running";
    this.turns.set(thread.id, { start: Date.now(), tools: {} });
    this.touch(thread);
  }

  // The turn clock times the event and learns the model the process resolved; Codex names it in its init event
  private noteResolvedModel(thread: Thread, event: any) {
    const clock = this.turns.get(thread.id)?.clock;
    if (clock)
      timed(() => {
        clock.event(event);
        const live = this.live.get(thread.id);
        if (live && clock.resolvedModel) live.model = clock.resolvedModel;
      });
    if (
      thread.provider === "codex" &&
      event.type === "system" &&
      event.subtype === "init" &&
      typeof event.model === "string"
    ) {
      thread.resolvedModel = event.model;
    }
  }

  // A question becomes pending (the stored copy replaces the event) and an answer clears it. True: invalid or unknown, so dropped.
  private noteQuestion(thread: Thread, flow: EventFlow): boolean {
    if (flow.event.type === "question") {
      try {
        flow.event = this.questions.add(thread.id, flow.event);
      } catch {
        this.publish(thread.id, {
          type: "console_error",
          text: "The agent sent an invalid question request.",
        });
        return true;
      }
      this.updateWaiting(thread.id);
      if (!flow.compacting && this.notificationTurns.has(thread.id))
        this.notify(thread, "needs_input");
    }
    if (flow.event.type === "question_answer") {
      if (!this.questions.remove(thread.id, flow.event.id)) return true;
      this.updateWaiting(thread.id);
    }
    return false;
  }

  // Codex quota windows. Not part of the conversation.
  private noteProviderUsage(thread: Thread, event: any): boolean {
    if (event.type !== "provider_usage") return false;
    const windows = codexWindows(event.rateLimits);
    if (windows.length) {
      const merged = new Map(
        (usage.get(thread.provider)?.windows || []).map((window) => [window.label, window]),
      );
      for (const window of windows) merged.set(window.label, window); // app-server quota notifications can be sparse
      usage.record(thread.provider, { windows: [...merged.values()] });
    }
    return true;
  }

  // Claude quota windows, stamped with the account they belong to and when they were seen
  private noteRateLimit(thread: Thread, flow: EventFlow) {
    if (flow.event.type !== "rate_limit_event") return;
    const windows = claudeWindows(flow.event);
    if (!windows.length) return;
    const provider =
      thread.provider === "claude" ? claudeUsageKey(thread.claudeAccount) : thread.provider;
    if (!provider.startsWith("claude")) {
      usage.record(provider, { windows });
      return;
    }
    const source = flow.event;
    const observedAt =
      source.usageProvider === provider && Number.isFinite(source.observedAt)
        ? source.observedAt
        : Date.now();
    const event = { ...source, observedAt, usageProvider: provider };
    flow.event = event;
    usage.record(provider, { windows }, event.observedAt, {
      observedAt: event.observedAt,
      usageProvider: provider,
      ...(typeof event.session_id === "string" && typeof event.uuid === "string"
        ? { sourceSessionId: event.session_id, sourceEventUuid: event.uuid }
        : {}),
    });
  }

  // Run settings start the record of the last run; token usage adds to it and is the turn's usage. Neither is logged.
  private noteRunSettings(thread: Thread, event: any): boolean {
    if (event.type === "token_usage") {
      const turn = this.turns.get(thread.id);
      if (turn) turn.usage = event;
    }
    if (event.type !== "run_settings" && event.type !== "token_usage") return false;
    thread.lastRun = {
      ...(event.type === "run_settings" ? {} : thread.lastRun),
      ...Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type")),
    };
    this.touch(thread);
    return true;
  }

  private noteContextUsage(thread: Thread, event: any): boolean {
    if (event.type !== "context_usage") return false;
    // not part of the conversation: remember it on the thread so the context meter survives reloads
    thread.context = {
      used: event.reset ? undefined : (event.used ?? thread.context?.used),
      max: event.max ?? thread.context?.max,
      ...(event.source ? { source: event.source } : {}),
    };
    this.emit({ t: "thread", thread });
    return true;
  }

  private noteSession(thread: Thread, event: any) {
    if (
      event.type !== "system" ||
      event.subtype !== "init" ||
      !event.session_id ||
      thread.sessionId === event.session_id
    )
      return;
    if (thread.forkFrom) this.accounting.seedFork(event.session_id, thread.forkFrom);
    thread.sessionId = event.session_id;
    delete thread.forkFrom; // the fork now has its own session
    this.persist();
  }

  private noteCompactBoundary(thread: Thread, event: any) {
    if (event.type !== "system" || event.subtype !== "compact_boundary") return;
    const live = this.live.get(thread.id);
    if (live) live.compactConfirmed = true;
    thread.lastCompactedAt = Date.now();
    thread.idleCompactionConsumedAt = thread.lastUserActivityAt;
    thread.context = { max: thread.context?.max, source: thread.context?.source };
    this.emit({ t: "thread", thread });
  }

  // Tool counts for the usage dashboard; background Bash calls for auto-continue
  private noteTurnContent(thread: Thread, event: any) {
    const turn = this.turns.get(thread.id);
    if (event.type === "assistant" && turn) {
      for (const block of event.message?.content ?? [])
        if (block?.type === "tool_use") turn.tools[block.name] = (turn.tools[block.name] ?? 0) + 1;
      this.trackBlocks(turn, event.message?.content ?? []);
    }
    if (event.type === "user") this.trackResults(turn, event.message?.content);
  }

  // The turn ended. True while Claude's empty /compact acknowledgement waits for the real result (nothing is logged yet).
  private noteResult(thread: Thread, flow: EventFlow): boolean {
    const questionOpen = this.questions.list(thread.id).length > 0; // cancelled just below; the turn still ended on it
    this.cancelQuestions(thread.id);
    if (this.awaitCompaction(thread, flow.event)) return true;
    const live = this.live.get(thread.id);
    live?.foreground?.clear();
    if (live?.taskTools)
      for (const [task, tool] of live.taskTools)
        if (!live.backgroundTools?.has(tool)) live.taskTools.delete(task);
    this.emitWorkState(thread);
    const failedTurn = this.turns.get(thread.id);
    const failure = failedTurn?.failure;
    const unfinished = questionOpen || !!failedTurn?.bgTools?.size;
    if (flow.event.is_error) flow.issueError = resultError(flow.event, failure);
    this.finishTurn(thread, flow.event);
    this.noteUsageStop(thread, flow.event, failure, failedTurn?.failureCode);
    this.noteQuotaPause(thread, flow.event, failure);
    if (!flow.compacting) {
      thread.replyAt = Date.now();
      thread.lastProviderActivityAt = Math.max(Date.now(), thread.lastUserActivityAt ?? 0);
      if (flow.event.is_error) thread.idleCompactionConsumedAt = thread.lastUserActivityAt;
    }
    if (thread.operation === "compact") this.finishCompaction(thread, flow);
    thread.lastRun = { ...thread.lastRun, duration_ms: flow.event.duration_ms };
    // a message that arrived just as the turn ended starts the next one straight away: Claude says so in queued_turn_count
    thread.status = Number(flow.event.queued_turn_count) > 0 ? "running" : "idle";
    this.notifyTurnEnd(thread, flow);
    this.touch(thread);
    this.recycleRouting(thread.id);
    brainCommit(); // agents may have written wiki pages this turn; keep the shared brain's git history current
    this.continueAfterResult(thread, flow.event, unfinished);
    return false;
  }

  // Claude answers /compact with an empty result straight away, then compacts and sends compact_boundary and the real result
  private awaitCompaction(thread: Thread, event: any): boolean {
    const live = this.live.get(thread.id);
    if (
      thread.operation === "compact" &&
      thread.provider === "claude" &&
      live &&
      !live.compactConfirmed &&
      !live.compactWait &&
      !event.is_error &&
      !event.num_turns
    ) {
      live.compactWait = setTimeout(() => {
        live.compactWait = undefined;
        if (thread.operation === "compact" && !live.compactConfirmed)
          this.onEvent(thread, { ...event, is_error: true, subtype: "error" });
      }, 10 * 60_000);
      return true;
    }
    if (live?.compactWait) {
      clearTimeout(live.compactWait);
      live.compactWait = undefined;
    }
    return false;
  }

  private noteUsageStop(
    thread: Thread,
    event: any,
    failure: string | undefined,
    failureCode: string | undefined,
  ) {
    const stop = event.is_error
      ? detectUsageStop(thread.provider, event, failure, failureCode)
      : undefined;
    if (!stop) return;
    const stopKey =
      thread.provider === "claude" ? claudeUsageKey(thread.claudeAccount) : thread.provider;
    thread.usageStop = {
      provider: thread.provider,
      at: Date.now(),
      text: stop.text,
      resetsAt: stop.resetsAt ?? this.windowReset(stopKey),
    };
    if (thread.usageStop.resetsAt === undefined) delete thread.usageStop.resetsAt;
  }

  // Mark thread as quota-paused if turn ended due to rate limit and quota is exhausted
  private noteQuotaPause(thread: Thread, event: any, failure: string | undefined) {
    if (!event.is_error || thread.archived || thread.quotaPaused) return;
    const errMsg = [event.error?.message ?? event.error, event.result, failure]
      .filter((part) => typeof part === "string")
      .join("\n");
    if (!QUOTA_ERROR.test(errMsg)) return;
    const providerKey =
      thread.provider === "claude" ? claudeUsageKey(thread.claudeAccount) : thread.provider;
    if (!usage.exhausted(providerKey)) return;
    const window = usage
      .get(providerKey)
      ?.windows.find(
        (candidate) =>
          candidate.used >= candidate.limit &&
          candidate.resetsAt &&
          candidate.resetsAt > Date.now(),
      );
    if (!window) return;
    thread.quotaPaused = {
      provider: providerKey,
      windowLabel: window.label,
      resetsAt: window.resetsAt,
    };
    this.touch(thread);
  }

  // A /compact turn reports how it went; without compact_boundary it counts as failed
  private finishCompaction(thread: Thread, flow: EventFlow) {
    if (!flow.event.is_error && !this.live.get(thread.id)?.compactConfirmed) {
      flow.event = { ...flow.event, is_error: true, subtype: "error" };
      this.publish(thread.id, {
        type: "console_error",
        text: "The agent did not confirm compaction. Context has not been marked as compacted.",
      });
    }
    this.publish(thread.id, {
      type: "command_status",
      command: "compact",
      status: flow.event.is_error ? "failed" : "completed",
      text: flow.event.is_error
        ? "Context compaction failed."
        : "Context compacted. The conversation transcript is kept.",
    });
    delete thread.operation;
  }

  private notifyTurnEnd(thread: Thread, flow: EventFlow) {
    if (flow.compacting || !this.notificationTurns.has(thread.id)) return;
    if (!flow.event.is_error && thread.status !== "idle") return;
    const queued = !!this.queues.get(thread.id)?.length;
    this.notificationTurns.delete(thread.id);
    if (flow.event.is_error) this.notify(thread, "failed");
    else if (!queued && !this.questions.list(thread.id).length) this.notify(thread, "finished");
  }

  // An idle thread moves on: queued messages, waiting subagent results, then auto-continue. Each step may start a turn.
  private continueAfterResult(thread: Thread, event: any, unfinished: boolean) {
    if (
      thread.status === "idle" &&
      (!event.is_error ||
        parseCommand(this.queues.get(thread.id)?.[0]?.text || "")?.name === "compact")
    )
      this.drain(thread.id);
    if (thread.status === "idle" && !event.is_error) this.wake(thread);
    if (thread.status === "idle") this.autoContinue(thread, event, unfinished);
  }

  // Schedule, turn-done and issue-run hooks see an idle thread's finished turn last; a hook failure never breaks the turn
  private afterIdleResult(thread: Thread, flow: EventFlow) {
    const event = flow.event;
    if (event.type !== "result") return;
    if (thread.schedule && thread.status === "idle")
      try {
        this.onTurnEnd?.(thread, event);
      } catch {}
    if (thread.status === "idle")
      try {
        this.onTurnDone?.(thread, event);
      } catch {}
    if (thread.issueRun && thread.status === "idle")
      try {
        this.onIssueTurnEnd?.(
          thread,
          event.is_error ? { ...event, error: flow.issueError } : event,
        );
      } catch {}
  }

  // Ask the labeler for a short label of each tool call that needs one
  private noteAssistant(thread: Thread, event: any) {
    if (event.type !== "assistant") return;
    for (const block of event.message?.content ?? []) {
      if (block?.type !== "tool_use" || !needsLabel(block.name, block.input)) continue;
      this.labeler.request({
        thread: thread.id,
        id: block.id,
        name: block.name,
        command: toolSketch(block),
        cwd: thread.cwd,
      });
    }
  }

  // Background Bash calls count until they return.
  private trackBlocks(turn: TurnState, blocks: any[]) {
    for (const block of blocks) {
      if (block?.type !== "tool_use") continue;
      if (block.name === "Bash" && block.input?.run_in_background === true && block.id)
        (turn.bgTools ??= new Set()).add(String(block.id));
    }
  }

  private trackResults(turn: TurnState | undefined, content: any) {
    if (!turn?.bgTools?.size || !Array.isArray(content)) return;
    for (const block of content)
      if (block?.type === "tool_result") turn.bgTools.delete(String(block.tool_use_id));
  }

  private continueBlocked(thread: Thread, event: any, unfinished: boolean) {
    const live = this.live.get(thread.id);
    return (
      !!event.is_error ||
      thread.status !== "idle" ||
      !!thread.operation ||
      !!thread.background ||
      unfinished ||
      !!live?.wakes?.length ||
      !!this.queues.get(thread.id)?.length ||
      !!this.questions.list(thread.id).length
    );
  }

  private continueParked(thread: Thread) {
    return !!(
      thread.waiting ||
      thread.issueRun ||
      thread.quotaPaused ||
      thread.usageStop ||
      thread.archived
    );
  }

  // Every user turn gets one "Continue" nudge when it ends idle; the nudge's own turn never re-arms.
  private autoContinue(thread: Thread, event: any, unfinished: boolean) {
    if (!this.continueArmed.has(thread.id)) return;
    if (Number(event.queued_turn_count) > 0) return;
    this.continueArmed.delete(thread.id);
    if (!autoContinueEnabled()) return;
    if (this.continueBlocked(thread, event, unfinished) || this.continueParked(thread)) return;
    const live = this.live.get(thread.id);
    setTimeout(() => {
      if (this.live.get(thread.id) !== live || this.threads.get(thread.id) !== thread) return;
      if (this.continueBlocked(thread, {}, false) || this.continueParked(thread)) return;
      try {
        this.send(thread.id, AUTO_CONTINUE_PROMPT, { auto: "continue" });
      } catch {}
    }, 250);
  }

  // Give finished subagent results to an agent that does not wake itself (Codex). Waits behind a running turn or queued messages.
  private wake(t: Thread, text?: string) {
    const live = this.live.get(t.id);
    if (!live) return;
    if (text) (live.wakes ??= []).push(text);
    if (!live.wakes?.length) return;
    setTimeout(() => {
      if (
        this.live.get(t.id) !== live ||
        t.status !== "idle" ||
        this.queues.get(t.id)?.length ||
        !live.wakes?.length
      )
        return;
      const msg = live.wakes.splice(0).join("\n\n");
      try {
        this.send(t.id, msg, { auto: "subagent" });
      } catch (e: any) {
        this.publish(t.id, {
          type: "console_error",
          text: `Could not resume after the subagent finished: ${e.message}`,
        });
      }
    }, 50);
  }

  private finishTurn(thread: Thread, event: any) {
    const measured = event.modelUsage
      ? this.accounting.consume(event.session_id || thread.sessionId || thread.id, event)
      : undefined;
    if (measured?.duplicate) return;
    const turn = this.turns.get(thread.id);
    if (!turn) return;
    this.endTiming(thread, event);
    this.turns.delete(thread.id);
    const row = turnRow(thread, event, turn, measured);
    if (row.cost != null) {
      thread.cost += row.cost;
      thread.costMeasured = true;
    }
    try {
      recordTurn(row);
    } catch {}
  }

  // Close the turn's clock: one timing row, and the compact facts the Run details panel shows for the last run.
  private endTiming(t: Thread, ev: any) {
    const turn = this.turns.get(t.id),
      clock = turn?.clock;
    if (!clock) return;
    turn.clock = undefined;
    timed(() => {
      const live = this.live.get(t.id);
      const row = clock.finish(
        ev,
        Date.now(),
        live?.readyAt != null && live.spawnAt != null ? live.readyAt - live.spawnAt : null,
      );
      t.lastRun = { ...t.lastRun, timing: runFacts(row) };
      timing?.recordTurn(t.id, row);
    });
  }

  private command(thread: Thread, text: string, attachments?: unknown): boolean {
    const parsed = /^\/\s*$/.test(text.trim()) ? { name: "help", args: "" } : parseCommand(text);
    if (!parsed) return false;
    const { name, args } = parsed;
    if (!CONSOLE_COMMANDS.some((entry) => entry.name === name)) {
      if (thread.provider === "claude" || thread.provider === "pi") return false; // their native command/skill registries are authoritative, including commands in the first prompt
      throw new Error(
        `/${name} is not available for this agent. Type /help for supported commands.`,
      );
    }
    if (Array.isArray(attachments) && attachments.length)
      throw new Error("Run commands without attachments.");
    if (name === "stop") {
      this.abort(thread.id);
      return true;
    }
    if (name === "compact") {
      this.compact(thread.id, args);
      return true;
    }
    this.applyCommandSetting(thread, name, args);
    this.publish(thread.id, {
      type: "command_status",
      command: name,
      status: "completed",
      text: this.commandReply(thread, name),
    });
    return true;
  }

  private applyCommandSetting(thread: Thread, name: string, args: string) {
    if (name === "model" && args) {
      if (!PROVIDERS.get(thread.provider)?.models().includes(args))
        throw new Error("Unknown model. Choose one from the model menu.");
      this.update(thread.id, { model: args });
    } else if (name === "effort" && args) this.update(thread.id, { effort: args });
  }

  private commandReply(thread: Thread, name: string): string {
    if (name === "help")
      return this.getCommands()
        [thread.provider].map(
          (entry) =>
            `/${entry.name}${entry.argumentHint ? " " + entry.argumentHint : ""} — ${entry.description}`,
        )
        .join("\n");
    const used = thread.context?.used;
    return `${PROVIDERS.get(thread.provider)?.label}: ${thread.model} · effort ${thread.effort || "default"} · ${thread.operation === "compact" ? "compacting" : thread.status}${used != null ? ` · ${used.toLocaleString()} context tokens` : ""}`;
  }

  compact(id: string, instructions = "") {
    const t = this.threads.get(id);
    if (!t) throw new Error("Unknown thread");
    if (t.provider === "codex" && instructions)
      throw new Error("Codex /compact does not accept extra instructions.");
    if (
      t.operation === "compact" ||
      this.queues.get(id)?.some((q) => parseCommand(q.text)?.name === "compact")
    )
      throw new Error("Context compaction is already running or queued.");
    if (t.status === "running")
      return this.whileRunning(t, `/compact${instructions ? " " + instructions : ""}`, {
        mode: "queue",
      });
    if (!fs.existsSync(logFile(id)) || (t.provider === "codex" && !t.sessionId))
      throw new Error("Send a message before compacting this thread.");
    t.idleCompactionConsumedAt = t.lastUserActivityAt;
    this.idleCompactionTimers.cancel(id);
    delete t.idleCompactionDueAt;
    this.kill(id, "compact"); // native sessions resume from disk; never share a mutable session with an idle subprocess
    const live = this.start(t);
    if (!live.agent.compact) {
      this.kill(id);
      throw new Error("This agent does not support context compaction.");
    }
    live.compactConfirmed = false;
    t.operation = "compact";
    t.status = "running";
    this.publish(id, {
      type: "user_input",
      text: `/compact${instructions ? " " + instructions : ""}`,
      command: true,
      ts: Date.now(),
    });
    this.publish(id, {
      type: "command_status",
      command: "compact",
      status: "running",
      text: "Compacting context…",
    });
    this.turns.set(id, {
      start: Date.now(),
      tools: {},
      clock: new TurnClock({ provider: t.provider, alias: t.model, start: Date.now(), cold: true }),
    });
    this.touch(t);
    try {
      live.agent.compact(instructions);
    } catch (error) {
      this.kill(id);
      delete t.operation;
      t.status = "idle";
      this.touch(t);
      throw error;
    }
  }

  // `attachments` is untrusted browser input: [{id}] naming files already uploaded to this thread
  // While a turn is running a message either steers it (delivered to the agent now, picked up after its current tool call) or waits in
  // a queue for the turn to end. `mode: "queue"` forces the queue; so does an agent that cannot take input mid-turn.
  // `instructions` go to the agent after the text but stay out of the transcript bubble; `scheduled` labels a scheduled run's prompt.
  send(threadId: string, text: string, opts: SendOptions = {}) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Unknown thread");
    if (!opts.auto && !opts.questionAnswer && this.command(thread, text, opts.attachments)) return;
    const attachments = resolveAttachments(threadId, opts.attachments);
    this.answerAsyncQuestions(thread, text, opts, attachments);
    if (!opts.auto) this.noteUserActivity(thread);
    if (thread.status === "running") {
      if (opts.auto) throw new Error("A turn is already running.");
      return this.whileRunning(thread, text, opts);
    }
    // older queued messages are about to drain (or wait on an edit): a new one joins behind them, never jumps ahead
    if (!opts.auto && !opts.delivery && this.queues.get(threadId)?.length) {
      this.enqueue(thread, text, opts);
      return this.drain(threadId);
    }
    const prompt = this.composePrompt(thread, text, opts, attachments);
    const live = this.beginTurn(thread, opts);
    this.publish(threadId, userInputEvent(text, opts, attachments));
    this.touch(thread);
    if (live.held) this.release(thread, live); // a warm agent's start-up events, after the message as on a cold start
    if (opts.auto) this.notificationTurns.delete(threadId);
    else this.notificationTurns.add(threadId);
    try {
      live.agent.send(
        prompt,
        attachments.filter((attachment) => attachment.kind === "image"),
      );
    } catch (error) {
      if (this.notificationTurns.delete(threadId)) this.notify(thread, "failed");
      throw error;
    }
    if (!opts.auto) this.notePrompt(thread, text);
  }

  // A plain chat reply answers the thread's pending background questions.
  private answerAsyncQuestions(
    thread: Thread,
    text: string,
    opts: SendOptions,
    attachments: ReturnType<typeof resolveAttachments>,
  ) {
    if (opts.auto || opts.delivery || opts.questionAnswer) return;
    if (!text.trim() || attachments.length) return;
    if (thread.status === "running" && opts.mode === "queue") return;
    for (const question of this.questions.list(thread.id).filter((request) => request.async)) {
      const result = this.questions.answer(
        thread.id,
        question.id,
        {},
        undefined,
        false,
        text,
        () => false,
      );
      this.publish(thread.id, result.event);
      this.updateWaiting(thread.id);
    }
  }

  private noteUserActivity(thread: Thread) {
    this.continueArmed.add(thread.id);
    delete thread.quotaPaused; // the user continued by hand: no auto "Continue." later
    thread.lastUserActivityAt = Math.max(Date.now(), (thread.lastUserActivityAt ?? 0) + 1);
    this.idleCompactionTimers.cancel(thread.id);
    delete thread.idleCompactionDueAt;
  }

  private composePrompt(
    thread: Thread,
    text: string,
    opts: SendOptions,
    attachments: ReturnType<typeof resolveAttachments>,
  ): string {
    const prompt =
      withFileList(text, attachments) + (opts.instructions ? `\n\n---\n${opts.instructions}` : "");
    if (!thread.replay || opts.auto) return prompt;
    const preamble =
      thread.replayLimit === 6000
        ? recentPreamble(this.history(thread.id))
        : replayPreamble(this.history(thread.id)); // exclude this new message
    thread.replay = false;
    delete thread.replayLimit;
    return preamble + prompt;
  }

  // Get an agent ready for the turn: reuse the warm one or start cold, then open the turn's clock.
  private beginTurn(thread: Thread, opts: SendOptions) {
    delete thread.usageStop;
    if (!opts.auto) delete thread.archived; // writing to an archived thread puts it back to work (touch below persists it)
    this.recycleRouting(thread.id);
    let live = this.live.get(thread.id);
    if (live?.interrupting) {
      this.kill(thread.id, "stop");
      live = undefined;
    } // its interrupted turn has not ended yet
    const cold = !live || !live.agent.alive; // a pre-warmed agent counts as warm
    const start = Date.now();
    if (cold) live = this.start(thread);
    live = live!;
    live.aborted = false;
    thread.status = "running";
    this.turns.set(thread.id, {
      start,
      tools: {},
      clock: new TurnClock({
        provider: thread.provider,
        alias: thread.model,
        start,
        cold,
        model: live.model,
        queueMs: opts.queuedAt != null ? Math.max(0, start - opts.queuedAt) : undefined,
      }),
    });
    return live;
  }

  // Record a user prompt for naming. Every prompt with substance (re)names the thread unless the user chose its title. Media is not
  // part of `text`, so an image-only message names nothing; "ok" / "hi" say nothing about the topic either.
  private notePrompt(t: Thread, text: string) {
    const clean = titleText(text);
    if (!clean) return;
    if (clean.split(" ").length < 3) return;
    if (t.autoTitle) t.autoTitle = false; // the folder-name default is gone, whatever the outcome
    if (!t.titleLocked) void this.retitle(t, clean);
  }

  private whileRunning(
    thread: Thread,
    text: string,
    opts: { attachments?: unknown; mode?: "steer" | "queue"; questionAnswer?: true },
  ) {
    const attachments = resolveAttachments(thread.id, opts.attachments); // reject bad ids now, not when the queue drains
    const agent = this.live.get(thread.id)?.agent;
    // A normal chat reply also releases a waiting tool; otherwise steering can sit behind that tool forever.
    if (
      opts.mode !== "queue" &&
      !attachments.length &&
      text.trim() &&
      this.answerBlockingQuestions(thread, text, agent)
    )
      return;
    if (thread.operation !== "compact" && opts.mode !== "queue" && agent?.steer) {
      this.steerAgent(thread, text, opts, attachments, agent);
      return;
    }
    this.enqueue(thread, text, opts);
  }

  // True when a waiting tool consumed the reply.
  private answerBlockingQuestions(thread: Thread, text: string, agent: Agent | undefined): boolean {
    for (const question of this.questions.list(thread.id).filter((request) => !request.async)) {
      const result = this.questions.answer(thread.id, question.id, {}, agent, false, text);
      this.publish(thread.id, result.event);
      this.updateWaiting(thread.id);
      if (result.consumed) return true;
    }
    return false;
  }

  private steerAgent(
    thread: Thread,
    text: string,
    opts: { attachments?: unknown; mode?: "steer" | "queue"; questionAnswer?: true },
    attachments: ReturnType<typeof resolveAttachments>,
    agent: Agent,
  ) {
    const delivery = agent.steer!(
      withFileList(text, attachments),
      attachments.filter((attachment) => attachment.kind === "image"),
    );
    if (!(delivery instanceof Promise)) return this.steerAccepted(thread, text, opts, attachments);
    void delivery
      .then(() => this.steerAccepted(thread, text, opts, attachments))
      .catch((error) => {
        if (!this.threads.has(thread.id) || this.live.get(thread.id)?.agent !== agent) return;
        this.steerRejected(thread, text, opts, error);
      });
  }

  private steerAccepted(
    thread: Thread,
    text: string,
    opts: { questionAnswer?: true },
    attachments: ReturnType<typeof resolveAttachments>,
  ) {
    this.continueArmed.add(thread.id);
    this.notificationTurns.add(thread.id);
    this.notePrompt(thread, text);
    this.publish(thread.id, {
      type: "user_input",
      text,
      ts: Date.now(),
      delivery: "steer",
      ...(opts.questionAnswer ? { questionAnswer: true } : {}),
      ...attachmentSummary(attachments),
    });
  }

  private steerRejected(
    thread: Thread,
    text: string,
    opts: { attachments?: unknown; mode?: "steer" | "queue"; questionAnswer?: true },
    error: Error,
  ) {
    this.publish(thread.id, {
      type: "console_error",
      text: `Steering was not accepted: ${error.message}. Sending as the next message.`,
    });
    try {
      this.send(thread.id, text, { ...opts, mode: "queue" });
    } catch (failure: any) {
      this.publish(thread.id, {
        type: "console_error",
        text: `Message could not be sent: ${failure.message}`,
      });
    }
  }

  private enqueue(t: Thread, text: string, opts: { attachments?: unknown; questionAnswer?: true }) {
    const q = this.queues.get(t.id) ?? [];
    if (q.length >= MAX_QUEUE) throw new Error("Too many queued messages.");
    q.push({
      id: crypto.randomUUID(),
      text,
      attachments: opts.attachments,
      revision: 0,
      at: Date.now(),
      ...(opts.questionAnswer ? { questionAnswer: true } : {}),
    });
    this.queues.set(t.id, q);
    this.emitQueue(t.id);
  }

  private emitQueue(id: string) {
    fs.writeFileSync(QUEUES_FILE + ".tmp", JSON.stringify(Object.fromEntries(this.queues)), {
      mode: 0o600,
    });
    fs.renameSync(QUEUES_FILE + ".tmp", QUEUES_FILE);
    this.emit({ t: "queue", thread: id, items: (this.queues.get(id) ?? []).map(queuePreview) });
  }
  getQueues(): Record<string, ReturnType<typeof queuePreview>[]> {
    const out: Record<string, ReturnType<typeof queuePreview>[]> = {};
    for (const [id, q] of this.queues) if (q.length) out[id] = q.map(queuePreview);
    return out;
  }
  editQueued(id: string, qid: string) {
    const item = this.queues.get(id)?.find((q) => q.id === qid);
    if (!item) throw new Error("This message is no longer queued. It may already have been sent.");
    item.editing = true;
    this.emitQueue(id);
    return {
      id: item.id,
      text: item.text,
      revision: item.revision,
      attachments: Array.isArray(item.attachments) ? item.attachments.length : 0,
    };
  }
  saveQueued(id: string, qid: string, revision: number, text: unknown) {
    const item = this.queues.get(id)?.find((q) => q.id === qid);
    if (!item)
      throw new Error("This message is no longer queued. Your draft has been kept in the editor.");
    if (!item.editing || item.revision !== revision)
      throw new Error(
        "This queued message changed in another window. Reopen it to edit the latest version.",
      );
    if (
      typeof text !== "string" ||
      text.length > 100_000 ||
      (!text.trim() && !(Array.isArray(item.attachments) && item.attachments.length))
    )
      throw new Error("Enter a message of up to 100,000 characters, or keep an attachment.");
    item.text = text;
    item.revision++;
    item.editing = false;
    this.emitQueue(id);
    this.drain(id);
  }
  cancelQueuedEdit(id: string, qid: string, revision: number) {
    const item = this.queues.get(id)?.find((q) => q.id === qid);
    if (item && item.revision === revision) {
      item.editing = false;
      this.emitQueue(id);
      this.drain(id);
    }
  }
  // "Steer" on a queued card: hand that one message to the running turn now instead of waiting for it to end
  steerQueued(id: string, qid: string) {
    const t = this.threads.get(id);
    const q = this.queues.get(id);
    const item = q?.find((x) => x.id === qid);
    if (!t || !item)
      throw new Error("This message is no longer queued. It may already have been sent.");
    if (item.editing) throw new Error("Finish editing this message first.");
    if (t.status !== "running") return this.drain(id);
    if (t.operation || !this.live.get(id)?.agent.steer)
      throw new Error(
        "This agent cannot take a message mid-turn. It will be sent when the turn ends.",
      );
    this.queues.set(
      id,
      q!.filter((x) => x !== item),
    );
    this.emitQueue(id);
    this.whileRunning(t, item.text, {
      attachments: item.attachments,
      mode: "steer",
      ...(item.questionAnswer ? { questionAnswer: true } : {}),
    });
  }
  unqueue(id: string, qid: string) {
    const q = this.queues.get(id);
    if (!q) return;
    this.queues.set(
      id,
      q.filter((x) => x.id !== qid),
    );
    this.emitQueue(id);
    this.drain(id);
  }
  // When a turn ends leaving the thread idle, everything queued behind it goes out together as ONE prompt. A command such as
  // /compact always goes alone, and a message being edited holds back the ones after it.
  private drain(id: string) {
    if (!this.queues.get(id)?.length) return;
    setTimeout(() => {
      const t = this.threads.get(id);
      const q = this.queues.get(id);
      if (!t || t.status !== "idle" || !q?.length || q[0].editing) return;
      let n = 1;
      let files = attachList(q[0]).length;
      if (!parseCommand(q[0].text)) {
        while (
          n < q.length &&
          !q[n].editing &&
          !parseCommand(q[n].text) &&
          files + attachList(q[n]).length <= MAX_ATTACHMENTS
        )
          files += attachList(q[n++]).length;
      }
      const items = q.splice(0, n);
      const { text, attachments, questionAnswer } = mergeQueued(items);
      const queuedAt = Math.min(...items.map((x) => x.at ?? Infinity));
      this.emitQueue(id);
      try {
        this.send(id, text, {
          attachments,
          delivery: "queued",
          ...(questionAnswer ? { questionAnswer: true } : {}),
          ...(Number.isFinite(queuedAt) ? { queuedAt } : {}),
        });
      } catch (e: any) {
        this.publish(id, {
          type: "console_error",
          text: `A queued message could not be sent: ${e?.message ?? e}`,
        });
      }
    }, 250).unref();
  }

  // Every typed user message of the thread, oldest first. The log is read only for its user_input lines.
  /** Record progress on an issue run (its PR, that its review has started). */
  setIssueRun(id: string, patch: Partial<NonNullable<Thread["issueRun"]>>) {
    const t = this.threads.get(id);
    if (!t?.issueRun) return;
    t.issueRun = { ...t.issueRun, ...patch };
    this.touch(t);
  }

  private userTexts(id: string): string[] {
    try {
      return fs
        .readFileSync(logFile(id), "utf8")
        .split("\n")
        .filter((l) => l.includes('"user_input"'))
        .flatMap((l) => {
          try {
            const e = JSON.parse(l);
            return e.type === "user_input" && !e.auto && !e.command && typeof e.text === "string"
              ? [e.text]
              : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  // Name the thread after all its user messages (newest weigh most). Never blocks the turn; on any failure the current title stays.
  private async retitle(t: Thread, latest: string) {
    const n = (this.titling.get(t.id) ?? 0) + 1;
    this.titling.set(t.id, n);
    const texts = this.userTexts(t.id);
    const title = await suggestTitle(texts.length ? texts : [latest]).catch(() => undefined);
    if (!title || !this.threads.has(t.id) || t.titleLocked || this.titling.get(t.id) !== n) return; // deleted, renamed by the user, or a newer prompt is already being named
    t.title = title;
    this.touch(t);
  }

  abort(id: string) {
    this.notificationTurns.delete(id);
    this.continueArmed.delete(id);
    const t = this.threads.get(id);
    const live = this.live.get(id);
    live?.foreground?.clear();
    live?.backgroundTools?.clear();
    live?.taskTools?.clear();
    if (!t) return;
    this.cancelQuestions(id, true);
    t.idleCompactionConsumedAt = t.lastUserActivityAt;
    this.idleCompactionTimers.cancel(id);
    delete t.idleCompactionDueAt;
    this.persist();
    if (this.queues.delete(id)) this.emitQueue(id); // Stop means stop: nothing queued behind it runs
    if (!live) {
      delete t.background;
      this.emitWorkState(t);
      this.touch(t);
      return;
    }
    this.endTiming(t, { subtype: "aborted", is_error: true });
    // interrupt keeps the process, and with it any background subagents: stop with subagents working must kill the agent
    if (!t.operation && !t.background && live.agent.interrupt && live.agent.alive && !live.held) {
      // keep the process: the harness ends the turn itself; restart only if it does not within 3 s
      live.interrupting = setTimeout(() => {
        if (this.live.get(id) === live && live.interrupting) this.kill(id, "stop", true);
      }, 3000);
      live.interrupting.unref();
      live.agent.interrupt();
    } else {
      live.aborted = true;
      live.exitReason = "stop";
      live.rewarm = !t.archived;
      this.live.delete(id); // next send uses a fresh agent that resumes the session
      live.agent.abort();
    }
    t.status = "idle";
    delete t.operation;
    delete t.background;
    this.emitWorkState(t);
    this.publish(id, { type: "aborted", ts: Date.now() });
    this.touch(t);
  }

  private kill(id: string, reason = "kill", rewarm = false) {
    this.notificationTurns.delete(id);
    this.continueArmed.delete(id);
    this.cancelQuestions(id);
    const live = this.live.get(id);
    if (live) {
      live.exitReason ??= reason;
      clearTimeout(live.interrupting);
      live.rewarm = rewarm && live.agent.alive;
      live.aborted = true;
      this.live.delete(id);
      live.agent.kill();
    }
    const t = this.threads.get(id);
    if (t) this.emitWorkState(t);
    if (t?.background) {
      delete t.background;
      this.emit({ t: "thread", thread: t });
    } // the tasks died with the process
  }

  private staleRouting(live: Live) {
    return live.recycleRouting || (!!live.proxyUrl && live.proxyUrl !== headroom.url());
  }

  private recycleRouting(id: string) {
    const live = this.live.get(id),
      t = this.threads.get(id);
    if (!live || !t || !this.staleRouting(live)) return false;
    live.recycleRouting = true;
    // Background subagents and running turns retain their process until they finish.
    if (t.status !== "idle" || t.background || t.operation) return false;
    this.kill(id, "stale-proxy-routing");
    return true;
  }

  routingHealth() {
    let idle = 0,
      active = 0,
      silent = 0;
    for (const [id, live] of this.live) {
      const t = this.threads.get(id);
      if (!t) continue;
      if (this.staleRouting(live)) {
        if (t.status === "idle" && !t.background && !t.operation) idle++;
        else active++;
      }
      if (this.staleTurn(t, live)) silent++;
    }
    return { idle, active, silent };
  }

  private staleTurn(t: Thread, live: Live) {
    return (
      t.status === "running" &&
      !t.background &&
      !this.questions.list(t.id).some((q) => !q.async) &&
      Date.now() -
        Math.max(live.heardAt ?? 0, live.spawnAt ?? 0, this.turns.get(t.id)?.start ?? 0) >
        TURN_STALE_MS
    );
  }

  repairStaleTurns() {
    let fixed = 0;
    for (const [id, live] of this.live) {
      const t = this.threads.get(id);
      if (t && this.staleTurn(t, live)) {
        this.expire(t);
        fixed++;
      }
    }
    return fixed;
  }

  repairRouting() {
    let fixed = 0,
      deferred = 0;
    for (const [id, live] of this.live) {
      if (!this.staleRouting(live)) continue;
      if (this.recycleRouting(id)) fixed++;
      else deferred++;
    }
    return { fixed, deferred };
  }

  // free memory from idle agent processes; sessions resume on the next message
  sweep(memAvailable = os.freemem() / os.totalmem()) {
    this.repairRouting();
    const idle: [string, number][] = [];
    for (const [threadId, live] of this.live) this.sweepLive(threadId, live, idle);
    idle.sort((left, right) => left[1] - right[1]); // oldest first
    this.evictIdle(idle, memAvailable);
    // no process left to finish them
    for (const thread of this.threads.values())
      if (thread.background && !this.live.has(thread.id)) {
        delete thread.background;
        this.emit({ t: "thread", thread });
      }
  }

  private evictIdle(idle: [string, number][], memAvailable: number) {
    const keep = memAvailable < IDLE_MEM_FLOOR ? 2 : IDLE_MAX;
    for (const [threadId] of idle.slice(0, Math.max(0, idle.length - keep)))
      this.kill(threadId, memAvailable < IDLE_MEM_FLOOR ? "memory" : "idle-cap");
  }

  // One live agent: expire a hung turn, retire a stale process, or list it as an idle candidate.
  private sweepLive(threadId: string, live: Live, idle: [string, number][]) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    if (thread.status === "running") return this.sweepRunning(threadId, live, thread);
    if (thread.status !== "idle") return;
    if (thread.background) {
      if (Date.now() - (live.heardAt ?? live.spawnAt!) > BACKGROUND_STALE_MS)
        this.kill(threadId, "stale-background");
      return;
    }
    const lastActive = Math.max(thread.updatedAt, live.spawnAt!);
    if (Date.now() - lastActive > (live.warm ? WARM_IDLE_MS : IDLE_KILL_MS))
      return this.kill(threadId, "idle");
    if (!thread.operation) idle.push([threadId, lastActive]);
  }

  private sweepRunning(threadId: string, live: Live, thread: Thread) {
    if (this.questions.list(threadId).some((request) => !request.async)) live.heardAt = Date.now(); // waiting on the user is not silence
    const lastSign = Math.max(
      live.heardAt ?? 0,
      live.spawnAt!,
      this.turns.get(threadId)?.start ?? 0,
    );
    if (Date.now() - lastSign > TURN_STALE_MS) this.expire(thread);
  }

  // End a hung turn like a crash, except that whatever was queued behind it still goes out.
  private expire(t: Thread) {
    const notify = !t.operation && this.notificationTurns.has(t.id);
    this.kill(t.id, "stale-turn");
    t.status = "idle";
    delete t.operation;
    this.publish(t.id, {
      type: "console_error",
      text: `No output for ${Math.round(TURN_STALE_MS / 60_000)} minutes, so the hung turn was stopped. Send a message to continue the session.`,
    });
    if (notify) this.notify(t, "failed");
    this.endTiming(t, { subtype: "stale", is_error: true });
    this.touch(t);
    this.drain(t.id);
  }

  shutdown() {
    this.closed = true;
    this.idleCompactionTimers.shutdown();
    for (const id of [...this.live.keys()]) this.kill(id, "shutdown");
  }
}
