// Security page: real browser, phone + desktop, mocked /api/security, no console errors, first-party only.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";
import { LATEST, HISTORY } from "./security-mock.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) failed++; };
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const browser = await chromium.launch();
// the page scrolls inside #hm, so a full-page capture shows only the viewport: take the top and the bottom
async function shoot(page: any, name: string) {
  await page.evaluate(() => { document.getElementById("hm")!.scrollTop = 0; });
  await page.screenshot({ path: `${OUT}/security-${name}.png` });
  await page.evaluate(() => { const m = document.getElementById("hm")!; m.scrollTop = m.scrollHeight; });
  await page.screenshot({ path: `${OUT}/security-${name}-end.png` });
}

async function open(viewport: { width: number; height: number }, scheme: "light" | "dark", routes: Record<string, (n: number) => unknown>) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [], external: string[] = [], hits: Record<string, number> = {};
  page.on("console", (m) => m.type() === "error" && !/status of (50\d)/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => { const u = r.url(); if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u); });
  await page.route("**/api/security/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace("/api/security/", "").replace(/^scans\/.*/, "scans");
    hits[p] = (hits[p] || 0) + 1;
    const f = routes[p]; return f ? route.fulfill(json(f(hits[p]), (f(hits[p]) as any)?.__status || 200)) : route.fulfill(json({ error: "unmocked" }, 500));
  });
  return { ctx, page, errors, external, hits };
}
const findings = { latest: () => ({ result: LATEST }), history: () => ({ scans: HISTORY }), status: () => ({ running: false, startedAt: null, currentTool: null }), scans: () => LATEST, run: () => ({ started: true }) };

for (const [name, viewport, scheme] of [["desktop-light", { width: 1280, height: 900 }, "light"], ["phone-dark", { width: 390, height: 844 }, "dark"], ["phone-light", { width: 390, height: 844 }, "light"], ["desktop-dark", { width: 1280, height: 900 }, "dark"]] as const) {
  const { ctx, page, errors, external } = await open(viewport, scheme, findings);
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  check(`${name}: verdict`, (await page.locator("#verdict h2").innerText()).includes("Findings"));
  check(`${name}: readout`, (await page.locator(".readout dd").allInnerTexts()).join(",") === "1,3,1,3,3", (await page.locator(".readout dd").allInnerTexts()).join(","));
  check(`${name}: four tool cards`, await page.locator(".tool").count() === 4);
  check(`${name}: infected file listed`, (await page.locator("#findings").innerText()).includes("Win.Trojan.Agent-1234"));
  check(`${name}: falco groups by rule`, await page.locator("#falco-rows .hrow.tgt").count() === 2);
  await page.locator("#falco-rows .hrow.tgt", { hasText: "Terminal shell" }).click();
  check(`${name}: falco group expands`, await page.locator("#falco-rows .vuln").count() === 2);
  check(`${name}: open ports`, await page.locator("#port-rows .port").count() === 3);
  check(`${name}: history strip`, await page.locator("#strip .tick").count() === HISTORY.length);
  const t = page.locator("#trivy .hrow.tgt").first();
  await t.click();
  check(`${name}: target expands`, await t.getAttribute("aria-expanded") === "true" && await page.locator("#trivy .vuln").count() === 3);
  await page.check("#fixed-only");
  check(`${name}: fix-available filter`, await page.locator("#trivy .vuln").count() === 2);
  await page.uncheck("#fixed-only");
  await page.locator("#strip .tick").first().click();
  check(`${name}: history tick loads scan`, await page.locator("#strip .tick[aria-current]").count() === 1);
  check(`${name}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await shoot(page, name);
  check(`${name}: no console errors, first-party only`, errors.length === 0 && external.length === 0, errors.concat(external).join(" | ").slice(0, 200));
  await ctx.close();
}

// run flow: button -> running banner with current tool -> status polling -> finished -> refresh
{
  const phases = [{ running: true, startedAt: new Date().toISOString(), currentTool: "clamav" }];
  const { ctx, page, errors, hits } = await open({ width: 390, height: 844 }, "light", { ...findings, status: (n) => (n >= 3 ? { running: false, startedAt: null, currentTool: null } : phases[0]) });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  const status0 = hits.status;
  check("run: banner shows current tool", (await page.locator("#running").innerText()).includes("ClamAV") && await page.locator("#run").isDisabled());
  check("run: states duration", (await page.locator("#running").innerText()).includes("10 to 40 minutes"));
  await shoot(page, "running");
  await page.waitForSelector("#running", { state: "hidden", timeout: 20000 });
  check("run: polls then refreshes", status0 === 1 && hits.latest >= 2 && await page.locator("#run").isEnabled(), JSON.stringify(hits));
  check("run: no console errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  await page.click("#run");
  await page.waitForSelector("#running:not([hidden])");
  check("run: click starts and shows banner", hits.run === 1);
  await ctx.close();
}
// empty, unreachable and error states
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, "dark", { latest: () => ({ result: null }), history: () => ({ scans: [] }), status: () => ({ running: false, startedAt: null, currentTool: null }) });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  check("empty: no scan yet", (await page.locator("#verdict h2").innerText()) === "No scan yet" && await page.locator("#trivy").isHidden() && await page.locator("#history").isHidden());
  await shoot(page, "empty");
  await ctx.close();
}
{
  const down = (): any => ({ error: "Could not reach the scan host over SSH.", __status: 502 });
  const { ctx, page } = await open({ width: 390, height: 844 }, "dark", { latest: down, history: down, status: down });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector("#verdict h2");
  check("unreachable: explained", (await page.locator("#verdict").innerText()).includes("unreachable") && (await page.locator("#verdict").innerText()).includes("over SSH") && await page.locator("#tools").isHidden() && await page.locator("#verdict >> text=Try again").count() === 1);
  await shoot(page, "unreachable");
  await ctx.close();
}
{
  const errRes = { ...LATEST, status: "error", tools: { ...LATEST.tools, clamav: { ...LATEST.tools.clamav, status: "error", infected: [], error: "clamscan exited with code 2: database missing" }, falco: { ...LATEST.tools.falco, status: "error", alerts: [], error: "falco.service is not running" }, trivy: { ...LATEST.tools.trivy, status: "clean", targets: [] } } };
  const { ctx, page } = await open({ width: 390, height: 844 }, "light", { ...findings, latest: () => ({ result: errRes }) });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  check("error: tool error shown", (await page.locator(".tool .terr").first().innerText()).includes("database missing") && (await page.locator("#verdict h2").innerText()).includes("errors"));
  await shoot(page, "error");
  await ctx.close();
}
await browser.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
