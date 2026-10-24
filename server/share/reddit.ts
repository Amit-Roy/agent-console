import fs from "node:fs";
import path from "node:path";
import { DOMParser, parseHTML } from "linkedom";
import { type FetchOptions, type Provider, ShareError, type ShareLink } from "./types.ts";
import { buildArgs, runYtDlp, scanStage } from "./ytdlp.ts";

// Share-to-console for Reddit posts. Anonymous only (no cookies): the post's .rss feed gives text and top comments,
// oEmbed is the fallback, i.redd.it images and v.redd.it video (yt-dlp) are the media. All remote text is untrusted data.

const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "m.reddit.com",
  "np.reddit.com",
]);
const SHORT_HOST = "redd.it";
const USER_AGENT = "agent-console/1.0 (personal share)";
const TEXT_TIMEOUT_MS = 15_000;
const TEXT_CAP_BYTES = 2 << 20;
const IMAGE_CAP_BYTES = 10 << 20;
const RETRY_DELAY_MS = 2000;
const CACHE_MS = 60_000;
const MAX_COMMENTS = 20;
const MAX_IMAGES = 10;
const MAX_REDIRECTS = 3;
const ID_RE = /^[a-z0-9]{2,12}$/i;
const SUB_RE = /^[A-Za-z0-9_]{2,40}$/;
const CODE_RE = /^[A-Za-z0-9]{4,24}$/;
const IMAGE_HOSTS = new Set(["i.redd.it", "preview.redd.it"]);
const VIDEO_HOST = "v.redd.it";

/** Injection points for tests. */
export const redditDeps = {
  fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
  retryDelayMs: RETRY_DELAY_MS,
  downloadVideo: downloadVideoDefault,
};

export interface RedditLink extends ShareLink {
  provider: "reddit";
  kind: "post" | "share";
}

function postLink(sub: string | null, id: string): RedditLink {
  const base = sub ? `r/${sub}/comments/${id}/` : `comments/${id}/`;
  return { provider: "reddit", kind: "post", id, url: `https://www.reddit.com/${base}` };
}

function matchRedditPath(segments: string[]): RedditLink | null {
  const [first, second, third, fourth] = segments;
  if (first === "comments" && ID_RE.test(second ?? "")) return postLink(null, second);
  if (first !== "r" || !SUB_RE.test(second ?? "")) return null;
  if (third === "comments" && ID_RE.test(fourth ?? "")) return postLink(second, fourth);
  if (third === "s" && CODE_RE.test(fourth ?? "")) {
    const url = `https://www.reddit.com/r/${second}/s/${fourth}`;
    return { provider: "reddit", kind: "share", id: fourth, url };
  }
  return null;
}

function matchReddit(parsed: URL): RedditLink | null {
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)
    return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname === SHORT_HOST)
    return segments.length === 1 && ID_RE.test(segments[0]) ? postLink(null, segments[0]) : null;
  return REDDIT_HOSTS.has(parsed.hostname) ? matchRedditPath(segments) : null;
}

/** Follows a /s/ share link by redirects only, staying on Reddit hosts, until it lands on a post. */
async function resolveShare(link: RedditLink, signal?: AbortSignal): Promise<RedditLink> {
  let current = link.url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await redditDeps.fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT },
        signal: withTimeout(signal),
      });
    } catch {
      throw new ShareError("Could not resolve that Reddit share link.");
    }
    const location = response.headers.get("location");
    if (!location) break;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      break;
    }
    const matched = matchReddit(next);
    if (matched?.kind === "post") return matched;
    if (!matched) break;
    current = next.toString();
  }
  throw new ShareError("Could not resolve that Reddit share link.");
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(TEXT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body as any) {
    total += chunk.length;
    if (total > cap) throw new ShareError("Reddit response was too large.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getText(url: string, signal?: AbortSignal): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await redditDeps.fetch(url, {
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      signal: withTimeout(signal),
    });
    if (response.status === 429 && attempt === 0) {
      await sleep(redditDeps.retryDelayMs);
      continue;
    }
    if (!response.ok) return null;
    return (await readCapped(response, TEXT_CAP_BYTES)).toString("utf8");
  }
  return null;
}

const feedCache = new Map<string, { text: string; at: number }>();

export function clearRedditCache(): void {
  feedCache.clear();
}

async function getFeed(link: RedditLink, signal?: AbortSignal): Promise<string | null> {
  const hit = feedCache.get(link.url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.text;
  let text: string | null = null;
  try {
    text = await getText(`${link.url}.rss`, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  if (text) feedCache.set(link.url, { text, at: Date.now() });
  return text;
}

export interface RedditEntry {
  author: string;
  published: string;
  title: string;
  text: string;
  images: string[];
  videos: string[];
  outbound: string;
}

function htmlToText(html: string): { text: string; document: any } {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const node of document.querySelectorAll("br")) node.replaceWith("\n");
  for (const node of document.querySelectorAll("p, li, div, blockquote, pre, h1, h2, h3"))
    node.append("\n");
  const text = String(document.body?.textContent ?? "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, document };
}

function httpsUrl(raw: string | null): URL | null {
  try {
    const parsed = new URL(raw ?? "");
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed : null;
  } catch {
    return null;
  }
}

function collectUrls(document: any): string[] {
  const urls: string[] = [];
  for (const node of document.querySelectorAll("a[href], img[src]"))
    urls.push(node.getAttribute("href") ?? node.getAttribute("src"));
  return urls;
}

function classifyUrls(urls: string[]): Pick<RedditEntry, "images" | "videos" | "outbound"> {
  const images = new Set<string>();
  const videos = new Set<string>();
  let outbound = "";
  for (const raw of urls) {
    const parsed = httpsUrl(raw);
    if (!parsed) continue;
    if (IMAGE_HOSTS.has(parsed.hostname)) images.add(parsed.toString());
    else if (parsed.hostname === VIDEO_HOST) videos.add(parsed.toString());
    else if (!outbound && !isRedditHost(parsed.hostname)) outbound = parsed.toString();
  }
  return { images: [...images].slice(0, MAX_IMAGES), videos: [...videos], outbound };
}

function isRedditHost(host: string): boolean {
  return (
    REDDIT_HOSTS.has(host) ||
    host === SHORT_HOST ||
    host.endsWith(".redd.it") ||
    host.endsWith(".redditmedia.com")
  );
}

function childText(entry: any, tag: string): string {
  return String(entry.querySelector(tag)?.textContent ?? "").trim();
}

function parseEntry(entry: any): RedditEntry {
  const { text, document } = htmlToText(childText(entry, "content"));
  const urls = collectUrls(document);
  return {
    author: childText(entry, "author > name"),
    published: childText(entry, "published") || childText(entry, "updated"),
    title: childText(entry, "title"),
    text,
    ...classifyUrls(urls),
  };
}

export function parseFeed(xml: string): RedditEntry[] {
  const doc: any = new DOMParser().parseFromString(xml, "text/xml");
  return [...doc.querySelectorAll("entry")].map(parseEntry);
}

function yamlValue(value: unknown): string {
  return JSON.stringify(value ?? "");
}

function frontMatter(
  link: RedditLink,
  post: Partial<RedditEntry>,
  kind: string,
  missing: number[],
): string {
  return [
    "---",
    "provider: reddit",
    `url: ${yamlValue(link.url)}`,
    `title: ${yamlValue(post.title)}`,
    `author: ${yamlValue(post.author)}`,
    `published: ${yamlValue(post.published)}`,
    `kind: ${kind}`,
    `missing: [${missing.join(", ")}]`,
    "---",
    "",
  ].join("\n");
}

function bodySections(post: RedditEntry | null, comments: RedditEntry[], notes: string[]): string {
  const parts: string[] = [];
  if (post?.text) parts.push(post.text);
  if (post?.outbound) parts.push(`Link: ${post.outbound}`);
  for (const note of notes) parts.push(`Note: ${note}`);
  if (comments.length) {
    parts.push("## Top comments");
    for (const comment of comments) parts.push(`**${comment.author}**: ${comment.text}`);
  }
  return `${parts.join("\n\n")}\n`;
}

async function downloadImage(url: string, dest: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await redditDeps.fetch(url, {
      headers: { "user-agent": USER_AGENT },
      redirect: "error",
      signal: withTimeout(signal),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.startsWith("image/")) return false;
    fs.writeFileSync(dest, await readCapped(response, IMAGE_CAP_BYTES), { mode: 0o600 });
    return true;
  } catch {
    if (signal?.aborted) throw new ShareError("Cancelled.");
    return false;
  }
}

function imageExt(url: string): string {
  const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  return /^(jpe?g|png|gif|webp)$/.test(ext) ? ext.replace("jpeg", "jpg") : "jpg";
}

async function downloadVideoDefault(
  url: string,
  stage: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const sub = fs.mkdtempSync(path.join(stage, "video-"));
  try {
    await runYtDlp(buildArgs(url, sub), signal, "reddit");
    const found = scanStage(sub).find((entry) => /^(mp4|webm|mkv|mov|m4v)$/.test(entry.ext));
    if (!found) return null;
    const dest = path.join(stage, "video.mp4");
    fs.renameSync(path.join(sub, found.name), dest);
    return dest;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally {
    fs.rmSync(sub, { recursive: true, force: true });
  }
}

interface MediaOutcome {
  items: { path: string; name: string }[];
  missing: number[];
}

async function fetchMedia(
  link: RedditLink,
  post: RedditEntry,
  stage: string,
  signal?: AbortSignal,
): Promise<MediaOutcome> {
  const items: MediaOutcome["items"] = [];
  const missing: number[] = [];
  let position = 0;
  for (const [offset, url] of post.images.entries()) {
    position++;
    const name = `image-${offset + 1}.${imageExt(url)}`;
    const dest = path.join(stage, name);
    if (await downloadImage(url, dest, signal)) items.push({ path: dest, name });
    else missing.push(position);
  }
  if (post.videos.length) {
    position++;
    const video = await redditDeps.downloadVideo(link.url, stage, signal);
    if (video) items.push({ path: video, name: "video.mp4" });
    else missing.push(position);
  }
  return { items, missing };
}

function mediaKind(items: MediaOutcome["items"]): "video" | "images" | "thread" {
  if (items.some((item) => item.name.startsWith("video"))) return "video";
  return items.length ? "images" : "thread";
}

async function fetchOembed(link: RedditLink, signal?: AbortSignal): Promise<Partial<RedditEntry>> {
  const endpoint = `https://www.reddit.com/oembed?url=${encodeURIComponent(link.url)}`;
  let body: string | null = null;
  try {
    body = await getText(endpoint, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  try {
    const data = JSON.parse(body ?? "");
    return { title: String(data.title ?? ""), author: String(data.author_name ?? "") };
  } catch {
    throw new ShareError("Could not fetch that Reddit post. Try again later.");
  }
}

async function fetchReddit(link: ShareLink, stage: string, opts: FetchOptions) {
  let target = link as RedditLink;
  if (target.kind === "share") target = await resolveShare(target, opts.signal);
  const xml = await getFeed(target, opts.signal);
  const entries = xml ? parseFeed(xml) : [];
  const post = entries[0] ?? null;
  const comments = entries.slice(1, 1 + MAX_COMMENTS);
  const notes: string[] = [];
  let head: Partial<RedditEntry> | null = post;
  if (!post) {
    head = await fetchOembed(target, opts.signal);
    notes.push("comments unavailable");
  }
  const media = post
    ? await fetchMedia(target, post, stage, opts.signal)
    : { items: [], missing: [] };
  const kind = mediaKind(media.items);
  const notePath = path.join(stage, "post.md");
  const content =
    frontMatter(target, head ?? {}, kind, media.missing) + bodySections(post, comments, notes);
  fs.writeFileSync(notePath, content, { mode: 0o600 });
  return { items: media.items, notePath, kind, missing: media.missing };
}

export const redditProvider: Provider = {
  name: "reddit",
  match: matchReddit,
  fetch: fetchReddit,
};
