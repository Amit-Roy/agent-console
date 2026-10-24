import fs from "node:fs";
import path from "node:path";
import { type Provider, ShareError, type ShareItem, type ShareLink } from "./types.ts";
import { runYtDlp } from "./ytdlp.ts";

// YouTube share provider: anonymous yt-dlp (no shell, no cookies). Titles, descriptions and captions are untrusted data.

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PATH_RE = /^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/;
const MAX_VIDEO_SECONDS = 20 * 60;
const VIDEO_FORMAT = "bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/b[height<=480]";
const NOTE_HINT =
  "Video not attached (too long or unavailable); run `share-fetch <url>` or watch the URL directly.";
const BASE_ARGS = ["--ignore-config", "--no-cookies", "--no-progress", "--no-playlist"];

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

function canonical(id: string): ShareLink {
  return { provider: "youtube", id, url: `https://www.youtube.com/watch?v=${id}` };
}

function idFromYoutubeBe(parsed: URL): string | null {
  const id = parsed.pathname.slice(1).replace(/\/$/, "");
  return ID_RE.test(id) ? id : null;
}

function idFromYoutubeCom(parsed: URL): string | null {
  if (parsed.pathname === "/watch") {
    const id = parsed.searchParams.get("v") ?? "";
    return ID_RE.test(id) ? id : null;
  }
  return PATH_RE.exec(parsed.pathname)?.[2] ?? null;
}

function matchYoutube(parsed: URL): ShareLink | null {
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)
    return null;
  const host = parsed.hostname;
  let id: string | null = null;
  if (host === "youtu.be") id = idFromYoutubeBe(parsed);
  else if (HOSTS.has(host)) {
    id = idFromYoutubeCom(parsed);
    if (!id && parsed.pathname === "/playlist")
      throw new ShareError("Playlist links are not supported; share a single video.");
    if (!id && parsed.pathname === "/watch" && parsed.searchParams.has("list"))
      throw new ShareError("Playlist links are not supported; share a single video.");
  }
  return id ? canonical(id) : null;
}

function yamlText(value: unknown): string {
  return JSON.stringify(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500),
  );
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (num: number) => String(num).padStart(2, "0");
  return hours ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

function publishedDate(info: any): string {
  const raw = String(info?.upload_date ?? "");
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : "";
}

interface NoteInput {
  link: ShareLink;
  info: any;
  missing: number[];
  extraLines: string[];
}

function chapterLines(info: any): string[] {
  const chapters = Array.isArray(info?.chapters) ? info.chapters : [];
  if (!chapters.length) return [];
  const rows = chapters.map(
    (chapter: any) =>
      `- ${formatDuration(Number(chapter?.start_time) || 0)} ${String(chapter?.title ?? "").replace(/\s+/g, " ")}`,
  );
  return ["", "## Chapters", ...rows];
}

function noteText({ link, info, missing, extraLines }: NoteInput): string {
  const author = info?.channel ?? info?.uploader ?? info?.author_name ?? "";
  const front = [
    "---",
    "provider: youtube",
    `url: ${link.url}`,
    `title: ${yamlText(info?.title)}`,
    `author: ${yamlText(author)}`,
    `published: ${yamlText(publishedDate(info))}`,
    "kind: video",
    `missing: [${missing.join(", ")}]`,
    "---",
    "",
  ];
  const duration = Number(info?.duration);
  const facts = [
    ...(duration > 0 ? [`Duration: ${formatDuration(duration)}`] : []),
    ...(author ? [`Channel: ${String(author).replace(/\s+/g, " ")}`] : []),
  ];
  const body = [
    String(info?.description ?? "").slice(0, 5000),
    "",
    ...facts,
    ...chapterLines(info),
  ];
  return [...front, ...body, ...(extraLines.length ? ["", ...extraLines] : []), ""].join("\n");
}

function writeNote(stage: string, input: NoteInput): string {
  const notePath = path.join(stage, "post.md");
  fs.writeFileSync(notePath, noteText(input), { mode: 0o600 });
  return notePath;
}

async function loadInfo(link: ShareLink, stage: string, signal?: AbortSignal): Promise<any> {
  const args = [
    ...BASE_ARGS,
    "--js-runtimes",
    "node",
    "--skip-download",
    "--write-info-json",
    "-o",
    path.join(stage, "meta.%(ext)s"),
    "--",
    link.url,
  ];
  await runYtDlp(args, signal, "youtube");
  return JSON.parse(fs.readFileSync(path.join(stage, "meta.info.json"), "utf8"));
}

async function downloadVideo(link: ShareLink, stage: string, signal?: AbortSignal): Promise<void> {
  const args = [
    ...BASE_ARGS,
    "--js-runtimes",
    "node",
    "-f",
    VIDEO_FORMAT,
    "--merge-output-format",
    "mp4",
    "--max-filesize",
    "100M",
    "-o",
    path.join(stage, "video.%(ext)s"),
    "--",
    link.url,
  ];
  await runYtDlp(args, signal, "youtube");
  if (!fs.existsSync(path.join(stage, "video.mp4"))) throw new ShareError("No video produced.");
}

/** Best-effort captions; returns the item or null when no English track exists. */
async function downloadCaptions(
  link: ShareLink,
  stage: string,
  signal?: AbortSignal,
): Promise<ShareItem | null> {
  const args = [
    ...BASE_ARGS,
    "--js-runtimes",
    "node",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    "en.*,en",
    "--sub-format",
    "vtt",
    "--skip-download",
    "-o",
    path.join(stage, "sub"),
    "--",
    link.url,
  ];
  try {
    await runYtDlp(args, signal, "youtube");
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const found = fs
    .readdirSync(stage)
    .find((name) => name.startsWith("sub") && name.endsWith(".vtt"));
  if (!found) return null;
  const target = path.join(stage, "transcript.vtt");
  fs.renameSync(path.join(stage, found), target);
  return { path: target, name: "transcript.vtt" };
}

async function tryVideo(link: ShareLink, stage: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await downloadVideo(link, stage, signal);
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function oembedFallback(
  link: ShareLink,
  stage: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
) {
  let info: any;
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(link.url)}&format=json`;
    const response = await fetchImpl(endpoint, { signal });
    if (!response.ok) throw new Error(`oEmbed ${response.status}`);
    info = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ShareError(
      "YouTube blocked the download and no details were available. Try again later.",
    );
  }
  const notePath = writeNote(stage, { link, info, missing: [1], extraLines: [NOTE_HINT] });
  return { items: [], notePath, kind: "video" as const, missing: [1] };
}

export function createYoutubeProvider(fetchImpl: FetchLike = fetch): Provider {
  return {
    name: "youtube",
    match: matchYoutube,
    async fetch(link, stage, opts) {
      let info: any;
      try {
        info = await loadInfo(link, stage, opts.signal);
      } catch (error) {
        if (opts.signal?.aborted) throw error;
        return oembedFallback(link, stage, fetchImpl, opts.signal);
      }
      const short = Number(info?.duration) <= MAX_VIDEO_SECONDS;
      if (short && (await tryVideo(link, stage, opts.signal))) {
        const items = [{ path: path.join(stage, "video.mp4"), name: "video.mp4" }];
        const notePath = writeNote(stage, { link, info, missing: [], extraLines: [] });
        return { items, notePath, kind: "video" as const, missing: [] };
      }
      const caption = await downloadCaptions(link, stage, opts.signal);
      const notePath = writeNote(stage, { link, info, missing: [1], extraLines: [NOTE_HINT] });
      return { items: caption ? [caption] : [], notePath, kind: "video" as const, missing: [1] };
    },
  };
}

export const youtubeProvider: Provider = createYoutubeProvider();
