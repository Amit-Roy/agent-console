import fs from "node:fs";
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
export function watchClosed(dir: string, onClosed: () => Promise<unknown> | void, onError?: (e: unknown) => void) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let running = false, again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try { do { again = false; await onClosed(); } while (again); }
    catch (e) { onError?.(e); }
    finally { running = false; }
  };
  const watcher = fs.watch(dir, (_event, name) => { if (name === FILE) void run(); });
  watcher.unref();
  return { close: () => watcher.close() };
}
