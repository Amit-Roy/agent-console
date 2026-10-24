import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ShareError } from "./types.ts";
import { BLOCKED_MESSAGE, MAX_ITEMS } from "./ytdlp.ts";

// gallery-dl runner for Instagram image posts that yt-dlp cannot fetch. It always runs with the user's cookie file
// (no shell). Output and metadata are untrusted data, and cookie values must never reach logs or messages.

const DEFAULT_GALLERYDL = "/home/coder/.local/bin/gallery-dl";
const TIMEOUT_MS = 120_000;
const RAW_META_RE = /^(\d+)\.(?!info\.)[A-Za-z0-9]+\.json$/;
export const COOKIES_EXPIRED_MESSAGE =
  "Instagram cookies expired or were rejected. Refresh instagram-cookies.txt.";
const FAILED_TEXT = "Instagram download failed.";

/** `range` is the item indices wanted; empty means the first MAX_ITEMS. */
export function galleryArgs(
  url: string,
  stage: string,
  cookies: string,
  range: number[] = [],
): string[] {
  return [
    "--config-ignore",
    "-q",
    "--no-part",
    "--no-mtime",
    "--http-timeout",
    "30",
    "--filesize-max",
    "100M",
    "--write-metadata",
    "-C",
    cookies,
    "-D",
    stage,
    "-f",
    "{num}.{extension}",
    "--range",
    range.length ? range.join(",") : `1-${MAX_ITEMS}`,
    "--",
    url,
  ];
}

export function classifyGalleryError(stderr: string): string {
  const text = String(stderr ?? "");
  if (/redirect to login|challenge|\b401\b|AuthRequired/i.test(text))
    return COOKIES_EXPIRED_MESSAGE;
  if (/\b429\b|rate.?limit/i.test(text)) return BLOCKED_MESSAGE;
  return FAILED_TEXT;
}

function redact(line: string): string {
  return line.replace(/(sessionid|csrftoken)=[^\s;'"]*/gi, "$1=[redacted]").slice(0, 200);
}

/** Resolves true when gallery-dl ran and exited cleanly, false when the binary is missing; rejects with a ShareError otherwise. */
export function runGalleryDl(
  args: string[],
  signal?: AbortSignal,
  label = "instagram",
): Promise<boolean> {
  const binary = process.env.AGENT_CONSOLE_GALLERYDL || DEFAULT_GALLERYDL;
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 20, signal, env: { ...process.env, NO_COLOR: "1" } },
      (error: (NodeJS.ErrnoException & { killed?: boolean }) | null, _stdout, stderr) => {
        if (!error) return resolve(true);
        if (error.code === "ENOENT") return resolve(false);
        const firstLine =
          String(stderr ?? "")
            .split("\n")
            .find(Boolean) ?? "";
        console.error(`[${label}] gallery-dl failed:`, redact(firstLine));
        reject(new ShareError(classifyGalleryError(String(stderr ?? ""))));
      },
    );
  });
}

/** Turns gallery-dl's per-file `N.<ext>.json` into one `gallery.info.json` shaped like yt-dlp's info, then removes the raw files. */
export function normalizeMeta(stage: string): void {
  const raws = fs
    .readdirSync(stage)
    .flatMap((name) => {
      const match = RAW_META_RE.exec(name);
      return match ? [{ name, index: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.index - right.index);
  if (raws.length) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stage, raws[0].name), "utf8"));
      const date = String(raw.post_date ?? "")
        .slice(0, 10)
        .replace(/-/g, "");
      const info = {
        description: raw.description,
        uploader: raw.username,
        upload_date: date,
        // Instagram's own count can include items it no longer serves; trust what gallery-dl listed
        playlist_count: raws[raws.length - 1].index,
      };
      fs.writeFileSync(path.join(stage, "gallery.info.json"), JSON.stringify(info), {
        mode: 0o600,
      });
    } catch {}
  }
  for (const entry of raws) fs.rmSync(path.join(stage, entry.name), { force: true });
}
