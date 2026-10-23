import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { launchBrowser } from "./browser.mjs";

const server = createServer(async (req, res) => {
  const file = req.url === "/benchmarks" ? "/benchmarks.html" : req.url!.split("?")[0];
  if (file.includes("..")) return void res.writeHead(400).end();
  try {
    const body = await readFile(new URL(`../public${file}`, import.meta.url));
    res.setHeader(
      "Content-Type",
      ({ js: "text/javascript", css: "text/css", html: "text/html" } as any)[
        file.split(".").pop()!
      ] || "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await launchBrowser();
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }),
      page = await context.newPage();
    let subscriptions: any,
      posts = 0;
    await page.route("**/api/benchmarks", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ usage: {}, snapshot: null, subscriptions }),
      }),
    );
    await page.route("**/api/benchmarks/subscriptions", (route) => {
      posts++;
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto(`${base}/benchmarks`);
    await page.waitForFunction(
      () => document.querySelector("#benchmark-main")?.getAttribute("aria-busy") === "false",
    );
    assert.match(await page.locator("#subscription-cost").innerText(), /settings are unavailable/);
    assert.equal(await page.locator("#save-fees").isDisabled(), true);
    await page
      .locator("#subscription-fees")
      .evaluate((form) =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    assert.equal(posts, 0);
    subscriptions = { plans: [], totalMonthly: null, configured: false };
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector("#benchmark-main")?.getAttribute("aria-busy") === "false",
    );
    assert.match(await page.locator("#subscription-cost").innerText(), /not configured/);
    assert.equal(await page.locator("#save-fees").isEnabled(), true);
    await context.close();
    console.log(
      `PASS ${width}px: unavailable settings block saves; available settings enable configuration`,
    );
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
