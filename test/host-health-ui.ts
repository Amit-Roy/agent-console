// Host "Workspace health" panel: mocked /api/host/health routes, phone + desktop, light + dark.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "host-health-ui-"));
const data = path.join(scratch, "data");
fs.mkdirSync(data, { recursive: true });
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
fs.writeFileSync(path.join(data, "threads.json"), "[]");
fs.writeFileSync(path.join(data, "commands.json"), "{}");
const PORT = process.env.HOST_HEALTH_UI_PORT || String(20000 + Math.floor(Math.random() * 20000));
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT || "/tmp/ac473-evidence";
fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT,
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(scratch, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_PID_FILE: "",
    AGENT_CONSOLE_ENV_FILES: "/dev/null",
    AGENT_CONSOLE_LABELS: "0",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErrors = "";
server.stderr?.on("data", (chunk) => (serverErrors += chunk.toString()));
process.on("exit", () => {
  server.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
});
for (let attempt = 0; ; attempt++) {
  const ready = await fetch(`${BASE}/api/host/metrics`, {
    headers: { cookie: `__Host-ac_session=${makeToken()}` },
  }).then(
    (res) => res.ok,
    () => false,
  );
  if (ready) break;
  if (server.exitCode !== null || attempt > 150)
    throw new Error(`server did not start: ${serverErrors.slice(0, 300)}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
}
let failed = 0;
const check = (name: string, passed: boolean, extra = "") => {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!passed) failed++;
};

const HOUR = 3_600_000;
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
const checks = [
  { id: "disk", label: "Disk space", status: "ok", detail: "42% of /home used" },
  { id: "mem", label: "Memory", status: "warning", detail: "Swap above 60% for 20 minutes" },
  { id: "svc", label: "Services", status: "error", detail: "agent-console-tunnel is not running" },
  { id: "ver", label: "Runtime versions", status: "info", detail: "node 24.1.0, python 3.13.2" },
  {
    id: "wt",
    label: "Stale worktrees",
    status: "ok",
    detail: "3 removed",
    healed: { action: "git worktree prune", result: "3 pruned" },
  },
];
const worsts = [
  "ok",
  "ok",
  "warning",
  "ok",
  "error",
  "ok",
  "warning",
  "ok",
  "ok",
  "ok",
  "info",
  "ok",
  "error",
  "warning",
];
const fullRun = { at: iso(2 * HOUR), trigger: "hourly", durationMs: 1840, checks };
const fullState = {
  latest: fullRun,
  history: worsts.map((worst, index) => ({
    at: iso((index + 1) * HOUR),
    trigger: index % 5 === 0 ? "nightly" : "hourly",
    worst,
  })),
  running: false,
};
const emptyState = { latest: null, history: [], running: false };

type Mock = { state: any; posts: number; gets: number };
async function mockHealth(page: any, mock: Mock) {
  await page.route("**/api/host/health/run", async (route: any) => {
    mock.posts++;
    mock.state = { ...fullState, latest: { ...fullRun, at: iso(1000), trigger: "manual" } };
    await route.fulfill({ json: mock.state.latest });
  });
  await page.route("**/api/host/health", async (route: any) => {
    mock.gets++;
    await route.fulfill({ json: mock.state });
  });
}
async function newPage(browser: any, viewport: any, scheme: string) {
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
  const errors: string[] = [];
  page.on("console", (msg: any) => msg.type() === "error" && errors.push(msg.text()));
  page.on("pageerror", (err: any) => errors.push(String(err)));
  return { ctx, page, errors };
}
const overflow = (page: any) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

const browser = await chromium.launch();
const shots = [
  ["phone-light", { width: 390, height: 844 }, "light"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
  ["desktop-light", { width: 1280, height: 800 }, "light"],
  ["desktop-dark", { width: 1280, height: 800 }, "dark"],
] as const;
for (const [name, viewport, scheme] of shots) {
  const { ctx, page, errors } = await newPage(browser, viewport, scheme);
  const mock: Mock = { state: fullState, posts: 0, gets: 0 };
  await mockHealth(page, mock);
  await page.goto(`${BASE}/host`);
  await page.waitForSelector("#health-rows .health-row");
  const rows = await page.locator("#health-rows .health-row").allInnerTexts();
  const badges = await page.locator("#health-rows .health-badge").allInnerTexts();
  check(`${name}: five rows`, rows.length === 5, String(rows.length));
  check(
    `${name}: badges`,
    badges.join("|").toUpperCase() === "OK|WARNING|ERROR|INFO|OK",
    badges.join("|"),
  );
  check(`${name}: healed note`, rows[4].includes("healed: git worktree prune — 3 pruned"));
  check(
    `${name}: overall error`,
    (await page.locator("#health-worst").innerText()).toUpperCase() === "ERROR",
  );
  const last = await page.locator("#health-last").innerText();
  check(`${name}: last run text`, /^Last run 2h ago \(hourly\)$/.test(last), last);
  check(`${name}: 14 dots`, (await page.locator("#health-strip .health-dot").count()) === 14);
  const dot = page.locator("#health-strip .health-dot").last();
  check(
    `${name}: dot label`,
    /Error|Warning|OK|Info/.test((await dot.getAttribute("aria-label")) || "") &&
      !!(await dot.getAttribute("title")),
  );
  check(`${name}: no horizontal overflow`, !(await overflow(page)));
  const panel = page.locator("#health");
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `${OUT}/host-health-${name}.png` });
  if (name === "phone-light") {
    await page.route("**/api/host/health/run", async (route: any) => {
      mock.posts++;
      await new Promise((resolve) => setTimeout(resolve, 600));
      mock.state = { ...fullState, latest: { ...fullRun, at: iso(1000), trigger: "manual" } };
      await route.fulfill({ json: mock.state.latest });
    });
    const getsBefore = mock.gets;
    await page.click("#health-run");
    check(
      `${name}: run disabled while running`,
      (await page.locator("#health-run").isDisabled()) &&
        (await page.locator("#health-run").innerText()) === "Running…",
    );
    await page.waitForFunction(() =>
      /\(manual\)/.test(document.getElementById("health-last")?.textContent || ""),
    );
    check(`${name}: run posted + refreshed`, mock.posts === 1 && mock.gets > getsBefore);
    check(`${name}: run enabled again`, !(await page.locator("#health-run").isDisabled()));
  }
  check(`${name}: no console errors`, errors.length === 0, errors.join(";"));
  await ctx.close();
}

// empty state
{
  const { ctx, page, errors } = await newPage(browser, { width: 390, height: 844 }, "light");
  await mockHealth(page, { state: emptyState, posts: 0, gets: 0 });
  await page.goto(`${BASE}/host`);
  await page.waitForSelector("#health-empty:not([hidden])");
  check(
    "empty: message",
    (await page.locator("#health-empty").innerText()) === "No health runs yet",
  );
  check("empty: no rows", (await page.locator("#health-rows .health-row").count()) === 0);
  check("empty: no overflow", !(await overflow(page)));
  check("empty: no console errors", errors.length === 0, errors.join(";"));
  await ctx.close();
}

// before: the host page without the section (stripped from the served HTML)
const html = fs.readFileSync("public/host.html", "utf8");
const before = html
  .replace(/\s*<section class="panel" id="health"[\s\S]*?<\/section>/, "")
  .replace(/\s*<script type="module" src="\/host-health.js"><\/script>/, "");
check("before: html stripped", !before.includes("health"));
for (const [name, viewport] of [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1280, height: 800 }],
] as const) {
  const { ctx, page } = await newPage(browser, viewport, "light");
  await page.route("**/host", (route: any) =>
    route.fulfill({ contentType: "text/html", body: before }),
  );
  await page.goto(`${BASE}/host`);
  await page.waitForSelector("#proc-rows .hrow.proc");
  await page.screenshot({ path: `${OUT}/host-before-${name}.png` });
  await ctx.close();
}
await browser.close();
server.kill();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("host health ui: all checks passed");
