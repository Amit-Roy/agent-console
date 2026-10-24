import fs from "node:fs";
import path from "node:path";
import { providerFor, resolveShare } from "../server/share/registry.ts";
import { ShareError } from "../server/share/types.ts";

// bin/share-fetch <url> [--out DIR] [--items 1,8]
// Anonymous download of a shared link for agents; prints one "path size" line per file, note file last.
const USAGE = "usage: share-fetch <url> [--out DIR] [--items 1,8]";

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

function safeSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "_").slice(0, 80) || "link";
}

async function main() {
  const { url, out, items } = parseArgs(process.argv.slice(2));
  if (!url) fail(USAGE);
  const link = resolveShare("", url);
  if (!link) fail(`That is not a link share-fetch can read. ${USAGE}`);
  const outDir = path.resolve(
    out || path.join("/tmp/share-fetch", `${link.provider}-${safeSegment(link.id)}`),
  );
  fs.mkdirSync(outDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(outDir, ".work-"));
  try {
    const fetched = await providerFor(link).fetch(link, stage, { items });
    const noteName = link.provider === "instagram" ? "instagram.txt" : "post.md";
    const lines: string[] = [];
    for (const item of [...fetched.items, { path: fetched.notePath, name: noteName }]) {
      const target = path.join(outDir, item.name);
      fs.renameSync(item.path, target);
      lines.push(`${target} ${fs.statSync(target).size}`);
    }
    console.log(lines.join("\n"));
    if (fetched.missing.length) console.error(`missing: ${fetched.missing.join(",")}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error: any) {
  fail(error instanceof ShareError ? error.message : `Download failed: ${error?.message ?? error}`);
}
