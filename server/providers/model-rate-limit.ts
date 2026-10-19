import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

export const MODEL_REQUEST_INTERVAL_MS = 1_100;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

type Options = { path: string; intervalMs?: number };

/** One admission clock shared by all Console processes, providers, and models. */
export class ModelRateLimit {
  private db: DatabaseSync;
  readonly intervalMs: number;

  constructor(options: Options) {
    this.intervalMs = options.intervalMs ?? MODEL_REQUEST_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new Error("Model request interval must be a positive integer.");
    }
    fs.mkdirSync(path.dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS admission (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_at INTEGER NOT NULL,
      cooldown_until INTEGER NOT NULL
    ); INSERT OR IGNORE INTO admission VALUES (1, 0, 0);`);
    fs.chmodSync(options.path, 0o600);
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      let waiting = 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Read the clock after obtaining the lock, never before waiting for it.
        const now = Date.now();
        const state = this.db.prepare("SELECT next_at, cooldown_until FROM admission WHERE id = 1")
          .get() as { next_at: number; cooldown_until: number };
        waiting = Math.max(state.next_at, state.cooldown_until) - now;
        if (waiting <= 0) {
          signal?.throwIfAborted();
          this.db.prepare("UPDATE admission SET next_at = ? WHERE id = 1")
            .run(now + this.intervalMs);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      if (waiting <= 0) return;
      // No reservation and no SQLite lock survives this await. Cancelled callers
      // consume no slot; all contenders recheck cooldowns after waking.
      await delay(waiting, undefined, { signal });
    }
  }

  /** Publish a provider's Retry-After value to every waiting process. */
  report429(retryAfter?: string | number | null): number {
    const now = Date.now();
    let milliseconds = DEFAULT_COOLDOWN_MS;
    if (retryAfter != null && String(retryAfter).trim() !== "") {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) milliseconds = seconds * 1_000;
      else {
        const timestamp = Date.parse(String(retryAfter));
        if (Number.isFinite(timestamp)) milliseconds = timestamp - now;
      }
    }
    const until = now + Math.max(0, Math.min(MAX_COOLDOWN_MS, milliseconds));
    this.db.prepare("UPDATE admission SET cooldown_until = MAX(cooldown_until, ?) WHERE id = 1")
      .run(until);
    return (this.db.prepare("SELECT cooldown_until FROM admission WHERE id = 1").get() as { cooldown_until: number })
      .cooldown_until;
  }

  async fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    await this.acquire(signal ?? undefined);
    const response = await globalThis.fetch(input, init);
    if (response.status === 429) this.report429(response.headers.get("retry-after"));
    return response;
  }

  close(): void { this.db.close(); }
}

let singleton: ModelRateLimit | undefined;
export function getModelRateLimit(): ModelRateLimit {
  return singleton ??= new ModelRateLimit({
    path: path.join(process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console"), "model-rate-limit.sqlite"),
  });
}

// Keep module imports side-effect free, including Pi preloads and scratch tests.
export const modelRateLimit = {
  acquire: (signal?: AbortSignal) => getModelRateLimit().acquire(signal),
  report429: (retryAfter?: string | number | null) => getModelRateLimit().report429(retryAfter),
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => getModelRateLimit().fetch(input, init),
};
export const acquireModelRequest = modelRateLimit.acquire;
export const reportModel429 = modelRateLimit.report429;
