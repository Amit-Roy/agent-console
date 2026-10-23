import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp/benchmark-qa";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, viewport, colorScheme] of [
    ["desktop", { width: 1440, height: 1100 }, "light"],
    ["phone", { width: 390, height: 844 }, "dark"],
  ] as const) {
    const context = await browser.newContext({ viewport, colorScheme });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
    const page = await context.newPage(),
      errors: string[] = [],
      external: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith(BASE) && !r.url().startsWith("data:")) external.push(r.url());
    });
    await page.goto(`${BASE}/benchmarks`);
    await page.waitForFunction(
      () => document.querySelector("#benchmark-main")?.getAttribute("aria-busy") === "false",
    );
    const data = await page.evaluate(async () => (await fetch("/api/benchmarks")).json());
    assert.ok(data.snapshot.models.length > 0, "The QA server needs a cached benchmark snapshot.");
    assert.equal(
      data.subscriptions.totalMonthly,
      60,
      "Seed three $20 subscription fees in the QA data directory.",
    );
    assert.match(
      await page.locator("#subscription-cost").innerText(),
      /\$60\/month fixed across 3 subscriptions/,
    );
    assert.equal(await page.locator("#subscription-plans h3").count(), 3);
    assert.match(
      await page.locator("#subscription-capacity").innerText(),
      /112 productive hours\/week is not established/,
    );
    assert.match(await page.locator("#subscription-overflow").innerText(), /unknown/);
    assert.ok((await page.locator("#models tr").count()) > 0);
    assert.ok(await page.locator("#comparison-chart").isVisible());
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.selectOption("#cache", "conservative");
    const standard = await page.locator("#recommendation-cost").innerText();
    await page.selectOption("#cache", "known");
    assert.notEqual(
      await page.locator("#recommendation-cost").innerText(),
      standard,
      "Cache assumptions change projected cost.",
    );
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    const expected = data.snapshot.models
      .filter((m: any) => m.intelligence !== null)
      .map((m: any) => {
        const u = data.usage;
        const rates = [
          m.inputPrice,
          m.cacheReadPrice ?? m.inputPrice,
          m.cacheWritePrice ?? m.inputPrice,
          m.outputPrice,
        ];
        const tokens = [u.fresh, u.cacheRead, u.cacheWrite, u.output];
        const hourly = rates.some((rate: any, i: number) => tokens[i] > 0 && rate === null)
          ? null
          : rates.reduce((s: number, rate: number, i: number) => s + tokens[i] * rate, 0) /
            1e6 /
            u.activeHours;
        return { ...m, monthly: hourly === null ? null : (hourly * 16 * 7 * 52) / 12 };
      })
      .filter(
        (m: any, _: number, all: any[]) =>
          m.monthly !== null && m.intelligence >= Math.max(...all.map((x) => x.intelligence)) * 0.9,
      )
      .sort((a: any, b: any) => a.monthly - b.monthly || b.intelligence - a.intelligence)[0];
    assert.equal(await page.locator("#recommendation-title").innerText(), expected.name);
    await page.fill("#overflow", "10");
    const combined = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(60 + expected.monthly * 0.1);
    assert.ok(
      (await page.locator("#subscription-overflow").innerText()).includes(
        `${combined}/month combined`,
      ),
    );
    await page.fill("#overflow", "0");
    assert.match(await page.locator("#subscription-overflow").innerText(), /\$60\/month combined/);
    await page.fill("#overflow", "");
    assert.match(await page.locator("#subscription-overflow").innerText(), /unknown/);
    await page.locator(".subscription-overview summary").click();
    await page.fill("#fee-codex", "25");
    await page.click("#save-fees");
    await page.waitForFunction(() =>
      document.querySelector("#subscription-cost")?.textContent?.includes("$65/month"),
    );
    await page.fill("#fee-codex", "20");
    await page.click("#save-fees");
    await page.waitForFunction(() =>
      document.querySelector("#subscription-cost")?.textContent?.includes("$60/month"),
    );
    await page.locator(".subscription-overview summary").click();
    await page.fill("#budget", "0");
    assert.match(
      await page.locator("#recommendation-title").innerText(),
      /No priced model|More usage/,
    );
    await page.fill("#budget", "");
    await page.fill("#hours", "0");
    assert.match(await page.locator("#recommendation-title").innerText(), /Check your comparison/);
    assert.equal(await page.locator("#models tr").count(), 0);
    await page.fill("#hours", "16");
    await page.selectOption("#score", "coding");
    assert.match(await page.locator("#table-count").innerText(), /coding/i);
    await page.selectOption("#score", "intelligence");
    await page.locator("#models button").first().click();
    assert.match(await page.locator("#selection").innerText(), /seconds to first answer token/);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const settingsResponse = await page.evaluate(async () => {
      const rejected = await fetch("/api/benchmarks/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekly: "yes" }),
      });
      const saved = await fetch("/api/benchmarks/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekly: false }),
      });
      const body = await saved.json();
      await fetch("/api/benchmarks/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekly: true }),
      });
      return { rejected: rejected.status, weekly: body.weekly, next: body.nextRefreshAt };
    });
    assert.deepEqual(settingsResponse, { rejected: 400, weekly: false, next: null });
    await page.route("**/api/benchmarks", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...data,
          subscriptions: {
            ...data.subscriptions,
            configured: false,
            totalMonthly: null,
            plans: data.subscriptions.plans.map((p: any) => ({
              ...p,
              monthly: null,
              windows: [],
              updatedAt: null,
            })),
          },
        }),
      }),
    );
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector("#benchmark-main")?.getAttribute("aria-busy") === "false",
    );
    assert.match(await page.locator("#subscription-cost").innerText(), /not configured/);
    assert.equal(
      (await page.locator("#subscription-plans").innerText()).match(/quota unknown/g)?.length,
      6,
    );
    await page.fill("#overflow", "0");
    assert.match(await page.locator("#subscription-overflow").innerText(), /Set subscription fees/);
    console.log(
      `PASS ${name}: real cached data, projection, cache scenario, budget, invalid settings, selection, responsive layout, first-party only`,
    );
    await context.close();
  }
  assert.equal(
    (await fetch(`${BASE}/api/benchmarks`)).status,
    401,
    "Benchmark data requires authentication.",
  );
  assert.equal(
    (
      await fetch(`${BASE}/api/benchmarks/refresh`, {
        method: "POST",
        headers: { Cookie: `ac_session=${makeToken()}`, Origin: "https://other.example" },
      })
    ).status,
    403,
    "Cross-origin refreshes are rejected before upstream work.",
  );
  assert.equal(
    (
      await fetch(`${BASE}/api/benchmarks/subscriptions`, {
        method: "POST",
        headers: {
          Cookie: `ac_session=${makeToken()}`,
          Origin: "https://other.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fees: { claude: 20, "claude:nefro": 20, codex: 20 } }),
      })
    ).status,
    403,
  );
} finally {
  await browser.close();
}
