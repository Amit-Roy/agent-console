// Regenerates PNG app icons from public/icon.svg (run: npm run icons). Needed for Android/ChromeOS install.
import sharp from "sharp";
import fs from "node:fs";
const svg = fs.readFileSync(new URL("../public/icon.svg", import.meta.url));
const out = (n) => new URL(`../public/${n}`, import.meta.url).pathname;
for (const size of [192, 512]) await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out(`icon-${size}.png`));
// maskable: full-bleed background, glyph inside the 80% safe zone
const bg = "#1c1c1e", size = 512, inner = Math.round(size * 0.62);
const glyph = await sharp(svg, { density: 384 }).resize(inner, inner).png().toBuffer();
await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
  .composite([{ input: glyph, gravity: "centre" }]).png().toFile(out("icon-maskable-512.png"));
console.log("icons written");
