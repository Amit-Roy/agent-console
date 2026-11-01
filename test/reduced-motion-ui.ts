// Browser check: the running-thread dot keeps its opacity-only pulse under prefers-reduced-motion.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const css = fs.readFileSync(path.join(root, "public/style.css"), "utf8");
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body><span class="dot running"></span></body></html>`,
  );
  const style = await page.locator(".dot.running").evaluate((dotElement) => {
    const computed = getComputedStyle(dotElement);
    return { iterations: computed.animationIterationCount, name: computed.animationName };
  });
  assert.equal(style.iterations, "infinite", "running dot pulse repeats under reduced motion");
  console.log(`reduced-motion ok (animation-name=${style.name})`);
  await context.close();
} finally {
  await browser.close();
}
