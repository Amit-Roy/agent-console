import { instagramProvider } from "./instagram.ts";
import type { Provider, ShareLink } from "./types.ts";

/** Providers are tried in order; append new ones here. */
export const PROVIDERS: Provider[] = [instagramProvider];

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** First link any provider recognizes, checking the explicit url before URLs found in the shared text. */
export function resolveShare(text: unknown, url: unknown): ShareLink | null {
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
    for (const provider of PROVIDERS) {
      const link = provider.match(parsed);
      if (link) return link;
    }
  }
  return null;
}
