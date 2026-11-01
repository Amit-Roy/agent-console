// Codemap map storage: DATA_DIR/maps/<slug>/{meta.json, scan.json, architecture.json, map.json, clone/}.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../auth.ts";

export type MapStatus = "queued" | "cloning" | "scanning" | "describing" | "ready" | "failed";

export type MapMeta = {
  slug: string;
  label: string;
  source: { kind: "local" | "github"; ref: string };
  status: MapStatus;
  error?: string;
  files?: number;
  modules?: number;
  loc?: number;
  commit?: string;
  described?: number;
  createdAt: number;
  updatedAt: number;
};

export const MAX_MAPS = 30;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function mapsDir(base: string = DATA_DIR): string {
  return path.join(base, "maps");
}

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid map slug: ${slug}`);
}

export function mapDir(slug: string, base: string = DATA_DIR): string {
  assertSlug(slug);
  return path.join(mapsDir(base), slug);
}

export function readMeta(slug: string, base: string = DATA_DIR): MapMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(mapDir(slug, base), "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

export function writeMeta(meta: MapMeta, base: string = DATA_DIR): void {
  const dir = mapDir(meta.slug, base);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "meta.json");
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listMaps(base: string = DATA_DIR): MapMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(mapsDir(base));
  } catch {
    return [];
  }
  const metas: MapMeta[] = [];
  for (const name of names) {
    if (!SLUG_RE.test(name)) continue;
    const meta = readMeta(name, base);
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteMap(slug: string, base: string = DATA_DIR): void {
  fs.rmSync(mapDir(slug, base), { recursive: true, force: true });
}

/** Throw when adding a new map would exceed MAX_MAPS (existing slug updates are fine). */
export function assertCapacity(slug?: string, base: string = DATA_DIR): void {
  const metas = listMaps(base);
  if (slug && metas.some((meta) => meta.slug === slug)) return;
  if (metas.length >= MAX_MAPS) throw new Error(`map limit reached (${MAX_MAPS})`);
}
