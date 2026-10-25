#!/usr/bin/env node
/** Whole Console sessions. Predictors contain only initiating user messages. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexAccounting, piAccounting, SessionAccounting } from "../server/accounting.ts";
import { normalizeAccountingRows } from "../server/accounting-repair.ts";
import { observedActivity } from "./triage-history-build.ts";

type Json = Record<string, any>;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_REQUEST = 12_000;
const CONTROL_INPUT =
  /^\s*\/(?:\s*$|(?:compact|help|clear|reset|model|effort|status|usage|cost|context|login|logout|exit|quit|resume|new|permissions|settings|theme|rename|thinking)(?:\s|$))/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown): number | undefined =>
  finite(value)
    ? value
    : typeof value === "string" && Number.isFinite(Date.parse(value))
      ? Date.parse(value)
      : undefined;
const validUsage = (row: Json) =>
  finite(row.in) &&
  finite(row.out) &&
  (row.cache == null || (finite(row.cache) && row.cache <= row.in)) &&
  !row.unresolved;
function jsonLines(file: string) {
  if (fs.statSync(file).size > MAX_BYTES) throw Error("Session input exceeds safety limit");
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Json);
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function usageEqual(a: Json, b: Json) {
  return (
    a.in === b.in &&
    a.out === b.out &&
    (!finite(a.cache) || !finite(b.cache) || a.cache === b.cache)
  );
}

/** A one-word genuine request is valid. Later answers and plans never enter features. */
export function initialSessionRequest(events: Json[], createdAt = 0) {
  const genuine = (event: Json) =>
    event.type === "user_input" &&
    !event.auto &&
    !event.automation &&
    !event.system &&
    !event.questionAnswer &&
    typeof event.text === "string" &&
    !!event.text.trim() &&
    !CONTROL_INPUT.test(event.text) &&
    finite(event.ts) &&
    event.ts >= createdAt;
  const first = events.findIndex(genuine);
  if (first < 0) return;
  const selected: { text: string; line: number }[] = [];
  for (let index = first; index < events.length; index++) {
    const event = events[index];
    if (
      event.type === "assistant" ||
      event.type === "tool_use" ||
      event.type === "tool_result" ||
      event.type === "result" ||
      (event.type === "user" &&
        event.message?.content?.some((block: Json) => block.type === "tool_result"))
    )
      break;
    if (genuine(event)) selected.push({ text: event.text.trim(), line: index + 1 });
  }
  const original = selected.map((row) => row.text).join("\n\n");
  return {
    request: original.slice(0, MAX_REQUEST),
    startedAt: events[first].ts as number,
    index: first,
    messageCount: selected.length,
    sourceLines: selected.map((row) => row.line),
    originalCharacters: original.length,
    truncated: original.length > MAX_REQUEST,
  };
}

/** Distinct durable ledger identities are projected once, before cumulative normalization. */
export function deduplicateSessionLedger(raw: Json[]) {
  const records: Json[] = [],
    seen = new Map<string, Json>(),
    conflictThreads = new Set<string>();
  let duplicates = 0,
    explicitDuplicates = 0,
    invalidThreadRows = 0;
  for (const row of raw) {
    if (typeof row.thread !== "string") {
      invalidThreadRows++;
      continue;
    }
    if (row.duplicate === true) {
      explicitDuplicates++;
      continue;
    }
    const eventKey =
      typeof row.eventId === "string" && row.eventId
        ? `${row.thread}:event:${row.session || ""}:${row.eventId}`
        : `${row.thread}:exact:${stable(row)}`;
    const old = seen.get(eventKey);
    if (old) {
      duplicates++;
      if (!usageEqual(old, row) || old.unresolved !== row.unresolved)
        conflictThreads.add(row.thread);
      continue;
    }
    seen.set(eventKey, row);
    records.push(row);
  }
  return { records, conflictThreads, duplicates, explicitDuplicates, invalidThreadRows };
}

function nativeIds(thread: Json | undefined, events: Json[], rows: Json[]) {
  const initial = initialSessionRequest(events, finite(thread?.createdAt) ? thread.createdAt : 0);
  const createdAt = finite(thread?.createdAt) ? thread.createdAt : 0;
  const ownEvents = initial ? events.slice(initial.index) : [];
  const idsFrom = (source: Json[]) =>
    source
      .filter(
        (event) => event.type === "result" || (event.type === "system" && event.subtype === "init"),
      )
      .map((event) => event.session_id);
  const values = [
    thread?.sessionId,
    ...rows.filter((row) => finite(row.ts) && row.ts >= createdAt).map((row) => row.session),
    ...idsFrom(ownEvents),
  ];
  const own = [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && UUID.test(value) && value !== thread?.forkFrom,
      ),
    ),
  ].sort();
  const inherited = initial ? idsFrom(events.slice(0, initial.index)) : [];
  const lineage = [
    ...new Set(
      [thread?.forkFrom, ...inherited].filter(
        (value): value is string =>
          typeof value === "string" && UUID.test(value) && !own.includes(value),
      ),
    ),
  ].sort();
  return { own, lineage };
}

type MeasureState = {
  accounting: SessionAccounting;
  seen: Set<string>;
  session: string;
  inputAt: number | undefined;
  pendingUsage: Json | undefined;
};

function trackEvent(state: MeasureState, event: Json) {
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    if (state.session !== event.session_id)
      state.accounting.seedFork(event.session_id, state.session);
    state.session = event.session_id;
  }
  if (event.type === "user_input" && finite(event.ts) && state.inputAt === undefined)
    state.inputAt = event.ts;
  if (event.type === "token_usage") state.pendingUsage = event;
}

function measureResult(state: MeasureState, event: Json, thread: Json) {
  if (event.modelUsage) return state.accounting.consume(event.session_id || state.session, event);
  if (event.usageModels) return piAccounting(event.usageModels);
  if (state.pendingUsage) return codexAccounting(state.pendingUsage, thread.model || "unknown");
  return { accounting: 2 };
}

function resultProvider(state: MeasureState, event: Json, thread: Json) {
  if (event.modelUsage) return "claude";
  if (event.usageModels) return "pi";
  return state.pendingUsage ? "codex" : thread.provider;
}

/** Root-result deltas also cover billable auto-wakes lacking a new user_input. */
function resultMeasurements(events: Json[], thread: Json, firstIndex: number) {
  const state: MeasureState = {
    accounting: new SessionAccounting(),
    seen: new Set<string>(),
    session: thread.id,
    inputAt: undefined,
    pendingUsage: undefined,
  };
  const results: Json[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    trackEvent(state, event);
    if (event.type !== "result") continue;
    const measured = measureResult(state, event, thread);
    const key = typeof event.uuid === "string" ? event.uuid : undefined;
    if (!measured.duplicate && (!key || !state.seen.has(key)) && index >= firstIndex) {
      results.push({
        ...measured,
        provider: resultProvider(state, event, thread),
        eventId: key,
        inputAt: state.inputAt,
        index,
        resultAt: timestamp(event.ts) ?? timestamp(event.timestamp),
        ms: event.duration_ms,
        err: !!event.is_error,
        zeroTurn: event.num_turns === 0,
      });
    }
    if (key) state.seen.add(key);
    state.inputAt = undefined;
    state.pendingUsage = undefined;
  }
  return results;
}

type Dedup = ReturnType<typeof deduplicateSessionLedger>;
type ConsoleContext = {
  byId: Map<string, Json>;
  normalized: Json[];
  dedup: Dedup;
  logDir: string;
  ledgerFile: string;
};
type ThreadOutcome = {
  provider: string;
  link?: Json;
  reason?: string;
  logRead?: boolean;
  rootResults?: number;
  task?: Json;
  matched?: number;
  reconstructed?: number;
  selectedRows?: number;
  failures?: number;
};
type MeasureAccumulator = {
  used: Set<Json>;
  measurements: Json[];
  incomplete: boolean;
  conflicts: boolean;
  reconstructed: number;
  matched: number;
};

function loadThreadMetadata(dataDir: string) {
  const metadataFile = path.join(dataDir, "threads.json");
  const metadata = fs.existsSync(metadataFile)
    ? JSON.parse(fs.readFileSync(metadataFile, "utf8"))
    : [];
  if (!Array.isArray(metadata)) throw Error("Expected Console thread metadata array");
  return metadata;
}

function restoreLegacyCodexRow(row: Json, source: Json) {
  // Legacy Codex input/output are per-turn totals even if cache telemetry was absent.
  if (
    (row.unresolved || !finite(row.in) || !finite(row.out)) &&
    source.provider === "codex" &&
    finite(source.in) &&
    finite(source.out) &&
    source.cache == null
  ) {
    const { unresolved, ...rest } = row;
    return {
      ...rest,
      in: source.in,
      out: source.out,
      cache: undefined,
      accounting: 2,
      cacheUnreported: true,
    };
  }
  return row;
}

function readSessionLog(logFile: string) {
  let events: Json[] = [],
    logError = false,
    logRead = false;
  try {
    if (fs.existsSync(logFile)) {
      events = jsonLines(logFile);
      logRead = true;
    }
  } catch {
    logError = true;
  }
  return { events, logError, logRead };
}

function sessionLink(threadId: string, thread: Json | undefined, identities: Json): Json {
  return {
    threadId,
    nativeSessionIds: identities.own,
    lineageNativeSessionIds: identities.lineage,
    status: thread?.status ?? "unknown",
    active: !!thread && (thread.status !== "idle" || !!thread.operation || thread.background > 0),
    selected: false,
  };
}

function preflightReason(
  thread: Json | undefined,
  threadId: string,
  provider: string,
  logError: boolean,
  logFile: string,
) {
  if (!thread) return "missingThreadMetadata";
  if (
    thread.mock ||
    thread.synthetic ||
    thread.testFixture ||
    provider === "mock" ||
    /^(?:mock|test-fixture|fixture)[-_]/i.test(threadId)
  )
    return "explicitSyntheticSession";
  // Quota window openers (server/index.ts) send a one-word probe; they are not user work.
  if (typeof thread.title === "string" && thread.title.startsWith("Window opener"))
    return "quotaWindowOpener";
  if (thread.status !== "idle" || thread.operation || thread.background > 0)
    return "activeOrUnconfirmedIdle";
  if (logError) return "invalidOrOversizedLog";
  if (!fs.existsSync(logFile)) return "missingSessionLog";
  return undefined;
}

function findCandidates(selected: Json[], used: Set<Json>, result: Json) {
  let candidates = selected.filter(
    (row) => !used.has(row) && result.eventId && row.eventId === result.eventId,
  );
  if (!candidates.length && finite(result.inputAt))
    candidates = selected.filter((row) => !used.has(row) && row.ts === result.inputAt);
  if (!candidates.length && finite(result.ms))
    candidates = selected.filter(
      (row) =>
        !used.has(row) &&
        row.ms === result.ms &&
        (!finite(result.inputAt) || Math.abs(row.ts - result.inputAt) <= 1000),
    );
  return candidates;
}

function reconcileUnmatched(acc: MeasureAccumulator, result: Json) {
  if (!validUsage(result)) {
    acc.incomplete = true;
    return;
  }
  acc.measurements.push(result);
  acc.reconstructed++;
}

function reconcileMatched(acc: MeasureAccumulator, row: Json, result: Json, provider: string) {
  if (validUsage(row)) {
    if (validUsage(result) && !usageEqual(row, result)) acc.conflicts = true;
    acc.measurements.push(row);
  } else if (validUsage(result)) {
    acc.measurements.push({ ...result, provider: result.provider || row.provider || provider });
    acc.reconstructed++;
  } else acc.incomplete = true;
}

function consumeResult(acc: MeasureAccumulator, selected: Json[], result: Json, provider: string) {
  const candidates = findCandidates(selected, acc.used, result);
  if (candidates.length > 1) {
    acc.incomplete = true;
    return;
  }
  const row = candidates[0];
  if (!row) {
    reconcileUnmatched(acc, result);
    return;
  }
  acc.used.add(row);
  acc.matched++;
  reconcileMatched(acc, row, result, provider);
}

/** Join log results against ledger rows; leftovers must carry valid usage. */
function matchMeasurements(selected: Json[], results: Json[], provider: string) {
  const acc: MeasureAccumulator = {
    used: new Set<Json>(),
    measurements: [],
    incomplete: false,
    conflicts: false,
    reconstructed: 0,
    matched: 0,
  };
  for (const result of results) consumeResult(acc, selected, result, provider);
  for (const row of selected) {
    if (acc.used.has(row)) continue;
    if (validUsage(row)) acc.measurements.push(row);
    else acc.incomplete = true;
  }
  return acc;
}

function completionBounds(thread: Json, initial: Json, selected: Json[], results: Json[]) {
  const latestLedgerStart = Math.max(
    initial.startedAt,
    ...selected.map((row) => (finite(row.ts) ? row.ts : 0)),
  );
  const metadataBound = timestamp(thread.updatedAt);
  const lastResultAt = results.at(-1)?.resultAt;
  let safeBound: number | undefined;
  if (metadataBound !== undefined && metadataBound >= latestLedgerStart) safeBound = metadataBound;
  else if (finite(lastResultAt) && lastResultAt >= latestLedgerStart) safeBound = lastResultAt;
  return { metadataBound, safeBound };
}

function latestCompletion(events: Json[], safeBound: number) {
  return Math.max(
    safeBound,
    ...events.flatMap((event) => {
      const value = timestamp(event.ts) ?? timestamp(event.timestamp);
      return value === undefined ? [] : [value];
    }),
  );
}

function tokenTotals(measurements: Json[]) {
  const total = (field: "in" | "out" | "cache") =>
    measurements.reduce((sum, row) => sum + row[field], 0);
  const inputTokens = total("in"),
    outputTokens = total("out");
  const cacheReadTokens = measurements.every((row) => finite(row.cache)) ? total("cache") : null;
  const safe = [inputTokens, outputTokens, ...(cacheReadTokens === null ? [] : [cacheReadTokens])];
  return { inputTokens, outputTokens, cacheReadTokens, safe: safe.every(Number.isSafeInteger) };
}

function providerMixOf(measurements: Json[], provider: string) {
  return Object.fromEntries(
    [...new Set(measurements.map((row) => row.provider || provider))]
      .sort()
      .map((name) => [
        name,
        measurements.filter((row) => (row.provider || provider) === name).length,
      ]),
  );
}

type SessionFacts = {
  threadId: string;
  initial: Json;
  events: Json[];
  identities: Json;
  logFile: string;
  ledgerFile: string;
  selectedRows: number;
  acc: MeasureAccumulator;
  failures: number;
  metadataBound: number | undefined;
  safeBound: number;
};

function consoleProvenance(facts: SessionFacts) {
  const { initial, identities, acc } = facts;
  return {
    scope: "completed-session",
    source: "agent-console",
    threadId: facts.threadId,
    nativeSessionIds: identities.own,
    lineageNativeSessionIds: identities.lineage,
    predictor:
      "Only first genuine user_input and contiguous user inputs before first assistant/tool/result. No subsequent conversation, plans, outcomes, or commit proof.",
    initialMessageCount: initial.messageCount,
    initialSourceLines: initial.sourceLines,
    requestOriginalCharacters: initial.originalCharacters,
    requestTruncated: initial.truncated,
    requestLimit: MAX_REQUEST,
    log: facts.logFile,
    ledger: facts.ledgerFile,
    ledgerRows: facts.selectedRows,
    matchedLogResults: acc.matched,
    reconstructedLogResults: acc.reconstructed,
    accountingRecords: acc.measurements.length,
    historicalFailureRecords: facts.failures,
    completionBound:
      facts.metadataBound === facts.safeBound
        ? "idle-thread-updatedAt/log-timestamp-upper-bound"
        : "last-result/log-timestamp-upper-bound",
    completionTimeExact: false,
    completionNote:
      "Conservative observed availability bound for whole idle session; no duration or active-time inference.",
    inputIncludesCache: true,
    usageScope:
      "Entire retained Console session, including measured failures and retries; child usage depends on provider accounting and is not imputed.",
    outcomeNote:
      "Actual session usage, not successful-task effort. Session may contain multiple later requests, scope changes, failures, and troubleshooting.",
    activityNote:
      "Distinct root-log tool_use IDs; rounds are distinct assistant message IDs or deduplicated call batches. Zero observed calls is valid.",
  };
}

function consoleTask(
  facts: SessionFacts,
  totals: ReturnType<typeof tokenTotals>,
  provider: string,
) {
  const { initial, acc } = facts;
  const { inputTokens, outputTokens, cacheReadTokens } = totals;
  const providerMix = providerMixOf(acc.measurements, provider);
  return {
    id: `console:${facts.threadId}`,
    group: `console:${facts.threadId}`,
    startedAt: new Date(initial.startedAt).toISOString(),
    completedAt: new Date(latestCompletion(facts.events, facts.safeBound)).toISOString(),
    request: initial.request,
    preworkContext: [],
    inputTokens,
    outputTokens,
    cacheReadTokens,
    nonCachedInputTokens: cacheReadTokens === null ? null : inputTokens - cacheReadTokens,
    ...observedActivity(facts.events.slice(initial.index)),
    provider: Object.keys(providerMix).length === 1 ? Object.keys(providerMix)[0] : "mixed",
    providerMix,
    provenance: consoleProvenance(facts),
  };
}

type SessionInput = {
  context: ConsoleContext;
  thread: Json;
  threadId: string;
  provider: string;
  ledger: Json[];
  logFile: string;
  events: Json[];
  identities: Json;
};

/** Evaluate one idle, readable session; returns an exclusion reason or the finished task. */
function evaluateSession(input: SessionInput): Partial<ThreadOutcome> {
  const { context, thread, threadId, provider, ledger, logFile, events, identities } = input;
  const initial = initialSessionRequest(events, finite(thread.createdAt) ? thread.createdAt : 0);
  if (!initial) return { reason: "missingInitiatingUserInput" };
  if (context.dedup.conflictThreads.has(threadId))
    return { reason: "conflictingDuplicateAccounting" };
  const results = resultMeasurements(events, thread, initial.index);
  const rootResults = results.length;
  const selected = ledger.filter(
    (row) => !finite(thread.createdAt) || !finite(row.ts) || row.ts >= thread.createdAt,
  );
  const acc = matchMeasurements(selected, results, provider);
  if (acc.conflicts) return { rootResults, reason: "conflictingLogAndLedgerUsage" };
  if (acc.incomplete) return { rootResults, reason: "incompleteSessionAccounting" };
  if (!acc.measurements.length) return { rootResults, reason: "missingSessionAccounting" };
  const { metadataBound, safeBound } = completionBounds(thread, initial, selected, results);
  if (safeBound === undefined) return { rootResults, reason: "missingSafeSessionCompletionBound" };
  const totals = tokenTotals(acc.measurements);
  if (!totals.safe) return { rootResults, reason: "unsafeSessionTokenTotal" };
  const failures = acc.measurements.filter((row) => row.err).length;
  const facts: SessionFacts = {
    threadId,
    initial,
    events,
    identities,
    logFile,
    ledgerFile: context.ledgerFile,
    selectedRows: selected.length,
    acc,
    failures,
    metadataBound,
    safeBound,
  };
  return {
    rootResults,
    task: consoleTask(facts, totals, provider),
    matched: acc.matched,
    reconstructed: acc.reconstructed,
    selectedRows: selected.length,
    failures,
  };
}

function threadProvider(thread: Json | undefined, ledger: Json[]) {
  return (
    thread?.provider ||
    [...new Set(ledger.map((row) => row.provider).filter(Boolean))].join("+") ||
    "unknown"
  );
}

function evaluateThread(context: ConsoleContext, threadId: string): ThreadOutcome {
  const thread = context.byId.get(threadId);
  const ledger = context.normalized.filter((row) => row.thread === threadId);
  const provider = threadProvider(thread, ledger);
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) return { provider, reason: "invalidThreadId" };
  const logFile = path.join(context.logDir, `${threadId}.jsonl`);
  const { events, logError, logRead } = readSessionLog(logFile);
  const identities = nativeIds(thread, events, ledger);
  const link = sessionLink(threadId, thread, identities);
  const base = { provider, link, logRead };
  const preflight = preflightReason(thread, threadId, provider, logError, logFile);
  // Unlinked, so its native transcript is judged by origin alone and dropped as a probe.
  if (preflight === "quotaWindowOpener") return { provider, logRead, reason: preflight };
  if (preflight || !thread) return { ...base, reason: preflight };
  const input = { context, thread, threadId, provider, ledger, logFile, events, identities };
  return { ...base, ...evaluateSession(input) };
}

function listLogIds(logDir: string) {
  return fs.existsSync(logDir)
    ? fs
        .readdirSync(logDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -6))
    : [];
}

function newTally() {
  return {
    exclusions: {} as Record<string, number>,
    providers: {} as Record<string, Json>,
    tasks: [] as Json[],
    linkage: [] as Json[],
    linked: new Set<string>(),
    reconstructedResults: 0,
    matchedResults: 0,
    selectedLedgerRows: 0,
    selectedFailureRows: 0,
    logsRead: 0,
    rootResults: 0,
  };
}

function recordOutcome(tally: ReturnType<typeof newTally>, outcome: ThreadOutcome) {
  const coverage = (tally.providers[outcome.provider] ??= { total: 0, selected: 0, excluded: {} });
  coverage.total++;
  if (outcome.logRead) tally.logsRead++;
  if (outcome.link) {
    for (const value of outcome.link.nativeSessionIds) tally.linked.add(value);
    tally.linkage.push(outcome.link);
  }
  tally.rootResults += outcome.rootResults ?? 0;
  if (outcome.reason || !outcome.task) {
    const reason = outcome.reason as string;
    tally.exclusions[reason] = (tally.exclusions[reason] || 0) + 1;
    coverage.excluded[reason] = (coverage.excluded[reason] || 0) + 1;
    if (outcome.link) outcome.link.exclusion = reason;
    return;
  }
  tally.tasks.push(outcome.task);
  outcome.link!.selected = true;
  coverage.selected++;
  tally.reconstructedResults += outcome.reconstructed!;
  tally.matchedResults += outcome.matched!;
  tally.selectedLedgerRows += outcome.selectedRows!;
  tally.selectedFailureRows += outcome.failures!;
}

export function buildConsoleSessions(opts: { dataDir: string }) {
  const ledgerFile = path.join(opts.dataDir, "turns.jsonl");
  const metadata = loadThreadMetadata(opts.dataDir);
  const raw = fs.existsSync(ledgerFile) ? jsonLines(ledgerFile) : [];
  const dedup = deduplicateSessionLedger(raw);
  const normalized = normalizeAccountingRows(opts.dataDir, dedup.records).map((row, index) =>
    restoreLegacyCodexRow(row, dedup.records[index]),
  );
  const byId = new Map<string, Json>();
  for (const thread of metadata) if (typeof thread.id === "string") byId.set(thread.id, thread);
  const logDir = path.join(opts.dataDir, "logs");
  const logIds = listLogIds(logDir);
  const ids = [
    ...new Set([...byId.keys(), ...logIds, ...normalized.map((row) => row.thread)]),
  ].sort();
  const context: ConsoleContext = { byId, normalized, dedup, logDir, ledgerFile };
  const tally = newTally();
  for (const threadId of ids) recordOutcome(tally, evaluateThread(context, threadId));
  const {
    exclusions,
    providers,
    tasks,
    linkage,
    linked,
    reconstructedResults,
    matchedResults,
    selectedLedgerRows,
    selectedFailureRows,
    logsRead,
    rootResults,
  } = tally;
  tasks.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
  );
  const excludedSessions = Object.values(exclusions).reduce((sum, value) => sum + value, 0);
  return {
    version: 1,
    scope: "completed-session",
    tasks,
    linkedNativeSessionIds: [...linked].sort(),
    lineageNativeSessionIds: [
      ...new Set(linkage.flatMap((row) => row.lineageNativeSessionIds)),
    ].sort(),
    activeNativeSessionIds: [
      ...new Set(linkage.filter((row) => row.active).flatMap((row) => row.nativeSessionIds)),
    ].sort(),
    sessionLinks: linkage,
    audit: {
      totalSessions: ids.length,
      metadataSessions: metadata.length,
      logFiles: logIds.length,
      logsRead,
      ledgerRows: raw.length,
      normalizedLedgerRows: normalized.length,
      ledgerDuplicateRows: dedup.duplicates,
      ledgerExplicitDuplicateRows: dedup.explicitDuplicates,
      ledgerInvalidThreadRows: dedup.invalidThreadRows,
      orphanLedgerSessions: new Set(
        normalized.filter((row) => !byId.has(row.thread)).map((row) => row.thread),
      ).size,
      orphanLogSessions: logIds.filter((logId) => !byId.has(logId)).length,
      selectedSessions: tasks.length,
      excludedSessions,
      exclusions,
      accountingExhaustive: tasks.length + excludedSessions === ids.length,
      providers,
      linkedNativeSessions: linked.size,
      selectedLedgerRows,
      matchedResults,
      reconstructedResults,
      selectedFailureRows,
      observedRootResults: rootResults,
      limitation:
        "One sample per whole Console thread, not one turn or successful commit. Predictors use only initiating user messages. Later scope changes remain part of actual outcome. Missing accounting is never zero-imputed; native session coverage is audited separately.",
    },
  };
}

export function writePrivateSessionJson(output: string, result: unknown) {
  if (!path.isAbsolute(output)) throw Error("Use an absolute private output path");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  if ((fs.statSync(path.dirname(output)).mode & 0o077) !== 0)
    throw Error("Output parent directory must be private (0700)");
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    flag = (name: string, fallback?: string) => {
      const at = args.indexOf(name);
      return at < 0 ? fallback : args[at + 1];
    };
  const output = flag("--output");
  if (!output) throw Error("Use --output with an absolute private JSON path");
  const result = buildConsoleSessions({
    dataDir: flag("--data", path.join(os.homedir(), ".config", "agent-console"))!,
  });
  writePrivateSessionJson(output, result);
  console.log(JSON.stringify(result.audit));
}
