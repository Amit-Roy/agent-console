import fs from "node:fs";
import path from "node:path";

type RuntimeThread = {
  id: string;
  status?: string;
  background?: number;
  archived?: number;
  issueRun?: { outcome?: string; stalled?: number; finishedAt?: number; redoing?: boolean };
};

// Caches, scratch files and plugin copies are recreated on the next launch. Transcripts,
// sessions and seeded logins stay so a finished thread can still be inspected, forked or resumed.
const RECLAIMABLE = ["tmp", "cache", "claude/plugins", "codex/plugins", "codex/cache", "codex/tmp"];
const ID = /^[a-zA-Z0-9_-]+$/;

/** A thread is final once archived, stalled, or judged; running work is never final. */
export function runtimeFinished(t: RuntimeThread): boolean {
  if (!t.issueRun || t.status === "running" || t.background) return false;
  return !!(t.archived || t.issueRun.stalled || t.issueRun.outcome);
}

/** Returns the target only when every component below `root` is a real directory, so a planted link cannot redirect deletion. */
async function realPath(root: string, relative: string): Promise<string | undefined> {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    } catch {
      return;
    }
  }
  return current;
}

async function listRuntimeEntries(root: string): Promise<string[] | undefined> {
  try {
    const stat = await fs.promises.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    return await fs.promises.readdir(root);
  } catch {
    return undefined;
  }
}

async function sweepEntry(
  root: string,
  id: string,
  known: Map<string, RuntimeThread>,
  result: { pruned: number; removed: number; failed: number },
) {
  const thread = known.get(id);
  try {
    if (!thread) {
      // An empty list means threads failed to load; never treat that as "every job is gone".
      if (!known.size) return;
      await fs.promises.rm(path.join(root, id), { recursive: true, force: true });
      result.removed++;
    } else if (runtimeFinished(thread) && (await prune(root, id))) result.pruned++;
  } catch {
    // One undeletable folder must not stop the sweep; the caller reports the count.
    result.failed++;
  }
}

/**
 * Reclaim disk from Auto runtime folders: prune finished threads and delete folders of
 * threads that no longer exist. Running and unfinished threads are untouched.
 */
export async function sweepAutoRuntime(dataDir: string, threads: RuntimeThread[]) {
  const result = { pruned: 0, removed: 0, failed: 0 };
  const root = path.join(path.resolve(dataDir), "auto-runtime");
  const entries = await listRuntimeEntries(root);
  if (!entries) return result;
  const known = new Map(threads.map((t) => [t.id, t]));
  for (const id of entries) {
    if (!ID.test(id)) continue;
    await sweepEntry(root, id, known, result);
  }
  return result;
}

async function prune(root: string, id: string): Promise<boolean> {
  const runtime = await realPath(root, id);
  if (!runtime) return false;
  let pruned = false;
  for (const relative of RECLAIMABLE) {
    const target = await realPath(runtime, relative);
    if (!target) continue;
    await fs.promises.rm(target, { recursive: true, force: true });
    pruned = true;
  }
  return pruned;
}
