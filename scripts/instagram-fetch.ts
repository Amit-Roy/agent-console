import fs from "node:fs";
import path from "node:path";
import { extractInstagramUrl, fetchPost, ShareError } from "../server/instagram.ts";

// bin/instagram-fetch <instagram-url> [--out DIR] [--items 1,8]
// Anonymous download of every item of a post for agents; prints one "path size" line per file, then the caption file.
const USAGE = "usage: instagram-fetch <instagram-url> [--out DIR] [--items 1,8]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseItems(raw: string): number[] {
  const items = raw.split(",").map(Number);
  if (!items.every((item) => Number.isInteger(item) && item >= 1 && item <= 10))
    fail("--items takes comma-separated numbers from 1 to 10.");
  return items;
}

function parseArgs(argv: string[]) {
  let url = "";
  let out = "";
  let items: number[] | undefined;
  for (let pos = 0; pos < argv.length; pos++) {
    const arg = argv[pos];
    if (arg === "--out") out = argv[++pos] ?? fail(USAGE);
    else if (arg === "--items") items = parseItems(argv[++pos] ?? fail(USAGE));
    else if (arg.startsWith("-") || url) fail(USAGE);
    else url = arg;
  }
  return { url, out, items };
}

const { url, out, items } = parseArgs(process.argv.slice(2));
const link = extractInstagramUrl("", url);
if (!link) fail(`That is not a valid Instagram link. ${USAGE}`);
const outDir = path.resolve(out || path.join("/tmp/instagram-fetch", link.code));
fs.mkdirSync(outDir, { recursive: true });
const stage = fs.mkdtempSync(path.join(outDir, ".work-"));
try {
  const fetched = await fetchPost(link, stage, { items });
  const lines: string[] = [];
  for (const item of [...fetched.items, { path: fetched.captionPath, name: "instagram.txt" }]) {
    const target = path.join(outDir, item.name);
    fs.renameSync(item.path, target);
    lines.push(`${target} ${fs.statSync(target).size}`);
  }
  console.log(lines.join("\n"));
  if (fetched.missing.length) console.error(`missing: ${fetched.missing.join(",")}`);
} catch (error: any) {
  fail(error instanceof ShareError ? error.message : "Instagram download failed.");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
