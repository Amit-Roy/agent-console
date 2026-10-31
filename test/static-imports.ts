// Public modules must import with relative paths so the release-prefixed /r/<sha12>/ URLs keep working (#400). Run: node test/static-imports.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const publicDir = new URL("../public/", import.meta.url).pathname;
const ABSOLUTE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']\/[A-Za-z]/;
const bad: string[] = [];
for (const name of fs.readdirSync(publicDir)) {
  if (!name.endsWith(".js") && !name.endsWith(".css")) continue;
  const lines = fs.readFileSync(path.join(publicDir, name), "utf8").split("\n");
  lines.forEach((line, index) => {
    const cssAbsolute = name.endsWith(".css") && /url\(\s*["']?\/[A-Za-z]/.test(line);
    if (ABSOLUTE.test(line) || cssAbsolute) bad.push(`${name}:${index + 1}: ${line.trim()}`);
  });
}
assert.deepEqual(bad, [], `absolute asset paths in public/:\n${bad.join("\n")}`);
console.log("static-imports ok");
