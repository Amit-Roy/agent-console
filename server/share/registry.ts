import { genericProvider } from "./generic.ts";
import { instagramProvider } from "./instagram.ts";
import { redditProvider } from "./reddit.ts";
import type { Provider, ShareLink } from "./types.ts";
import { xProvider } from "./x.ts";
import { youtubeProvider } from "./youtube.ts";

/** Providers are tried in order; generic accepts any http(s) URL, so it stays last. */
export const PROVIDERS: Provider[] = [
  instagramProvider,
  xProvider,
  redditProvider,
  youtubeProvider,
  genericProvider,
];

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/**
 * First link any provider recognizes, checking the explicit url before URLs found in the shared text
 * (Android often puts the URL in the text). A provider's match may throw a user-facing ShareError
 * (for example a playlist-only YouTube URL); that propagates to the caller.
 */
export function resolveShare(text: unknown, url: unknown): ShareLink | null {
  const candidates: string[] = [];
  if (typeof url === "string" && url.trim()) candidates.push(url.trim());
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

export function providerFor(link: ShareLink): Provider {
  const found = PROVIDERS.find((provider) => provider.name === link.provider);
  if (!found) throw new Error(`No share provider named ${link.provider}.`);
  return found;
}
