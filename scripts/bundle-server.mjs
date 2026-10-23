// Bundle the server into one ESM file so boot loads one module instead of ~150 (Express alone is ~200 ms of module loading).
// Run by `bin/agent-console supervise` when a source is newer than the bundle, and by idle-restart before it stops the server.
// The output path keeps "server/index.ts" in the process command line: bin/agent-console and workspace scripts match on it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE = path.join(ROOT, ".bundle", "server", "index.ts.mjs");

// Modules find their siblings (Pi extensions, the host worker, skills) through import.meta.url.
// Keep each file's own URL instead of the bundle's.
const ownUrl = {
  name: "own-import-meta-url",
  setup(b) {
    b.onLoad({ filter: /\.(ts|mjs|js)$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const source = await fs.promises.readFile(args.path, "utf8");
      return {
        contents: source.replaceAll(
          "import.meta.url",
          JSON.stringify(pathToFileURL(args.path).href),
        ),
        loader: args.path.endsWith(".ts") ? "ts" : "js",
      };
    });
  },
};

const tmp = `${BUNDLE}.${process.pid}.tmp`;
await build({
  entryPoints: [path.join(ROOT, "server", "index.ts")],
  outfile: tmp,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // ws loads these optional native speedups when present; web-push loads lazily through createRequire.
  external: ["bufferutil", "utf-8-validate", "web-push"],
  // CommonJS dependencies (Express) call require() for Node built-ins.
  banner: {
    js: 'import { createRequire as __bundleRequire } from "node:module"; const require = __bundleRequire(import.meta.url);',
  },
  plugins: [ownUrl],
  logLevel: "warning",
});
fs.renameSync(tmp, BUNDLE);
