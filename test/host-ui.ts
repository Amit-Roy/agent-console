// Host dashboard: real browser, desktop + phone, first-party only, no console errors.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

// Isolated server on a temp data dir, seeded with a Headroom profile; never the deployed console.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "host-ui-"));
const data = path.join(scratch, "data");
fs.mkdirSync(data, { recursive: true });
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const { HeadroomProfileStore } = await import("../server/headroom-profile.ts");
const MIB = 1024 * 1024;
const MINUTE = 60_000;
const SITE_COUNT = 20;

function seedProfile(file: string) {
  const store = new HeadroomProfileStore(file);
  const pid = 4242;
  const now = Date.now();
  const stepMinutes = [10, 22, 35, 48];
  const rssAt = (minute: number) =>
    500 * MIB + stepMinutes.filter((step) => minute >= step).length * 142.5 * MIB + minute * 0.05 * MIB;
  for (let minute = 0; minute <= 60; minute++) {
    const sampledAt = now - (60 - minute) * MINUTE + 1000;
    const rss = rssAt(minute);
    store.recordSample(pid, { rssBytes: rss, time: sampledAt }, { anon: rss * 0.72, fileBacked: rss * 0.2 });
    if (minute % 2 === 0) {
      store.recordMetrics(
        pid,
        [
          { name: "process.runtime.cpython.memory", attr: "type=rss", value: rss * 0.9 },
          { name: "headroom.malloc.arena_bytes", attr: null, value: rss * 0.6 },
          { name: "headroom.malloc.in_use_bytes", attr: null, value: rss * 0.35 },
          { name: "headroom.malloc.free_held_bytes", attr: null, value: rss * 0.2 + minute * MIB },
          { name: "process.runtime.cpython.gc_count", attr: "count=0", value: 120 + minute },
          { name: "process.runtime.cpython.gc_count", attr: "count=1", value: 8 },
          { name: "process.runtime.cpython.gc_count", attr: "count=2", value: 2 },
          { name: "process.runtime.cpython.thread_count", attr: null, value: 38 },
        ],
        sampledAt,
      );
    }
  }
  for (const minute of stepMinutes)
    store.recordSnapshot(pid, "step", rssAt(minute), now - (60 - minute) * MINUTE + 1000);
  store.recordSnapshot(pid, "breaker", rssAt(58), now - 2 * MINUTE);
  const sites = (scale: number) =>
    Array.from({ length: SITE_COUNT }, (_, index) => ({
      location: `headroom/proxy/module_${index}.py:${100 + index * 7}`,
      bytes: Math.round((SITE_COUNT - index) * 3.1 * MIB * scale),
      count: (SITE_COUNT - index) * 1200,
    }));
  store.recordSites(pid, sites(0.8), now - 20 * MINUTE);
  store.recordSites(pid, sites(1), now - 2 * MINUTE);
}
seedProfile(path.join(data, "latency.sqlite"));

const PORT = process.env.HOST_UI_PORT || "17851";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT || "/tmp";
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT,
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(scratch, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_WARM_MAX: "0",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErrors = "";
server.stderr?.on("data", (chunk) => (serverErrors += chunk.toString()));
const cleanup = () => {
  server.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (let attempt = 0; ; attempt++) {
  const ready = await fetch(`${BASE}/api/host/metrics`, {
    headers: { cookie: `ac_session=${makeToken()}` },
  }).then(
    (res) => res.ok,
    () => false,
  );
  if (ready) break;
  if (attempt > 150) throw new Error(`server did not start: ${serverErrors.slice(0, 300)}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
}
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const browser = await chromium.launch();
async function headroomChecks(page: any, name: string) {
  const card = page.locator("#headroom");
  await page.waitForSelector("#hr-body:not([hidden]) #hr-sites tbody tr");
  check(`${name}: headroom card`, await card.isVisible());
  check(`${name}: headroom chart canvas`, (await page.locator("#ch-hr").count()) === 1);
  await page.waitForFunction(() => !!(globalThis as any).Chart?.getChart("ch-hr"));
  check(
    `${name}: headroom sites rows`,
    (await page.locator("#hr-sites tbody tr").count()) === SITE_COUNT,
  );
  const legend = (await page.locator("#hr-legend li").allInnerTexts()).join("|");
  check(
    `${name}: headroom legend names snapshots`,
    legend.includes("Step snapshot ×4") && legend.includes("Breaker snapshot ×1"),
    legend,
  );
  const stats = (await page.locator("#hr-stats dd").allInnerTexts()).join("|");
  check(`${name}: headroom stats`, /GB/.test(stats) && /MB\/h/.test(stats), stats);
  // tall viewport so the whole card sits in one frame, clear of the sticky header
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.width, height: 2600 });
  await card.screenshot({ path: `${OUT}/host-headroom-${name}.png` });
  await page.setViewportSize(viewport);
  await headroomEmptyStates(page, name);
}
async function stubProfile(page: any, patch: (json: any) => any) {
  await page.route("**/api/host/headroom-profile*", async (route: any) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: patch(await res.json()) });
  });
}
async function headroomEmptyStates(page: any, name: string) {
  await stubProfile(page, (json) => ({ ...json, sites: { at: null, rows: [] } }));
  await page.click('#hr-range button[data-range="6h"]');
  await page.waitForSelector("#hr-sites-empty:not([hidden])");
  check(
    `${name}: headroom no-sites empty state`,
    (await page.locator("#hr-sites-empty").innerText()) ===
      "Allocation sites need AGENT_CONSOLE_HEADROOM_TRACEMALLOC=1 (adds CPU)",
  );
  await page.unroute("**/api/host/headroom-profile*");
  await stubProfile(page, () => ({ rss: [], snapshots: [], metrics: {}, sites: { at: null, rows: [] } }));
  await page.click('#hr-range button[data-range="24h"]');
  await page.waitForSelector("#hr-empty:not([hidden])");
  check(
    `${name}: headroom not reporting`,
    (await page.locator("#hr-empty").innerText()) === "Headroom profiler not reporting",
  );
  await page.unroute("**/api/host/headroom-profile*");
  await page.click('#hr-range button[data-range="1h"]');
  await page.waitForSelector("#hr-body:not([hidden]) #hr-sites tbody tr");
}
for (const [name, viewport, scheme] of [
  ["desktop-light", { width: 1280, height: 900 }, "light"],
  ["desktop-dark", { width: 1280, height: 900 }, "dark"],
  ["phone-light", { width: 390, height: 844 }, "light"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
] as const) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [],
    external: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u);
  });
  await page.goto(`${BASE}/host`);
  await page.waitForSelector("#proc-rows .hrow.proc");
  const dials = await page.locator(".dial .c .l").allInnerTexts();
  check(
    `${name}: dials`,
    dials.join("|").toUpperCase() === "CPU|MEMORY|DISK|LOAD",
    dials.join("|"),
  );
  check(
    `${name}: dial values`,
    (await page.locator(".dial .c .v").allInnerTexts()).every((v) => v.trim().length > 0),
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".charts canvas").length === 3 && !!(globalThis as any).Chart,
  );
  check(
    `${name}: history ranges`,
    (await page.locator("#range button").allInnerTexts()).join("|") === "5m|1h|12h|24h",
  );
  await headroomChecks(page, name);
  await page.click('#range button[data-range="86400"]');
  check(
    `${name}: range switch`,
    (await page.locator('#range button[data-range="86400"]').getAttribute("aria-pressed")) ===
      "true",
  );
  const label = await page.locator("#proc-rows .hrow.proc .hname b").first().innerText();
  check(`${name}: process label`, label.length > 0 && label !== "MainThread", label);
  // a long-lived, unprotected process, pinned with the filter so refreshes cannot drop it
  const pid = await page.evaluate(async () => {
    const j = await (await fetch("/api/host/processes")).json();
    return String(
      j.processes.filter((p: any) => !p.protected).sort((a: any, b: any) => a.pid - b.pid)[0].pid,
    );
  });
  await page.fill("#proc-filter", pid);
  const kill = page.locator(`#proc-rows .hrow.proc .kill[data-pid="${pid}"]`);
  await kill.click();
  check(
    `${name}: kill arms confirm`,
    (await kill.innerText()) === "Confirm" &&
      (await kill.evaluate((b) => b.classList.contains("armed"))),
  );
  await page.waitForTimeout(2600); // survives a refresh without being replaced
  check(`${name}: confirm survives refresh`, (await kill.innerText()) === "Confirm");
  await page.keyboard.press("Escape");
  await page.fill("#proc-filter", "");
  check(`${name}: port kill`, (await page.locator("#port-rows .hrow.port .kill").count()) > 0);
  check(
    `${name}: storage mounts`,
    (await page.locator("#mounts .mount b").allInnerTexts()).some((t) =>
      t.split(" · ").includes("/"),
    ),
  );
  check(
    `${name}: no /etc/hosts mount`,
    !(await page.locator("#mounts .mount b").allInnerTexts()).some((t) => t.includes("/etc/hosts")),
  );
  await page.fill("#proc-filter", "zzz-no-such-process");
  check(
    `${name}: filter empties list`,
    (await page.locator("#proc-rows .hrow.proc").count()) === 0,
  );
  await page.fill("#proc-filter", "");
  const drill = page.locator("#du-rows button.hrow").first();
  if (await drill.count()) {
    const target = await drill.getAttribute("data-path");
    await drill.click();
    await page.waitForFunction(
      (t) =>
        document.querySelector("#du-crumbs [aria-current]")?.textContent === t?.split("/").pop(),
      target,
    );
    check(`${name}: disk drill-down`, true, target ?? "");
  }
  await page.locator("#proc-rows .hrow.proc .hname").first().click();
  await page.waitForSelector("#proc-modal:not([hidden]) .pm-head h2");
  check(`${name}: detail modal`, (await page.locator("#proc-modal .pm-acts .kill").count()) === 2);
  await page.keyboard.press("Escape");
  check(`${name}: modal closes`, await page.locator("#proc-modal").isHidden());
  check(
    `${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await page.screenshot({ path: `${OUT}/host-${name}.png`, fullPage: true });
  check(
    `${name}: no console errors, first-party only`,
    errors.length === 0 && external.length === 0,
    errors.concat(external).join(" | ").slice(0, 200),
  );
  await ctx.close();
}
// deploy skew: new page files against an older server (no io field, no history endpoint)
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/api/host/metrics", async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    delete j.io;
    await route.fulfill({ response: r, json: j });
  });
  await page.route("**/api/host/history*", (route) =>
    route.fulfill({ status: 404, contentType: "text/html", body: "Cannot GET" }),
  );
  await page.goto(`${BASE}/host`);
  await page.waitForSelector("#proc-rows .hrow.proc");
  await page.waitForTimeout(2500);
  const toast = await page.locator("#toast.show").count();
  check(
    "skew: old server renders without errors",
    errors.length === 0 && toast === 0,
    errors.join(" | ").slice(0, 200),
  );
  check(
    "skew: history explains restart",
    (await page.locator("#cap-cpu").innerText()).includes("restart"),
  );
  await ctx.close();
}
// API contracts
{
  const r = await fetch(`${BASE}/api/host/metrics`, {
    headers: { cookie: `ac_session=${makeToken()}` },
  });
  check("api: metrics ok", r.status === 200, String(r.status));
}
{
  const r = await fetch(`${BASE}/api/host/history?range=300`, {
    headers: { cookie: `ac_session=${makeToken()}` },
  });
  const j = await r.json();
  check(
    "api: history shape",
    j.cols?.[0] === "ts" && Array.isArray(j.points),
    JSON.stringify(j).slice(0, 120),
  );
}
{
  const r = await fetch(`${BASE}/api/host/du?path=/`, {
    headers: { cookie: `ac_session=${makeToken()}` },
  });
  const j = await r.json();
  check(
    "api: du shape",
    j.path === "/" && Array.isArray(j.children),
    JSON.stringify(j).slice(0, 120),
  );
}
{
  const r = await fetch(`${BASE}/api/host/du/rescan`, {
    method: "POST",
    headers: { cookie: `ac_session=${makeToken()}`, origin: "https://evil.example" },
  });
  check("api: rescan refuses cross-site", r.status === 403, String(r.status));
}
{
  const r = await fetch(`${BASE}/api/host/processes`, {
    headers: { cookie: `ac_session=${makeToken()}` },
  });
  const j = await r.json();
  check(
    "api: processes shape",
    Array.isArray(j.processes) && j.processes.length > 0 && typeof j.processes[0].pid === "number",
    JSON.stringify(j).slice(0, 120),
  );
}
{
  const r = await fetch(`${BASE}/api/host/ports`, {
    headers: { cookie: `ac_session=${makeToken()}` },
  });
  const j = await r.json();
  check(
    "api: ports shape",
    Array.isArray(j.ports) && j.ports.length > 0 && typeof j.ports[0].port === "number",
    JSON.stringify(j).slice(0, 120),
  );
}
{
  // the console's own process tree and PID 1 are listed as protected and refused by the kill API
  const j = await (
    await fetch(`${BASE}/api/host/processes`, { headers: { cookie: `ac_session=${makeToken()}` } })
  ).json();
  const guarded = j.processes.find((p: any) => p.protected);
  check("api: protected processes flagged", !!guarded, guarded?.label ?? "none");
  if (guarded) {
    const r = await fetch(`${BASE}/api/host/processes/${guarded.pid}/kill`, {
      method: "POST",
      headers: {
        cookie: `ac_session=${makeToken()}`,
        origin: BASE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ signal: "SIGTERM" }),
    });
    check("api: protected kill refused", r.status === 403, String(r.status));
  }
}
{
  const res = await fetch(`${BASE}/api/host/headroom-profile?range=1h`, {
    headers: { cookie: `ac_session=${makeToken()}` },
  });
  const body = await res.json();
  check(
    "api: headroom profile shape",
    Array.isArray(body.rss) && Array.isArray(body.snapshots) && body.sites?.rows?.length === SITE_COUNT,
    JSON.stringify(body).slice(0, 120),
  );
}
// unauth refused
{
  const r = await fetch(`${BASE}/api/host/metrics`);
  check("api: unauth refused", r.status === 401, String(r.status));
}
await browser.close();
if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall host checks passed");
