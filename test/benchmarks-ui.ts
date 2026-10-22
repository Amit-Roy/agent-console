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
    const page = await context.newPage(), errors: string[] = [], external: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (!r.url().startsWith(BASE) && !r.url().startsWith("data:")) external.push(r.url()); });
    await page.goto(`${BASE}/benchmarks`);
    await page.waitForFunction(() => document.querySelector("#benchmark-main")?.getAttribute("aria-busy") === "false");
    const data = await page.evaluate(async () => (await fetch("/api/benchmarks")).json());
    assert.ok(data.snapshot.models.length > 0, "The QA server needs a cached benchmark snapshot.");
    assert.ok(await page.locator("#models tr").count() > 0);
    assert.ok(await page.locator("#comparison-chart").isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.selectOption("#cache", "conservative");
    const standard = await page.locator("#recommendation-cost").innerText();
    await page.selectOption("#cache", "known");
    assert.notEqual(await page.locator("#recommendation-cost").innerText(), standard, "Cache assumptions change projected cost.");
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    const expected = data.snapshot.models.filter((m: any) => m.intelligence !== null).map((m: any) => {
      const u = data.usage;
      const rates = [m.inputPrice, m.cacheReadPrice ?? m.inputPrice, m.cacheWritePrice ?? m.inputPrice, m.outputPrice];
      const tokens = [u.fresh, u.cacheRead, u.cacheWrite, u.output];
      const hourly = rates.some((rate: any, i: number) => tokens[i] > 0 && rate === null) ? null : rates.reduce((s: number, rate: number, i: number) => s + tokens[i] * rate, 0) / 1e6 / u.activeHours;
      return { ...m, monthly: hourly === null ? null : hourly * 16 * 7 * 52 / 12 };
    }).filter((m: any, _: number, all: any[]) => m.monthly !== null && m.intelligence >= Math.max(...all.map(x => x.intelligence)) * .9).sort((a: any, b: any) => a.monthly - b.monthly || b.intelligence - a.intelligence)[0];
    assert.equal(await page.locator("#recommendation-title").innerText(), expected.name);
    await page.fill("#budget", "0");
    assert.match(await page.locator("#recommendation-title").innerText(), /No priced model|More usage/);
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
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const settingsResponse = await page.evaluate(async () => {
      const rejected = await fetch('/api/benchmarks/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekly: 'yes' }) });
      const saved = await fetch('/api/benchmarks/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekly: false }) });
      const body = await saved.json();
      await fetch('/api/benchmarks/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekly: true }) });
      return { rejected: rejected.status, weekly: body.weekly, next: body.nextRefreshAt };
    });
    assert.deepEqual(settingsResponse, { rejected: 400, weekly: false, next: null });
    console.log(`PASS ${name}: real cached data, projection, cache scenario, budget, invalid settings, selection, responsive layout, first-party only`);
    await context.close();
  }
  assert.equal((await fetch(`${BASE}/api/benchmarks`)).status, 401, 'Benchmark data requires authentication.');
  assert.equal((await fetch(`${BASE}/api/benchmarks/refresh`, { method: 'POST', headers: { Cookie: `ac_session=${makeToken()}`, Origin: 'https://other.example' } })).status, 403, 'Cross-origin refreshes are rejected before upstream work.');
} finally { await browser.close(); }
