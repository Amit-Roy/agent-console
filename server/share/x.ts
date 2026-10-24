import fs from "node:fs";
import path from "node:path";
import { type FetchOptions, type Provider, ShareError, type ShareLink } from "./types.ts";
import { buildArgs, runYtDlp, scanStage } from "./ytdlp.ts";

// Share-to-console for X/Twitter posts: anonymous syndication JSON (vxtwitter fallback) for text and media URLs,
// yt-dlp for video. All remote content is untrusted data; media hosts are checked strictly.

const HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "mobile.x.com",
]);
const PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/|$)/;
const JSON_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 60_000;
const JSON_CAP = 2 << 20;
const IMAGE_CAP = 10 << 20;
const VIDEO_CAP = 100 << 20;
const MAX_MEDIA = 10;
export const UNAVAILABLE = "That post is unavailable or private.";
const LOAD_FAILED = "Could not load that post. Try again later.";

export interface XLink extends ShareLink {
  provider: "x";
  handle: string;
}

export interface Variant {
  url: string;
  bitrate: number;
}

export interface Media {
  type: "photo" | "video";
  url: string;
  variants: Variant[];
}

export interface Tweet {
  id: string;
  name: string;
  handle: string;
  created: string;
  text: string;
  media: Media[];
  quoted?: { name: string; handle: string; text: string };
  likes?: number;
  replies?: number;
}

export interface XDeps {
  fetchFn: typeof fetch;
  ytdlp: (args: string[], signal?: AbortSignal) => Promise<void>;
}

export function matchX(parsed: URL): XLink | null {
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)
    return null;
  if (!HOSTS.has(parsed.hostname)) return null;
  const match = PATH_RE.exec(parsed.pathname);
  if (!match || match[1].toLowerCase() === "i") return null;
  return {
    provider: "x",
    handle: match[1],
    id: match[2],
    url: `https://x.com/${match[1]}/status/${match[2]}`,
  };
}

// ---- normalising the two JSON shapes

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function expandText(text: string, entities: any): string {
  let out = text;
  for (const entry of entities?.urls ?? []) {
    if (typeof entry?.url === "string" && typeof entry?.expanded_url === "string")
      out = out.split(entry.url).join(entry.expanded_url);
  }
  for (const entry of entities?.media ?? []) {
    if (typeof entry?.url === "string") out = out.split(entry.url).join("");
  }
  return out.trim();
}

function synVariants(detail: any): Variant[] {
  const list: any[] = detail?.video_info?.variants ?? [];
  return list
    .filter((entry) => entry?.content_type === "video/mp4" && typeof entry?.url === "string")
    .map((entry) => ({ url: entry.url, bitrate: Number(entry.bitrate) || 0 }));
}

function synMedia(raw: any): Media[] {
  const details: any[] = Array.isArray(raw.mediaDetails) ? raw.mediaDetails : [];
  if (!details.length)
    return (raw.photos ?? []).map((photo: any) => ({
      type: "photo" as const,
      url: asText(photo?.url),
      variants: [],
    }));
  return details.map((detail) =>
    detail?.type === "photo"
      ? { type: "photo" as const, url: asText(detail.media_url_https), variants: [] }
      : {
          type: "video" as const,
          url: asText(detail?.media_url_https),
          variants: synVariants(detail),
        },
  );
}

export function fromSyndication(raw: any, id: string): Tweet | null {
  if (!raw || raw.__typename === "TweetTombstone" || !raw.text || !raw.user) return null;
  const quoted = raw.quoted_tweet;
  return {
    id: asText(raw.id_str) || id,
    name: asText(raw.user.name),
    handle: asText(raw.user.screen_name),
    created: asText(raw.created_at),
    text: expandText(raw.text, raw.entities),
    media: synMedia(raw).slice(0, MAX_MEDIA),
    quoted: quoted?.text
      ? {
          name: asText(quoted.user?.name),
          handle: asText(quoted.user?.screen_name),
          text: expandText(asText(quoted.text), quoted.entities),
        }
      : undefined,
    likes: asCount(raw.favorite_count),
    replies: asCount(raw.conversation_count),
  };
}

function vxMedia(raw: any): Media[] {
  return (raw.media_extended ?? []).map((entry: any) =>
    entry?.type === "image"
      ? { type: "photo" as const, url: asText(entry.url), variants: [] }
      : {
          type: "video" as const,
          url: asText(entry?.thumbnail_url),
          variants: [{ url: asText(entry?.url), bitrate: 0 }],
        },
  );
}

export function fromVxTwitter(raw: any, id: string): Tweet | null {
  if (!raw || typeof raw.text !== "string" || !raw.user_screen_name) return null;
  const quoted = raw.qrt;
  return {
    id: asText(raw.tweetID) || id,
    name: asText(raw.user_name),
    handle: asText(raw.user_screen_name),
    created:
      typeof raw.date_epoch === "number"
        ? new Date(raw.date_epoch * 1000).toISOString()
        : asText(raw.date),
    text: raw.text.trim(),
    media: vxMedia(raw).slice(0, MAX_MEDIA),
    quoted: quoted?.text
      ? {
          name: asText(quoted.user_name),
          handle: asText(quoted.user_screen_name),
          text: asText(quoted.text),
        }
      : undefined,
    likes: asCount(raw.likes),
    replies: asCount(raw.replies),
  };
}

// ---- bounded network access

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > cap) return null;
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as any) {
    total += chunk.length;
    if (total > cap) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

type JsonResult = { json: any } | { gone: true } | { failed: true };

async function getJson(
  deps: XDeps,
  url: string,
  signal: AbortSignal | undefined,
): Promise<JsonResult> {
  try {
    const res = await deps.fetchFn(url, {
      signal: withTimeout(signal, JSON_TIMEOUT_MS),
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (res.status === 404 || res.status === 403) return { gone: true };
    if (!res.ok) return { failed: true };
    const body = await readCapped(res, JSON_CAP);
    if (!body) return { failed: true };
    if (!body.length) return { gone: true };
    return { json: JSON.parse(body.toString("utf8")) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { failed: true };
  }
}

export async function loadTweet(
  deps: XDeps,
  link: ShareLink,
  signal: AbortSignal | undefined,
): Promise<Tweet> {
  const sources: [string, (raw: any, id: string) => Tweet | null][] = [
    [`https://cdn.syndication.twimg.com/tweet-result?id=${link.id}&token=a`, fromSyndication],
    [`https://api.vxtwitter.com/x/status/${link.id}`, fromVxTwitter],
  ];
  let gone = false;
  for (const [url, parse] of sources) {
    const result = await getJson(deps, url, signal);
    const tweet = "json" in result ? parse(result.json, link.id) : null;
    if (tweet) return tweet;
    if ("gone" in result || "json" in result) gone = true;
  }
  throw new ShareError(gone ? UNAVAILABLE : LOAD_FAILED);
}

// ---- media

function trustedUrl(raw: string, host: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname !== host) return null;
    if (parsed.port || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function imageExt(parsed: URL): string {
  const fromFormat = parsed.searchParams.get("format");
  const fromPath = /\.([A-Za-z0-9]{3,4})$/.exec(parsed.pathname)?.[1];
  const ext = (fromFormat ?? fromPath ?? "jpg").toLowerCase();
  if (ext === "jpeg") return "jpg";
  return ["jpg", "png", "webp"].includes(ext) ? ext : "jpg";
}

async function downloadImage(
  deps: XDeps,
  raw: string,
  dest: (ext: string) => string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const parsed = trustedUrl(raw, "pbs.twimg.com");
  if (!parsed) return null;
  const ext = imageExt(parsed);
  for (const size of ["orig", "large"]) {
    parsed.search = "";
    parsed.searchParams.set("name", size);
    const body = await fetchBytes(deps, parsed.href, IMAGE_CAP, signal);
    if (!body) continue;
    const file = dest(ext);
    fs.writeFileSync(file, body, { mode: 0o600 });
    return file;
  }
  return null;
}

async function fetchBytes(
  deps: XDeps,
  url: string,
  cap: number,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  try {
    const res = await deps.fetchFn(url, {
      signal: withTimeout(signal, MEDIA_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) return null;
    const body = await readCapped(res, cap);
    return body?.length ? body : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function downloadDirect(
  deps: XDeps,
  variants: Variant[],
  file: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const ranked = [...variants].sort((left, right) => right.bitrate - left.bitrate);
  for (const variant of ranked) {
    const parsed = trustedUrl(variant.url, "video.twimg.com");
    if (!parsed || !parsed.pathname.endsWith(".mp4")) continue;
    const body = await fetchBytes(deps, parsed.href, VIDEO_CAP, signal);
    if (!body) continue;
    fs.writeFileSync(file, body, { mode: 0o600 });
    return true;
  }
  return false;
}

async function tryYtDlp(
  deps: XDeps,
  url: string,
  stage: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await deps.ytdlp(buildArgs(url, stage), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
}

/** Fetches every video; yt-dlp first, then direct mp4 variants. Returns 1-based media indexes that failed. */
async function fetchVideos(
  deps: XDeps,
  link: ShareLink,
  videos: [number, Media][],
  stage: string,
  signal: AbortSignal | undefined,
  items: { path: string; name: string }[],
): Promise<number[]> {
  const ytDir = fs.mkdtempSync(path.join(stage, "yt-"));
  await tryYtDlp(deps, link.url, ytDir, signal);
  const got = scanStage(ytDir).filter((entry) => /^(mp4|webm|mkv|mov|m4v)$/.test(entry.ext));
  const missing: number[] = [];
  for (const [offset, [mediaIndex, media]] of videos.entries()) {
    const base = videos.length > 1 ? `video-${offset + 1}` : "video";
    const found = got[offset];
    if (found) {
      const target = path.join(stage, `${base}.mp4`);
      fs.renameSync(path.join(ytDir, found.name), target);
      items.push({ path: target, name: `${base}.mp4` });
      continue;
    }
    const target = path.join(stage, `${base}.mp4`);
    if (await downloadDirect(deps, media.variants, target, signal))
      items.push({ path: target, name: `${base}.mp4` });
    else missing.push(mediaIndex);
  }
  fs.rmSync(ytDir, { recursive: true, force: true });
  return missing;
}

async function fetchPhotos(
  deps: XDeps,
  photos: [number, Media][],
  stage: string,
  signal: AbortSignal | undefined,
  items: { path: string; name: string }[],
): Promise<number[]> {
  const missing: number[] = [];
  for (const [offset, [mediaIndex, media]] of photos.entries()) {
    const base = `image-${offset + 1}`;
    const file = await downloadImage(
      deps,
      media.url,
      (ext) => path.join(stage, `${base}.${ext}`),
      signal,
    );
    if (file) items.push({ path: file, name: path.basename(file) });
    else missing.push(mediaIndex);
  }
  return missing;
}

// ---- post.md

const yamlText = (value: string): string => JSON.stringify(value.replace(/\s+/g, " ").trim());

function countLine(tweet: Tweet): string {
  const parts: string[] = [];
  if (tweet.likes !== undefined) parts.push(`${tweet.likes} likes`);
  if (tweet.replies !== undefined) parts.push(`${tweet.replies} replies`);
  return parts.join(", ");
}

export function renderPost(tweet: Tweet, link: ShareLink, kind: string, missing: number[]): string {
  const title = tweet.text.replace(/\s+/g, " ").slice(0, 80);
  const head = [
    "---",
    "provider: x",
    `url: ${yamlText(link.url)}`,
    `title: ${yamlText(title)}`,
    `author: ${yamlText(`${tweet.name} (@${tweet.handle})`)}`,
    `published: ${yamlText(tweet.created)}`,
    `kind: ${kind}`,
    `missing: [${missing.join(", ")}]`,
    "---",
    "",
  ];
  const body = [`**${tweet.name}** (@${tweet.handle})`, tweet.created, "", tweet.text];
  if (tweet.quoted) {
    const quote = tweet.quoted;
    body.push("", `> Quoted ${quote.name} (@${quote.handle}):`);
    for (const line of quote.text.split("\n")) body.push(`> ${line}`);
  }
  const counts = countLine(tweet);
  if (counts) body.push("", counts);
  return `${[...head, ...body].join("\n")}\n`;
}

export function createXProvider(deps: XDeps): Provider {
  return {
    name: "x",
    match: matchX,
    async fetch(link: ShareLink, stageDir: string, opts: FetchOptions) {
      const tweet = await loadTweet(deps, link, opts.signal);
      const indexed = tweet.media.map((media, index): [number, Media] => [index + 1, media]);
      const items: { path: string; name: string }[] = [];
      const missing = await fetchPhotos(
        deps,
        indexed.filter(([, media]) => media.type === "photo"),
        stageDir,
        opts.signal,
        items,
      );
      const videos = indexed.filter(([, media]) => media.type === "video");
      if (videos.length)
        missing.push(...(await fetchVideos(deps, link, videos, stageDir, opts.signal, items)));
      missing.sort((left, right) => left - right);
      const kind = videos.length ? "video" : indexed.length ? "images" : "thread";
      const notePath = path.join(stageDir, "post.md");
      fs.writeFileSync(notePath, renderPost(tweet, link, kind, missing), { mode: 0o600 });
      return { items, notePath, kind, missing };
    },
  };
}

export const xProvider: Provider = createXProvider({
  fetchFn: (input, init) => fetch(input, init),
  ytdlp: (args, signal) => runYtDlp(args, signal, "x"),
});
