import fs from "node:fs/promises";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { planShards } from "./shard-plan.mjs";

const weights = JSON.parse(await fs.readFile(new URL("./weights.json", import.meta.url), "utf8"));

// Node's CLI sorts file names. Start the longest suites first so they overlap short suites
// instead of extending the end of the pool. Shards come from a longest-first plan over
// measured seconds per file (test/weights.json, regenerate with scripts/test-weights.mjs).
let files = process.argv.slice(2);
if (!files.length) throw new Error("Pass test files to the runner.");
files = planShards(files, weights, 1)[0];
if (process.env.TEST_SHARD) {
  const match = /^(\d+)\/(\d+)$/.exec(process.env.TEST_SHARD);
  const index = Number(match?.[1]),
    total = Number(match?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || index > total)
    throw new Error("TEST_SHARD must be an index/total pair with 1 <= index <= total.");
  console.log(`Test suite files: ${JSON.stringify(files)}`);
  console.log(`Test run started: ${Date.now() - performance.now()}`);
  const count = files.length;
  files = planShards(files, weights, total)[index - 1];
  console.log(`Test shard ${index}/${total}: ${files.length} of ${count} files.`);
}
// Build the frontend bundle once; UI tests spawn servers that serve it (AGENT_CONSOLE_WEB_BUNDLE is inherited).
if (!process.env.AGENT_CONSOLE_WEB_BUNDLE) {
  const webDir = path.resolve(".bundle/public");
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/bundle-web.mjs", import.meta.url)), webDir],
    { stdio: "inherit" },
  );
  process.env.AGENT_CONSOLE_WEB_BUNDLE = webDir;
}
const outdir = ".bundle/tests";
await build({
  entryPoints: files,
  outdir,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  logLevel: "warning",
  plugins: [
    {
      name: "original-import-meta-url",
      setup(builder) {
        builder.onLoad({ filter: /\.(?:ts|mjs|js)$/ }, async ({ path: sourcePath }) => {
          if (sourcePath.includes(`${path.sep}node_modules${path.sep}`)) return;
          const source = await fs.readFile(sourcePath, "utf8");
          return {
            contents: source
              .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(sourcePath).href))
              .replaceAll("import.meta.dirname", JSON.stringify(path.dirname(sourcePath)))
              .replaceAll("import.meta.filename", JSON.stringify(sourcePath)),
            loader: sourcePath.endsWith(".ts") ? "ts" : "js",
          };
        });
      },
    },
  ],
});
const originalFiles = new Map(
  files.map((file) => [`${outdir}/${path.basename(file, path.extname(file))}.mjs`, file]),
);
const stream = run({
  files: [...originalFiles.keys()],
  concurrency: Number(process.env.TEST_CONCURRENCY || 4),
});
stream.on("test:fail", () => {
  process.exitCode = 1;
});
// Report original file identities and include bundling in the enforced wall budget.
const executed = new Set();
async function* originalEvents(events) {
  for await (const event of events) {
    const data = { ...event.data };
    for (const field of ["name", "file"]) {
      if (typeof data[field] !== "string") continue;
      for (const [bundle, original] of originalFiles) {
        if (data[field] === bundle) data[field] = original;
        else if (data[field] === path.resolve(bundle)) data[field] = path.resolve(original);
      }
    }
    if ((event.type === "test:pass" || event.type === "test:fail") && data.file) {
      const file = path.relative(process.cwd(), data.file);
      if (files.includes(file)) executed.add(file);
    }
    if (event.type === "test:diagnostic" && data.message.startsWith("duration_ms ")) {
      if (process.env.TEST_SHARD)
        console.log(`Test executed files: ${JSON.stringify([...executed])}`);
      data.message = `duration_ms ${performance.now()}`;
    }
    if (event.type === "test:summary") data.duration_ms = performance.now();
    yield { ...event, data };
  }
}
stream.compose(originalEvents).compose(new spec()).pipe(process.stdout);
