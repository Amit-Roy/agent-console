export interface ShareLink {
  provider: string;
  url: string;
  id: string;
  kind?: string;
}

export interface ShareItem {
  path: string;
  name: string;
}

export interface ShareResult {
  items: ShareItem[];
  notePath: string;
  kind: "video" | "images" | "article" | "thread";
  missing: number[];
}

export interface FetchOptions {
  signal?: AbortSignal;
  items?: number[];
}

export interface Provider {
  name: string;
  match(url: URL): ShareLink | null;
  fetch(link: ShareLink, stageDir: string, opts: FetchOptions): Promise<ShareResult>;
}

export class ShareError extends Error {}
