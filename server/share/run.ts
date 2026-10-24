import fs from "node:fs";
import path from "node:path";
import { downloadInstagram, instagramProvider } from "./instagram.ts";
import { providerFor } from "./registry.ts";
import type { ShareLink, ShareResult } from "./types.ts";

export interface SharedFiles {
  result: ShareResult;
  cleanup: () => void;
}

async function stageFetch(link: ShareLink, signal?: AbortSignal): Promise<SharedFiles> {
  const { DATA_DIR } = await import("../auth.ts");
  const root = path.join(DATA_DIR, "tmp");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(root, `${link.provider}-`));
  const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
  try {
    return { result: await providerFor(link).fetch(link, stage, { signal }), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Fetches a shared link into a private stage dir. The caller owns the files and must call cleanup(). */
export async function downloadShare(link: ShareLink, signal?: AbortSignal): Promise<SharedFiles> {
  if (link.provider !== instagramProvider.name) return stageFetch(link, signal);
  // Instagram keeps its one-at-a-time queue and duplicate-request guard.
  const download = await downloadInstagram(link as never, { signal });
  const allImages = download.items.every((item) => /\.(jpg|png|webp)$/.test(item.name));
  return {
    result: {
      items: download.items,
      notePath: download.captionPath,
      kind: allImages ? "images" : "video",
      missing: download.missing ?? [],
    },
    cleanup: download.cleanup,
  };
}
