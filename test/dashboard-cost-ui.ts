import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Standalone first-party fixture: no session data, provider processes or live server.
const base = "http://127.0.0.1:7075";
const server = createServer(async (req, res) => {
  const path = req.url === "/dashboard" ? "/dashboard.html" : req.url!.split("?")[0];
  if (path.includes("..")) { res.writeHead(400).end(); return; }
  try {
    const data = await readFile(new URL(`../public${path}`, import.meta.url));
    const ext = path.split(".").pop();
    res.setHeader("content-type", ({ js: "text/javascript", css: "text/css", html: "text/html", svg: "image/svg+xml" } as any)[ext!] || "application/octet-stream");
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(7075, "127.0.0.1", resolve); });
const browser = await chromium.launch();
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, colorScheme: mobile ? "dark" : "light" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    let legacy = false, partial = false;
    await page.route("**/api/dashboard?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ turns: legacy ? [
      { ts: Date.UTC(2026, 0, 31), thread: "legacy", provider: "claude", in: 999, out: 99, cost: 99 },
    ] : [
      { ts: Date.UTC(2026, 0, 31), thread: "restored", provider: "claude", accounting: 2, in: 1000000, out: 100000, cache: 800000, cost: 12 },
      { ts: Date.UTC(2026, 1, 1), thread: "restored-codex", provider: "codex", accounting: 2, in: 2000000, out: 100000, cache: 1000000, cost: partial ? undefined : 8 },
      { ts: Date.UTC(2026, 1, 1), thread: "pi", provider: "pi", accounting: 2, in: 100, out: 10, cost: 5 },
    ], pricing: { currency: "USD", verifiedAt: "2026-10-17", sources: [{ name: "Official pricing", url: "https://example.com/pricing" }, { name: "Unsafe source", url: "javascript:alert(1)" }], assumptions: ["Standard short-context rates; default five-minute cache writes."] }, rtk: { daily: [] }, headroom: { daily: [] } }) }));
    await page.goto(base + "/dashboard#2026-01-31..2026-02-01");
    await page.locator(".kpis").waitFor();
    assert.match(await page.locator(".kpis").innerText(), /3.2M/);
    const usageChart = page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Usage", exact: true }) }).locator("svg.chart");
    assert.ok((await usageChart.locator("text").allTextContents()).includes("5.0M"), "Token axis must use millions, not unit scale");
    const labels = await usageChart.locator("g.hov").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
    assert.match(labels.join("|"), /Claude 1.1M/);
    assert.match(labels.join("|"), /Codex 2.1M/);
    const barHeight = await usageChart.locator("path.bar").first().evaluate(node => (node as SVGGraphicsElement).getBBox().height);
    assert.ok(barHeight > 40, "1.1M token bar must occupy a meaningful fraction of the 5M axis");
    await page.getByText("Show data as a table", { exact: true }).click();
    assert.match(await page.locator("details.table table").innerText(), /1.1M/);
    assert.match(await page.locator("details.table table").innerText(), /2.1M/);
    await page.getByText("Show data as a table", { exact: true }).click();
    assert.match(await page.locator(".kpis").innerText(), /\$25.00/);
    assert.match(await page.locator(".comparison-result").innerText(), /Not configured/);
    await page.getByText("Pricing basis · verified 2026-10-17", { exact: true }).click();
    assert.equal(await page.getByRole("link", { name: "Official pricing" }).getAttribute("href"), "https://example.com/pricing");
    assert.equal(await page.getByRole("link", { name: "Unsafe source" }).count(), 0);
    assert.match(await page.locator(".pricing-details").innerText(), /Standard short-context rates/);
    await page.screenshot({ path: `/tmp/dashboard-cost-${mobile ? "phone" : "desktop"}-unconfigured.png`, fullPage: true });
    await page.getByText("Set your monthly subscription fees", { exact: true }).click();
    await page.getByLabel("Claude monthly fee (USD)").fill("31");
    await page.getByLabel("Codex / ChatGPT monthly fee (USD)").fill("28");
    await page.getByRole("button", { name: "Save fees" }).click();
    const values = page.locator(".comparison-values .v");
    assert.match(await page.locator(".comparison-result").innerText(), /2\/2 matching turns priced/);
    assert.equal(await values.nth(0).innerText(), "$20.00"); // Pi excluded
    assert.equal(await values.nth(1).innerText(), "$4.01"); // 31/31 + 31/28 + 28/31 + 28/28
    assert.equal(await values.nth(2).innerText(), "$15.99");
    await page.reload(); await page.locator(".kpis").waitFor();
    assert.equal(await page.locator(".comparison-values .v").nth(1).innerText(), "$4.01");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `/tmp/dashboard-cost-${mobile ? "phone" : "desktop"}-configured.png`, fullPage: true });
    await page.getByText("Set your monthly subscription fees", { exact: true }).click();
    await page.getByLabel("Claude monthly fee (USD)").fill("3100");
    await page.getByLabel("Codex / ChatGPT monthly fee (USD)").fill("2800");
    await page.getByRole("button", { name: "Save fees" }).click();
    assert.equal(await page.locator(".comparison-values .v").nth(1).innerText(), "$401.04");
    assert.equal(await page.locator(".comparison-values .v").nth(2).innerText(), "−$381.04");
    partial = true;
    await page.reload(); await page.locator(".kpis").waitFor();
    assert.match(await page.locator(".kpis").innerText(), /2\/3 turns priced · partial coverage/);
    assert.equal(await page.locator(".comparison-values .v").nth(2).innerText(), "—");
    legacy = true;
    await page.reload(); await page.locator(".kpis").waitFor();
    assert.match(await page.locator(".kpis").innerText(), /1.1k/);
    assert.match(await page.locator(".kpis").innerText(), /0\/1 turns priced/);
    assert.equal(await page.locator(".comparison-values .v").nth(2).innerText(), "—");
    assert.match(await page.locator("#dm").innerText(), /old costs are unverified/);
    assert.ok(await page.locator("svg.chart path.bar").count());
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS dashboard restored and legacy usage, subscription configuration, calendar proration, scope, persistence, desktop and phone");
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
