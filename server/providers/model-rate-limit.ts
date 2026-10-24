import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import PQueue from "p-queue";

export const MODEL_REQUEST_INTERVAL_MS = 1_100;
export const MODEL_REQUEST_PRIORITIES = {
  interactive: 20,
  automation: 10,
  triage: 5,
  label: 0,
} as const;
export type ModelRequestProvider = "nvidia" | "openrouter" | "other";
export type ModelRequestPriority = keyof typeof MODEL_REQUEST_PRIORITIES;
export type ModelRequestAdmission = {
  signal?: AbortSignal;
  priority?: ModelRequestPriority | number;
  provider?: ModelRequestProvider;
};
export type ModelRateLimitOptions = {
  path: string;
  intervalMs?: number;
  openRouterMinuteLimit?: number;
  openRouterWindowMs?: number;
  openRouterDayLimit?: number;
  /** Injected clock for deterministic UTC quota tests. Queue timers remain real. */
  now?: () => number;
};

export class AdmissionUnavailable extends Error {
  readonly code = "MODEL_PROVIDER_QUOTA_EXHAUSTED";
  readonly provider: ModelRequestProvider;
  readonly retryAt: number;
  readonly reason: "minute-quota" | "daily-quota";
  constructor(
    provider: ModelRequestProvider,
    retryAt: number,
    reason: "minute-quota" | "daily-quota",
  ) {
    super(`${provider} ${reason} exhausted; retry at ${new Date(retryAt).toISOString()}.`);
    this.name = "AdmissionUnavailable";
    this.provider = provider;
    this.retryAt = retryAt;
    this.reason = reason;
  }
}

class DeferredAdmission extends Error {
  readonly until: number;
  constructor(until: number) {
    super("Admission deferred.");
    this.until = until;
  }
}

/** One central priority queue. SQLite preserves admission clocks across restarts. */
export class ModelRateLimit {
  private db: DatabaseSync;
  private queue: PQueue;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private now: () => number;
  private minuteLimit: number;
  private windowMs: number;
  private dayLimit: number;
  readonly intervalMs: number;

  constructor(options: ModelRateLimitOptions) {
    this.intervalMs = options.intervalMs ?? MODEL_REQUEST_INTERVAL_MS;
    this.minuteLimit = options.openRouterMinuteLimit ?? 20;
    this.windowMs = options.openRouterWindowMs ?? 60_000;
    this.dayLimit = options.openRouterDayLimit ?? 1_000;
    this.now = options.now ?? Date.now;
    for (const value of [this.intervalMs, this.minuteLimit, this.windowMs, this.dayLimit]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Rate limits must be positive integers.");
    }
    this.queue = new PQueue({
      concurrency: 1,
      autoStart: false,
      intervalCap: 1,
      interval: this.intervalMs,
      strict: true,
    });
    fs.mkdirSync(path.dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS admission (
        id INTEGER PRIMARY KEY CHECK (id = 1), next_at INTEGER NOT NULL, cooldown_until INTEGER NOT NULL
      ); INSERT OR IGNORE INTO admission VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS provider_cooldowns (provider TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS openrouter_starts (started_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS openrouter_starts_time ON openrouter_starts(started_at);
      CREATE TABLE IF NOT EXISTS openrouter_days (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS openrouter_limits (day TEXT PRIMARY KEY, request_limit INTEGER NOT NULL);`);
    // Preserve the previous unscoped cooldown conservatively during upgrade.
    this.db.exec(`INSERT OR IGNORE INTO provider_cooldowns
      SELECT 'other', cooldown_until FROM admission WHERE id = 1 AND cooldown_until > 0;`);
    fs.chmodSync(options.path, 0o600);
    this.resumeAt(this.nextAt());
  }

  private nextAt(): number {
    return (
      this.db.prepare("SELECT next_at FROM admission WHERE id = 1").get() as { next_at: number }
    ).next_at;
  }

  private cooldown(provider: ModelRequestProvider): number {
    return (
      (
        this.db
          .prepare("SELECT until_at FROM provider_cooldowns WHERE provider = ?")
          .get(provider) as { until_at: number } | undefined
      )?.until_at ?? 0
    );
  }

  private resumeAt(until: number): void {
    this.queue.pause();
    if (this.timer) clearTimeout(this.timer);
    const wait = until - this.now();
    if (wait <= 0) {
      this.queue.start();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed) this.resumeAt(this.nextAt());
    }, wait);
  }

  private checkQuota(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    const count =
      (
        this.db.prepare("SELECT requests FROM openrouter_days WHERE day = ?").get(day) as
          | { requests: number }
          | undefined
      )?.requests ?? 0;
    const reportedLimit =
      (
        this.db.prepare("SELECT request_limit FROM openrouter_limits WHERE day = ?").get(day) as
          | { request_limit: number }
          | undefined
      )?.request_limit ?? this.dayLimit;
    if (count >= Math.min(this.dayLimit, reportedLimit)) {
      throw new AdmissionUnavailable(
        "openrouter",
        Date.parse(`${day}T00:00:00Z`) + 86_400_000,
        "daily-quota",
      );
    }
    this.db.prepare("DELETE FROM openrouter_starts WHERE started_at <= ?").run(now - this.windowMs);
    const starts = this.db
      .prepare("SELECT started_at FROM openrouter_starts ORDER BY started_at")
      .all() as { started_at: number }[];
    if (starts.length >= this.minuteLimit) {
      throw new DeferredAdmission(starts[0].started_at + this.windowMs);
    }
  }

  private recordAdmission(provider: ModelRequestProvider, now: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE admission SET next_at = ? WHERE id = 1").run(now + this.intervalMs);
      if (provider === "openrouter") {
        const day = new Date(now).toISOString().slice(0, 10);
        this.db.prepare("INSERT INTO openrouter_starts VALUES (?)").run(now);
        this.db
          .prepare(`INSERT INTO openrouter_days VALUES (?, 1)
                ON CONFLICT(day) DO UPDATE SET requests = requests + 1`)
          .run(day);
        this.db.prepare("DELETE FROM openrouter_days WHERE day < ?").run(day);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private admitNow(provider: ModelRequestProvider, signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
    const now = this.now();
    const cooldown = this.cooldown(provider);
    if (cooldown > now) throw new DeferredAdmission(cooldown);
    if (provider === "openrouter") this.checkQuota(now);
    const next = this.nextAt();
    if (next > now) {
      this.resumeAt(next);
      throw new DeferredAdmission(next);
    }
    this.recordAdmission(provider, now);
    // PQueue owns live spacing; persisted next_at restores it after restart.
  }

  /** Returns true when the OpenRouter quota deferred this attempt and the wait already finished. */
  private async deferForQuota(signal: AbortSignal | undefined): Promise<boolean> {
    try {
      this.checkQuota(this.now());
    } catch (error) {
      if (!(error instanceof DeferredAdmission)) throw error;
      await delay(Math.max(0, error.until - this.now()), undefined, { signal });
      return true;
    }
    return false;
  }

  async acquire(input?: AbortSignal | ModelRequestAdmission): Promise<void> {
    const options = input && "aborted" in input ? { signal: input } : (input ?? {});
    const { signal, provider = "other" } = options;
    const priority =
      typeof options.priority === "number"
        ? options.priority
        : MODEL_REQUEST_PRIORITIES[options.priority ?? "interactive"];
    if (!Number.isFinite(priority)) throw new Error("Invalid model request priority.");
    for (;;) {
      if (this.closed) throw new Error("Model request scheduler is closed.");
      signal?.throwIfAborted();
      if (provider === "openrouter" && (await this.deferForQuota(signal))) continue;
      const waiting = this.cooldown(provider) - this.now();
      if (waiting > 0) await delay(waiting, undefined, { signal });
      try {
        await this.queue.add(() => this.admitNow(provider, signal), { priority, signal });
        return;
      } catch (error) {
        if (!(error instanceof DeferredAdmission)) throw error;
        await delay(Math.max(0, error.until - this.now()), undefined, { signal });
      }
    }
  }

  /** A 429 pauses only requests targeting the provider that returned it. */
  report429(retryAfter?: string | number | null, provider: ModelRequestProvider = "other"): number {
    const now = this.now();
    let milliseconds = 30_000;
    if (retryAfter != null && String(retryAfter).trim() !== "") {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) milliseconds = seconds * 1_000;
      else {
        const timestamp = Date.parse(String(retryAfter));
        if (Number.isFinite(timestamp)) milliseconds = timestamp - now;
      }
    }
    const until = now + Math.max(0, Math.min(15 * 60_000, milliseconds));
    this.db
      .prepare(`INSERT INTO provider_cooldowns VALUES (?, ?)
      ON CONFLICT(provider) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)`)
      .run(provider, until);
    return this.cooldown(provider);
  }

  /** Reconcile the upstream daily counter without restoring locally consumed quota. */
  syncOpenRouterQuota({
    used,
    limit,
    observedAt = this.now(),
  }: {
    used: number;
    limit: number;
    observedAt?: number;
  }): void {
    if (
      !Number.isFinite(used) ||
      used < 0 ||
      !Number.isFinite(limit) ||
      limit < 0 ||
      !Number.isFinite(observedAt)
    ) {
      throw new Error("Invalid OpenRouter quota observation.");
    }
    const day = new Date(observedAt).toISOString().slice(0, 10);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO openrouter_days VALUES (?, ?)
        ON CONFLICT(day) DO UPDATE SET requests = MAX(requests, excluded.requests)`)
        .run(day, Math.ceil(used));
      this.db
        .prepare(`INSERT INTO openrouter_limits VALUES (?, ?)
        ON CONFLICT(day) DO UPDATE SET request_limit = MIN(request_limit, excluded.request_limit)`)
        .run(day, Math.floor(limit));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.queue.pause();
    this.db.close();
  }
}
