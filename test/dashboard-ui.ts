// Usage dashboard in real Chromium: renders from /api/dashboard, range switching, no page errors, no horizontal overflow on a phone,
// all requests first-party. Needs a server (any provider mode); spends nothing.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) failed++; };
const browser = await chromium.launch();
for (const [name, viewport, scheme] of [["desktop-light", { width: 1280, height: 900 }, "light"], ["phone-dark", { width: 390, height: 844 }, "dark"]] as const) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [], external: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => { const u = r.url(); if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u); });
  await page.goto(`${BASE}/dashboard#7`);
  await page.waitForSelector(".kpis");
  const kpis = await page.locator(".kpi .l").allInnerTexts();
  check(`${name}: scoped headline numbers`, kpis.join("|") === "Turns|Known tokens processed|API-equivalent cost|RTK output reduction|Headroom input reduction", kpis.join("|"));
  check(`${name}: usage and savings charts, source panels, breakdowns`, (await page.locator("svg.chart").count()) >= 2 && (await page.locator(".src").count()) === 2 && (await page.locator(".panel h2").allInnerTexts()).includes("Tools"));
  check(`${name}: 7 days is selected`, (await page.getAttribute('.range [data-r="7"]', "aria-pressed")) === "true");
  await page.click('.range [data-r="30"]');
  await page.waitForFunction(() => document.querySelector('.range [data-r="30"]')!.getAttribute("aria-pressed") === "true" && document.getElementById("dm")!.getAttribute("aria-busy") === "false");
  check(`${name}: range switch re-renders and updates the URL`, (await page.evaluate(() => location.hash)) === "#30");
  await page.click('.range [data-r="custom"]');
  check(`${name}: Custom reveals date inputs`, await page.locator("#custom").isVisible());
  const bar = page.locator("svg.chart g.hov").first();
  if (await bar.count()) { await bar.hover(); check(`${name}: hovering a bar shows a tooltip`, await page.locator("#tip").isVisible()); }
  await page.click('.range [data-r="7"]');
  await page.waitForSelector(".kpis");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check(`${name}: no horizontal overflow`, !overflow);
  await page.screenshot({ path: `${OUT}/dashboard-${name}.png`, fullPage: true });
  check(`${name}: no console errors, first-party only`, errors.length === 0 && external.length === 0, errors.concat(external).join(" | ").slice(0, 200));
  await ctx.close();
}
const r = await fetch(`${BASE}/api/dashboard?from=1&to=${Date.now()}`, { headers: { cookie: `ac_session=${makeToken()}` } });
check("api: refuses ranges over 400 days", r.status === 400);
await browser.close();
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall dashboard checks passed");
