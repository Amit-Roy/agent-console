import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

// Standalone first-party fixture: no session data, provider processes or live server.
const server = createServer(async (req, res) => {
  const path = req.url === "/dashboard" ? "/dashboard.html" : req.url!.split("?")[0];
  if (path.includes("..")) {
    res.writeHead(400).end();
    return;
  }
  try {
    const data = await readFile(new URL(`../public${path}`, import.meta.url));
    const ext = path.split(".").pop();
    res.setHeader(
      "content-type",
      ({ js: "text/javascript", css: "text/css", html: "text/html", svg: "image/svg+xml" } as any)[
        ext!
      ] || "application/octet-stream",
    );
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
const browser = await chromium.launch();
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      colorScheme: mobile ? "dark" : "light",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    let legacy = false,
      partial = false;
    let savings: "empty" | "missing" | "partial" | "nonzero" = "empty";
    await page.route("**/api/dashboard?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          turns: legacy
            ? [
                {
                  ts: Date.UTC(2026, 0, 31),
                  thread: "legacy",
                  provider: "claude",
                  in: 999,
                  out: 99,
                  cost: 99,
                },
              ]
            : [
                {
                  ts: Date.UTC(2026, 0, 31),
                  thread: "restored",
                  provider: "claude",
                  accounting: 2,
                  in: 1000000,
                  out: 100000,
                  cache: 800000,
                  cost: 12,
                },
                {
                  ts: Date.UTC(2026, 1, 1),
                  thread: "restored-codex",
                  provider: "codex",
                  accounting: 2,
                  in: 2000000,
                  out: 100000,
                  cache: 1000000,
                  cost: partial ? undefined : 8,
                },
                {
                  ts: Date.UTC(2026, 1, 1),
                  thread: "pi",
                  provider: "pi",
                  accounting: 2,
                  in: 100,
                  out: 10,
                  cost: 5,
                },
              ],
          pricing: {
            currency: "USD",
            verifiedAt: "2026-10-17",
            sources: [
              { name: "Official pricing", url: "https://example.com/pricing" },
              { name: "Unsafe source", url: "javascript:alert(1)" },
            ],
            assumptions: ["Standard short-context rates; default five-minute cache writes."],
          },
          rtk:
            savings === "missing"
              ? null
              : {
                  daily:
                    savings === "empty"
                      ? []
                      : [
                          {
                            date: "2026-01-31",
                            saved_tokens: 1200,
                            input_tokens: 2400,
                            commands: 3,
                          },
                        ],
                },
          headroom: {
            enabled: true,
            running: false,
            daily:
              savings === "missing" || savings === "partial"
                ? null
                : savings === "empty"
                  ? []
                  : [{ timestamp: "2026-01-31T00:00:00Z", tokens_saved: 3400 }],
          },
        }),
      }),
    );
    await page.goto(base + "/dashboard#2026-01-31..2026-02-01");
    await page.locator(".kpis").waitFor();
    assert.match(await page.locator(".kpis").innerText(), /3.0M/);
    const usageChart = page
      .locator(".panel")
      .filter({ has: page.getByRole("heading", { name: "Usage", exact: true }) })
      .locator("svg.chart");
    assert.ok(
      (await usageChart.locator("text").allTextContents()).includes("5.0M"),
      "Token axis must use millions, not unit scale",
    );
    const labels = await usageChart
      .locator("g.hov")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    assert.match(labels.join("|"), /Claude 1.1M/);
    assert.match(labels.join("|"), /Codex 2.1M/);
    const barHeight = await usageChart
      .locator("path.bar")
      .first()
      .evaluate((node) => (node as SVGGraphicsElement).getBBox().height);
    assert.ok(barHeight > 40, "1.1M token bar must occupy a meaningful fraction of the 5M axis");
    await page.getByText("Show data as a table", { exact: true }).click();
    assert.match(await page.locator("details.table table").innerText(), /1.1M/);
    assert.match(await page.locator("details.table table").innerText(), /2.1M/);
    await page.getByText("Show data as a table", { exact: true }).click();
    assert.match(await page.locator(".kpis").innerText(), /\$25.00/);
    assert.match(await page.locator(".comparison-result").innerText(), /\$60.00\/month/);
    await page.getByText("Pricing basis · verified 2026-10-17", { exact: true }).click();
    assert.equal(
      await page.getByRole("link", { name: "Official pricing" }).getAttribute("href"),
      "https://example.com/pricing",
    );
    assert.equal(await page.getByRole("link", { name: "Unsafe source" }).count(), 0);
    assert.match(
      await page.locator(".pricing-details").innerText(),
      /Standard short-context rates/,
    );
    await page.screenshot({
      path: `/tmp/dashboard-cost-${mobile ? "phone" : "desktop"}-unconfigured.png`,
      fullPage: true,
    });
    await page.getByText("Set your monthly subscription fees", { exact: true }).click();
    await page.getByLabel("Claude combined monthly fee (USD)").fill("31");
    await page.getByLabel("Codex / ChatGPT monthly fee (USD)").fill("28");
    await page.getByRole("button", { name: "Save fees" }).click();
    const values = page.locator(".comparison-values .v");
    assert.match(
      await page.locator(".comparison-result").innerText(),
      /2\/2 matching turns priced/,
    );
    assert.equal(await values.nth(0).innerText(), "$20.00"); // Pi excluded
    assert.equal(await values.nth(1).innerText(), "$4.01"); // 31/31 + 31/28 + 28/31 + 28/28
    assert.equal(await values.nth(2).innerText(), "$15.99");
    await page.reload();
    await page.locator(".kpis").waitFor();
    assert.equal(await page.locator(".comparison-values .v").nth(1).innerText(), "$4.01");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      path: `/tmp/dashboard-cost-${mobile ? "phone" : "desktop"}-configured.png`,
      fullPage: true,
    });
    await page.getByText("Set your monthly subscription fees", { exact: true }).click();
    await page.getByLabel("Claude combined monthly fee (USD)").fill("3100");
    await page.getByLabel("Codex / ChatGPT monthly fee (USD)").fill("2800");
    await page.getByRole("button", { name: "Save fees" }).click();
    assert.equal(await page.locator(".comparison-values .v").nth(1).innerText(), "$401.04");
    assert.equal(await page.locator(".comparison-values .v").nth(2).innerText(), "−$381.04");
    partial = true;
    await page.reload();
    await page.locator(".kpis").waitFor();
    assert.match(await page.locator(".kpis").innerText(), /2\/3 turns priced · partial coverage/);
    assert.equal(await page.locator(".comparison-values .v").nth(2).innerText(), "—");
    legacy = true;
    await page.reload();
    await page.locator(".kpis").waitFor();
    assert.match(await page.locator(".kpis").innerText(), /999/);
    assert.match(await page.locator(".kpis").innerText(), /0\/1 turns priced/);
    assert.equal(await page.locator(".comparison-values .v").nth(2).innerText(), "—");
    assert.match(await page.locator("#dm").innerText(), /old costs are unverified/);
    assert.ok(await page.locator("svg.chart path.bar").count());
    const savingsPanel = page
      .locator(".panel")
      .filter({ has: page.getByRole("heading", { name: "Context saved", exact: true }) });
    const sourcePanel = (name: string) =>
      page.locator(".src").filter({ has: page.getByRole("heading", { name, exact: true }) });
    const savingsKpis = page.locator(".kpis > *");
    assert.match(await savingsKpis.nth(4).innerText(), /\n0\n/);
    assert.match(await savingsPanel.innerText(), /No savings recorded/);
    for (const scenario of ["missing", "partial", "nonzero"] as const) {
      savings = scenario;
      await page.reload();
      await page.locator(".kpis").waitFor();
      const missingHeadroom = scenario !== "nonzero";
      assert.match(await savingsKpis.nth(5).innerText(), missingHeadroom ? /—/ : /3.4k/);
      assert.match(await savingsKpis.nth(4).innerText(), scenario === "missing" ? /—/ : /1.2k/);
      if (missingHeadroom) {
        assert.match(
          await sourcePanel("Headroom").innerText(),
          /Savings unavailable. Reload to retry/,
        );
        assert.deepEqual(await sourcePanel("Headroom").locator("dd").allTextContents(), [
          "—",
          "—",
          "—",
          "—",
          "—",
        ]);
      }
      if (scenario === "missing") {
        assert.match(await sourcePanel("RTK").innerText(), /Unavailable/);
        assert.deepEqual(await sourcePanel("RTK").locator("dd").allTextContents(), [
          "—",
          "—",
          "—",
          "—",
        ]);
        assert.match(await savingsPanel.innerText(), /Savings unavailable. Reload to retry/);
        assert.doesNotMatch(await savingsPanel.innerText(), /No savings recorded/);
        assert.equal(await savingsPanel.locator("svg").count(), 0);
      } else {
        assert.ok(await savingsPanel.locator("svg.chart path.bar").count());
        const chartText = (
          await savingsPanel
            .locator("g.hov")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))
        ).join("|");
        assert.match(chartText, /RTK.*1.2k/);
        if (scenario === "partial") {
          assert.doesNotMatch(chartText, /Headroom/);
          assert.match(await savingsPanel.innerText(), /Headroom savings unavailable/);
        } else assert.match(chartText, /Headroom.*3.4k/);
      }
      await page.getByText("Show data as a table", { exact: true }).click();
      const cells = await page
        .locator("details.table tbody tr")
        .first()
        .locator("td")
        .allTextContents();
      assert.equal(cells[4], scenario === "missing" ? "—" : "1.2k");
      assert.equal(cells[5], missingHeadroom ? "—" : "3.4k");
      await page.getByText("Show data as a table", { exact: true }).click();
      await page.evaluate(() => scrollTo(0, 0));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: `/tmp/dashboard-savings-${mobile ? "phone" : "desktop"}-${scenario}.png`,
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "PASS dashboard restored and legacy usage, subscription configuration, calendar proration, scope, persistence, desktop and phone",
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
