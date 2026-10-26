// Bundle the browser modules in public/ with esbuild. Output is only the esbuild result; the server falls back to public/ for everything else.
// Usage: node scripts/bundle-web.mjs [outDir]   (default .bundle/public)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const outDir = path.resolve(process.argv[2] || path.join(root, ".bundle", "public"));
const NOT_BUNDLED = new Set(["/sw.js", "/arch-route-worker.js", "/vendor/chart.umd.min.js"]);
const isExternal = (p) => NOT_BUNDLED.has(p) || p.startsWith("/vendor/libavoid/");
const isModule = (file) =>
  /^\s*(import|export)\b/m.test(fs.readFileSync(path.join(pub, file), "utf8"));

const entries = fs
  .readdirSync(pub)
  .filter((f) => f.endsWith(".js") && !isExternal(`/${f}`) && isModule(f))
  .map((f) => path.join("public", f));

const absoluteImports = {
  name: "absolute-public",
  setup(b) {
    b.onResolve({ filter: /^\// }, (args) => {
      if (isExternal(args.path)) return { path: args.path, external: true };
      if (args.path.startsWith(pub)) return undefined;
      return { path: path.join(pub, args.path) };
    });
  },
};

const started = performance.now();
fs.rmSync(outDir, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: entries,
  outdir: outDir,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  sourcemap: "linked",
  metafile: true,
  logLevel: "warning",
  plugins: [absoluteImports],
});
const outputs = Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js"));
const chunks = outputs.filter((f) => f.includes("/chunks/")).length;
console.log(
  JSON.stringify({
    outDir,
    entries: entries.length,
    chunks,
    esbuildMs: Math.round(performance.now() - started),
  }),
);
