// Usage dashboard in real Chromium: renders from /api/dashboard, range switching, no page errors, no horizontal overflow on a phone,
// all requests first-party. Needs a server (any provider mode); spends nothing.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const browser = await chromium.launch();
for (const [name, viewport, scheme] of [
  ["desktop-light", { width: 1280, height: 900 }, "light"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
] as const) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([
    {
      name: "__Host-ac_session",
      value: makeToken(),
      domain: new URL(BASE).hostname,
      path: "/",
      secure: true,
    },
  ]);
  const page = await ctx.newPage();
  const errors: string[] = [],
    external: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u);
  });
  await page.goto(`${BASE}/dashboard#7`);
  await page.waitForSelector(".kpis");
  const kpis = await page.locator(".kpis:not(.lat-kpis) .kpi .l").allInnerTexts();
  check(
    `${name}: scoped headline numbers`,
    kpis.join("|") ===
      "Turns|Input tokens|Output tokens|Estimated API cost|RTK output reduction|Headroom input reduction",
    kpis.join("|"),
  );
  check(
    `${name}: usage and savings charts, source panels, breakdowns`,
    (await page.locator("svg.chart").count()) >= 2 &&
      (await page.locator(".src").count()) === 2 &&
      (await page.locator(".panel h2").allInnerTexts()).includes("Tools"),
  );
  check(
    `${name}: 7 days is selected`,
    (await page.getAttribute('.range [data-r="7"]', "aria-pressed")) === "true",
  );
  await page.click('.range [data-r="30"]');
  await page.waitForFunction(
    () =>
      document.querySelector('.range [data-r="30"]')!.getAttribute("aria-pressed") === "true" &&
      document.getElementById("dm")!.getAttribute("aria-busy") === "false",
  );
  check(
    `${name}: range switch re-renders and updates the URL`,
    (await page.evaluate(() => location.hash)) === "#30",
  );
  await page.click('.range [data-r="custom"]');
  check(`${name}: Custom reveals date inputs`, await page.locator("#custom").isVisible());
  const bar = page.locator("svg.chart g.hov").first();
  if (await bar.count()) {
    await bar.hover();
    check(`${name}: hovering a bar shows a tooltip`, await page.locator("#tip").isVisible());
  }
  await page.click('.range [data-r="7"]');
  await page.waitForSelector(".kpis");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check(`${name}: no horizontal overflow`, !overflow);
  await page.screenshot({ path: `${OUT}/dashboard-${name}.png`, fullPage: true });
  // Tokens tab: tab semantics, URL state, panels, duplicate flags, privacy of the overhead response, keyboard back to Usage.
  const ohResp = page.waitForResponse((x) => x.url().includes("/api/dashboard/overhead"));
  await page.click("#tab-tokens");
  const ohText = await (await ohResp).text();
  await page.waitForFunction(
    () =>
      document.getElementById("dt")!.getAttribute("aria-busy") === "false" &&
      document.querySelectorAll("#dt .panel h2").length >= 5,
  );
  check(
    `${name}: Tokens tab is selected and in the URL`,
    (await page.getAttribute("#tab-tokens", "aria-selected")) === "true" &&
      (await page.getAttribute("#tab-usage", "aria-selected")) === "false" &&
      new URL(page.url()).searchParams.get("tab") === "tokens",
  );
  const titles = await page.locator("#dt .panel h2").allInnerTexts();
  const wanted = ["By provider", "By model", "By project", "Top threads", "Tools"];
  check(
    `${name}: Tokens spend panels`,
    wanted.every((t) => titles.includes(t)),
    titles.join("|"),
  );
  check(
    `${name}: Prompt overhead section`,
    (await page.locator("#dt h2", { hasText: "Prompt overhead" }).count()) >= 1,
  );
  const flags = (await page.locator("#dt .tk-flag.warn").allInnerTexts())
    .map((t) => t.trim())
    .filter(Boolean);
  // The scratch server reads the real home, so check the documented shape instead of seeded file lines.
  const oh = JSON.parse(ohText);
  check(
    `${name}: a duplicate flag with text per reported duplicate`,
    flags.length > 0 === oh.duplicates?.length > 0,
    flags.slice(0, 2).join("|"),
  );
  const shape = new Set(["generatedAt", "cwd", "estimate", "providers", "duplicates", "skipped"]);
  const srcKeys = new Set([
    "id",
    "kind",
    "label",
    "path",
    "bytes",
    "tokensEst",
    "missing",
    "count",
    "hidden",
    "items",
    "dupSections",
    "dupOf",
  ]);
  const provKeys = new Set(["id", "label", "totalBytes", "tokensEst", "sources"]);
  const longs: string[] = [],
    badKeys: string[] = [];
  const walk = (v: unknown, k = "") => {
    if (typeof v === "string" && v.length > 200) longs.push(k);
    else if (Array.isArray(v))
      v.forEach((x) => {
        walk(x, k);
      });
    else if (v && typeof v === "object") for (const [kk, x] of Object.entries(v)) walk(x, kk);
  };
  walk(oh);
  for (const k of Object.keys(oh)) if (!shape.has(k)) badKeys.push(k);
  for (const p of oh.providers || []) {
    for (const k of Object.keys(p)) if (!provKeys.has(k)) badKeys.push(k);
    for (const s of p.sources || [])
      for (const k of Object.keys(s)) if (!srcKeys.has(k)) badKeys.push(k);
  }
  check(
    `${name}: overhead response has only documented fields and no long strings`,
    !badKeys.length && !longs.length,
    badKeys.concat(longs).join(","),
  );
  if (name === "phone-dark")
    check(
      `${name}: Tokens tab has no horizontal overflow`,
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )),
    );
  await page.screenshot({ path: `${OUT}/dashboard-tokens-${name}.png`, fullPage: true });
  await page.focus("#tab-tokens");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    () =>
      document.getElementById("dm")!.getAttribute("aria-busy") === "false" &&
      !document.getElementById("dm")!.hidden,
  );
  check(
    `${name}: arrow key returns to Usage`,
    (await page.getAttribute("#tab-usage", "aria-selected")) === "true" &&
      (await page.locator("#dt").isHidden()) &&
      (await page.locator(".kpis").count()) > 0 &&
      !new URL(page.url()).searchParams.has("tab"),
  );
  check(
    `${name}: no console errors, first-party only`,
    errors.length === 0 && external.length === 0,
    errors.concat(external).join(" | ").slice(0, 200),
  );
  await ctx.close();
}
const r = await fetch(`${BASE}/api/dashboard?from=1&to=${Date.now()}`, {
  headers: { cookie: `__Host-ac_session=${makeToken()}` },
});
check("api: refuses ranges over 400 days", r.status === 400);
await browser.close();
if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall dashboard checks passed");
