// Host dashboard: real browser, desktop + phone, first-party only, no console errors.
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
  await page.goto(`${BASE}/host`);
  await page.waitForSelector(".kpis");
  const kpis = await page.locator(".kpis .kpi .l").allInnerTexts();
  check(`${name}: kpis`, kpis.join("|") === "CPU|RAM|Disk|Load", kpis.join("|"));
  check(`${name}: gauges`, await page.locator(".gauge").count() >= 2);
  check(`${name}: process table`, (await page.locator("table.proc tbody tr").count()) > 0);
  check(`${name}: port table`, await page.locator("table.ports tbody tr").count() > 0);
  check(`${name}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await page.screenshot({ path: `${OUT}/host-${name}.png`, fullPage: true });
  check(`${name}: no console errors, first-party only`, errors.length === 0 && external.length === 0, errors.concat(external).join(" | ").slice(0, 200));
  await ctx.close();
}
// API contracts
CK: {
  const r = await fetch(`${BASE}/api/host/metrics`, { headers: { cookie: `ac_session=${makeToken()}` } });
  check("api: metrics ok", r.status === 200, String(r.status));
}
{
  const r = await fetch(`${BASE}/api/host/processes`, { headers: { cookie: `ac_session=${makeToken()}` } });
  const j = await r.json();
  check("api: processes shape", Array.isArray(j.processes) && j.processes.length > 0 && typeof j.processes[0].pid === "number", JSON.stringify(j).slice(0, 120));
}
{
  const r = await fetch(`${BASE}/api/host/ports`, { headers: { cookie: `ac_session=${makeToken()}` } });
  const j = await r.json();
  check("api: ports shape", Array.isArray(j.ports) && j.ports.length > 0 && typeof j.ports[0].port === "number", JSON.stringify(j).slice(0, 120));
}
// unauth refused
{
  const r = await fetch(`${BASE}/api/host/metrics`);
  check("api: unauth refused", r.status === 401, String(r.status));
}
await browser.close();
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall host checks passed");
