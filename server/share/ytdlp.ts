import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ShareError } from "./types.ts";

// Anonymous yt-dlp runner shared by providers (no shell, no cookies). Output and metadata are untrusted data.

const DEFAULT_YTDLP = "/home/coder/.local/bin/yt-dlp";
export const BLOCKED_MESSAGE =
  "Instagram blocked anonymous download. Cookie fallback is not set up yet.";
const TIMEOUT_MS = 120_000;
export const MAX_ITEMS = 10;
export const MAX_TOTAL_BYTES = 100 << 20;
const MEDIA_RE = /^(\d+)\.(mp4|webm|mkv|mov|m4v|jpe?g|png|webp)$/i;

export function buildArgs(
  url: string,
  outDir: string,
  items?: number[],
  extraArgs: string[] = [],
): string[] {
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
    ...extraArgs,
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

export function runYtDlp(args: string[], signal?: AbortSignal, label = "instagram"): Promise<void> {
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
        console.error(`[${label}] yt-dlp failed:`, firstLine.slice(0, 200));
        const killed = error.killed || error.signal === "SIGTERM";
        reject(
          new ShareError(classifyError(String(stderr ?? ""), killed ? "ETIMEDOUT" : error.code)),
        );
      },
    );
  });
}

export interface Found {
  index: number;
  name: string;
  ext: string;
}

export function scanStage(stage: string): Found[] {
  const found: Found[] = [];
  for (const name of fs.readdirSync(stage)) {
    const match = MEDIA_RE.exec(name);
    if (match) found.push({ index: Number(match[1]), name, ext: match[2].toLowerCase() });
  }
  return found.sort((left, right) => left.index - right.index);
}

/** Item count yt-dlp reported for the post (carousel size), from the info files it wrote; 0 when unknown. */
export function expectedCount(stage: string): number {
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

export function readInfo(stage: string): any {
  const infoName = fs.existsSync(path.join(stage, "1.info.json"))
    ? "1.info.json"
    : fs.readdirSync(stage).find((name) => name.endsWith(".info.json"));
  try {
    if (infoName) return JSON.parse(fs.readFileSync(path.join(stage, infoName), "utf8"));
  } catch {}
  return {};
}
