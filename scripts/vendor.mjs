// Copies self-hosted assets out of node_modules into public/ (run: npm run vendor). The results are committed so the
// app has no runtime dependency on node_modules for fonts or highlighting, and works offline as a PWA.
//   fonts:       Inter Variable + JetBrains Mono Variable + Newsreader Variable (SIL OFL 1.1), latin + latin-ext subsets only
//   highlight.js: core + 13 common languages as ES modules (BSD-3-Clause)
//   chart.js:    minified UMD build, lazy-loaded by render.js only when a ```chart block appears (MIT)
//   cytoscape:   minified ES module, lazy-loaded by brain.js only when the Brain graph view opens (MIT)
//   libavoid-js: orthogonal connector router (JS + wasm), lazy-loaded by arch.js for ```arch diagrams (LGPL-2.1)
//   lucide:      icons.json, a name -> inner SVG markup map built from lucide-static, used by arch.js (ISC)
//   marked:      markdown parser ES module, imported by render.js as /vendor/marked.js (MIT)
//   purify:      DOMPurify ES module, imported by render.js as /vendor/purify.js (MPL-2.0 OR Apache-2.0)
//   simplewebauthn-browser: UMD bundle loaded by vault.html for passkeys (MIT)
import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const nm = (p) => path.join(root, "node_modules", p);
const out = (p) => path.join(root, "public", p);
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

for (const [pkg, face, subsets] of [
  ["inter", "inter", ["latin-wght-normal", "latin-ext-wght-normal", "latin-wght-italic"]],
  [
    "jetbrains-mono",
    "jetbrains-mono",
    ["latin-wght-normal", "latin-ext-wght-normal", "latin-wght-italic", "latin-ext-wght-italic"],
  ],
  [
    "newsreader",
    "newsreader",
    [
      "latin-standard-normal",
      "latin-ext-standard-normal",
      "latin-standard-italic",
      "latin-ext-standard-italic",
    ],
  ], // weight + optical size axes
]) {
  for (const s of subsets)
    copy(
      nm(`@fontsource-variable/${pkg}/files/${face}-${s}.woff2`),
      out(`fonts/${face}-${s}.woff2`),
    );
  copy(nm(`@fontsource-variable/${pkg}/LICENSE`), out(`fonts/LICENSE-${pkg}.txt`));
}

// highlight.js ships its core as CommonJS only; the languages are plain ES modules.
const core = fs.readFileSync(nm("highlight.js/lib/core.js"), "utf8");
if (!core.includes("module.exports = highlight;"))
  throw new Error("highlight.js core layout changed");
fs.mkdirSync(out("vendor/hljs/languages"), { recursive: true });
fs.writeFileSync(
  out("vendor/hljs/core.js"),
  core.replace("module.exports = highlight;", "") + "\nexport default highlight;\n",
);
for (const l of [
  "bash",
  "javascript",
  "typescript",
  "json",
  "python",
  "css",
  "xml",
  "markdown",
  "diff",
  "yaml",
  "sql",
  "go",
  "rust",
]) {
  copy(nm(`highlight.js/es/languages/${l}.js`), out(`vendor/hljs/languages/${l}.js`));
}
copy(nm("highlight.js/LICENSE"), out("vendor/hljs/LICENSE.txt"));
copy(nm("chart.js/dist/chart.umd.min.js"), out("vendor/chart.umd.min.js"));
copy(nm("chart.js/LICENSE.md"), out("vendor/chart.LICENSE.txt"));
copy(nm("cytoscape/dist/cytoscape.esm.min.mjs"), out("vendor/cytoscape.esm.min.mjs"));
copy(nm("cytoscape/LICENSE"), out("vendor/cytoscape.LICENSE.txt"));
copy(nm("libavoid-js/dist/index.js"), out("vendor/libavoid/index.js"));
copy(nm("libavoid-js/dist/libavoid.wasm"), out("vendor/libavoid/libavoid.wasm"));
copy(nm("libavoid-js/LICENSE"), out("vendor/libavoid/LICENSE.txt"));
copy(nm("marked/lib/marked.esm.js"), out("vendor/marked.js"));
copy(nm("marked/LICENSE"), out("vendor/marked.LICENSE.txt"));
copy(nm("dompurify/dist/purify.es.mjs"), out("vendor/purify.js"));
copy(nm("dompurify/LICENSE"), out("vendor/purify.LICENSE.txt"));
copy(nm("dompurify/LICENSE-MPL"), out("vendor/purify.LICENSE-MPL.txt"));
copy(
  nm("@simplewebauthn/browser/dist/bundle/index.umd.min.js"),
  out("vendor/simplewebauthn-browser.js"),
);
copy(nm("@simplewebauthn/browser/LICENSE.md"), out("vendor/simplewebauthn-browser.LICENSE.txt"));
const nodes = JSON.parse(fs.readFileSync(nm("lucide-static/icon-nodes.json"), "utf8"));
const attrText = (attrs) =>
  Object.entries(attrs)
    .filter(([key]) => key !== "key")
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
const icons = {};
for (const [name, parts] of Object.entries(nodes))
  icons[name] = parts.map(([tag, attrs]) => `<${tag}${attrText(attrs)}/>`).join("");
fs.mkdirSync(out("vendor/lucide"), { recursive: true });
fs.writeFileSync(out("vendor/lucide/icons.json"), JSON.stringify(icons));
copy(nm("lucide-static/LICENSE"), out("vendor/lucide/LICENSE.txt"));
console.log(
  "vendored fonts + highlight.js + chart.js + cytoscape + libavoid + lucide + marked + purify + simplewebauthn into public/",
);
