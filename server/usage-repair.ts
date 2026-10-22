export type UsageRepairRow = { ts: number; provider: string; label: string; used: number; limit: number; unit?: string; resetsAt?: number; schemaVersion?: number; provenance?: string; timestampSource?: string; accountUnresolved?: boolean };
type Event = Record<string, any>;
const accountKey = (v: unknown) => v === "nefro" ? "claude:nefro" : v === "sunny" ? "claude" : undefined;
const winList = (ev: Event) => {
  const w = ev.rate_limit_info?.unifiedWindows;
  return [["5-hour", w?.five_hour], ["7-day", w?.seven_day]].flatMap(([label, x]: any[]) => x && Number.isFinite(x.utilization) ? [{ label, used: x.utilization * 100, limit: 100, unit: "%", ...((x.resetsAt || x.resets_at) ? { resetsAt: (x.resetsAt || x.resets_at) * 1000 } : {}) }] : []);
};
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
export function reconstructClaudeHistory(input: { rows: UsageRepairRow[]; logs: Record<string, Event[]>; threads: { id: string; claudeAccount?: string }[] }) {
  const explicit = input.rows.filter(r => r.provider !== "claude" && r.provider !== "claude:nefro" || r.schemaVersion != null);
  const events: { ev: Event; turnTs?: number; id: string; account?: string }[] = [];
  for (const [id, list] of Object.entries(input.logs)) {
    let turnTs: number | undefined;
    const thread = input.threads.find(t => t.id === id);
    for (const ev of list) {
      if (ev.type === "user_input" && Number.isFinite(ev.ts)) turnTs = ev.ts;
      if (ev.type === "rate_limit_event") events.push({ ev, turnTs, id, account: thread ? thread.claudeAccount === undefined ? "claude" : accountKey(thread.claudeAccount) : undefined });
    }
  }
  const groups = new Map<string, typeof events>();
  for (const e of events) {
    const validProvider = e.ev.usageProvider === "claude" || e.ev.usageProvider === "claude:nefro";
    const identity = validProvider ? `explicit:${e.ev.observedAt ?? e.ev.ts ?? e.turnTs ?? "unknown"}:${e.ev.usageProvider}:${stable(e.ev.rate_limit_info)}` : `legacy:${e.ev.ts ?? e.turnTs ?? "unknown"}:${stable(e.ev.rate_limit_info)}`;
    const group = groups.get(identity) ?? []; group.push(e); groups.set(identity, group);
  }
  const rows: UsageRepairRow[] = [];
  for (const group of groups.values()) {
    const sample = group[0];
    const explicitProvider = group.map(x => x.ev.usageProvider === "claude" || x.ev.usageProvider === "claude:nefro" ? x.ev.usageProvider : undefined).find(Boolean);
    const received = !!explicitProvider && Number.isFinite(sample.ev.observedAt);
    const accounts = new Set(group.map(x => x.account).filter(Boolean));
    const unresolved = !explicitProvider && (accounts.size !== 1 || group.some(x => !x.account));
    const provider = explicitProvider || (unresolved ? "claude:unknown" : [...accounts][0]);
    const ts = received ? sample.ev.observedAt : Number.isFinite(sample.ev.ts) ? sample.ev.ts : sample.turnTs;
    if (!Number.isFinite(ts)) continue;
    const timestampSource = received ? "received" : Number.isFinite(sample.ev.ts) ? "logged" : "turn-start";
    for (const w of winList(sample.ev)) rows.push({ ts: ts!, provider: provider!, ...w, schemaVersion: 2, provenance: "claude-log", timestampSource, ...(unresolved ? { accountUnresolved: true } : {}) });
  }
  const represented = (row: UsageRepairRow) => rows.some(r => r.ts === row.ts && r.label === row.label && r.used === row.used && r.resetsAt === row.resetsAt);
  const orphaned = input.rows.filter(r => (r.provider === "claude" || r.provider === "claude:nefro") && r.schemaVersion == null && !represented(r))
    .map(r => ({ ...r, provider: "claude:unknown", schemaVersion: 2, provenance: "legacy-history", timestampSource: "unknown", accountUnresolved: true }));
  const unique = new Map<string, UsageRepairRow>();
  const rank = (row: UsageRepairRow) => row.timestampSource === "received" || row.provenance === "received" ? 3 : row.schemaVersion != null ? 2 : 1;
  for (const row of [...explicit, ...rows, ...orphaned]) {
    const key = [row.provider, row.ts, row.label, row.resetsAt ?? "", row.used, row.limit, row.unit ?? ""].join("|");
    if (!unique.has(key) || rank(row) > rank(unique.get(key)!)) unique.set(key, row);
  }
  return { rows: [...unique.values()].sort((a, b) => a.ts - b.ts) };
}
