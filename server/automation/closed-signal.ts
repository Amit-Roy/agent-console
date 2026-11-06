import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The GitHub webhook worker is a separate process. When GitHub reports a closed issue or merged PR it drops a marker file here;
// the Console watches the directory (inotify, no polling) and reconciles archives at once.
const FILE = "closed.json";

export type ClosedItem = { repo: string; number: number; kind: "issue" | "pull_request" };

export function announceClosed(dir: string, item: ClosedItem, now = Date.now): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...item, ts: now() }), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, FILE));
}

/** Runs `onClosed` after each announcement. Bursts coalesce; an announcement during a run triggers exactly one more run. */
export function watchClosed(
  dir: string,
  onClosed: () => Promise<unknown> | void,
  onError?: (e: unknown) => void,
) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let running = false,
    again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await onClosed();
      } while (again);
    } catch (e) {
      onError?.(e);
    } finally {
      running = false;
    }
  };
  const watcher = fs.watch(dir, (_event, name) => {
    if (name === FILE) void run();
  });
  watcher.unref();
  return { close: () => watcher.close() };
}

// Per-PR webhook signals (check runs, reviews, comments, deployments): one atomic file per PR so the cockpit refreshes that PR only.
const SIGNAL_DIR = "pr-signals";
const DEBOUNCE_MS = 3000;

export type PrKey = { repo: string; pr?: number; sha?: string; event: string };
export type PrSignal = PrKey & { at: number };
export type PrSignalOptions = { dir?: string; debounceMs?: number };

/** Base directory shared with closed.json (the triage worker and the Console must agree on it). */
export function defaultEventsDir(): string {
  const config =
    process.env.AGENT_CONSOLE_TRIAGE_CONFIG ||
    path.join(os.homedir(), ".config/agent-console/github-triage.json");
  return path.join(path.dirname(config), "github-events");
}

const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "_");

function signalName(key: PrKey): string | undefined {
  const id = key.pr !== undefined ? String(key.pr) : key.sha;
  if (!id || !/^[\w.-]+\/[\w.-]+$/.test(key.repo)) return undefined;
  return `${safe(key.repo.replace("/", "_"))}-${safe(id)}.json`;
}

/** Writes `pr-signals/<owner_name>-<pr|sha>.json` atomically. Same key overwrites, so bursts collapse on disk. */
export function announcePr(key: PrKey, baseDir = defaultEventsDir(), now = Date.now): void {
  const name = signalName(key);
  if (!name) return;
  const dir = path.join(baseDir, SIGNAL_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  const sig: PrSignal = { repo: key.repo, pr: key.pr, sha: key.sha, event: key.event, at: now() };
  fs.writeFileSync(tmp, JSON.stringify(sig), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}

function readSignal(file: string): PrSignal | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
    fs.rmSync(file, { force: true });
  } catch {
    return undefined;
  }
  try {
    const sig = JSON.parse(text);
    return typeof sig?.repo === "string" && typeof sig.event === "string" ? sig : undefined;
  } catch {
    return undefined;
  }
}

/** Consumes every signal file (read, delete, callback) on start and on each directory change. Per-key debounce; returns a stopper. */
export function watchPrSignals(
  onSignal: (sig: PrSignal) => void,
  options: PrSignalOptions = {},
): () => void {
  const dir = path.join(options.dir ?? defaultEventsDir(), SIGNAL_DIR);
  const wait = options.debounceMs ?? DEBOUNCE_MS;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pending = new Map<string, { sig: PrSignal; timer: NodeJS.Timeout }>();
  const queue = (name: string, sig: PrSignal) => {
    const held = pending.get(name);
    if (held) {
      held.sig = sig; // latest wins; the timer keeps running from the first event
      return;
    }
    const entry = {
      sig,
      timer: setTimeout(() => {
        pending.delete(name);
        try {
          onSignal(entry.sig);
        } catch {
          // a failing consumer must not stop the watcher
        }
      }, wait),
    };
    entry.timer.unref();
    pending.set(name, entry);
  };
  const sweep = () => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const sig = readSignal(path.join(dir, name));
      if (sig) queue(name, sig);
    }
  };
  const watcher = fs.watch(dir, () => sweep());
  watcher.unref();
  sweep();
  return () => {
    watcher.close();
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}
