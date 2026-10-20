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
  await page.waitForSelector("#proc-rows .hrow.proc");
  const dials = await page.locator(".dial .c .l").allInnerTexts();
  check(`${name}: dials`, dials.join("|").toUpperCase() === "CPU|MEMORY|DISK|LOAD", dials.join("|"));
  check(`${name}: dial values`, (await page.locator(".dial .c .v").allInnerTexts()).every(v => v.trim().length > 0));
  await page.waitForFunction(() => document.querySelectorAll(".charts canvas").length === 3 && !!(globalThis as any).Chart);
  check(`${name}: history ranges`, (await page.locator("#range button").allInnerTexts()).join("|") === "5m|1h|12h|24h");
  await page.click('#range button[data-range="86400"]');
  check(`${name}: range switch`, await page.locator('#range button[data-range="86400"]').getAttribute("aria-pressed") === "true");
  const label = await page.locator("#proc-rows .hrow.proc .hname b").first().innerText();
  check(`${name}: process label`, label.length > 0 && label !== "MainThread", label);
  const pid = await page.locator("#proc-rows .hrow.proc .kill").first().getAttribute("data-pid");
  const kill = page.locator(`#proc-rows .hrow.proc .kill[data-pid="${pid}"]`);
  await kill.click();
  check(`${name}: kill arms confirm`, (await kill.innerText()) === "Confirm" && await kill.evaluate(b => b.classList.contains("armed")));
  await page.waitForTimeout(2600); // survives a refresh without being replaced
  check(`${name}: confirm survives refresh`, (await kill.innerText()) === "Confirm");
  await page.keyboard.press("Escape");
  check(`${name}: port kill`, await page.locator("#port-rows .hrow.port .kill").count() > 0);
  check(`${name}: storage mounts`, (await page.locator("#mounts .mount b").allInnerTexts()).some(t => t.split(" · ").includes("/")));
  check(`${name}: no /etc/hosts mount`, !(await page.locator("#mounts .mount b").allInnerTexts()).some(t => t.includes("/etc/hosts")));
  await page.fill("#proc-filter", "zzz-no-such-process");
  check(`${name}: filter empties list`, await page.locator("#proc-rows .hrow.proc").count() === 0);
  await page.fill("#proc-filter", "");
  const drill = page.locator("#du-rows button.hrow").first();
  if (await drill.count()) {
    const target = await drill.getAttribute("data-path");
    await drill.click();
    await page.waitForFunction((t) => document.querySelector("#du-crumbs [aria-current]")?.textContent === t?.split("/").pop(), target);
    check(`${name}: disk drill-down`, true, target ?? "");
  }
  await page.locator("#proc-rows .hrow.proc .hname").first().click();
  await page.waitForSelector("#proc-modal:not([hidden]) .pm-head h2");
  check(`${name}: detail modal`, await page.locator("#proc-modal .pm-acts .kill").count() === 2);
  await page.keyboard.press("Escape");
  check(`${name}: modal closes`, await page.locator("#proc-modal").isHidden());
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
  const r = await fetch(`${BASE}/api/host/history?range=300`, { headers: { cookie: `ac_session=${makeToken()}` } });
  const j = await r.json();
  check("api: history shape", j.cols?.[0] === "ts" && Array.isArray(j.points), JSON.stringify(j).slice(0, 120));
}
{
  const r = await fetch(`${BASE}/api/host/du?path=/`, { headers: { cookie: `ac_session=${makeToken()}` } });
  const j = await r.json();
  check("api: du shape", j.path === "/" && Array.isArray(j.children), JSON.stringify(j).slice(0, 120));
}
{
  const r = await fetch(`${BASE}/api/host/du/rescan`, { method: "POST", headers: { cookie: `ac_session=${makeToken()}`, origin: "https://evil.example" } });
  check("api: rescan refuses cross-site", r.status === 403, String(r.status));
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
