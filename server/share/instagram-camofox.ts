import fs from "node:fs";
import path from "node:path";
import { CamofoxUnavailableError, camofoxCall } from "./camofox.ts";
import { assertPublicHost, safeFetch } from "./safe-fetch.ts";
import type { ShareLink } from "./types.ts";
import { MAX_ITEMS, MAX_TOTAL_BYTES, scanStage } from "./ytdlp.ts";

// Logged-out fallback for Instagram posts: render the public page in camofox, read the media URLs from its embedded
// JSON, then download them from the Instagram CDN ourselves. No cookies. Page content and URLs are untrusted data.

const USER = "agent-console-share";
const TAB_TIMEOUT_MS = 60_000;
const EVALUATE_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;
const IMAGE_MAX_BYTES = 15 << 20;
const VIDEO_MAX_BYTES = 60 << 20;
const URL_MAX = 2048;
const CAPTION_MAX = 4000;
const CDN_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];

export interface PickedItem {
  image: string;
  video: string;
}

export interface PickedMedia {
  items: PickedItem[];
  caption: string;
  username: string;
  takenAt: number;
}

export interface MediaResponse {
  url: string;
  status: number;
  body: Buffer;
}

export interface CamofoxDeps {
  call: typeof camofoxCall;
  fetchMedia: (
    url: string,
    opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal },
  ) => Promise<MediaResponse>;
}

export const defaultCamofoxDeps: CamofoxDeps = {
  call: camofoxCall,
  fetchMedia: (url, opts) => safeFetch(url, opts),
};

// pickMedia and its helpers run inside the page via camofox evaluate: they are stringified (see PAGE_FUNCTIONS), so they
// must stay plain JS after type stripping, call only each other, and touch nothing else in module scope.

function carouselSize(node: any): number {
  return Array.isArray(node.carousel_media) ? node.carousel_media.length : 0;
}

function isMediaNode(value: any): boolean {
  return Boolean(
    Array.isArray(value.carousel_media) || value.image_versions2 || value.video_versions,
  );
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectNodes(texts: string[]): any[] {
  const nodes: any[] = [];
  const walk = (value: any, depth: number) => {
    if (!value || typeof value !== "object" || depth > 40 || nodes.length > 5000) return;
    if (!Array.isArray(value) && isMediaNode(value)) nodes.push(value);
    for (const key of Object.keys(value)) walk(value[key], depth + 1);
  };
  for (const text of texts) walk(parseJson(text), 0);
  return nodes;
}

function largestCarousel(list: any[]): any {
  return list.reduce((top, node) => (carouselSize(node) > carouselSize(top) ? node : top), list[0]);
}

/** Node whose `code` matches (preferring its carousel), else the largest carousel on the page, else null. */
function chooseNode(nodes: any[], code: string): any {
  const matching = nodes.filter((node) => node.code === code);
  const matchedCarousels = matching.filter((node) => carouselSize(node) > 0);
  if (matchedCarousels.length) return largestCarousel(matchedCarousels);
  if (matching.length) return matching[0];
  const carousels = nodes.filter((node) => carouselSize(node) > 0);
  return carousels.length ? largestCarousel(carousels) : null;
}

/** Widest image candidate url; the first candidate when no candidate has a width. */
function widestImage(media: any): string {
  const list = media?.image_versions2?.candidates;
  if (!Array.isArray(list) || !list.length) return "";
  const wider = (left: any, right: any) =>
    Number(right?.width) > Number(left?.width) ? right : left;
  return String(list.reduce(wider)?.url ?? "");
}

export function pickMedia(texts: string[], code: string): PickedMedia | null {
  const chosen = chooseNode(collectNodes(texts), code);
  if (!chosen) return null;
  const slides = carouselSize(chosen) > 0 ? chosen.carousel_media : [chosen];
  return {
    items: slides.map((slide: any) => ({
      image: widestImage(slide),
      video: String(slide?.video_versions?.[0]?.url ?? ""),
    })),
    caption: String(chosen.caption?.text ?? ""),
    username: String(chosen.user?.username ?? ""),
    takenAt: Number(chosen.taken_at) || 0,
  };
}

const PAGE_FUNCTIONS = [
  carouselSize,
  isMediaNode,
  parseJson,
  collectNodes,
  largestCarousel,
  chooseNode,
  widestImage,
  pickMedia,
];

export function pageExpression(code: string): string {
  const source = PAGE_FUNCTIONS.map((pageFunction) => pageFunction.toString()).join("\n");
  const texts = `[...document.querySelectorAll('script[type="application/json"]')].map(s=>s.textContent)`;
  return `(()=>{${source}\nreturn pickMedia(${texts}, ${JSON.stringify(code)});})()`;
}

/** https, no userinfo, no port, host exactly under an Instagram CDN domain. */
export function isCdnUrl(raw: string): boolean {
  if (raw.length > URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)
    return false;
  return CDN_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
}

/** Image/video type from magic bytes, or null. */
export function sniffMedia(body: Buffer): "jpg" | "png" | "webp" | "mp4" | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "jpg";
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (
    body.length >= 12 &&
    body.toString("latin1", 0, 4) === "RIFF" &&
    body.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
  if (body.length >= 12 && body.toString("latin1", 4, 8) === "ftyp") return "mp4";
  return null;
}

function stageBytes(stage: string): number {
  return scanStage(stage).reduce(
    (sum, entry) => sum + fs.statSync(path.join(stage, entry.name)).size,
    0,
  );
}

async function evaluatePage(
  deps: CamofoxDeps,
  tabId: string,
  code: string,
  signal?: AbortSignal,
): Promise<PickedMedia | null> {
  const expression = pageExpression(code);
  const run = async () => {
    const answer = await deps.call(
      `/tabs/${tabId}/evaluate`,
      { method: "POST", body: JSON.stringify({ userId: USER, expression }) },
      signal,
      EVALUATE_TIMEOUT_MS,
    );
    const picked = answer?.result as PickedMedia | null;
    return picked?.items?.length ? picked : null;
  };
  const first = await run();
  if (first) return first;
  await deps.call(
    `/tabs/${tabId}/wait`,
    { method: "POST", body: JSON.stringify({ userId: USER, timeout: WAIT_TIMEOUT_MS }) },
    signal,
    WAIT_TIMEOUT_MS + 5000,
  );
  return run();
}

async function openAndPick(
  deps: CamofoxDeps,
  link: ShareLink & { code?: string },
  signal?: AbortSignal,
): Promise<PickedMedia | null> {
  const created = await deps.call(
    "/tabs",
    {
      method: "POST",
      body: JSON.stringify({ userId: USER, sessionKey: "instagram", url: link.url }),
    },
    signal,
    TAB_TIMEOUT_MS,
  );
  const tabId = encodeURIComponent(String(created?.tabId ?? ""));
  try {
    return await evaluatePage(deps, tabId, link.code ?? link.id, signal);
  } finally {
    await deps
      .call(`/tabs/${tabId}?userId=${USER}`, { method: "DELETE" }, undefined, 10_000)
      .catch(() => {});
  }
}

async function downloadMedia(
  deps: CamofoxDeps,
  url: string,
  isVideo: boolean,
  remaining: number,
  signal?: AbortSignal,
): Promise<{ body: Buffer; ext: string } | null> {
  if (!isCdnUrl(url) || remaining <= 0) return null;
  const maxBytes = Math.min(isVideo ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES, remaining);
  const response = await deps.fetchMedia(url, { maxBytes, timeoutMs: FETCH_TIMEOUT_MS, signal });
  if (response.status !== 200 || !isCdnUrl(response.url)) return null;
  const ext = sniffMedia(response.body);
  if (!ext || (isVideo && ext !== "mp4") || (!isVideo && ext === "mp4")) return null;
  return { body: response.body, ext };
}

function writeInfo(stage: string, picked: PickedMedia, count: number): void {
  const file = path.join(stage, "1.info.json");
  if (fs.existsSync(file)) return;
  const date = picked.takenAt
    ? new Date(picked.takenAt * 1000).toISOString().slice(0, 10).replaceAll("-", "")
    : "";
  const info = {
    description: picked.caption.slice(0, CAPTION_MAX),
    uploader: picked.username,
    upload_date: date,
    playlist_count: Math.min(picked.items.length, MAX_ITEMS),
  };
  fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
}

async function saveItems(
  deps: CamofoxDeps,
  stage: string,
  picked: PickedMedia,
  wanted: number[],
  signal?: AbortSignal,
): Promise<number> {
  let remaining = MAX_TOTAL_BYTES - stageBytes(stage);
  let saved = 0;
  const slides = picked.items.slice(0, MAX_ITEMS);
  const targets = wanted.length ? wanted : slides.map((_slide, offset) => offset + 1);
  for (const index of targets) {
    const slide = slides[index - 1];
    if (!slide) continue;
    const isVideo = Boolean(slide.video);
    let got: Awaited<ReturnType<typeof downloadMedia>> = null;
    try {
      got = await downloadMedia(
        deps,
        isVideo ? slide.video : slide.image,
        isVideo,
        remaining,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (!got) continue;
    fs.writeFileSync(path.join(stage, `${index}.${got.ext}`), got.body, { mode: 0o600 });
    remaining -= got.body.length;
    saved++;
  }
  return saved;
}

/**
 * Fills `wanted` item numbers from the logged-out Instagram page. Any camofox trouble is a quiet skip (one console
 * line); never throws except on abort or a blocked/private post URL.
 */
export async function runCamofoxFallback(
  link: ShareLink,
  stage: string,
  opts: { signal?: AbortSignal },
  wanted: number[],
  deps: CamofoxDeps = defaultCamofoxDeps,
): Promise<void> {
  await assertPublicHost(link.url);
  try {
    const picked = await openAndPick(deps, link, opts.signal);
    if (!picked) return;
    const saved = await saveItems(deps, stage, picked, wanted, opts.signal);
    if (saved) writeInfo(stage, picked, saved);
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    const detail = error instanceof CamofoxUnavailableError ? error.message : "failed";
    console.warn(`[instagram] camofox fallback skipped: ${detail}`.slice(0, 160));
  }
}
