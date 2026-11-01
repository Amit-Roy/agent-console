// Browser check: the running-thread dot and .spin spinners keep their opacity-only pulse under prefers-reduced-motion (no rotation).
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
    `<!doctype html><html><head><style>${css}</style></head><body><span class="dot running"></span><i class="spin"></i></body></html>`,
  );
  const readAnimation = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const computed = getComputedStyle(element);
      return { iterations: computed.animationIterationCount, name: computed.animationName };
    });
  const dotStyle = await readAnimation(".dot.running");
  assert.equal(dotStyle.iterations, "infinite", "running dot pulse repeats under reduced motion");
  assert.equal(dotStyle.name, "pulse", "running dot pulse animation is not disabled");
  const spinStyle = await readAnimation(".spin");
  assert.equal(spinStyle.iterations, "infinite", "spinner pulse repeats under reduced motion");
  assert.equal(
    spinStyle.name,
    "pulse",
    "spinner is not rotating and is pulsing under reduced motion",
  );
  console.log("reduced-motion ok");
  await context.close();
} finally {
  await browser.close();
}
