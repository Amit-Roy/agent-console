/**
 * Build the published design system from the app's token layer, so the package never drifts from the UI.
 * Source: the `:root` token blocks at the top of public/style.css, up to the `base` section marker.
 * Output: packages/design-system/design-system.css (verbatim token layer) and tokens.json (parsed maps).
 *
 *   node scripts/build-design-system.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SOURCE = "public/style.css";
const END_MARKER = "/* ---------- base ---------- */";
// Media query of each `:root` block -> theme name in tokens.json. A new block forces a deliberate update here.
const THEMES = {
  "": "base",
  "prefers-color-scheme: dark": "dark",
  "pointer: coarse": "coarse",
  "prefers-contrast: more": "contrast",
};
const HEADER = `/* Agent Console design system tokens. Generated from ${SOURCE} by scripts/build-design-system.js; do not edit. */\n\n`;

function declarations(block) {
  const map = {};
  for (const [, name, value] of block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    map[name] = value.replace(/\s+/g, " ").trim();
  return map;
}

export function buildDesignSystem(styleCss) {
  const start = styleCss.search(/^:root \{/m);
  const end = styleCss.indexOf(END_MARKER);
  if (start < 0 || end < start)
    throw new Error(`No token layer in ${SOURCE}: need ":root {" before "${END_MARKER}".`);
  const layer = styleCss.slice(start, end).trim();
  const themes = {};
  for (const [, media = "", body] of layer.matchAll(
    /(?:@media \(([^)]+)\) \{\s*)?:root \{([^}]*)\}/g,
  )) {
    const theme = THEMES[media];
    if (!theme) throw new Error(`Unknown token layer block "@media (${media})": add it to THEMES.`);
    themes[theme] = { ...themes[theme], ...declarations(body) };
  }
  return { css: `${HEADER}${layer}\n`, tokens: { version: 1, source: SOURCE, themes } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(ROOT, "packages", "design-system");
  const { css, tokens } = buildDesignSystem(readFileSync(join(ROOT, SOURCE), "utf8"));
  writeFileSync(join(out, "design-system.css"), css);
  writeFileSync(join(out, "tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`);
  console.log(
    `Wrote design-system.css and tokens.json (${Object.keys(tokens.themes).length} themes).`,
  );
}
