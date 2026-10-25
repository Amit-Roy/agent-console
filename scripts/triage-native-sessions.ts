import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Provider = "claude" | "codex" | "pi";
type Row = Record<string, any>;
export interface NativeSessionOptions {
  /** Unspecified roots are skipped, so scratch calibration cannot read production history. */
  claudeDir?: string;
  codexDir?: string;
  piDir?: string;
  activeNativeSessionIds?: string[];
  detectRunningProcesses?: boolean;
  now?: number;
  maxFileBytes?: number;
}
export interface NativeSessionTask {
  id: string;
  group: string;
  startedAt: string;
  completedAt: string;
  request: string;
  preworkContext: never[];
  provider: Provider;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  nonCachedInputTokens: number | null;
  toolCalls: number;
  toolRounds: number | null;
  provenance: {
    scope: "completed-session";
    source: "native-session";
    snapshot: true;
    nativeSessionIds: string[];
    rootNativeSessionId: string;
    childCount: number;
    terminalStatus: string;
    usageRecords: number;
    childUsageIncluded: boolean;
    origin: { entrypoint?: string; cwd?: string };
    userOrigin: boolean;
  };
}
interface Parsed {
  provider: Provider;
  id: string;
  parent?: string;
  fork?: string;
  child: boolean;
  startedAt: string;
  completedAt: string;
  request?: string;
  terminalStatus: string;
  input: number;
  output: number;
  cache: number | null;
  fresh: number | null;
  calls: Set<string>;
  rounds: number | null;
  usageRecords: number;
  usages: Map<string, Usage>;
  copiedRows: number;
  duplicateUsageRecords: number;
  missingUsage: boolean;
  error?: string;
  /** Claude `entrypoint` or Codex `originator`; Pi has none. */
  entrypoint?: string;
  cwd?: string;
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e15;
const idText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 250 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const date = (value: unknown): string | undefined => {
  const time =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= 0 && time < 1e15
    ? new Date(time).toISOString()
    : undefined;
};
const textBlocks = (content: any): string[] =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content
          .filter(
            (block) =>
              ["text", "input_text"].includes(block?.type) && typeof block.text === "string",
          )
          .map((block) => block.text)
      : [];
/** Control/context messages are not user intent. Tool result blocks never enter this path. */
export function genuineNativeRequest(content: unknown): string | undefined {
  const blocks = textBlocks(content)
    .map((text) => text.trim())
    .filter(
      (text) =>
        text &&
        !/^(?:# AGENTS\.md instructions|<environment_context>|<permissions[ _]|<collaboration_mode>|<skills_instructions>|<system[-_]reminder>|<local-command|<command-(?:name|message)>|\[Request interrupted by user|This session is being continued from a previous conversation|You are an agent in a team of agents)/i.test(
          text,
        ),
    );
  const joined = blocks.join("\n\n").trim();
  return joined || undefined;
}

function readDirectory(directory: string): fs.Dirent[] | undefined {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw Error("directory-unreadable");
  }
}
function walkDirectory(directory: string, depth: number, files: string[], limit: number) {
  if (depth > 16) throw Error("directory-depth-limit");
  const entries = readDirectory(directory);
  if (!entries) return;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkDirectory(file, depth + 1, files, limit);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(file);
      if (files.length > limit) throw Error("file-count-limit");
    }
  }
}
function listFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw Error("symlink-root");
  walkDirectory(root, 0, files, limit);
  return files;
}
function readDescriptor(descriptor: number, maxBytes: number) {
  const before = fs.fstatSync(descriptor);
  if (!before.isFile() || before.size > maxBytes) throw Error("file-size-limit");
  const buffer = Buffer.alloc(before.size + 1);
  let length = 0;
  while (length < buffer.length) {
    const bytes = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
    if (!bytes) break;
    length += bytes;
  }
  const after = fs.fstatSync(descriptor);
  if (
    length !== before.size ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw Error("file-changed-during-read");
  const raw = buffer.subarray(0, length).toString("utf8");
  if (!Buffer.from(raw).equals(buffer.subarray(0, length))) throw Error("invalid-encoding");
  return raw;
}
function parseJsonlRows(raw: string): Row[] {
  const rows: Row[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      throw Error("malformed-jsonl");
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw Error("malformed-jsonl");
    rows.push(row);
    if (rows.length > 250_000) throw Error("record-count-limit");
  }
  return rows;
}
function readRows(file: string, maxBytes: number): Row[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    return parseJsonlRows(readDescriptor(fd, maxBytes));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function base(provider: Provider, id: string, rows: Row[]): Parsed {
  const timestamps = rows
    .map((row) => date(row.timestamp))
    .filter((time): time is string => !!time)
    .sort();
  return {
    provider,
    id,
    child: false,
    startedAt: timestamps[0] ?? "",
    completedAt: timestamps.at(-1) ?? "",
    terminalStatus: "inactive-snapshot",
    input: 0,
    output: 0,
    cache: 0,
    fresh: 0,
    calls: new Set(),
    usages: new Map(),
    copiedRows: 0,
    duplicateUsageRecords: 0,
    rounds: 0,
    usageRecords: 0,
    missingUsage: false,
  };
}
interface Usage {
  input: number;
  output: number;
  cache: number | null;
  fresh: number | null;
}
function mergeHighwater(previous: Usage | undefined, current: Usage): Usage {
  if (!previous) return current;
  return {
    input: Math.max(previous.input, current.input),
    output: Math.max(previous.output, current.output),
    cache:
      previous.cache === null || current.cache === null
        ? null
        : Math.max(previous.cache, current.cache),
    fresh:
      previous.fresh === null || current.fresh === null
        ? null
        : Math.max(previous.fresh, current.fresh),
  };
}
function applyUsage(result: Parsed, usage: Iterable<[string, Usage]>) {
  for (const [id, item] of usage) {
    result.usages.set(id, item);
    result.input += item.input;
    result.output += item.output;
    result.cache = result.cache === null || item.cache === null ? null : result.cache + item.cache;
    result.fresh = result.fresh === null || item.fresh === null ? null : result.fresh + item.fresh;
    result.usageRecords++;
  }
  if (!result.usageRecords) result.missingUsage = true;
}
function claudeUsage(usage: any): Usage | undefined {
  if (!finite(usage?.input_tokens) || !finite(usage?.output_tokens)) return;
  // Claude input_tokens excludes cache reads and cache creation.
  if (!finite(usage.cache_creation_input_tokens) || !finite(usage.cache_read_input_tokens)) return;
  return {
    input: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    output: usage.output_tokens,
    cache: usage.cache_read_input_tokens,
    fresh: usage.input_tokens + usage.cache_creation_input_tokens,
  };
}
interface ClaudeState {
  result: Parsed;
  usages: Map<string, Usage>;
  missingIds: Set<string>;
  toolRounds: Set<string>;
}
function claudeMessageId(message: any, row: Row): string | undefined {
  if (idText(message.id)) return message.id;
  return idText(row.requestId) ? row.requestId : undefined;
}
function recordClaudeUsage(state: ClaudeState, messageId: string | undefined, usage?: Usage) {
  const { result, usages, missingIds } = state;
  if (messageId && usage) {
    if (usages.has(messageId)) result.duplicateUsageRecords++;
    usages.set(messageId, mergeHighwater(usages.get(messageId), usage));
    missingIds.delete(messageId);
    return;
  }
  if (messageId) {
    if (!usages.has(messageId)) missingIds.add(messageId);
    return;
  }
  if (usage) result.missingUsage = true;
}
function recordClaudeToolUses(state: ClaudeState, message: any, messageId?: string) {
  for (const block of Array.isArray(message.content) ? message.content : [])
    if (block?.type === "tool_use" && idText(block.id)) {
      state.result.calls.add(block.id);
      if (messageId) state.toolRounds.add(messageId);
    }
}
function handleClaudeAssistant(state: ClaudeState, row: Row, message: any) {
  const messageId = claudeMessageId(message, row);
  recordClaudeUsage(state, messageId, claudeUsage(message.usage));
  recordClaudeToolUses(state, message, messageId);
  if (["end_turn", "stop_sequence"].includes(message.stop_reason))
    state.result.terminalStatus = "turn-finished";
  else if (message.stop_reason === "tool_use")
    state.result.terminalStatus = "inactive-after-tool-call";
}
function handleClaudeRow(state: ClaudeState, row: Row) {
  const { result } = state;
  if (!result.entrypoint && idText(row.entrypoint)) {
    result.entrypoint = row.entrypoint;
    if (idText(row.cwd)) result.cwd = row.cwd;
  }
  const message = row.message;
  if (row.type === "user" && !row.isMeta && row.promptSource !== "system" && !result.request)
    result.request = genuineNativeRequest(message?.content);
  if (row.type === "assistant" && message?.role === "assistant")
    handleClaudeAssistant(state, row, message);
  if (row.type === "system" && row.subtype === "api_error")
    result.terminalStatus = "observed-error";
  if (row.type === "user" && !row.isMeta && genuineNativeRequest(message?.content))
    result.terminalStatus = "inactive-after-user";
}
const INTERACTIVE_ORIGINS: Record<string, string> = {
  claude: "cli",
  codex: "codex-tui",
};
function underDirectory(cwd: string, directory: string) {
  const relative = path.relative(directory, path.resolve(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
/** Probe, test and scratch directories never hold real user requests. */
function probeCwd(cwd: string) {
  const home = os.homedir();
  if (underDirectory(cwd, "/tmp") || underDirectory(cwd, path.join(home, "worktrees"))) return true;
  const rel = path.relative(home, path.resolve(cwd));
  return !rel.startsWith("..") && !path.isAbsolute(rel) && /^scratch[^/]*(\/|$)/.test(rel);
}
/** Origin only, never outcome: zero-tool-call sessions stay. */
function isUserOrigin(root: Parsed) {
  if (root.provider !== "pi" && root.entrypoint !== INTERACTIVE_ORIGINS[root.provider])
    return false;
  if (!root.cwd) return root.provider === "pi";
  return !probeCwd(root.cwd);
}
function parseClaude(file: string, rows: Row[]): Parsed {
  const sessionIds = rows.map((row) => row.sessionId).filter(idText);
  const filenameId = path.basename(file, ".jsonl");
  const id = sessionIds.includes(filenameId) ? filenameId : (sessionIds[0] ?? filenameId);
  const result = base("claude", id, rows);
  const parentMatch = file.replaceAll("\\", "/").match(/\/([^/]+)\/subagents\/[^/]+\.jsonl$/);
  if (parentMatch) {
    result.child = true;
    result.parent = parentMatch[1];
    result.id = path.basename(file, ".jsonl");
  }
  const state: ClaudeState = {
    result,
    usages: new Map<string, Usage>(),
    missingIds: new Set<string>(),
    toolRounds: new Set<string>(),
  };
  for (const row of rows) {
    if (!result.child && idText(row.sessionId) && row.sessionId !== id) {
      // Copied native fork history is provenance, not a new API request.
      result.fork ??= row.sessionId;
      result.copiedRows++;
      continue;
    }
    handleClaudeRow(state, row);
  }
  applyUsage(result, state.usages.entries());
  result.rounds = state.toolRounds.size;
  result.missingUsage ||= state.missingIds.size > 0;
  return result;
}
function codexUsage(usage: any): Usage | undefined {
  if (!finite(usage?.input_tokens) || !finite(usage?.output_tokens)) return;
  const cached =
    finite(usage.cached_input_tokens) && usage.cached_input_tokens <= usage.input_tokens
      ? usage.cached_input_tokens
      : null;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache: cached,
    fresh: cached === null ? null : usage.input_tokens - cached,
  };
}
interface CodexState {
  result: Parsed;
  sessionId: string;
  usages: Map<string, Usage>;
  fallback: Usage[];
  previous: Usage | undefined;
}
function codexMeta(file: string, rows: Row[]): Row {
  const metadata = rows.filter((row) => row.type === "session_meta");
  return (
    metadata.find(
      (row) => idText(row.payload?.id) && path.basename(file).includes(row.payload.id),
    ) ?? metadata.at(-1)!
  );
}
function recordCodexUsage(state: CodexState, payload: any) {
  const { result, usages } = state;
  // Fork logs may contain cloned parent records. Thread attribution is mandatory.
  if (payload.thread_id !== state.sessionId) {
    result.copiedRows++;
    return;
  }
  const usage = codexUsage(payload.usage);
  if (!usage || !idText(payload.response_id)) {
    result.missingUsage = true;
    return;
  }
  if (usages.has(payload.response_id)) result.duplicateUsageRecords++;
  usages.set(payload.response_id, mergeHighwater(usages.get(payload.response_id), usage));
}
function recordCodexResponse(result: Parsed, payload: any) {
  if (payload.type === "message" && payload.role === "user" && !result.request)
    result.request = genuineNativeRequest(payload.content);
  if (
    ["function_call", "custom_tool_call"].includes(payload.type) &&
    idText(payload.call_id ?? payload.id)
  )
    result.calls.add(payload.call_id ?? payload.id);
}
function cumulativeDelta(total: Usage, previous: Usage | undefined): Usage {
  const reset = previous && (total.input < previous.input || total.output < previous.output);
  const carry = !reset && previous ? previous : undefined;
  return {
    input: total.input - (carry ? carry.input : 0),
    output: total.output - (carry ? carry.output : 0),
    cache:
      total.cache === null || (previous && previous.cache === null)
        ? null
        : Math.max(0, total.cache - (carry ? carry.cache! : 0)),
    fresh:
      total.fresh === null || (previous && previous.fresh === null)
        ? null
        : Math.max(0, total.fresh - (carry ? carry.fresh! : 0)),
  };
}
function recordCodexEvent(state: CodexState, payload: any) {
  const { result } = state;
  if (["task_complete", "turn_complete"].includes(payload.type))
    result.terminalStatus = "turn-finished";
  if (["turn_aborted", "task_aborted"].includes(payload.type))
    result.terminalStatus = "observed-interruption";
  if (payload.type === "task_started") result.terminalStatus = "inactive-unfinished-turn";
  if (payload.type !== "token_count") return;
  const total = codexUsage(payload.info?.total_token_usage);
  if (!total) return;
  state.fallback.push(cumulativeDelta(total, state.previous));
  state.previous = total;
}
function handleCodexRow(state: CodexState, row: Row) {
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return;
  if (row.type === "token_usage_record") recordCodexUsage(state, payload);
  else if (row.type === "response_item") recordCodexResponse(state.result, payload);
  else if (row.type === "event_msg") recordCodexEvent(state, payload);
}
function parseCodex(file: string, rows: Row[]): Parsed {
  const meta = codexMeta(file, rows);
  const id = meta?.payload?.id;
  if (!idText(id)) throw Error("missing-session-id");
  const result = base("codex", id, rows);
  const source = meta.payload.source;
  if (idText(meta.payload.originator)) result.entrypoint = meta.payload.originator;
  if (idText(meta.payload.cwd)) result.cwd = meta.payload.cwd;
  result.child = !!source && typeof source === "object";
  const parent = source?.subagent?.thread_spawn?.parent_thread_id ?? meta.payload.parent_thread_id;
  if (idText(parent)) result.parent = parent;
  if (idText(meta.payload.forked_from_id)) result.fork = meta.payload.forked_from_id;
  const state: CodexState = {
    result,
    sessionId: id,
    usages: new Map<string, Usage>(),
    fallback: [],
    previous: undefined,
  };
  for (const row of rows.slice(rows.indexOf(meta))) handleCodexRow(state, row);
  const { usages, fallback } = state;
  applyUsage(
    result,
    usages.size
      ? usages.entries()
      : fallback.map((usage, index) => [`${id}:cumulative:${index}`, usage] as [string, Usage]),
  );
  if (!usages.size && result.fork) result.missingUsage = true;
  // Native records identify calls but do not reliably identify model/tool rounds.
  result.rounds = null;
  return result;
}
function piStatus(stopReason: unknown) {
  if (stopReason === "error") return "observed-error";
  return stopReason === "aborted" ? "observed-interruption" : "turn-finished";
}
function piUsage(usage: any): Usage {
  return {
    input: usage.input + usage.cacheRead + usage.cacheWrite,
    output: usage.output,
    cache: usage.cacheRead,
    fresh: usage.input + usage.cacheWrite,
  };
}
function validPiUsage(row: Row, usage: any) {
  return (
    idText(row.id) &&
    finite(usage?.input) &&
    finite(usage?.output) &&
    finite(usage?.cacheRead) &&
    finite(usage?.cacheWrite)
  );
}
function handlePiAssistant(
  result: Parsed,
  usages: Map<string, Usage>,
  rounds: Set<string>,
  row: Row,
) {
  const message = row.message;
  const usage = message.usage;
  if (!validPiUsage(row, usage)) result.missingUsage = true;
  else {
    if (usages.has(row.id)) result.duplicateUsageRecords++;
    usages.set(row.id, mergeHighwater(usages.get(row.id), piUsage(usage)));
  }
  for (const block of Array.isArray(message.content) ? message.content : [])
    if (block?.type === "toolCall" && idText(block.id)) {
      result.calls.add(block.id);
      if (idText(row.id)) rounds.add(row.id);
    }
  result.terminalStatus = piStatus(message.stopReason);
}
function parsePi(file: string, rows: Row[]): Parsed {
  const session = rows.find((row) => row.type === "session");
  const result = base("pi", idText(session?.id) ? session.id : path.basename(file, ".jsonl"), rows);
  if (idText(session?.cwd)) result.cwd = session.cwd;
  const usages = new Map<string, Usage>();
  const rounds = new Set<string>();
  for (const row of rows) {
    if (row.type !== "message") continue;
    const message = row.message;
    if (message?.role === "user" && !result.request)
      result.request = genuineNativeRequest(message.content);
    if (message?.role === "assistant") handlePiAssistant(result, usages, rounds, row);
  }
  applyUsage(result, usages.entries());
  result.rounds = rounds.size;
  return result;
}

function runningSessionIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const pid of fs
      .readdirSync("/proc")
      .filter((value) => /^\d+$/.test(value))
      .slice(0, 8_192)) {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (args.length > 65_536 || !/(?:^|[\x00/])(?:claude|codex|pi)(?:\.js)?\x00/.test(args))
          continue;
        for (const match of args.matchAll(
          /(?:--resume|--session(?:-id)?|\bresume|-r)\x00([a-f\d-]{36})(?:\x00|$)/gi,
        ))
          ids.add(match[1]);
      } catch {}
    }
  } catch {}
  return ids;
}

type NativeAudit = ReturnType<typeof newNativeAudit>;
function newNativeAudit() {
  return {
    files: 0,
    roots: 0,
    children: 0,
    included: 0,
    includedChildren: 0,
    orphanChildren: 0,
    duplicateSessions: 0,
    excluded: {} as Record<string, number>,
    copiedRowsIgnored: 0,
    duplicateUsageRecords: 0,
    rolledUpDuplicateUsageRecords: 0,
    rolledUpDuplicateToolCalls: 0,
    exclusions: [] as { provider: Provider; nativeSessionId?: string; reason: string }[],
    sources: { claude: 0, codex: 0, pi: 0 },
    snapshotBasis: "inactive-observed-session" as const,
  };
}
function excludeSession(
  audit: NativeAudit,
  provider: Provider,
  reason: string,
  nativeSessionId?: string,
) {
  audit.excluded[reason] = (audit.excluded[reason] ?? 0) + 1;
  audit.exclusions.push({ provider, nativeSessionId, reason });
}
function parseByProvider(provider: Provider, file: string, rows: Row[]) {
  if (provider === "claude") return parseClaude(file, rows);
  return provider === "codex" ? parseCodex(file, rows) : parsePi(file, rows);
}
function ingestFile(
  audit: NativeAudit,
  sessions: Map<string, Parsed>,
  provider: Provider,
  file: string,
  maxBytes: number,
) {
  audit.files++;
  audit.sources[provider]++;
  try {
    const parsed = parseByProvider(provider, file, readRows(file, maxBytes));
    const key = `${provider}:${parsed.id}`;
    if (sessions.has(key)) {
      audit.duplicateSessions++;
      // Duplicate logs are never summed. Keep the most complete observed copy.
      const old = sessions.get(key)!;
      if (parsed.completedAt <= old.completedAt) return;
    }
    sessions.set(key, parsed);
  } catch (error) {
    excludeSession(audit, provider, (error as Error).message);
  }
}
function loadSessions(audit: NativeAudit, options: NativeSessionOptions, maxBytes: number) {
  const sessions = new Map<string, Parsed>();
  for (const [provider, directory] of [
    ["claude", options.claudeDir],
    ["codex", options.codexDir],
    ["pi", options.piDir],
  ] as const) {
    if (!directory) continue;
    let files: string[];
    try {
      files = listFiles(directory, 5_000);
    } catch (error) {
      excludeSession(audit, provider, (error as Error).message);
      continue;
    }
    for (const file of files) ingestFile(audit, sessions, provider, file, maxBytes);
  }
  return sessions;
}
function groupChildren(audit: NativeAudit, sessions: Map<string, Parsed>) {
  const children = new Map<string, Parsed[]>();
  for (const parsed of sessions.values()) {
    if (!parsed.child) {
      audit.roots++;
      continue;
    }
    audit.children++;
    if (!parsed.parent || !sessions.has(`${parsed.provider}:${parsed.parent}`)) {
      audit.orphanChildren++;
      excludeSession(audit, parsed.provider, "orphan-child", parsed.id);
      continue;
    }
    const key = `${parsed.provider}:${parsed.parent}`;
    children.set(key, [...(children.get(key) ?? []), parsed]);
  }
  return children;
}
function collectFamily(
  session: Parsed,
  children: Map<string, Parsed[]>,
  seen: Set<string>,
  family: Parsed[],
) {
  const key = `${session.provider}:${session.id}`;
  if (seen.has(key)) throw Error("child-cycle");
  seen.add(key);
  family.push(session);
  for (const child of children.get(key) ?? []) collectFamily(child, children, seen, family);
}
function familyExclusion(root: Parsed, family: Parsed[], active: Set<string>) {
  if (family.some((session) => active.has(session.id))) return "active-session";
  if (!root.request) return "missing-initial-user-request";
  if (family.some((session) => !session.startedAt || !session.completedAt))
    return "missing-session-timestamps";
  if (family.some((session) => session.missingUsage)) return "missing-usage-telemetry";
  return undefined;
}
function rootLineage(root: Parsed, sessions: Map<string, Parsed>) {
  let lineage = root.id;
  let ancestor: Parsed | undefined = root;
  const ancestors = new Set<string>();
  while (ancestor?.fork && !ancestors.has(ancestor.fork)) {
    ancestors.add(ancestor.fork);
    lineage = ancestor.fork;
    ancestor = sessions.get(`${root.provider}:${ancestor.fork}`);
  }
  return lineage;
}
function buildFamilyTask(
  audit: NativeAudit,
  sessions: Map<string, Parsed>,
  root: Parsed,
  family: Parsed[],
): NativeSessionTask {
  const usages = new Map<string, Usage>();
  const calls = new Set<string>();
  for (const session of family) {
    for (const [usageId, usage] of session.usages)
      usages.set(usageId, mergeHighwater(usages.get(usageId), usage));
    for (const callId of session.calls) calls.add(callId);
  }
  const measurements = [...usages.values()];
  audit.rolledUpDuplicateUsageRecords +=
    family.reduce((sum, session) => sum + session.usages.size, 0) - usages.size;
  audit.rolledUpDuplicateToolCalls +=
    family.reduce((sum, session) => sum + session.calls.size, 0) - calls.size;
  const total = (key: "input" | "output") =>
    measurements.reduce((sum, usage) => sum + usage[key], 0);
  const usageOptional = (key: "cache" | "fresh") =>
    measurements.some((usage) => usage[key] === null)
      ? null
      : measurements.reduce((sum, usage) => sum + usage[key]!, 0);
  const optional = (key: "cache" | "fresh" | "rounds") =>
    family.some((session) => session[key] === null)
      ? null
      : family.reduce((sum, session) => sum + session[key]!, 0);
  const lineage = rootLineage(root, sessions);
  return {
    id: `native:${root.provider}:${root.id}`,
    group: `native:${root.provider}:${lineage}`,
    startedAt: family.map((session) => session.startedAt).sort()[0],
    completedAt: family
      .map((session) => session.completedAt)
      .sort()
      .at(-1)!,
    request: root.request!.slice(0, 12_000),
    preworkContext: [],
    provider: root.provider,
    inputTokens: total("input"),
    outputTokens: total("output"),
    cacheReadTokens: usageOptional("cache"),
    nonCachedInputTokens: usageOptional("fresh"),
    toolCalls: calls.size,
    toolRounds: optional("rounds"),
    provenance: {
      scope: "completed-session",
      source: "native-session",
      snapshot: true,
      initialRequestCharacters: root.request!.length,
      initialRequestTruncated: root.request!.length > 12_000,
      nativeSessionIds: family.map((session) => session.id),
      rootNativeSessionId: root.id,
      childCount: family.length - 1,
      terminalStatus: root.terminalStatus,
      usageRecords: usages.size,
      childUsageIncluded: true,
      origin: { entrypoint: root.entrypoint, cwd: root.cwd },
      userOrigin: isUserOrigin(root),
    },
  } as NativeSessionTask;
}
/** Returns the task for one root family, or records the exclusion and returns nothing. */
function evaluateRoot(
  audit: NativeAudit,
  sessions: Map<string, Parsed>,
  children: Map<string, Parsed[]>,
  active: Set<string>,
  root: Parsed,
) {
  const family: Parsed[] = [];
  try {
    collectFamily(root, children, new Set<string>(), family);
  } catch {
    excludeSession(audit, root.provider, "child-cycle", root.id);
    return undefined;
  }
  const reason = familyExclusion(root, family, active);
  if (reason) {
    excludeSession(audit, root.provider, reason, root.id);
    return undefined;
  }
  const task = buildFamilyTask(audit, sessions, root, family);
  if (![task.inputTokens, task.outputTokens, task.toolCalls].every(finite)) {
    excludeSession(audit, root.provider, "invalid-session-totals", root.id);
    return undefined;
  }
  audit.included++;
  audit.includedChildren += family.length - 1;
  return task;
}

/** Parse inactive observed snapshots, including failures. Never require commits or success. */
export function buildNativeSessions(options: NativeSessionOptions = {}) {
  const audit = newNativeAudit();
  const active = new Set(options.activeNativeSessionIds ?? []);
  if (options.detectRunningProcesses !== false)
    for (const runningId of runningSessionIds()) active.add(runningId);
  const maxBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024)
    throw Error("Invalid native session file limit");
  const sessions = loadSessions(audit, options, maxBytes);
  const children = groupChildren(audit, sessions);
  const tasks: NativeSessionTask[] = [];
  for (const session of sessions.values()) {
    audit.copiedRowsIgnored += session.copiedRows;
    audit.duplicateUsageRecords += session.duplicateUsageRecords;
  }
  for (const root of sessions.values()) {
    if (root.child) continue;
    const task = evaluateRoot(audit, sessions, children, active, root);
    if (task) tasks.push(task);
  }
  return {
    tasks: tasks.sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
    ),
    audit,
  };
}
