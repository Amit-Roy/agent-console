import fs from "node:fs";
import path from "node:path";
import { type Provider, ShareError, type ShareItem, type ShareLink } from "./types.ts";
import {
  BLOCKED_MESSAGE,
  buildArgs,
  expectedCount,
  type Found,
  MAX_ITEMS,
  MAX_TOTAL_BYTES,
  readInfo,
  runYtDlp,
  scanStage,
} from "./ytdlp.ts";

// Share-to-console for Instagram reels: validate the shared link, download it anonymously with yt-dlp (no shell, no cookies),
// and hand back the video plus a small caption file. Caption text is untrusted data.

const HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const PATH_RE = /^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,40})/;
const URL_RE = /https:\/\/[^\s<>"']+/g;
const DEDUPE_MS = 60_000;

export { BLOCKED_MESSAGE, buildArgs, classifyError, MAX_ITEMS, MAX_TOTAL_BYTES } from "./ytdlp.ts";
export { ShareError };

export interface InstagramLink extends ShareLink {
  provider: "instagram";
  kind: "reel" | "p" | "tv";
  code: string;
}

function parseCandidate(parsed: URL): InstagramLink | null {
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (!HOSTS.has(parsed.hostname)) return null;
  if (parsed.port) return null;
  const match = PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  const kind = match[1] === "reels" ? "reel" : (match[1] as "reel" | "p" | "tv");
  return {
    provider: "instagram",
    kind,
    code: match[2],
    id: match[2],
    url: `https://www.instagram.com/${kind}/${match[2]}/`,
  };
}

/** First valid Instagram post link found in the explicit url, then in the shared text; canonical form only. */
export function extractInstagramUrl(text: unknown, url: unknown): InstagramLink | null {
  const candidates: string[] = [];
  if (typeof url === "string") candidates.push(url.trim());
  if (typeof text === "string") candidates.push(...(text.match(URL_RE) ?? []));
  for (const candidate of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(candidate.replace(/[).,;!]+$/, ""));
    } catch {
      continue;
    }
    const link = parseCandidate(parsed);
    if (link) return link;
  }
  return null;
}

export const FETCH_HINT = "If slides are missing, run `instagram-fetch <url>`.";

function captionText(info: any, link: InstagramLink, got: number, missing: number[]): string {
  const lines = [
    `caption: ${String(info?.description ?? info?.title ?? "").slice(0, 4000)}`,
    `uploader: ${String(info?.uploader ?? info?.channel ?? "")}`,
    `upload_date: ${String(info?.upload_date ?? "")}`,
    `duration: ${String(info?.duration ?? "")}`,
    `items: ${got}`,
    `url: ${link.url}`,
  ];
  if (missing.length) {
    lines.push(`downloaded: ${got} of ${got + missing.length}`, `missing: ${missing.join(",")}`);
    lines.push(`fetch the rest: instagram-fetch ${link.url} --items ${missing.join(",")}`);
  } else lines.push(FETCH_HINT.replace("<url>", link.url));
  return lines.join("\n") + "\n";
}

export type DownloadedItem = ShareItem;

export interface Downloaded {
  items: DownloadedItem[];
  captionPath: string;
  cleanup: () => void;
}

let chain: Promise<unknown> = Promise.resolve();
const recent = new Map<string, number>();

/** Downloads one reel at a time. The caller owns the returned files and must call cleanup(). */
export function downloadInstagram(
  link: InstagramLink,
  opts: { signal?: AbortSignal } = {},
): Promise<Downloaded> {
  const now = Date.now();
  for (const [key, requestedAt] of recent) if (now - requestedAt > DEDUPE_MS) recent.delete(key);
  if (recent.has(link.url))
    return Promise.reject(new ShareError("That reel was just requested. Wait a minute."));
  recent.set(link.url, now);
  const job = chain.then(() => downloadNow(link, opts.signal));
  chain = job.catch(() => {});
  return job;
}

export interface FetchedPost {
  items: DownloadedItem[];
  captionPath: string;
  missing: number[];
}

/** Runs yt-dlp once; a failure is remembered (not thrown) because yt-dlp exits nonzero on a partial result. */
async function runAttempt(
  link: InstagramLink,
  stage: string,
  opts: { signal?: AbortSignal },
  items: number[] | undefined,
  errors: unknown[],
): Promise<void> {
  try {
    await runYtDlp(buildArgs(link.url, stage, items), opts.signal);
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    errors.push(error);
  }
}

function missingItems(stage: string, wantedItems?: number[]): number[] {
  const have = new Set(scanStage(stage).map((entry) => entry.index));
  const size = expectedCount(stage) || Math.max(1, ...have);
  const wanted = wantedItems ?? Array.from({ length: size }, (_, offset) => offset + 1);
  return wanted.filter((index) => !have.has(index));
}

function checkTotalSize(stage: string, found: Found[]): void {
  const total = found.reduce(
    (sum, entry) => sum + fs.statSync(path.join(stage, entry.name)).size,
    0,
  );
  if (total > MAX_TOTAL_BYTES) throw new ShareError("That post is too large (over 100 MB).");
}

function nameItems(stage: string, found: Found[]): DownloadedItem[] {
  const multi = found.length > 1 || expectedCount(stage) > 1 || found[0].index > 1;
  return found.map((entry) => {
    const isVideo = /^(mp4|webm|mkv|mov|m4v)$/.test(entry.ext);
    const outExt = isVideo ? "mp4" : entry.ext === "jpeg" ? "jpg" : entry.ext;
    const base = multi ? `slide-${entry.index}` : isVideo ? "video" : "image";
    return { path: path.join(stage, entry.name), name: `${base}.${outExt}` };
  });
}

/** Downloads, then retries once when nothing arrived (unless Instagram said no) and once more for the missing items. */
async function downloadItems(
  link: InstagramLink,
  stage: string,
  opts: { signal?: AbortSignal; items?: number[] },
): Promise<{ missing: number[]; firstError: unknown }> {
  const errors: unknown[] = [];
  await runAttempt(link, stage, opts, opts.items, errors);
  const first = errors[0];
  const blocked = first instanceof ShareError && first.message === BLOCKED_MESSAGE;
  // nothing at all: one more try, except when Instagram said no (retrying only adds rate-limit pressure)
  if (!scanStage(stage).length && !blocked) await runAttempt(link, stage, opts, opts.items, errors);
  if (!scanStage(stage).length) return { missing: [], firstError: first };
  let missing = missingItems(stage, opts.items);
  if (missing.length) {
    await runAttempt(link, stage, opts, missing, errors);
    missing = missingItems(stage, opts.items);
  }
  return { missing, firstError: first };
}

/**
 * Downloads a post into `stage` (yt-dlp keeps going past a failed item, so a nonzero exit with files on disk is a partial result),
 * retries the missing items once, and writes instagram.txt. Throws only when nothing at all was fetched.
 */
export async function fetchPost(
  link: InstagramLink,
  stage: string,
  opts: { signal?: AbortSignal; items?: number[] } = {},
): Promise<FetchedPost> {
  const { missing, firstError } = await downloadItems(link, stage, opts);
  const found = scanStage(stage).filter((entry) => !opts.items || opts.items.includes(entry.index));
  if (!found.length)
    throw firstError instanceof Error ? firstError : new ShareError("Instagram download failed.");
  checkTotalSize(stage, found);
  const items = nameItems(stage, found);
  const captionPath = path.join(stage, "instagram.txt");
  fs.writeFileSync(captionPath, captionText(readInfo(stage), link, items.length, missing), {
    mode: 0o600,
  });
  return { items, captionPath, missing };
}

export const instagramProvider: Provider = {
  name: "instagram",
  match: parseCandidate,
  async fetch(link, stageDir, opts) {
    const { items, captionPath, missing } = await fetchPost(link as InstagramLink, stageDir, opts);
    const allImages = items.every((item) => /\.(jpg|png|webp)$/.test(item.name));
    return { items, notePath: captionPath, kind: allImages ? "images" : "video", missing };
  },
};

async function downloadNow(link: InstagramLink, signal?: AbortSignal): Promise<Downloaded> {
  const { DATA_DIR } = await import("../auth.ts");
  const root = path.join(DATA_DIR, "tmp");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(root, "instagram-"));
  const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
  try {
    const { items, captionPath } = await fetchPost(link, stage, { signal });
    return { items, captionPath, cleanup };
  } catch (error) {
    cleanup();
    recent.delete(link.url);
    throw error;
  }
}
