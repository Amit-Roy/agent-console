// Regenerate the compact sidebar metrics when the bundled Inter font changes.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openSync } from "fontkit";

const fontPath = new URL("../public/fonts/inter-latin-wght-normal.woff2", import.meta.url);
const output = new URL("../server/providers/title-metrics.json", import.meta.url);
const font = openSync(fileURLToPath(fontPath));
const metrics = {
  source: "public/fonts/inter-latin-wght-normal.woff2",
  sha256: createHash("sha256").update(fs.readFileSync(fontPath)).digest("hex"),
  unitsPerEm: font.unitsPerEm,
  advances: Object.fromEntries(
    font.characterSet.map((code) => [code, font.glyphForCodePoint(code).advanceWidth]),
  ),
};
const expected = JSON.stringify(metrics, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (fs.readFileSync(output, "utf8") !== expected)
    throw new Error("Thread title metrics are stale. Run npm run title-metrics.");
  console.log("Thread title metrics match the bundled Inter font.");
} else {
  fs.writeFileSync(output, expected);
  console.log("Updated server/providers/title-metrics.json.");
}
