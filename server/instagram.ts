import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Share-to-console for Instagram reels: validate the shared link, download it anonymously with yt-dlp (no shell, no cookies),
// and hand back the video plus a small caption file. Caption text is untrusted data.

const HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const PATH_RE = /^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,40})/;
const URL_RE = /https:\/\/[^\s<>"']+/g;
const DEFAULT_YTDLP = "/home/coder/.local/bin/yt-dlp";
export const BLOCKED_MESSAGE =
  "Instagram blocked anonymous download. Cookie fallback is not set up yet.";
const DEDUPE_MS = 60_000;
const TIMEOUT_MS = 120_000;
export const MAX_ITEMS = 10;
export const MAX_TOTAL_BYTES = 100 << 20;
const MEDIA_RE = /^(\d+)\.(mp4|webm|mkv|mov|m4v|jpe?g|png|webp)$/i;

export interface InstagramLink {
  kind: "reel" | "p" | "tv";
  code: string;
  url: string;
}

export class ShareError extends Error {}

function parseCandidate(raw: string): InstagramLink | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (!HOSTS.has(parsed.hostname)) return null;
  if (parsed.port) return null;
  const match = PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  const kind = match[1] === "reels" ? "reel" : (match[1] as "reel" | "p" | "tv");
  return { kind, code: match[2], url: `https://www.instagram.com/${kind}/${match[2]}/` };
}

/** First valid Instagram post link found in the explicit url, then in the shared text; canonical form only. */
export function extractInstagramUrl(text: unknown, url: unknown): InstagramLink | null {
  const candidates: string[] = [];
  if (typeof url === "string") candidates.push(url.trim());
  if (typeof text === "string") candidates.push(...(text.match(URL_RE) ?? []));
  for (const candidate of candidates) {
    const link = parseCandidate(candidate.replace(/[).,;!]+$/, ""));
    if (link) return link;
  }
  return null;
}

export function buildArgs(url: string, outDir: string, items?: number[]): string[] {
  return [
    "--ignore-config",
    "--no-cookies",
    "--no-progress",
    ...(items?.length
      ? ["--playlist-items", items.join(",")]
      : ["--playlist-end", String(MAX_ITEMS)]),
    "--max-filesize",
    "100M",
    "-f",
    "b[ext=mp4]/bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "--write-info-json",
    "-o",
    path.join(outDir, "%(playlist_index|1)s.%(ext)s"),
    "--",
    url,
  ];
}

export function classifyError(stderr: string, code: unknown): string {
  const text = String(stderr ?? "").toLowerCase();
  if (code === "ETIMEDOUT" || code === "SIGTERM" || /timed out/.test(text))
    return "Instagram download timed out. Try again later.";
  if (/larger than max-filesize|file is larger|too large/.test(text))
    return "That video is too large (over 100 MB).";
  if (
    /login required|rate-limit|rate limit|not available|empty media response|restricted|log in/.test(
      text,
    )
  )
    return BLOCKED_MESSAGE;
  if (/unsupported url|invalid url|not a valid url/.test(text))
    return "That is not a valid Instagram link.";
  return "Instagram download failed.";
}

function runYtDlp(args: string[], signal?: AbortSignal): Promise<void> {
  const binary = process.env.AGENT_CONSOLE_YTDLP || DEFAULT_YTDLP;
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 20, signal, env: { ...process.env, NO_COLOR: "1" } },
      (error: any, _stdout, stderr) => {
        if (!error) return resolve();
        const firstLine =
          String(stderr ?? "")
            .split("\n")
            .find(Boolean) ?? "";
        console.error("[instagram] yt-dlp failed:", firstLine.slice(0, 200));
        const killed = error.killed || error.signal === "SIGTERM";
        reject(
          new ShareError(classifyError(String(stderr ?? ""), killed ? "ETIMEDOUT" : error.code)),
        );
      },
    );
  });
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

export interface DownloadedItem {
  path: string;
  name: string;
}

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

interface Found {
  index: number;
  name: string;
  ext: string;
}

function scanStage(stage: string): Found[] {
  const found: Found[] = [];
  for (const name of fs.readdirSync(stage)) {
    const match = MEDIA_RE.exec(name);
    if (match) found.push({ index: Number(match[1]), name, ext: match[2].toLowerCase() });
  }
  return found.sort((left, right) => left.index - right.index);
}

/** Item count yt-dlp reported for the post (carousel size), from the info files it wrote; 0 when unknown. */
function expectedCount(stage: string): number {
  let count = 0;
  for (const name of fs.readdirSync(stage)) {
    if (!name.endsWith(".info.json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(stage, name), "utf8"));
      count = Math.max(count, Number(info.playlist_count) || 0, Number(info.n_entries) || 0);
    } catch {}
  }
  return Math.min(count, MAX_ITEMS);
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

function readInfo(stage: string): any {
  const infoName = fs.existsSync(path.join(stage, "1.info.json"))
    ? "1.info.json"
    : fs.readdirSync(stage).find((name) => name.endsWith(".info.json"));
  try {
    if (infoName) return JSON.parse(fs.readFileSync(path.join(stage, infoName), "utf8"));
  } catch {}
  return {};
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

async function downloadNow(link: InstagramLink, signal?: AbortSignal): Promise<Downloaded> {
  const { DATA_DIR } = await import("./auth.ts");
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
