import fs from "node:fs";
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
  id: string; group: string; startedAt: string; completedAt: string;
  request: string; preworkContext: never[]; provider: Provider;
  inputTokens: number; outputTokens: number; cacheReadTokens: number | null;
  nonCachedInputTokens: number | null; toolCalls: number; toolRounds: number | null;
  provenance: {
    scope: "completed-session"; source: "native-session"; snapshot: true;
    nativeSessionIds: string[]; rootNativeSessionId: string; childCount: number;
    terminalStatus: string; usageRecords: number; childUsageIncluded: boolean;
  };
}
interface Parsed {
  provider: Provider; id: string; parent?: string; fork?: string; child: boolean;
  startedAt: string; completedAt: string; request?: string; terminalStatus: string;
  input: number; output: number; cache: number | null; fresh: number | null;
  calls: Set<string>; rounds: number | null; usageRecords: number;
  usages: Map<string, Usage>;
  copiedRows: number; duplicateUsageRecords: number;
  missingUsage: boolean; error?: string;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e15;
const idText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 250 && !/[\u0000-\u001f\u007f]/.test(value);
const date = (value: unknown): string | undefined => {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= 0 && time < 1e15 ? new Date(time).toISOString() : undefined;
};
const textBlocks = (content: any): string[] => typeof content === "string" ? [content] : Array.isArray(content)
  ? content.filter(block => ["text", "input_text"].includes(block?.type) && typeof block.text === "string").map(block => block.text) : [];
/** Control/context messages are not user intent. Tool result blocks never enter this path. */
export function genuineNativeRequest(content: unknown): string | undefined {
  const blocks = textBlocks(content).map(text => text.trim()).filter(text => text && !/^(?:# AGENTS\.md instructions|<environment_context>|<permissions[ _]|<collaboration_mode>|<skills_instructions>|<system[-_]reminder>|<local-command|<command-(?:name|message)>|\[Request interrupted by user|This session is being continued from a previous conversation|You are an agent in a team of agents)/i.test(text));
  const joined = blocks.join("\n\n").trim();
  return joined || undefined;
}

function listFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 16) throw Error("directory-depth-limit");
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw Error("directory-unreadable"); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) { files.push(file); if (files.length > limit) throw Error("file-count-limit"); }
    }
  };
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw Error("symlink-root");
  walk(root, 0);
  return files;
}
function readRows(file: string, maxBytes: number): Row[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw Error("file-size-limit");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) { const bytes = fs.readSync(fd, buffer, length, buffer.length - length, null); if (!bytes) break; length += bytes; }
    const after = fs.fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error("file-changed-during-read");
    const raw = buffer.subarray(0, length).toString("utf8");
    if (!Buffer.from(raw).equals(buffer.subarray(0, length))) throw Error("invalid-encoding");
    const rows: Row[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { throw Error("malformed-jsonl"); }
      if (!row || typeof row !== "object" || Array.isArray(row)) throw Error("malformed-jsonl");
      rows.push(row);
      if (rows.length > 250_000) throw Error("record-count-limit");
    }
    return rows;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function base(provider: Provider, id: string, rows: Row[]): Parsed {
  const timestamps = rows.map(row => date(row.timestamp)).filter((time): time is string => !!time).sort();
  return { provider, id, child: false, startedAt: timestamps[0] ?? "", completedAt: timestamps.at(-1) ?? "", terminalStatus: "inactive-snapshot",
    input: 0, output: 0, cache: 0, fresh: 0, calls: new Set(), usages: new Map(), copiedRows: 0, duplicateUsageRecords: 0, rounds: 0, usageRecords: 0, missingUsage: false };
}
interface Usage { input: number; output: number; cache: number | null; fresh: number | null }
function mergeHighwater(previous: Usage | undefined, current: Usage): Usage {
  if (!previous) return current;
  return { input: Math.max(previous.input, current.input), output: Math.max(previous.output, current.output),
    cache: previous.cache === null || current.cache === null ? null : Math.max(previous.cache, current.cache),
    fresh: previous.fresh === null || current.fresh === null ? null : Math.max(previous.fresh, current.fresh) };
}
function applyUsage(result: Parsed, usage: Iterable<[string, Usage]>) {
  for (const [id, item] of usage) {
    result.usages.set(id, item);
    result.input += item.input; result.output += item.output;
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
  return { input: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    output: usage.output_tokens, cache: usage.cache_read_input_tokens, fresh: usage.input_tokens + usage.cache_creation_input_tokens };
}
function parseClaude(file: string, rows: Row[]): Parsed {
  const sessionIds = rows.map(row => row.sessionId).filter(idText);
  const filenameId = path.basename(file, ".jsonl");
  const id = sessionIds.includes(filenameId) ? filenameId : sessionIds[0] ?? filenameId;
  const result = base("claude", id, rows);
  const parentMatch = file.replaceAll("\\", "/").match(/\/([^/]+)\/subagents\/[^/]+\.jsonl$/);
  if (parentMatch) { result.child = true; result.parent = parentMatch[1]; result.id = path.basename(file, ".jsonl"); }
  const usages = new Map<string, Usage>();
  const missingIds = new Set<string>();
  const toolRounds = new Set<string>();
  for (const row of rows) {
    if (!result.child && idText(row.sessionId) && row.sessionId !== id) {
      // Copied native fork history is provenance, not a new API request.
      result.fork ??= row.sessionId;
      result.copiedRows++;
      continue;
    }
    const message = row.message;
    if (row.type === "user" && !row.isMeta && row.promptSource !== "system" && !result.request) result.request = genuineNativeRequest(message?.content);
    if (row.type === "assistant" && message?.role === "assistant") {
      const messageId = idText(message.id) ? message.id : idText(row.requestId) ? row.requestId : undefined;
      const usage = claudeUsage(message.usage);
      if (messageId && usage) { if (usages.has(messageId)) result.duplicateUsageRecords++; usages.set(messageId, mergeHighwater(usages.get(messageId), usage)); missingIds.delete(messageId); }
      else if (messageId && !usages.has(messageId)) missingIds.add(messageId);
      else if (!messageId && usage) result.missingUsage = true;
      for (const block of Array.isArray(message.content) ? message.content : []) if (block?.type === "tool_use" && idText(block.id)) {
        result.calls.add(block.id); if (messageId) toolRounds.add(messageId);
      }
      if (["end_turn", "stop_sequence"].includes(message.stop_reason)) result.terminalStatus = "turn-finished";
      else if (message.stop_reason === "tool_use") result.terminalStatus = "inactive-after-tool-call";
    }
    if (row.type === "system" && row.subtype === "api_error") result.terminalStatus = "observed-error";
    if (row.type === "user" && !row.isMeta && genuineNativeRequest(message?.content)) result.terminalStatus = "inactive-after-user";
  }
  applyUsage(result, usages.entries());
  result.rounds = toolRounds.size;
  result.missingUsage ||= missingIds.size > 0;
  return result;
}
function codexUsage(usage: any): Usage | undefined {
  if (!finite(usage?.input_tokens) || !finite(usage?.output_tokens)) return;
  const cached = finite(usage.cached_input_tokens) && usage.cached_input_tokens <= usage.input_tokens ? usage.cached_input_tokens : null;
  return { input: usage.input_tokens, output: usage.output_tokens, cache: cached, fresh: cached === null ? null : usage.input_tokens - cached };
}
function parseCodex(file: string, rows: Row[]): Parsed {
  const metadata = rows.filter(row => row.type === "session_meta");
  const meta = metadata.find(row => idText(row.payload?.id) && path.basename(file).includes(row.payload.id)) ?? metadata.at(-1);
  const id = meta?.payload?.id;
  if (!idText(id)) throw Error("missing-session-id");
  const result = base("codex", id, rows);
  const source = meta.payload.source;
  result.child = !!source && typeof source === "object";
  const parent = source?.subagent?.thread_spawn?.parent_thread_id ?? meta.payload.parent_thread_id;
  if (idText(parent)) result.parent = parent;
  if (idText(meta.payload.forked_from_id)) result.fork = meta.payload.forked_from_id;
  const usages = new Map<string, Usage>();
  const fallback: Usage[] = [];
  let previous: Usage | undefined;
  let started = false;
  for (const row of rows) {
    if (row === meta) started = true;
    if (!started) continue;
    const payload = row.payload;
    if (!payload || typeof payload !== "object") continue;
    if (row.type === "token_usage_record") {
      // Fork logs may contain cloned parent records. Thread attribution is mandatory.
      if (payload.thread_id !== id) { result.copiedRows++; continue; }
      const usage = codexUsage(payload.usage);
      if (!usage || !idText(payload.response_id)) { result.missingUsage = true; continue; }
      if (usages.has(payload.response_id)) result.duplicateUsageRecords++;
      usages.set(payload.response_id, mergeHighwater(usages.get(payload.response_id), usage));
    }
    if (row.type === "response_item") {
      if (payload.type === "message" && payload.role === "user" && !result.request) result.request = genuineNativeRequest(payload.content);
      if (["function_call", "custom_tool_call"].includes(payload.type) && idText(payload.call_id ?? payload.id)) result.calls.add(payload.call_id ?? payload.id);
    }
    if (row.type === "event_msg") {
      if (["task_complete", "turn_complete"].includes(payload.type)) result.terminalStatus = "turn-finished";
      if (["turn_aborted", "task_aborted"].includes(payload.type)) result.terminalStatus = "observed-interruption";
      if (payload.type === "task_started") result.terminalStatus = "inactive-unfinished-turn";
      if (payload.type === "token_count") {
        const total = codexUsage(payload.info?.total_token_usage);
        if (total) {
          const reset = previous && (total.input < previous.input || total.output < previous.output);
          fallback.push({ input: total.input - (!reset && previous ? previous.input : 0), output: total.output - (!reset && previous ? previous.output : 0),
            cache: total.cache === null || (previous && previous.cache === null) ? null : Math.max(0, total.cache - (!reset && previous ? previous.cache! : 0)),
            fresh: total.fresh === null || (previous && previous.fresh === null) ? null : Math.max(0, total.fresh - (!reset && previous ? previous.fresh! : 0)) });
          previous = total;
        }
      }
    }
  }
  applyUsage(result, usages.size ? usages.entries() : fallback.map((usage, index) => [`${id}:cumulative:${index}`, usage] as [string, Usage]));
  if (!usages.size && result.fork) result.missingUsage = true;
  // Native records identify calls but do not reliably identify model/tool rounds.
  result.rounds = null;
  return result;
}
function parsePi(file: string, rows: Row[]): Parsed {
  const session = rows.find(row => row.type === "session");
  const result = base("pi", idText(session?.id) ? session.id : path.basename(file, ".jsonl"), rows);
  const usages = new Map<string, Usage>();
  const rounds = new Set<string>();
  for (const row of rows) {
    if (row.type !== "message") continue;
    const message = row.message;
    if (message?.role === "user" && !result.request) result.request = genuineNativeRequest(message.content);
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if (!idText(row.id) || !finite(usage?.input) || !finite(usage?.output) || !finite(usage?.cacheRead) || !finite(usage?.cacheWrite)) result.missingUsage = true;
    else {
      if (usages.has(row.id)) result.duplicateUsageRecords++;
      usages.set(row.id, mergeHighwater(usages.get(row.id), { input: usage.input + usage.cacheRead + usage.cacheWrite,
        output: usage.output, cache: usage.cacheRead, fresh: usage.input + usage.cacheWrite }));
    }
    for (const block of Array.isArray(message.content) ? message.content : []) if (block?.type === "toolCall" && idText(block.id)) {
      result.calls.add(block.id); if (idText(row.id)) rounds.add(row.id);
    }
    result.terminalStatus = message.stopReason === "error" ? "observed-error" : message.stopReason === "aborted" ? "observed-interruption" : "turn-finished";
  }
  applyUsage(result, usages.entries()); result.rounds = rounds.size;
  return result;
}

function runningSessionIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const pid of fs.readdirSync("/proc").filter(value => /^\d+$/.test(value)).slice(0, 8_192)) {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (args.length > 65_536 || !/(?:^|[\x00/])(?:claude|codex|pi)(?:\.js)?\x00/.test(args)) continue;
        for (const match of args.matchAll(/(?:--resume|--session(?:-id)?|\bresume|-r)\x00([a-f\d-]{36})(?:\x00|$)/gi)) ids.add(match[1]);
      } catch {}
    }
  } catch {}
  return ids;
}

/** Parse inactive observed snapshots, including failures. Never require commits or success. */
export function buildNativeSessions(options: NativeSessionOptions = {}) {
  const audit = {
    files: 0, roots: 0, children: 0, included: 0, includedChildren: 0, orphanChildren: 0,
    duplicateSessions: 0, excluded: {} as Record<string, number>,
    copiedRowsIgnored: 0, duplicateUsageRecords: 0, rolledUpDuplicateUsageRecords: 0, rolledUpDuplicateToolCalls: 0,
    exclusions: [] as { provider: Provider; nativeSessionId?: string; reason: string }[],
    sources: { claude: 0, codex: 0, pi: 0 }, snapshotBasis: "inactive-observed-session" as const,
  };
  const exclude = (provider: Provider, reason: string, nativeSessionId?: string) => {
    audit.excluded[reason] = (audit.excluded[reason] ?? 0) + 1;
    audit.exclusions.push({ provider, nativeSessionId, reason });
  };
  const sessions = new Map<string, Parsed>();
  const active = new Set(options.activeNativeSessionIds ?? []);
  if (options.detectRunningProcesses !== false) for (const id of runningSessionIds()) active.add(id);
  const maxBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw Error("Invalid native session file limit");
  for (const [provider, directory] of [["claude", options.claudeDir], ["codex", options.codexDir], ["pi", options.piDir]] as const) {
    if (!directory) continue;
    let files: string[];
    try { files = listFiles(directory, 5_000); }
    catch (error) { exclude(provider, (error as Error).message); continue; }
    for (const file of files) {
      audit.files++; audit.sources[provider]++;
      try {
        const rows = readRows(file, maxBytes);
        const parsed = provider === "claude" ? parseClaude(file, rows) : provider === "codex" ? parseCodex(file, rows) : parsePi(file, rows);
        const key = `${provider}:${parsed.id}`;
        if (sessions.has(key)) {
          audit.duplicateSessions++;
          // Duplicate logs are never summed. Keep the most complete observed copy.
          const old = sessions.get(key)!;
          if (parsed.completedAt <= old.completedAt) continue;
        }
        sessions.set(key, parsed);
      } catch (error) { exclude(provider, (error as Error).message); }
    }
  }
  const children = new Map<string, Parsed[]>();
  for (const parsed of sessions.values()) {
    if (parsed.child) {
      audit.children++;
      if (!parsed.parent || !sessions.has(`${parsed.provider}:${parsed.parent}`)) { audit.orphanChildren++; exclude(parsed.provider, "orphan-child", parsed.id); continue; }
      const key = `${parsed.provider}:${parsed.parent}`;
      children.set(key, [...(children.get(key) ?? []), parsed]);
    } else audit.roots++;
  }
  const tasks: NativeSessionTask[] = [];
  for (const session of sessions.values()) {
    audit.copiedRowsIgnored += session.copiedRows;
    audit.duplicateUsageRecords += session.duplicateUsageRecords;
  }
  for (const root of sessions.values()) {
    if (root.child) continue;
    const family: Parsed[] = [];
    const seen = new Set<string>();
    const collect = (session: Parsed) => {
      const key = `${session.provider}:${session.id}`;
      if (seen.has(key)) throw Error("child-cycle");
      seen.add(key); family.push(session);
      for (const child of children.get(key) ?? []) collect(child);
    };
    try { collect(root); } catch { exclude(root.provider, "child-cycle", root.id); continue; }
    if (family.some(session => active.has(session.id))) { exclude(root.provider, "active-session", root.id); continue; }
    if (!root.request) { exclude(root.provider, "missing-initial-user-request", root.id); continue; }
    if (family.some(session => !session.startedAt || !session.completedAt)) { exclude(root.provider, "missing-session-timestamps", root.id); continue; }
    if (family.some(session => session.missingUsage)) { exclude(root.provider, "missing-usage-telemetry", root.id); continue; }
    const usages = new Map<string, Usage>();
    const calls = new Set<string>();
    for (const session of family) {
      for (const [id, usage] of session.usages) usages.set(id, mergeHighwater(usages.get(id), usage));
      for (const id of session.calls) calls.add(id);
    }
    const measurements = [...usages.values()];
    audit.rolledUpDuplicateUsageRecords += family.reduce((sum, session) => sum + session.usages.size, 0) - usages.size;
    audit.rolledUpDuplicateToolCalls += family.reduce((sum, session) => sum + session.calls.size, 0) - calls.size;
    const total = (key: "input" | "output") => measurements.reduce((sum, usage) => sum + usage[key], 0);
    const usageOptional = (key: "cache" | "fresh") => measurements.some(usage => usage[key] === null) ? null : measurements.reduce((sum, usage) => sum + usage[key]!, 0);
    const optional = (key: "cache" | "fresh" | "rounds") => family.some(session => session[key] === null) ? null : family.reduce((sum, session) => sum + session[key]!, 0);
    let lineage = root.id;
    let ancestor: Parsed | undefined = root;
    const ancestors = new Set<string>();
    while (ancestor?.fork && !ancestors.has(ancestor.fork)) {
      ancestors.add(ancestor.fork); lineage = ancestor.fork;
      ancestor = sessions.get(`${root.provider}:${ancestor.fork}`);
    }
    const task: NativeSessionTask = {
      id: `native:${root.provider}:${root.id}`, group: `native:${root.provider}:${lineage}`,
      startedAt: family.map(session => session.startedAt).sort()[0], completedAt: family.map(session => session.completedAt).sort().at(-1)!,
      request: root.request.slice(0, 12_000), preworkContext: [], provider: root.provider,
      inputTokens: total("input"), outputTokens: total("output"), cacheReadTokens: usageOptional("cache"), nonCachedInputTokens: usageOptional("fresh"),
      toolCalls: calls.size, toolRounds: optional("rounds"),
      provenance: { scope: "completed-session", source: "native-session", snapshot: true,
        initialRequestCharacters: root.request.length, initialRequestTruncated: root.request.length > 12_000,
        nativeSessionIds: family.map(session => session.id), rootNativeSessionId: root.id, childCount: family.length - 1,
        terminalStatus: root.terminalStatus, usageRecords: usages.size, childUsageIncluded: true },
    };
    if (![task.inputTokens, task.outputTokens, task.toolCalls].every(finite)) { exclude(root.provider, "invalid-session-totals", root.id); continue; }
    tasks.push(task); audit.included++; audit.includedChildren += family.length - 1;
  }
  return { tasks: tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)), audit };
}
