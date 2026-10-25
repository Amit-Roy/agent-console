const SEND_TOOLS = new Set([
  "mcp__agent_console__thread_send",
  "agent_console:thread_send",
  "thread_send",
]);

type JsonRecord = Record<string, unknown>;
type Grant = { threadId: string; payload: string; expires: number };
type Waiter = { threadId: string; payload: string; finish: (allowed: boolean) => void };

export type ThreadToolAuthOptions = {
  grantTtlMs?: number;
  waitMs?: number;
  maxGrants?: number;
  maxWaiters?: number;
  maxSeenIds?: number;
  now?: () => number;
};

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!record(value)) throw new Error("Tool input must contain only JSON values.");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function payloadKey(value: unknown): string | null {
  try {
    return record(value) ? canonical(value) : null;
  } catch {
    return null;
  }
}

/**
 * This object accepts only trusted live provider events, never transcript replay or client input.
 * Call clear when a turn ends, is cancelled, or its thread is deleted. It resolves waiters and
 * removes grants while retaining tool IDs so old events cannot authorize a later turn.
 * The bounded ID ledger fails closed when full. Recreate this object only with a new live
 * provider lifecycle that cannot replay previous tool events.
 */
export class ThreadToolAuth {
  private readonly grants: Grant[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly seenIds = new Set<string>();
  private readonly grantTtlMs: number;
  private readonly waitMs: number;
  private readonly maxGrants: number;
  private readonly maxWaiters: number;
  private readonly maxSeenIds: number;
  private readonly now: () => number;

  constructor(options: ThreadToolAuthOptions = {}) {
    this.grantTtlMs = options.grantTtlMs ?? 30_000;
    this.waitMs = options.waitMs ?? 2_000;
    this.maxGrants = options.maxGrants ?? 256;
    this.maxWaiters = options.maxWaiters ?? 64;
    this.maxSeenIds = options.maxSeenIds ?? 100_000;
    this.now = options.now ?? Date.now;
  }

  observe(threadId: string, event: unknown): void {
    if (!threadId || !record(event) || event.type !== "assistant") return;
    if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) return;
    if (!record(event.message) || !Array.isArray(event.message.content)) return;
    this.expireGrants();
    for (const block of event.message.content) this.observeBlock(threadId, block);
  }

  private observeBlock(threadId: string, block: unknown): void {
    if (!record(block) || block.type !== "tool_use" || typeof block.id !== "string" || !block.id)
      return;
    if (typeof block.name !== "string" || !SEND_TOOLS.has(block.name)) return;
    const payload = payloadKey(block.input);
    if (payload === null) return;
    const identity = JSON.stringify([threadId, block.id]);
    if (this.seenIds.has(identity) || this.seenIds.size >= this.maxSeenIds) return;
    this.seenIds.add(identity);
    const waiter = [...this.waiters].find(
      (candidate) => candidate.threadId === threadId && candidate.payload === payload,
    );
    if (waiter) {
      waiter.finish(true);
      return;
    }
    if (this.grants.length < this.maxGrants)
      this.grants.push({ threadId, payload, expires: this.now() + this.grantTtlMs });
  }

  consume(threadId: string, name: string, params: unknown): Promise<boolean> {
    if (!threadId || !SEND_TOOLS.has(name)) return Promise.resolve(false);
    const payload = payloadKey(params);
    if (payload === null) return Promise.resolve(false);
    this.expireGrants();
    const position = this.grants.findIndex(
      (grant) => grant.threadId === threadId && grant.payload === payload,
    );
    if (position >= 0) {
      this.grants.splice(position, 1);
      return Promise.resolve(true);
    }
    if (this.waiters.size >= this.maxWaiters) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        threadId,
        payload,
        finish: (allowed) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(allowed);
        },
      };
      const timer = setTimeout(() => waiter.finish(false), this.waitMs);
      this.waiters.add(waiter);
    });
  }

  clear(threadId: string): void {
    for (let index = this.grants.length - 1; index >= 0; index--)
      if (this.grants[index].threadId === threadId) this.grants.splice(index, 1);
    for (const waiter of this.waiters) if (waiter.threadId === threadId) waiter.finish(false);
  }

  private expireGrants(): void {
    const now = this.now();
    for (let index = this.grants.length - 1; index >= 0; index--)
      if (this.grants[index].expires <= now) this.grants.splice(index, 1);
  }
}
