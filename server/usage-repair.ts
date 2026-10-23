import { createHash } from "node:crypto";

export type UsageRepairRow = { ts: number; provider: string; label: string; used: number; limit: number; unit?: string; resetsAt?: number; schemaVersion?: number; provenance?: string; timestampSource?: string; accountUnresolved?: boolean; sourceSessionId?: string; sourceEventUuid?: string; sourcePrefixHash?: string; accountSource?: string };
type Event = Record<string, any>;
const accountKey = (v: unknown) => v === "nefro" ? "claude:nefro" : v === "sunny" ? "claude" : undefined;
const winList = (ev: Event) => {
  const w = ev.rate_limit_info?.unifiedWindows;
  return [["5-hour", w?.five_hour], ["7-day", w?.seven_day]].flatMap(([label, x]: any[]) => x && Number.isFinite(x.utilization) ? [{ label, used: x.utilization * 100, limit: 100, unit: "%", ...((x.resetsAt || x.resets_at) ? { resetsAt: (x.resetsAt || x.resets_at) * 1000 } : {}) }] : []);
};
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
export function reconstructClaudeHistory(input: { rows: UsageRepairRow[]; logs: Record<string, Event[]>; threads: { id: string; claudeAccount?: string; createdAt?: number }[] }) {
  const explicit = input.rows.filter(r => r.provider !== "claude" && r.provider !== "claude:nefro" || r.schemaVersion != null);
  const threads = new Map(input.threads.map(t => [t.id, t]));
  const events: { ev: Event; turnTs?: number; id: string; account?: string; eligible: boolean; createdAt?: number; prefix: string }[] = [];
  for (const [id, list] of Object.entries(input.logs)) {
    let turnTs: number | undefined;
    const thread = threads.get(id);
    const prefixHash = createHash("sha256");
    for (let index = 0; index < list.length; index++) {
      const ev = list[index];
      const key = typeof ev.session_id === "string" && ev.session_id && typeof ev.uuid === "string" && ev.uuid;
      prefixHash.update(`${stable(ev)}\n`);
      if (ev.type === "user_input" && Number.isFinite(ev.ts)) turnTs = ev.ts;
      if (ev.type !== "rate_limit_event") continue;
      const ts = Number.isFinite(ev.observedAt) ? ev.observedAt : Number.isFinite(ev.ts) ? ev.ts : turnTs;
      const account = thread ? thread.claudeAccount === undefined ? "claude" : accountKey(thread.claudeAccount) : undefined;
      events.push({ ev, turnTs, id, account, eligible: !!thread && Number.isFinite(ts) && Number.isFinite(thread.createdAt) && thread.createdAt! <= ts!, createdAt: thread?.createdAt, prefix: key ? "" : prefixHash.copy().digest("hex") });
    }
  }
  const nativeKey = (ev: Event) => typeof ev.session_id === "string" && ev.session_id && typeof ev.uuid === "string" && ev.uuid ? `native:${ev.session_id}:${ev.uuid}` : undefined;
  const sessionOwners = new Map<string, Set<string>>();
  for (const event of events) {
    const sessionId = event.ev.session_id;
    if (!event.eligible || !event.account || typeof sessionId !== "string" || !sessionId) continue;
    const owners = sessionOwners.get(sessionId) ?? new Set<string>();
    owners.add(event.account); sessionOwners.set(sessionId, owners);
  }
  const identity = (e: typeof events[number]) => {
    const key = nativeKey(e.ev);
    if (key) return key;
    const explicitProvider = Number.isFinite(e.ev.observedAt) && (e.ev.usageProvider === "claude" || e.ev.usageProvider === "claude:nefro");
    return `${explicitProvider ? "explicit" : "legacy"}:${e.ev.observedAt ?? e.ev.ts ?? e.turnTs ?? "unknown"}:${explicitProvider ? e.ev.usageProvider : ""}:${e.prefix}`;
  };
  const groups = new Map<string, typeof events>();
  for (const e of events) {
    const key = identity(e);
    const group = groups.get(key) ?? []; group.push(e); groups.set(key, group);
  }
  const rows: UsageRepairRow[] = [];
  for (const group of groups.values()) {
    const sample = group[0];
    const explicitProvider = group.map(x => Number.isFinite(x.ev.observedAt) && (x.ev.usageProvider === "claude" || x.ev.usageProvider === "claude:nefro") ? x.ev.usageProvider : undefined).find(Boolean);
    const received = !!explicitProvider && Number.isFinite(sample.ev.observedAt);
    const native = !!nativeKey(sample.ev);
    const owners = native ? sessionOwners.get(sample.ev.session_id) ?? new Set<string>() : new Set(group.filter(x => x.account && (x.eligible || !Number.isFinite(x.createdAt))).map(x => x.account));
    const accountConflict = owners.size > 1;
    const unresolved = !explicitProvider && (accountConflict || owners.size !== 1);
    const provider = explicitProvider || (unresolved ? "claude:unknown" : [...owners][0]);
    const ts = received ? sample.ev.observedAt : Number.isFinite(sample.ev.ts) ? sample.ev.ts : sample.turnTs;
    if (!Number.isFinite(ts)) continue;
    const timestampSource = received ? "received" : Number.isFinite(sample.ev.ts) ? "logged" : "turn-start";
    for (const w of winList(sample.ev)) rows.push({ ts: ts!, provider: provider!, ...w, schemaVersion: 2, provenance: "claude-log", timestampSource, ...(unresolved ? { accountUnresolved: true } : {}), ...(native ? { sourceSessionId: sample.ev.session_id, sourceEventUuid: sample.ev.uuid, accountSource: explicitProvider ? "receipt" : "native-session" } : { sourcePrefixHash: sample.prefix }) });
  }
  const represented = (row: UsageRepairRow) => rows.some(r => r.ts === row.ts && r.label === row.label && r.used === row.used && r.resetsAt === row.resetsAt);
  const orphaned = input.rows.filter(r => (r.provider === "claude" || r.provider === "claude:nefro") && r.schemaVersion == null && !represented(r))
    .map(r => ({ ...r, provider: "claude:unknown", schemaVersion: 2, provenance: "legacy-history", timestampSource: "unknown", accountUnresolved: true }));
  const canonicalRows = rows.filter(r => (r.sourceSessionId && r.sourceEventUuid) || r.sourcePrefixHash);
  const reconciledExplicit = explicit.filter(row => {
    if ((row.provider !== "claude" && row.provider !== "claude:nefro") || row.schemaVersion == null || row.sourceSessionId || row.sourceEventUuid) return true;
    return !canonicalRows.some(canonical => canonical.provider === row.provider && canonical.ts === row.ts && canonical.label === row.label && canonical.resetsAt === row.resetsAt && canonical.used === row.used && canonical.limit === row.limit && canonical.unit === row.unit);
  });
  const unique = new Map<string, UsageRepairRow>();
  const rank = (row: UsageRepairRow) => row.timestampSource === "received" || row.provenance === "received" ? 3 : row.schemaVersion != null ? 2 : 1;
  for (const row of [...reconciledExplicit, ...rows, ...orphaned]) {
    const key = [row.provider, row.ts, row.label, row.resetsAt ?? "", row.used, row.limit, row.unit ?? "", row.sourceSessionId ?? "", row.sourceEventUuid ?? "", row.sourcePrefixHash ?? ""].join("|");
    if (!unique.has(key) || rank(row) > rank(unique.get(key)!)) unique.set(key, row);
  }
  return { rows: [...unique.values()].sort((a, b) => a.ts - b.ts) };
}
