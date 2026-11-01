// highlight.js must load lazily (#406): ALIASES matches the vendor language modules and no entry's static module graph reaches vendor/hljs. Run: node test/hljs-lazy.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { moduleGraph } from "../server/static-assets.ts";

const publicDir = new URL("../public/", import.meta.url).pathname;
const source = fs.readFileSync(`${publicDir}render.js`, "utf8");
const literal = (name: string) => {
  const match = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(source);
  assert.ok(match, `${name} literal in render.js`);
  return new Function(`return {${match[1]}}`)() as Record<string, string | (() => unknown)>;
};
const aliases = literal("ALIASES") as Record<string, string>;
const langPaths = [
  ...source.matchAll(/^\s+(\w+): \(\) => import\("\.\/vendor\/hljs\/languages\/(\w+)\.js"\)/gm),
];
assert.ok(langPaths.length >= 13, "LANGS thunks found");

const core = (await import(`${publicDir}vendor/hljs/core.js`)).default;
const expected: Record<string, string> = {};
for (const [, name, file] of langPaths) {
  assert.equal(name, file, `LANGS key ${name} matches its module`);
  const mod = (await import(`${publicDir}vendor/hljs/languages/${file}.js`)).default;
  expected[name] = name;
  for (const alias of mod(core).aliases ?? []) expected[alias] = name;
}
assert.deepEqual({ ...aliases }, expected, "ALIASES matches vendor module aliases");

const entries = ["app.js", "brain.js"].filter((name) => fs.existsSync(`${publicDir}${name}`));
const graph = moduleGraph(publicDir, entries);
assert.ok(graph.includes("render.js"), "render.js is in the static graph");
assert.deepEqual(
  graph.filter((rel) => rel.includes("vendor/hljs")),
  [],
  "no vendor/hljs module is statically reachable",
);
console.log("hljs-lazy ok");
