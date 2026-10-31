import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { camofoxCall } from "./camofox.ts";
import { assertPublicHost, BlockedAddressError, safeFetch } from "./safe-fetch.ts";
import { type Provider, ShareError, type ShareItem, type ShareLink } from "./types.ts";
import { buildArgs, MAX_TOTAL_BYTES, runYtDlp, scanStage } from "./ytdlp.ts";

// Generic "any website" share: fetch the page through the SSRF guard, keep OG/meta fields and readable markdown
// (Defuddle), the og:image, and the video via yt-dlp when the page has one. Page content is untrusted data.

const PAGE_MAX_BYTES = 5 << 20;
const IMAGE_MAX_BYTES = 10 << 20;
const BODY_MAX_CHARS = 200_000;
const VIDEO_HOSTS = ["vimeo.com", "tiktok.com", "dailymotion.com", "twitch.tv", "streamable.com"];
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};
const CAMOFOX_USER = "agent-console-share";
/** Item numbers reported in `missing`. */
export const VIDEO_ITEM = 1;
export const IMAGE_ITEM = 2;

export interface PageMeta {
  title: string;
  description: string;
  image: string;
  video: string;
  author: string;
  published: string;
  siteName: string;
}

export interface ReadablePage {
  meta: PageMeta;
  markdown: string;
  url: string;
}

function matchGeneric(parsed: URL): ShareLink | null {
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return null;
  const linkId = createHash("sha256").update(parsed.href).digest("hex").slice(0, 16);
  return { provider: "generic", url: parsed.href, id: linkId };
}

function metaContent(document: any, keys: string[]): string {
  for (const key of keys) {
    const node =
      document.querySelector(`meta[property="${key}"]`) ??
      document.querySelector(`meta[name="${key}"]`) ??
      document.querySelector(`meta[itemprop="${key}"]`);
    const value = node?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return "";
}

function absoluteUrl(value: string, base: string): string {
  if (!value) return "";
  try {
    return new URL(value, base).href;
  } catch {
    return "";
  }
}

/** OG/meta fields from a parsed document; relative media URLs are resolved against the page URL. */
export function readMeta(document: any, pageUrl: string): PageMeta {
  const titleTag = document.querySelector("title")?.textContent?.trim() ?? "";
  return {
    title: metaContent(document, ["og:title", "twitter:title"]) || titleTag,
    description: metaContent(document, ["og:description", "description", "twitter:description"]),
    image: absoluteUrl(
      metaContent(document, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"]),
      pageUrl,
    ),
    video: absoluteUrl(
      metaContent(document, ["og:video", "og:video:url", "og:video:secure_url"]),
      pageUrl,
    ),
    author: metaContent(document, [
      "author",
      "article:author",
      "og:article:author",
      "twitter:creator",
    ]),
    published: metaContent(document, [
      "article:published_time",
      "og:article:published_time",
      "datePublished",
      "date",
    ]),
    siteName: metaContent(document, ["og:site_name", "application-name"]),
  };
}

/** Meta plus Defuddle markdown from an HTML string. */
export async function parsePage(html: string, pageUrl: string): Promise<ReadablePage> {
  const { document } = parseHTML(html);
  const meta = readMeta(document, pageUrl);
  let markdown = "";
  try {
    const result: any = await Defuddle(document as any, pageUrl, { markdown: true });
    markdown = String(result.contentMarkdown ?? result.content ?? "").trim();
    meta.title ||= String(result.title ?? "");
    meta.author ||= String(result.author ?? "");
    meta.published ||= String(result.published ?? "");
    meta.siteName ||= String(result.site ?? "");
  } catch (error) {
    console.error(
      "[generic] defuddle failed:",
      String((error as Error)?.message ?? error).slice(0, 200),
    );
  }
  return { meta, markdown, url: pageUrl };
}

function emptyMeta(): PageMeta {
  return {
    title: "",
    description: "",
    image: "",
    video: "",
    author: "",
    published: "",
    siteName: "",
  };
}

/** Renders the page in the local camofox browser and reads its Defuddle markdown. */
export async function camofoxMarkdown(url: string, signal?: AbortSignal): Promise<ReadablePage> {
  await assertPublicHost(url);
  const created = await camofoxCall(
    "/tabs",
    { method: "POST", body: JSON.stringify({ userId: CAMOFOX_USER, sessionKey: "share", url }) },
    signal,
  );
  const tabId = encodeURIComponent(String(created.tabId ?? ""));
  const query = `userId=${CAMOFOX_USER}`;
  try {
    const read = await camofoxCall(
      `/tabs/${tabId}/markdown?${query}&maxChars=${BODY_MAX_CHARS}`,
      {},
      signal,
    );
    const meta = emptyMeta();
    meta.title = String(read.title ?? "");
    meta.author = String(read.author ?? "");
    meta.published = String(read.published ?? "");
    meta.siteName = String(read.site ?? "");
    return { meta, markdown: String(read.content ?? "").trim(), url: String(read.url ?? url) };
  } finally {
    camofoxCall(`/tabs/${tabId}?${query}`, { method: "DELETE" }).catch(() => {});
  }
}

async function plainPage(url: string, signal?: AbortSignal): Promise<ReadablePage | null> {
  const response = await safeFetch(url, {
    signal,
    maxBytes: PAGE_MAX_BYTES,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  });
  if (response.status === 403) return null;
  if (response.status >= 400) throw new ShareError(`That page returned HTTP ${response.status}.`);
  const html = response.body.toString("utf8");
  if (!html.trim()) return null;
  return parsePage(html, response.url);
}

/** Plain guarded fetch first; camofox when the site refuses (403) or gives nothing readable. */
async function readPage(url: string, signal?: AbortSignal): Promise<ReadablePage> {
  let page: ReadablePage | null = null;
  try {
    page = await plainPage(url, signal);
  } catch (error) {
    if (error instanceof BlockedAddressError || signal?.aborted) throw error;
    if (!(error instanceof ShareError)) throw new ShareError("Could not load that page.");
    throw error;
  }
  if (page?.markdown) return page;
  try {
    const rendered = await camofoxMarkdown(url, signal);
    if (!rendered.markdown && !page) throw new ShareError("That page had no readable content.");
    if (!page) return rendered;
    return { ...page, markdown: rendered.markdown, meta: mergeMeta(page.meta, rendered.meta) };
  } catch (error) {
    if (error instanceof BlockedAddressError || signal?.aborted || !page) throw error;
    return page;
  }
}

function mergeMeta(primary: PageMeta, extra: PageMeta): PageMeta {
  const merged = { ...primary };
  for (const key of Object.keys(merged) as (keyof PageMeta)[]) merged[key] ||= extra[key];
  return merged;
}

export function isVideoHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return VIDEO_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

async function downloadImage(
  imageUrl: string,
  stageDir: string,
  signal?: AbortSignal,
): Promise<ShareItem> {
  const response = await safeFetch(imageUrl, {
    signal,
    maxBytes: IMAGE_MAX_BYTES,
    accept: "image/*",
  });
  const type = response.contentType.split(";")[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (response.status >= 400 || !ext || !response.body.length)
    throw new ShareError("That page image could not be downloaded.");
  const name = `image.${ext}`;
  const filePath = path.join(stageDir, name);
  fs.writeFileSync(filePath, response.body, { mode: 0o600 });
  return { path: filePath, name };
}

async function downloadVideo(
  videoUrl: string,
  stageDir: string,
  signal?: AbortSignal,
): Promise<ShareItem> {
  await assertPublicHost(videoUrl);
  const videoDir = fs.mkdtempSync(path.join(stageDir, "video-"));
  try {
    await runYtDlp(buildArgs(videoUrl, videoDir, [1]), signal, "generic");
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const found = scanStage(videoDir).find((entry) => /^(mp4|webm|mkv|mov|m4v)$/.test(entry.ext));
  if (!found) throw new ShareError("That page video could not be downloaded.");
  const source = path.join(videoDir, found.name);
  if (fs.statSync(source).size > MAX_TOTAL_BYTES)
    throw new ShareError("That video is too large (over 100 MB).");
  const name = `video.${found.ext}`;
  const filePath = path.join(stageDir, name);
  fs.renameSync(source, filePath);
  fs.rmSync(videoDir, { recursive: true, force: true });
  return { path: filePath, name };
}

/** Runs one optional download; failures (other than abort) become a missing item number. */
async function optional(
  task: () => Promise<ShareItem>,
  itemNumber: number,
  out: { items: ShareItem[]; missing: number[] },
  signal?: AbortSignal,
): Promise<void> {
  try {
    out.items.push(await task());
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error(
      `[generic] item ${itemNumber} failed:`,
      String((error as Error)?.message ?? error).slice(0, 200),
    );
    out.missing.push(itemNumber);
  }
}

function yamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return JSON.stringify(String(value ?? ""));
}

/** post.md: YAML front matter, then the readable markdown body capped at about 200 KB. */
export function buildNote(
  page: ReadablePage,
  link: ShareLink,
  kind: string,
  missing: number[],
): string {
  const fields: [string, unknown][] = [
    ["provider", "generic"],
    ["url", link.url],
    ["final_url", page.url],
    ["title", page.meta.title],
    ["author", page.meta.author],
    ["published", page.meta.published],
    ["site_name", page.meta.siteName],
    ["description", page.meta.description],
    ["kind", kind],
    ["missing", missing],
  ];
  const header = fields.map(([key, value]) => `${key}: ${yamlValue(value)}`).join("\n");
  let body = page.markdown;
  if (body.length > BODY_MAX_CHARS) body = `${body.slice(0, BODY_MAX_CHARS)}\n\n[truncated]`;
  return `---\n${header}\n---\n\n${body}\n`;
}

function videoTarget(page: ReadablePage, link: ShareLink): string {
  const pageHost = new URL(page.url).hostname;
  if (isVideoHost(pageHost) || isVideoHost(new URL(link.url).hostname)) return page.url;
  return page.meta.video;
}

export const genericProvider: Provider = {
  name: "generic",
  match: matchGeneric,
  async fetch(link, stageDir, opts) {
    const signal = opts.signal;
    const page = await readPage(link.url, signal);
    const out = { items: [] as ShareItem[], missing: [] as number[] };
    const video = videoTarget(page, link);
    if (video)
      await optional(() => downloadVideo(video, stageDir, signal), VIDEO_ITEM, out, signal);
    if (page.meta.image)
      await optional(
        () => downloadImage(page.meta.image, stageDir, signal),
        IMAGE_ITEM,
        out,
        signal,
      );
    const kind = out.items.some((item) => item.name.startsWith("video.")) ? "video" : "article";
    const notePath = path.join(stageDir, "post.md");
    fs.writeFileSync(notePath, buildNote(page, link, kind, out.missing), { mode: 0o600 });
    return { items: out.items, notePath, kind, missing: out.missing };
  },
};
