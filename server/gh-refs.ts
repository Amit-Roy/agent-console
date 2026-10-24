import { execFile } from "node:child_process";
import type { RequestHandler } from "express";
import { contextDirs, readLogTail } from "./cwd-hints.ts";
import type { Lookup } from "./files.ts";

const NO_REPO = "No GitHub repository found for this thread.";
const URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)(?!\d)/g;
const REMOTE_RE =
  /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

export const validRefNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 999999;

/** `https://github.com/o/r(.git)` or `git@github.com:o/r.git` to owner/repo; null for other hosts. */
export function parseGithubRemote(remote: string): { owner: string; repo: string } | null {
  const match = REMOTE_RE.exec(remote.trim());
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** Newest exact `github.com/o/r/(issues|pull)/<number>` URL in the log text. */
export function exactLogUrl(text: string, number: number): string | null {
  let exact: string | null = null;
  for (const match of text.matchAll(URL_RE))
    if (Number(match[4]) === number)
      exact = `https://github.com/${match[1]}/${match[2]}/${match[3]}/${number}`;
  return exact;
}

/** Most mentioned owner/repo in the log (ties: newest) as an issues URL for `number`. */
export function repoLogUrl(text: string, number: number): string | null {
  const counts = new Map<string, { count: number; last: number }>();
  let index = 0;
  for (const match of text.matchAll(URL_RE)) {
    const key = `${match[1]}/${match[2]}`;
    counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, last: index++ });
  }
  let best: string | null = null;
  let bestEntry = { count: 0, last: -1 };
  for (const [key, entry] of counts) {
    const wins =
      entry.count > bestEntry.count ||
      (entry.count === bestEntry.count && entry.last > bestEntry.last);
    if (wins) [best, bestEntry] = [key, entry];
  }
  return best ? `https://github.com/${best}/issues/${number}` : null;
}

function originRemote(dir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 2000 }, (err, out) =>
      resolve(err ? "" : String(out)),
    );
  });
}

async function urlFromRemotes(dirs: string[], number: number): Promise<string | null> {
  for (const dir of dirs) {
    const repo = parseGithubRemote(await originRemote(dir));
    if (repo) return `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`;
  }
  return null;
}

export async function resolveGithubRef(
  threadId: string,
  cwd: string,
  number: number,
): Promise<{ url: string } | null> {
  if (!validRefNumber(number)) return null;
  const text = readLogTail(threadId)?.text ?? "";
  const exact = exactLogUrl(text, number);
  if (exact) return { url: exact };
  const remote = await urlFromRemotes([...contextDirs(threadId, cwd), cwd], number);
  const url = remote ?? repoLogUrl(text, number);
  return url ? { url } : null;
}

export function refHandler(lookup: Lookup): RequestHandler {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const threadId = typeof req.query.thread === "string" ? req.query.thread : "";
    const thread = threadId ? lookup(threadId) : undefined;
    if (!thread) return void res.status(404).json({ error: "Unknown thread." });
    const raw =
      typeof req.query.n === "string" && /^\d{1,6}$/.test(req.query.n) ? Number(req.query.n) : 0;
    if (!validRefNumber(raw)) return void res.status(400).json({ error: "Invalid issue number." });
    const found = await resolveGithubRef(threadId, thread.cwd, raw);
    if (!found) return void res.status(404).json({ error: NO_REPO });
    res.json(found);
  };
}
