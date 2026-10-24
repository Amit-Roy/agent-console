import { createHash } from "node:crypto";

export type UsageRepairRow = {
  ts: number;
  provider: string;
  label: string;
  used: number;
  limit: number;
  unit?: string;
  resetsAt?: number;
  schemaVersion?: number;
  provenance?: string;
  timestampSource?: string;
  accountUnresolved?: boolean;
  sourceSessionId?: string;
  sourceEventUuid?: string;
  sourcePrefixHash?: string;
  accountSource?: string;
};
type Event = Record<string, any>;
const accountKey = (v: unknown) =>
  v === "nefro" ? "claude:nefro" : v === "sunny" ? "claude" : undefined;
const winList = (ev: Event) => {
  const w = ev.rate_limit_info?.unifiedWindows;
  return [
    ["5-hour", w?.five_hour],
    ["7-day", w?.seven_day],
  ].flatMap(([label, x]: any[]) =>
    x && Number.isFinite(x.utilization)
      ? [
          {
            label,
            used: x.utilization * 100,
            limit: 100,
            unit: "%",
            ...(x.resetsAt || x.resets_at ? { resetsAt: (x.resetsAt || x.resets_at) * 1000 } : {}),
          },
        ]
      : [],
  );
};
const stable = (v: any): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
type LogThread = { id: string; claudeAccount?: string; createdAt?: number };
type LoggedEvent = {
  event: Event;
  turnTs?: number;
  id: string;
  account?: string;
  eligible: boolean;
  createdAt?: number;
  prefix: string;
};
const isClaudeProvider = (provider: unknown) =>
  provider === "claude" || provider === "claude:nefro";
const hasNativeIds = (event: Event) =>
  typeof event.session_id === "string" &&
  event.session_id &&
  typeof event.uuid === "string" &&
  event.uuid;
const nativeKey = (event: Event) =>
  hasNativeIds(event) ? `native:${event.session_id}:${event.uuid}` : undefined;

function eventTimestamp(event: Event, turnTs: number | undefined) {
  if (Number.isFinite(event.observedAt)) return event.observedAt;
  return Number.isFinite(event.ts) ? event.ts : turnTs;
}

function threadAccount(thread: LogThread | undefined) {
  if (!thread) return undefined;
  return thread.claudeAccount === undefined ? "claude" : accountKey(thread.claudeAccount);
}

function collectLoggedEvents(logs: Record<string, Event[]>, threads: Map<string, LogThread>) {
  const events: LoggedEvent[] = [];
  for (const [id, list] of Object.entries(logs)) {
    let turnTs: number | undefined;
    const thread = threads.get(id);
    const prefixHash = createHash("sha256");
    for (const event of list) {
      prefixHash.update(`${stable(event)}\n`);
      if (event.type === "user_input" && Number.isFinite(event.ts)) turnTs = event.ts;
      if (event.type !== "rate_limit_event") continue;
      const ts = eventTimestamp(event, turnTs);
      events.push({
        event,
        turnTs,
        id,
        account: threadAccount(thread),
        eligible:
          !!thread &&
          Number.isFinite(ts) &&
          Number.isFinite(thread.createdAt) &&
          thread.createdAt! <= ts!,
        createdAt: thread?.createdAt,
        prefix: hasNativeIds(event) ? "" : prefixHash.copy().digest("hex"),
      });
    }
  }
  return events;
}

function collectSessionOwners(events: LoggedEvent[]) {
  const sessionOwners = new Map<string, Set<string>>();
  for (const entry of events) {
    const sessionId = entry.event.session_id;
    if (!entry.eligible || !entry.account || typeof sessionId !== "string" || !sessionId) continue;
    const owners = sessionOwners.get(sessionId) ?? new Set<string>();
    owners.add(entry.account);
    sessionOwners.set(sessionId, owners);
  }
  return sessionOwners;
}

const receivedProvider = (entry: LoggedEvent) =>
  Number.isFinite(entry.event.observedAt) && isClaudeProvider(entry.event.usageProvider)
    ? entry.event.usageProvider
    : undefined;

function eventIdentity(entry: LoggedEvent) {
  const key = nativeKey(entry.event);
  if (key) return key;
  const explicitProvider = !!receivedProvider(entry);
  const stamp = entry.event.observedAt ?? entry.event.ts ?? entry.turnTs ?? "unknown";
  return `${explicitProvider ? "explicit" : "legacy"}:${stamp}:${explicitProvider ? entry.event.usageProvider : ""}:${entry.prefix}`;
}

function groupEvents(events: LoggedEvent[]) {
  const groups = new Map<string, LoggedEvent[]>();
  for (const entry of events) {
    const key = eventIdentity(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function groupOwners(
  group: LoggedEvent[],
  native: boolean,
  sessionOwners: Map<string, Set<string>>,
) {
  if (native) return sessionOwners.get(group[0].event.session_id) ?? new Set<string>();
  return new Set(
    group
      .filter((entry) => entry.account && (entry.eligible || !Number.isFinite(entry.createdAt)))
      .map((entry) => entry.account),
  );
}

function groupRows(group: LoggedEvent[], sessionOwners: Map<string, Set<string>>) {
  const sample = group[0];
  const explicitProvider = group.map(receivedProvider).find(Boolean);
  const received = !!explicitProvider && Number.isFinite(sample.event.observedAt);
  const native = !!nativeKey(sample.event);
  const owners = groupOwners(group, native, sessionOwners);
  const unresolved = !explicitProvider && owners.size !== 1;
  const provider = explicitProvider || (unresolved ? "claude:unknown" : [...owners][0]);
  const loggedTs = Number.isFinite(sample.event.ts);
  const ts = received ? sample.event.observedAt : loggedTs ? sample.event.ts : sample.turnTs;
  if (!Number.isFinite(ts)) return [];
  const timestampSource = received ? "received" : loggedTs ? "logged" : "turn-start";
  return winList(sample.event).map(
    (window): UsageRepairRow => ({
      ts: ts!,
      provider: provider!,
      ...window,
      schemaVersion: 2,
      provenance: "claude-log",
      timestampSource,
      ...(unresolved ? { accountUnresolved: true } : {}),
      ...(native
        ? {
            sourceSessionId: sample.event.session_id,
            sourceEventUuid: sample.event.uuid,
            accountSource: explicitProvider ? "receipt" : "native-session",
          }
        : { sourcePrefixHash: sample.prefix }),
    }),
  );
}

function orphanedLegacyRows(inputRows: UsageRepairRow[], rows: UsageRepairRow[]) {
  const represented = (row: UsageRepairRow) =>
    rows.some(
      (candidate) =>
        candidate.ts === row.ts &&
        candidate.label === row.label &&
        candidate.used === row.used &&
        candidate.resetsAt === row.resetsAt,
    );
  return inputRows
    .filter(
      (row) => isClaudeProvider(row.provider) && row.schemaVersion == null && !represented(row),
    )
    .map((row) => ({
      ...row,
      provider: "claude:unknown",
      schemaVersion: 2,
      provenance: "legacy-history",
      timestampSource: "unknown",
      accountUnresolved: true,
    }));
}

function reconcileExplicitRows(explicit: UsageRepairRow[], rows: UsageRepairRow[]) {
  const canonicalRows = rows.filter(
    (row) => (row.sourceSessionId && row.sourceEventUuid) || row.sourcePrefixHash,
  );
  return explicit.filter((row) => {
    if (
      !isClaudeProvider(row.provider) ||
      row.schemaVersion == null ||
      row.sourceSessionId ||
      row.sourceEventUuid
    )
      return true;
    return !canonicalRows.some(
      (canonical) =>
        canonical.provider === row.provider &&
        canonical.ts === row.ts &&
        canonical.label === row.label &&
        canonical.resetsAt === row.resetsAt &&
        canonical.used === row.used &&
        canonical.limit === row.limit &&
        canonical.unit === row.unit,
    );
  });
}

const rowRank = (row: UsageRepairRow) => {
  if (row.timestampSource === "received" || row.provenance === "received") return 3;
  return row.schemaVersion != null ? 2 : 1;
};

function uniqueRows(candidates: UsageRepairRow[]) {
  const unique = new Map<string, UsageRepairRow>();
  for (const row of candidates) {
    const key = [
      row.provider,
      row.ts,
      row.label,
      row.resetsAt ?? "",
      row.used,
      row.limit,
      row.unit ?? "",
      row.sourceSessionId ?? "",
      row.sourceEventUuid ?? "",
      row.sourcePrefixHash ?? "",
    ].join("|");
    if (!unique.has(key) || rowRank(row) > rowRank(unique.get(key)!)) unique.set(key, row);
  }
  return [...unique.values()];
}

export function reconstructClaudeHistory(input: {
  rows: UsageRepairRow[];
  logs: Record<string, Event[]>;
  threads: LogThread[];
}) {
  const explicit = input.rows.filter(
    (row) => !isClaudeProvider(row.provider) || row.schemaVersion != null,
  );
  const threads = new Map(input.threads.map((thread) => [thread.id, thread]));
  const events = collectLoggedEvents(input.logs, threads);
  const sessionOwners = collectSessionOwners(events);
  const rows: UsageRepairRow[] = [];
  for (const group of groupEvents(events).values()) rows.push(...groupRows(group, sessionOwners));
  const orphaned = orphanedLegacyRows(input.rows, rows);
  const reconciledExplicit = reconcileExplicitRows(explicit, rows);
  return {
    rows: uniqueRows([...reconciledExplicit, ...rows, ...orphaned]).sort(
      (left, right) => left.ts - right.ts,
    ),
  };
}
