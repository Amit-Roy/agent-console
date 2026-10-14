// Copies self-hosted assets out of node_modules into public/ (run: npm run vendor). The results are committed so the
// app has no runtime dependency on node_modules for fonts or highlighting, and works offline as a PWA.
//   fonts:       Inter Variable + JetBrains Mono Variable (SIL OFL 1.1), latin + latin-ext subsets only
//   highlight.js: core + 13 common languages as ES modules (BSD-3-Clause)
import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const nm = (p) => path.join(root, "node_modules", p);
const out = (p) => path.join(root, "public", p);
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

for (const [pkg, face, subsets] of [
  ["inter", "inter", ["latin-wght-normal", "latin-ext-wght-normal", "latin-wght-italic"]],
  ["jetbrains-mono", "jetbrains-mono", ["latin-wght-normal", "latin-ext-wght-normal", "latin-wght-italic", "latin-ext-wght-italic"]],
]) {
  for (const s of subsets) copy(nm(`@fontsource-variable/${pkg}/files/${face}-${s}.woff2`), out(`fonts/${face}-${s}.woff2`));
  copy(nm(`@fontsource-variable/${pkg}/LICENSE`), out(`fonts/LICENSE-${pkg}.txt`));
}

// highlight.js ships its core as CommonJS only; the languages are plain ES modules.
const core = fs.readFileSync(nm("highlight.js/lib/core.js"), "utf8");
if (!core.includes("module.exports = highlight;")) throw new Error("highlight.js core layout changed");
fs.mkdirSync(out("vendor/hljs/languages"), { recursive: true });
fs.writeFileSync(out("vendor/hljs/core.js"), core.replace("module.exports = highlight;", "") + "\nexport default highlight;\n");
for (const l of ["bash", "javascript", "typescript", "json", "python", "css", "xml", "markdown", "diff", "yaml", "sql", "go", "rust"]) {
  copy(nm(`highlight.js/es/languages/${l}.js`), out(`vendor/hljs/languages/${l}.js`));
}
copy(nm("highlight.js/LICENSE"), out("vendor/hljs/LICENSE.txt"));
console.log("vendored fonts + highlight.js into public/");
