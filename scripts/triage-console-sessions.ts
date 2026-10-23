#!/usr/bin/env node
/** Whole Console sessions. Predictors contain only initiating user messages. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAccountingRows } from "../server/accounting-repair.ts";
import { SessionAccounting, codexAccounting, piAccounting } from "../server/accounting.ts";
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

/** Root-result deltas also cover billable auto-wakes lacking a new user_input. */
function resultMeasurements(events: Json[], thread: Json, firstIndex: number) {
  const accounting = new SessionAccounting(),
    seen = new Set<string>();
  let session = thread.id,
    inputAt: number | undefined,
    pendingUsage: Json | undefined;
  const results: Json[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (
      event.type === "system" &&
      event.subtype === "init" &&
      typeof event.session_id === "string"
    ) {
      if (session !== event.session_id) accounting.seedFork(event.session_id, session);
      session = event.session_id;
    }
    if (event.type === "user_input" && finite(event.ts) && inputAt === undefined)
      inputAt = event.ts;
    if (event.type === "token_usage") pendingUsage = event;
    if (event.type !== "result") continue;
    const measured = event.modelUsage
      ? accounting.consume(event.session_id || session, event)
      : event.usageModels
        ? piAccounting(event.usageModels)
        : pendingUsage
          ? codexAccounting(pendingUsage, thread.model || "unknown")
          : { accounting: 2 };
    const key = typeof event.uuid === "string" ? event.uuid : undefined;
    if (!measured.duplicate && (!key || !seen.has(key)) && index >= firstIndex) {
      results.push({
        ...measured,
        provider: event.modelUsage
          ? "claude"
          : event.usageModels
            ? "pi"
            : pendingUsage
              ? "codex"
              : thread.provider,
        eventId: key,
        inputAt,
        index,
        resultAt: timestamp(event.ts) ?? timestamp(event.timestamp),
        ms: event.duration_ms,
        err: !!event.is_error,
        zeroTurn: event.num_turns === 0,
      });
    }
    if (key) seen.add(key);
    inputAt = undefined;
    pendingUsage = undefined;
  }
  return results;
}

export function buildConsoleSessions(opts: { dataDir: string }) {
  const metadataFile = path.join(opts.dataDir, "threads.json"),
    ledgerFile = path.join(opts.dataDir, "turns.jsonl");
  const metadata = fs.existsSync(metadataFile)
    ? JSON.parse(fs.readFileSync(metadataFile, "utf8"))
    : [];
  if (!Array.isArray(metadata)) throw Error("Expected Console thread metadata array");
  const raw = fs.existsSync(ledgerFile) ? jsonLines(ledgerFile) : [];
  const dedup = deduplicateSessionLedger(raw);
  const normalized = normalizeAccountingRows(opts.dataDir, dedup.records).map((row, index) => {
    const source = dedup.records[index];
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
  });
  const byId = new Map<string, Json>();
  for (const thread of metadata) if (typeof thread.id === "string") byId.set(thread.id, thread);
  const logDir = path.join(opts.dataDir, "logs");
  const logIds = fs.existsSync(logDir)
    ? fs
        .readdirSync(logDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -6))
    : [];
  const ids = [
    ...new Set([...byId.keys(), ...logIds, ...normalized.map((row) => row.thread)]),
  ].sort();
  const exclusions: Record<string, number> = {},
    providers: Record<string, Json> = {},
    tasks: Json[] = [],
    linkage: Json[] = [];
  const linked = new Set<string>();
  let reconstructedResults = 0,
    matchedResults = 0,
    selectedLedgerRows = 0,
    selectedFailureRows = 0,
    logsRead = 0,
    rootResults = 0;
  for (const id of ids) {
    const thread = byId.get(id),
      ledger = normalized.filter((row) => row.thread === id);
    const provider =
      thread?.provider ||
      [...new Set(ledger.map((row) => row.provider).filter(Boolean))].join("+") ||
      "unknown";
    const coverage = (providers[provider] ??= { total: 0, selected: 0, excluded: {} });
    coverage.total++;
    const exclude = (reason: string) => {
      exclusions[reason] = (exclusions[reason] || 0) + 1;
      coverage.excluded[reason] = (coverage.excluded[reason] || 0) + 1;
    };
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      exclude("invalidThreadId");
      continue;
    }
    const logFile = path.join(logDir, `${id}.jsonl`);
    let events: Json[] = [],
      logError = false;
    try {
      if (fs.existsSync(logFile)) {
        events = jsonLines(logFile);
        logsRead++;
      }
    } catch {
      logError = true;
    }
    const identities = nativeIds(thread, events, ledger),
      sessionIds = identities.own;
    for (const value of sessionIds) linked.add(value);
    const link: Json = {
      threadId: id,
      nativeSessionIds: sessionIds,
      lineageNativeSessionIds: identities.lineage,
      status: thread?.status ?? "unknown",
      active: !!thread && (thread.status !== "idle" || !!thread.operation || thread.background > 0),
      selected: false,
    };
    linkage.push(link);
    if (!thread) {
      exclude("missingThreadMetadata");
      link.exclusion = "missingThreadMetadata";
      continue;
    }
    if (
      thread.mock ||
      thread.synthetic ||
      thread.testFixture ||
      provider === "mock" ||
      /^(?:mock|test-fixture|fixture)[-_]/i.test(id)
    ) {
      exclude("explicitSyntheticSession");
      link.exclusion = "explicitSyntheticSession";
      continue;
    }
    if (thread.status !== "idle" || thread.operation || thread.background > 0) {
      exclude("activeOrUnconfirmedIdle");
      link.exclusion = "activeOrUnconfirmedIdle";
      continue;
    }
    if (logError) {
      exclude("invalidOrOversizedLog");
      link.exclusion = "invalidOrOversizedLog";
      continue;
    }
    if (!fs.existsSync(logFile)) {
      exclude("missingSessionLog");
      link.exclusion = "missingSessionLog";
      continue;
    }
    const initial = initialSessionRequest(events, finite(thread.createdAt) ? thread.createdAt : 0);
    if (!initial) {
      exclude("missingInitiatingUserInput");
      link.exclusion = "missingInitiatingUserInput";
      continue;
    }
    if (dedup.conflictThreads.has(id)) {
      exclude("conflictingDuplicateAccounting");
      link.exclusion = "conflictingDuplicateAccounting";
      continue;
    }
    const results = resultMeasurements(events, thread, initial.index);
    rootResults += results.length;
    const selected = ledger.filter(
      (row) => !finite(thread.createdAt) || !finite(row.ts) || row.ts >= thread.createdAt,
    );
    const used = new Set<Json>(),
      measurements: Json[] = [];
    let incomplete = false,
      conflicts = false,
      localReconstructed = 0,
      localMatched = 0;
    for (const result of results) {
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
      if (candidates.length > 1) {
        incomplete = true;
        continue;
      }
      const row = candidates[0];
      if (row) {
        used.add(row);
        localMatched++;
        if (validUsage(row)) {
          if (validUsage(result) && !usageEqual(row, result)) conflicts = true;
          measurements.push(row);
        } else if (validUsage(result)) {
          measurements.push({ ...result, provider: result.provider || row.provider || provider });
          localReconstructed++;
        } else incomplete = true;
      } else if (validUsage(result)) {
        measurements.push(result);
        localReconstructed++;
      } else incomplete = true;
    }
    for (const row of selected)
      if (!used.has(row)) {
        if (validUsage(row)) measurements.push(row);
        else incomplete = true;
      }
    if (conflicts) {
      exclude("conflictingLogAndLedgerUsage");
      link.exclusion = "conflictingLogAndLedgerUsage";
      continue;
    }
    if (incomplete) {
      exclude("incompleteSessionAccounting");
      link.exclusion = "incompleteSessionAccounting";
      continue;
    }
    if (!measurements.length) {
      exclude("missingSessionAccounting");
      link.exclusion = "missingSessionAccounting";
      continue;
    }
    const latestLedgerStart = Math.max(
      initial.startedAt,
      ...selected.map((row) => (finite(row.ts) ? row.ts : 0)),
    );
    const metadataBound = timestamp(thread.updatedAt);
    const lastResultAt = results.at(-1)?.resultAt;
    const safeBound =
      metadataBound !== undefined && metadataBound >= latestLedgerStart
        ? metadataBound
        : finite(lastResultAt) && lastResultAt >= latestLedgerStart
          ? lastResultAt
          : undefined;
    if (safeBound === undefined) {
      exclude("missingSafeSessionCompletionBound");
      link.exclusion = "missingSafeSessionCompletionBound";
      continue;
    }
    const completedAt = Math.max(
      safeBound,
      ...events.flatMap((event) => {
        const value = timestamp(event.ts) ?? timestamp(event.timestamp);
        return value === undefined ? [] : [value];
      }),
    );
    const total = (field: "in" | "out" | "cache") =>
      measurements.reduce((sum, row) => sum + row[field], 0);
    const inputTokens = total("in"),
      outputTokens = total("out");
    const cacheReadTokens = measurements.every((row) => finite(row.cache)) ? total("cache") : null;
    if (
      ![inputTokens, outputTokens, ...(cacheReadTokens === null ? [] : [cacheReadTokens])].every(
        Number.isSafeInteger,
      )
    ) {
      exclude("unsafeSessionTokenTotal");
      link.exclusion = "unsafeSessionTokenTotal";
      continue;
    }
    const providerMix = Object.fromEntries(
      [...new Set(measurements.map((row) => row.provider || provider))]
        .sort()
        .map((name) => [
          name,
          measurements.filter((row) => (row.provider || provider) === name).length,
        ]),
    );
    const failures = measurements.filter((row) => row.err).length;
    tasks.push({
      id: `console:${id}`,
      group: `console:${id}`,
      startedAt: new Date(initial.startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      request: initial.request,
      preworkContext: [],
      inputTokens,
      outputTokens,
      cacheReadTokens,
      nonCachedInputTokens: cacheReadTokens === null ? null : inputTokens - cacheReadTokens,
      ...observedActivity(events.slice(initial.index)),
      provider: Object.keys(providerMix).length === 1 ? Object.keys(providerMix)[0] : "mixed",
      providerMix,
      provenance: {
        scope: "completed-session",
        source: "agent-console",
        threadId: id,
        nativeSessionIds: sessionIds,
        lineageNativeSessionIds: identities.lineage,
        predictor:
          "Only first genuine user_input and contiguous user inputs before first assistant/tool/result. No subsequent conversation, plans, outcomes, or commit proof.",
        initialMessageCount: initial.messageCount,
        initialSourceLines: initial.sourceLines,
        requestOriginalCharacters: initial.originalCharacters,
        requestTruncated: initial.truncated,
        requestLimit: MAX_REQUEST,
        log: logFile,
        ledger: ledgerFile,
        ledgerRows: selected.length,
        matchedLogResults: localMatched,
        reconstructedLogResults: localReconstructed,
        accountingRecords: measurements.length,
        historicalFailureRecords: failures,
        completionBound:
          metadataBound === safeBound
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
      },
    });
    link.selected = true;
    coverage.selected++;
    reconstructedResults += localReconstructed;
    matchedResults += localMatched;
    selectedLedgerRows += selected.length;
    selectedFailureRows += failures;
  }
  tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
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
      orphanLogSessions: logIds.filter((id) => !byId.has(id)).length,
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
