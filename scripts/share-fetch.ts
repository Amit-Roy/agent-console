import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../server/auth.ts";
import { providerFor, resolveShare } from "../server/share/registry.ts";
import { ShareError } from "../server/share/types.ts";
import { MAX_ITEMS } from "../server/share/ytdlp.ts";
import { isId, SAFE_NAME } from "../server/uploads.ts";

// bin/share-fetch <url> [--out DIR] [--items 1,8]
// Anonymous download of a shared link for agents; prints one "path size" line per file, note file last.
const USAGE = "usage: share-fetch <url> [--out DIR] [--items 1,8]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseItems(raw: string): number[] {
  const items = raw.split(",").map(Number);
  if (!items.every((item) => Number.isInteger(item) && item >= 1 && item <= MAX_ITEMS))
    fail(`--items takes comma-separated numbers from 1 to ${MAX_ITEMS}.`);
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

// realpath of the deepest existing ancestor plus the not-yet-created tail, so symlinks cannot dodge the uploads check
function realTarget(target: string): string {
  const tail: string[] = [];
  let head = target;
  while (!fs.existsSync(head)) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  return path.join(fs.realpathSync(head), ...tail);
}

// Inside uploads the dir must be uploads/<thread>/<name> and gets the share-jail marker uploads/<thread>/<name>.untrusted.
function markUploadsOut(outDir: string) {
  const uploads = realTarget(path.join(DATA_DIR, "uploads"));
  const rel = path.relative(uploads, realTarget(outDir));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const [thread, name, ...extra] = rel.split(path.sep);
  if (!isId(thread) || !name || extra.length || name.startsWith(".") || !SAFE_NAME.test(name))
    fail("--out inside uploads must be exactly uploads/<thread-id>/<name>.");
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.writeFileSync(`${outDir}.untrusted`, "", { mode: 0o600 });
}

async function main() {
  const { url, out, items } = parseArgs(process.argv.slice(2));
  if (!url) fail(USAGE);
  const link = resolveShare("", url);
  if (!link) fail(`That is not a link share-fetch can read. ${USAGE}`);
  const outDir = path.resolve(
    out || path.join("/tmp/share-fetch", `${link.provider}-${safeSegment(link.id)}`),
  );
  markUploadsOut(outDir);
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
