// Boot module graph (issue #18): the largest packages load on first use, not while the server boots.
// Follows only static imports from server/index.ts in an esbuild metafile; dynamic import() edges are where loading defers.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Together these were about two thirds of the 8.3 MB server bundle and half the CPU time before the first boot mark.
const LAZY = ["undici", "linkedom", "defuddle", "@simplewebauthn/server"];

const result = await build({
  entryPoints: [path.join(ROOT, "server", "index.ts")],
  absWorkingDir: ROOT,
  bundle: true,
  write: false,
  metafile: true,
  outfile: path.join(ROOT, ".bundle", "boot-modules.mjs"),
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["bufferutil", "utf-8-validate", "web-push"],
  logLevel: "error",
});
const inputs = result.metafile.inputs;
const reached = new Set<string>();
const parents = new Map<string, string>();
const queue = ["server/index.ts"];
for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
  if (reached.has(file)) continue;
  reached.add(file);
  for (const edge of inputs[file]?.imports ?? []) {
    if (edge.kind === "dynamic-import" || edge.external || reached.has(edge.path)) continue;
    if (!parents.has(edge.path)) parents.set(edge.path, file);
    queue.push(edge.path);
  }
}
const chain = (file: string) => {
  const steps = [file];
  for (let parent = parents.get(file); parent; parent = parents.get(parent)) steps.unshift(parent);
  return steps.filter((step) => !step.includes("node_modules/")).join(" -> ");
};
for (const pkg of LAZY) {
  const marker = `node_modules/${pkg}/`;
  const eager = [...reached].find((file) => file.includes(marker));
  assert.equal(eager, undefined, `${pkg} loads at boot via ${eager && chain(eager)}`);
  assert.ok(
    Object.keys(inputs).some((file) => file.includes(marker)),
    `${pkg} is no longer in the bundle; drop it from LAZY`,
  );
}
console.log("boot-modules: ok");
