// Security page Tools section: real browser, mocked /api/security, table rows, status labels, Check now.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";
import { HISTORY, LATEST } from "./security-mock.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
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
    rec("uv", "0.9.1", "0.9.9"),
    rec("node", "22.9.0", "22.9.0", "host"),
    rec("gh", "2.60.0", "2.61.0"),
  ],
  mismatches: [
    { tool: "gh", path: "/usr/local/bin/gh", expected: "a".repeat(64), actual: "b".repeat(64) },
  ],
  errors: [],
  gate: { open: false, enabled: false, why: "disabled" },
};
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
  check(`${name}: three tool rows`, rows.length === 3, rows.join(" | "));
  const text = rows.map((r) => r.replace(/\s+/g, " ")).join("|");
  check(`${name}: OK status`, /node 22\.9\.0 22\.9\.0 OK/i.test(text), text);
  check(`${name}: update available`, /uv 0\.9\.1 0\.9\.9 Update available/i.test(text), text);
  check(`${name}: unsanctioned change wins`, /gh .* Unsanctioned change/i.test(text), text);
  check(`${name}: gate note`, (await page.locator("#tw-note").innerText()).includes("off"));
  check(
    `${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await page.locator("#toolwatch").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/tool-watch-${name}.png` });
  await page.click("#tw-check");
  await page.waitForFunction(() =>
    document.getElementById("toast")?.textContent?.includes("Tool check"),
  );
  check(`${name}: Check now posts run`, runs > 0);
  check(`${name}: no console errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
