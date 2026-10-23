import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.join(import.meta.dirname, "..");
const pkgDir = path.join(root, "packages", "design-system");

// spec document
const doc = fs.readFileSync(path.join(root, "docs", "design-system.md"), "utf8");
for (const h of [
  "## Tokens",
  "## Components",
  "## Usage Guidelines",
  "## Scope",
  "## Icon-Pack Style Constraint",
  "## Publishing",
])
  assert.ok(doc.includes(h), `docs/design-system.md has ${h}`);

// package: every file listed in "files" exists, and the package imports as ESM
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
assert.equal(pkg.type, "module");
for (const f of pkg.files)
  assert.ok(fs.existsSync(path.join(pkgDir, f)), `files entry ${f} exists`);
const ds: any = await import(path.join(pkgDir, "index.js"));
assert.ok(ds.tokens && typeof ds.tokens === "object");
assert.ok(ds.cssString.includes(":root"));
assert.equal(ds.default.cssString, ds.cssString);

// publish command produces an installable tarball with the entry files
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8" }),
)[0];
const names = packed.files.map((f: any) => f.path);
for (const f of ["index.js", "index.d.ts", "tokens.json", "design-system.css", "package.json"])
  assert.ok(names.includes(f), `tarball contains ${f}`);
console.log("design-system ok");
