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
// schedule section carries the exact task prompt so the task can be created verbatim
const schedule = doc.slice(doc.indexOf("### Schedule"));
for (const part of [
  "git pull",
  "node scripts/check-design-system-sources.js --out ~/.local/share/agent-console/design-system",
  "newest file in `runs/`",
  "run record path",
])
  assert.ok(schedule.includes(part), `schedule prompt has ${part}`);
console.log("design-system ok");
