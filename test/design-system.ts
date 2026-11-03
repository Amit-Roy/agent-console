import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const pkgDir = path.join(root, "packages", "design-system");
const { buildDesignSystem } = await import("../scripts/build-design-system.js");

// spec document
const doc = fs.readFileSync(path.join(root, "docs", "design-system.md"), "utf8");
for (const h of [
  "## Tokens",
  "## Components",
  "## Usage Guidelines",
  "## Scope",
  "## Published output",
  "## Icon-Pack Style Constraint",
  "## Publishing",
])
  assert.ok(doc.includes(h), `docs/design-system.md has ${h}`);

// the published files are generated from the app's token layer, never edited by hand
const built = buildDesignSystem(fs.readFileSync(path.join(root, "public", "style.css"), "utf8"));
assert.equal(
  fs.readFileSync(path.join(pkgDir, "design-system.css"), "utf8"),
  built.css,
  "design-system.css is stale: run node scripts/build-design-system.js",
);
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(pkgDir, "tokens.json"), "utf8")),
  built.tokens,
  "tokens.json is stale: run node scripts/build-design-system.js",
);
assert.equal(built.tokens.themes.base["--col"], "60rem", "tokens follow public/style.css");
assert.deepEqual(Object.keys(built.tokens.themes), ["base", "dark", "coarse", "contrast"]);
assert.throws(() => buildDesignSystem("body { color: red; }"), /token layer/);

// the scope document lists every published token and every published file
const names = new Set(Object.values(built.tokens.themes).flatMap((map) => Object.keys(map)));
for (const name of names) assert.ok(doc.includes(`\`${name}\``), `docs list ${name}`);

// package: every file listed in "files" exists, and the package imports as ESM
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
assert.equal(pkg.type, "module");
for (const file of pkg.files) {
  assert.ok(fs.existsSync(path.join(pkgDir, file)), `files entry ${file} exists`);
  assert.ok(doc.includes(`\`${file}\``), `docs list published file ${file}`);
}
const ds: any = await import(path.join(pkgDir, "index.js"));
assert.equal(ds.tokens.themes.dark["--s0"], "#0b0b0d");
assert.ok(ds.cssString.includes(":root"));
assert.equal(ds.default.cssString, ds.cssString);

// publish command produces an installable tarball with the entry files
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8" }),
)[0];
const tarball = packed.files.map((entry: any) => entry.path);
for (const file of ["index.js", "index.d.ts", "tokens.json", "design-system.css", "package.json"])
  assert.ok(tarball.includes(file), `tarball contains ${file}`);
// text scales with the browser font size (WCAG 1.4.4 Resize Text): rem sizes, no px root size, documented rule
const styleCss = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
for (const [name, value] of Object.entries(built.tokens.themes.base))
  if (/^--fm?-/.test(name))
    assert.match(
      String(value),
      /^[\d.]+rem \/ ([\d.]+rem|[\d.]+) /,
      `${name} is a rem size with a rem or unitless line height`,
    );
assert.doesNotMatch(
  styleCss,
  /font(-size)?:[^;{}]*\d(\.\d+)?px/,
  "public/style.css has no px font sizes",
);
assert.doesNotMatch(
  styleCss,
  /html\s*\{[^}]*font-size/,
  "html sets no font size, so browser settings scale rem",
);
assert.match(doc, /\*\*Text Scaling\*\*/, "Usage Guidelines has the Text Scaling rule");
assert.match(
  doc,
  /dbushell\.com\/2026\/11\/01\/tangled-accessibility/,
  "Text Scaling cites its source",
);
// schedule section carries the exact task prompt so the task can be created verbatim
const schedule = doc.slice(doc.indexOf("### Schedule"));
for (const part of [
  "git pull",
  "node scripts/check-design-system-sources.js --out ~/.local/share/agent-console/design-system",
  "newest file in `runs/`",
  "run record path",
])
  assert.ok(schedule.includes(part), `schedule prompt has ${part}`);
// contrast rules: every place two colour tokens meet clears its WCAG floor in both themes
// (docs Colors "Contrast rules"; source: earendil.com/posts/system-theme)
function channels(value: string) {
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((ch) => ch + ch).join("") : hex[1];
    return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)).concat(1);
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(rgba, `colour token value ${value} is hex or rgba`);
  const [red, green, blue, alpha = 1] = rgba[1].split(",").map(Number);
  return [red, green, blue, alpha];
}
function blend(top: number[], under: number[]) {
  return top.slice(0, 3).map((chan, idx) => chan * top[3] + under[idx] * (1 - top[3]));
}
function luminance(rgb: number[]) {
  const lin = rgb.map((chan) => {
    const unit = chan / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastRatio(fore: number[], back: number[]) {
  const [high, low] = [luminance(fore), luminance(back)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}
const surfaces = ["--s0", "--s1", "--s2", "--s3", "--pop", "--sel"];
const tintBases = ["--s0", "--s1", "--s2", "--pop", "--code-bg"];
const toneTints = [
  ["--accent", "--accent-tint"],
  ["--warn", "--warn-tint"],
  ["--bad", "--bad-tint"],
  ["--ok", "--add-bg"],
  ["--bad", "--del-bg"],
];
const solidPairs = [
  ["--on-fill", "--fill"],
  ["--on-fill", "--fill-hover"],
  ["--on-stop", "--stop"],
  ["--on-stop", "--stop-hover"],
];
const tokenNames = Object.keys(built.tokens.themes.base);
for (const theme of ["base", "dark"]) {
  const color = (name: string) =>
    channels(String(built.tokens.themes[theme][name] ?? built.tokens.themes.base[name]));
  const meets = (fore: string, back: number[], floor: number, where: string) => {
    const ratio = contrastRatio(color(fore), back);
    assert.ok(
      ratio >= floor,
      `${theme}: ${fore} on ${where} is ${ratio.toFixed(2)}:1, needs ${floor}:1`,
    );
  };
  for (const fore of ["--t1", "--t2", "--t3", "--accent", "--ok", "--warn", "--bad"])
    for (const back of surfaces) meets(fore, color(back), 4.5, back);
  for (const [fore, tint] of toneTints)
    for (const base of tintBases)
      meets(fore, blend(color(tint), color(base)), 4.5, `${tint} over ${base}`);
  for (const [fore, back] of solidPairs) meets(fore, color(back), 4.5, back);
  for (const name of tokenNames.filter((name) => name.startsWith("--hl-")))
    meets(name, color("--code-bg"), 4.5, "--code-bg");
  for (const name of tokenNames.filter((name) => name.startsWith("--viz-")))
    for (const back of ["--s1", "--s2"]) meets(name, color(back), 3, back);
  for (const back of ["--s0", "--s1", "--s2", "--pop"]) meets("--focus", color(back), 3, back);
}
assert.match(doc, /\*\*Contrast rules\*\*/, "Colors documents the contrast rules");
assert.match(doc, /earendil\.com\/posts\/system-theme/, "Contrast rules cite their source");
console.log("design-system ok");
