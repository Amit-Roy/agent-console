// Security page Tools section + sidebar security indicator + Files in More: real browser, mocked /api/security.
import fs from "node:fs";
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";
import { HISTORY, LATEST } from "./security-mock.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp/tw-evidence";
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const rec = (tool: string, installed: string, fixed: string, scope = "workspace") => ({
  key: `${tool}:${fixed}`,
  tool,
  installed,
  fixed,
  official_url: `https://example.com/${tool}`,
  checksum_source: `https://example.com/${tool}/sha256`,
  osv_ids: [],
  scope,
  advisories: 0,
});
const TOOLS = {
  generatedAt: "2026-10-23T00:00:00Z",
  records: [
    { ...rec("uv", "0.9.1", "0.9.9"), pr: 12 },
    { ...rec("node", "22.9.0", "22.9.0", "host"), pr: null },
    { ...rec("gh", "2.60.0", "2.61.0"), pr: null },
    { ...rec("rg", "14.0.0", "14.1.0"), pr: null, failed: true },
  ],
  mismatches: [
    { tool: "gh", path: "/usr/local/bin/gh", expected: "a".repeat(64), actual: "b".repeat(64) },
  ],
  errors: [],
  enabled: true,
};
const withTools = (tools: unknown) => (route: any) => route.fulfill(json(tools));
const browser = await chromium.launch();
let runs = 0;
for (const [name, viewport, scheme] of [
  ["desktop-light", { width: 1280, height: 900 }, "light"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
] as const) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/api/security/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace("/api/security/", "");
    if (p === "tools/run") return runs++, route.fulfill(json({ started: true }));
    if (p === "tools") return route.fulfill(json(TOOLS));
    if (p === "latest") return route.fulfill(json({ result: LATEST }));
    if (p === "history") return route.fulfill(json({ scans: HISTORY }));
    if (p === "status")
      return route.fulfill(json({ running: false, startedAt: null, currentTool: null }));
    return route.fulfill(json({ error: "unmocked" }, 500));
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector("#tw-rows tr");
  const rows = await page.locator("#tw-rows tr").allInnerTexts();
  check(`${name}: four tool rows`, rows.length === 4, rows.join(" | "));
  const text = rows.map((r) => r.replace(/\s+/g, " ")).join("|");
  check(`${name}: OK status`, /node 22\.9\.0 22\.9\.0 OK/i.test(text), text);
  check(`${name}: PR link`, /uv 0\.9\.1 0\.9\.9 Update available PR #12/i.test(text), text);
  check(`${name}: failed patch`, /rg .* Patch failed/i.test(text), text);
  check(
    `${name}: PR href`,
    (await page.locator("#tw-rows a").first().getAttribute("href"))?.endsWith("/pull/12") === true,
  );
  check(`${name}: unsanctioned change wins`, /gh .* Unsanctioned change/i.test(text), text);
  check(
    `${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await page.locator("#toolwatch").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/security-${name}.png` });
  await page.click("#tw-check");
  await page.waitForFunction(() =>
    document.getElementById("toast")?.textContent?.includes("Tool check"),
  );
  check(`${name}: Check now posts run`, runs > 0);
  check(`${name}: no console errors`, errors.length === 0, errors.join(" | ").slice(0, 200));

  // Sidebar: shield indicator + Files in the More menu.
  const tools = (over: Record<string, unknown>) => ({ ...TOOLS, ...over });
  const labelFor = async (data: unknown) => {
    await page.unroute("**/api/security/tools");
    await page.route("**/api/security/tools", withTools(data));
    await page.goto(BASE);
    await page.waitForSelector("#sec-status:not([data-tone=''])", { state: "attached" });
    return [
      await page.locator("#sec-status").getAttribute("aria-label"),
      await page.locator("#sec-status").getAttribute("data-tone"),
    ];
  };
  const clear = tools({ records: [], mismatches: [] });
  const behind = tools({ records: [{ ...rec("uv", "1", "2"), pr: null }], mismatches: [] });
  const open = tools({ records: [{ ...rec("uv", "1", "2"), pr: 12 }], mismatches: [] });
  const red = tools({ records: [], mismatches: TOOLS.mismatches });
  check(`${name}: all clear`, (await labelFor(clear)).join() === "Security: all clear,ok");
  check(`${name}: tool behind`, (await labelFor(behind)).join() === "Security: 1 tool behind,warn");
  check(`${name}: PR open`, (await labelFor(open)).join() === "Security: 1 patch PR open,warn");
  check(
    `${name}: mismatch is red`,
    (await labelFor(red)).join() === "Security: 1 unsanctioned change,bad",
  );
  await page.unroute("**/api/security/tools");
  await page.route("**/api/security/tools", withTools(TOOLS));
  await page.goto(BASE);
  await page.waitForSelector("#sec-status:not([data-tone=''])", { state: "attached" });
  const sec = page.locator("#sec-status");
  check(`${name}: shield links to /security`, (await sec.getAttribute("href")) === "/security");
  check(`${name}: red wins over amber`, (await sec.getAttribute("data-tone")) === "bad");
  if (viewport.width < 800)
    await page
      .locator("#menu")
      .first()
      .click()
      .catch(() => {});
  check(`${name}: shield visible`, await sec.isVisible());
  const dot = await sec.locator(".sec-dot").boundingBox();
  const box = await sec.boundingBox();
  check(
    `${name}: dot inside button`,
    !!dot && !!box && dot.x >= box.x && dot.x + dot.width <= box.x + box.width + 1,
  );
  check(
    `${name}: no #files button in row`,
    (await page.locator(".side-actions #files").count()) === 0,
  );
  await page.click("#side-more");
  const item = page.getByRole("menuitem", { name: /Files/ });
  check(`${name}: Files in More`, await item.isVisible());
  await page.screenshot({ path: `${OUT}/sidebar-${name}.png` });
  await item.click();
  await page
    .waitForSelector("dialog[open], #viewer, [data-viewer]", { timeout: 5000 })
    .catch(() => {});
  check(
    `${name}: Files opens the viewer`,
    await page.evaluate(() => !!document.querySelector("dialog[open]")),
  );
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
