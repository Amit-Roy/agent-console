// Token categories are disjoint except reasoning (a subset of output).
export interface Tokens {
  fresh?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  reasoning?: number;
}
export interface ModelUsage extends Tokens {
  model: string;
  role: "agent" | "unattributed";
  cost?: number;
}
export interface Accounting {
  in?: number;
  out?: number;
  cache?: number;
  cost?: number;
  models?: ModelUsage[];
  accounting: 2;
  session?: string;
  eventId?: string;
  cumulative?: any;
  duplicate?: boolean;
}
const number = (v: any): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
export const delta = (now: number, before?: number) =>
  before == null || now < before ? now : now - before;
function sum(rows: any[], key: string): number | undefined {
  const values = rows.map((r) => number(r[key]));
  return values.length && values.every((v) => v != null)
    ? values.reduce((s, v) => s! + v!, 0)
    : undefined;
}
export function claudeTotals(ev: any) {
  const models: ModelUsage[] = Object.entries(ev.modelUsage ?? {}).map(([model, value]) => {
    const m = value as any;
    return {
      model,
      role: "unattributed",
      fresh: number(m.inputTokens),
      cacheWrite: number(m.cacheCreationInputTokens),
      cacheRead: number(m.cacheReadInputTokens),
      output: number(m.outputTokens),
      cost: number(m.costUSD),
    };
  });
  const fresh = sum(models, "fresh"),
    write = sum(models, "cacheWrite"),
    read = sum(models, "cacheRead");
  return {
    cost: number(ev.total_cost_usd),
    in: fresh == null || write == null || read == null ? undefined : fresh + write + read,
    out: sum(models, "output"),
    cache: read,
    models,
  };
}
// Rebuilt from durable result logs at startup, preserving native-session counters across process/server restarts.
export class SessionAccounting {
  private snapshots = new Map<string, ReturnType<typeof claudeTotals>>();
  private seen = new Set<string>();
  restore(session: string, snapshot: any, eventId?: string) {
    if (!snapshot || !Array.isArray(snapshot.models)) return;
    this.snapshots.set(session, snapshot);
    if (eventId) this.seen.add(`${session}:${eventId}`);
  }
  seedFork(session: string, parent: string) {
    const v = this.snapshots.get(parent);
    if (v && !this.snapshots.has(session)) this.snapshots.set(session, v);
  }
  consume(session: string, ev: any): Accounting {
    const eventId = typeof ev.uuid === "string" ? ev.uuid : undefined;
    const key = eventId && `${session}:${eventId}`;
    if (key && this.seen.has(key)) return { accounting: 2, duplicate: true };
    if (key) this.seen.add(key);
    const now = claudeTotals(ev),
      previous = this.snapshots.get(session);
    const reset = now.cost != null && previous?.cost != null && now.cost < previous.cost;
    const before = reset ? undefined : previous;
    const models = now.models.map((m) => {
      const old = before?.models.find((x) => x.model === m.model);
      const row: ModelUsage = { model: m.model, role: "unattributed" };
      for (const field of ["fresh", "cacheWrite", "cacheRead", "output", "cost"] as const)
        if (m[field] != null) row[field] = delta(m[field]!, old?.[field]);
      return row;
    });
    const snapshots = now.models.map(
      (m) =>
        ({
          ...before?.models.find((x) => x.model === m.model),
          ...Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)),
        }) as ModelUsage,
    );
    for (const old of before?.models || [])
      if (!snapshots.some((m) => m.model === old.model)) snapshots.push(old);
    this.snapshots.set(session, { ...now, cost: now.cost ?? before?.cost, models: snapshots });
    const fresh = sum(models, "fresh"),
      write = sum(models, "cacheWrite"),
      read = sum(models, "cacheRead");
    return {
      accounting: 2,
      session,
      eventId,
      cumulative: this.snapshots.get(session),
      models,
      cost: now.cost == null ? undefined : delta(now.cost, before?.cost),
      in: fresh == null || write == null || read == null ? undefined : fresh + write + read,
      out: sum(models, "output"),
      cache: read,
    };
  }
}
export function codexAccounting(usage: any, model: string): Accounting {
  const input = number(usage?.input_tokens),
    cache = number(usage?.cached_input_tokens),
    output = number(usage?.output_tokens);
  return {
    accounting: 2,
    in: input,
    out: output,
    cache,
    models: [
      {
        model,
        role: "agent",
        fresh: input != null && cache != null ? Math.max(0, input - cache) : undefined,
        cacheRead: cache,
        output,
        reasoning: number(usage?.reasoning_output_tokens),
      },
    ],
  };
}
export function piAccounting(models: ModelUsage[]): Accounting {
  const fresh = sum(models, "fresh"),
    write = sum(models, "cacheWrite"),
    read = sum(models, "cacheRead");
  return {
    accounting: 2,
    models,
    in: fresh == null || write == null || read == null ? undefined : fresh + write + read,
    out: sum(models, "output"),
    cache: read,
    cost: sum(models, "cost"),
  };
}
