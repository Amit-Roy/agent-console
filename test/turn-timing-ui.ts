// Turn timing in a real browser against an isolated mock backend: Run details shows the last run's timing facts at phone width,
// the phone's send -> first token sample reaches the latency store, and /dashboard draws the Turn latency panel. Spends nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-turn-timing-ui-"));
const PORT = process.env.TIMING_UI_PORT || "17875",
  base = `http://127.0.0.1:${PORT}`,
  OUT = process.env.OUT || "/tmp";
const now = Date.now();
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id: "mock-timing",
      provider: "mock",
      model: "echo",
      title: "Timing",
      cwd: process.cwd(),
      mode: "acceptEdits",
      effort: "default",
      status: "idle",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]),
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
// An earlier long turn (45 steps, 18 min, 130 tools, a failure, a retry) seeded straight into the store, for the breakdown picker.
{
  const { TurnTimingStore } = await import("../server/turn-timing.ts");
  const seg: any[] = [{ k: "startup", a: 0, d: 900 }];
  let t = 900,
    tools: any[] = [];
  for (let i = 1; i <= 45; i++) {
    const md = 4000 + (i % 7) * 2500;
    seg.push({ k: "model", i, a: t, d: md, f: 600 + (i % 5) * 300 });
    t += md;
    if (i === 12) seg.push({ k: "retry", i, a: t - 1000, d: 8000, s: 529, c: "overloaded" });
    if (i === 45) break;
    const names = i % 3 ? ["Read", "Read", "Grep"] : ["Bash"];
    for (const [j, n] of names.entries()) {
      const d = n === "Bash" ? 30_000 + i * 400 : 1200 + j * 300;
      const e = i === 21 && n === "Bash" ? 1 : undefined;
      seg.push({ k: "tool", i, n, a: t + j * 50, d, ...(e ? { e } : {}) });
      tools.push({ n, ms: d, ...(e ? { e } : {}) });
    }
    t += Math.max(...seg.filter((x) => x.k === "tool" && x.i === i).map((x) => x.d)) + 100;
  }
  seg.sort((x, y) => x.a - y.a);
  const st = new TurnTimingStore(path.join(data, "latency.sqlite"));
  st.recordTurn(
    "mock-timing",
    {
      turn_ts: now - 3_600_000,
      provider: "mock",
      model: "echo",
      alias: "echo",
      cold: 0,
      spawn_ms: null,
      queue_ms: 1200,
      first_ms: 1500,
      total_ms: t,
      model_ms: Math.round(t * 0.55),
      tool_ms: Math.round(t * 0.43),
      startup_ms: 900,
      wait_ms: 0,
      steps: 45,
      tools: tools.slice(0, 100),
      retries: 1,
      retry_detail: [{ s: 529, c: "overloaded" }],
      rate_limits: 0,
      outcome: "ok",
      timeline: { seg },
    },
    now - 3_600_000,
  );
  st.close();
}
const env = {
  ...process.env,
  PORT,
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_RUN: path.join(data, "run"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_HEADROOM: "0",
  AGENT_CONSOLE_LABELS: "0",
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
};
delete env.AGENT_CONSOLE_PID_FILE;
const server = spawn(process.execPath, ["server/index.ts"], {
  env,
  stdio: process.env.DEBUG ? "inherit" : "ignore",
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
try {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    if (server.exitCode != null) throw Error("Scratch server exited before readiness");
    try {
      ready = (await fetch(base)).status < 500;
    } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "scratch backend ready");
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    hasTouch: true,
  });
  await context.addCookies([{ name: "__Host-ac_session", value: makeToken(), domain: new URL(base).hostname, path: "/", secure: true }]);
  await context.addInitScript(() => localStorage.setItem("ac_thread", "mock-timing"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base);
  await page
    .locator("#input:not([disabled])")
    .waitFor()
    .catch(async (e) => {
      await page.screenshot({ path: `${OUT}/obs-debug.png` });
      console.log("errors:", errors.join(" | ").slice(0, 400));
      throw e;
    });
  for (const text of ["tool first", "tool second"]) {
    await page.fill("#input", text);
    await page.locator("#send").click();
    await page
      .locator(".msg.asst")
      .filter({ hasText: `mock reply (acceptEdits, echo): ${text}` })
      .waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector("#state") ||
        (document.querySelector("#state") as HTMLElement).hidden,
    );
  }
  await page.locator("#more").click();
  await page.getByRole("menuitem", { name: /^Run details/ }).click();
  await page.waitForSelector("#run-details[open]");
  const timing = (await page.locator("#turn-timing").textContent()) || "";
  check(
    "run details: first token, warm process",
    /\d+ ms\s*to first token\s*Warm/.test(timing) &&
      timing.includes("Agent process was already running"),
    timing.slice(0, 160),
  );
  check(
    "run details: model vs tools split bar",
    (await page.locator("#turn-timing .tt-bar i").count()) >= 2 &&
      /Model\s*\d+ ms/.test(timing) &&
      /Tools\s*\d+ ms/.test(timing) &&
      /^Of \d+ ms: model \d+ ms, tools \d+ ms, other \d+ ms$/.test(
        (await page.locator("#turn-timing .tt-bar").getAttribute("aria-label")) || "",
      ),
  );
  check("run details: slowest tools", /Slowest tools\s*Bash\s*\d+ ms/.test(timing));
  check("run details: phone first-token shown", timing.includes("until shown here"));
  check(
    "run details: thread id prefix prominent",
    (await page.locator("#run-thread .tid b").textContent()) === "mock-tim",
  );
  const copy = page.locator("#run-thread .tid-copy");
  const box = await copy.boundingBox();
  check(
    "run details: copy button is a 44px touch target",
    (box?.height || 0) >= 43.9,
    JSON.stringify(box),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await copy.click();
  await page.locator("#run-thread .tid-copy", { hasText: "Copied" }).waitFor();
  check(
    "run details: copy takes the full id",
    (await page.evaluate(() => navigator.clipboard.readText())) === "mock-timing",
  );
  check(
    "run details: fits 390px",
    await page.evaluate(() => {
      const d = document.getElementById("run-details")!;
      return (
        d.scrollWidth <= d.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth
      );
    }),
  );
  await page.locator("#run-thread .tid-copy", { hasText: "Copy id" }).waitFor();
  await page.locator("#turn-timing").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/obs-run-details-after-dark.png` });
  await page.emulateMedia({ colorScheme: "light" });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400); // let color transitions settle
  await page.screenshot({ path: `${OUT}/obs-run-details-after-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  // Full breakdown: a pushed sub-view in the same sheet, from a 44px button under the Last turn summary
  const open = page.locator("#turn-timing .tb-open");
  const ob = await open.boundingBox();
  check("breakdown: button is a 44px touch target", (ob?.height || 0) >= 43.9, JSON.stringify(ob));
  await open.click();
  await page
    .locator("#turn-breakdown .tb-fall")
    .waitFor({ timeout: 5000 })
    .catch(async (e) => {
      console.log(
        "breakdown:",
        (await page.locator("#turn-breakdown").textContent())?.slice(0, 200),
        errors.join(" | ").slice(0, 400),
      );
      throw e;
    });
  const bd = (await page.locator("#turn-breakdown").textContent()) || "";
  check(
    "breakdown: replaces the summary in the same sheet",
    (await page.locator("#turn-timing").isHidden()) &&
      (await page.locator("#run-details[data-view=breakdown]").count()) === 1,
  );
  check(
    "breakdown: totals, timeline, tools table, steps",
    ["whole turn", "First token", "Timeline", "Tools", "Model steps", "Step 1"].every((x) =>
      bd.includes(x),
    ) && /Bash\s*1\s*\d+ ms\s*\d+ ms/.test(bd),
    bd.slice(0, 200),
  );
  check(
    "breakdown: waterfall rows carry durations as text",
    (await page.locator("#turn-breakdown .tb-row").count()) >= 3 &&
      (await page.locator("#turn-breakdown .tb-row .tb-ms").allTextContents()).every((x) =>
        /\d|—/.test(x),
      ),
  );
  const fits = () =>
    page.evaluate(() => {
      const d = document.getElementById("run-details")!;
      return (
        d.scrollWidth <= d.clientWidth + 1 &&
        document.documentElement.scrollWidth <= innerWidth &&
        [...d.querySelectorAll("#turn-breakdown *")].every(
          (e) => e.getBoundingClientRect().right <= d.getBoundingClientRect().right + 0.5,
        )
      );
    });
  check("breakdown: fits 390px, no horizontal overflow", await fits());
  const back = page.locator("#turn-breakdown .tb-back");
  check(
    "breakdown: back is a 44px touch target",
    ((await back.boundingBox())?.height || 0) >= 43.9,
  );
  await page.screenshot({ path: `${OUT}/breakdown-short-dark.png` });
  // earlier long turn: picker, capped rows with Show all, failure marked in words
  await page.locator("#turn-breakdown .tb-pick select").selectOption("2");
  await page.locator("#turn-breakdown .tb-more").waitFor();
  const long = (await page.locator("#turn-breakdown").textContent()) || "";
  check(
    "breakdown: earlier turns selectable (last 10)",
    (await page.locator("#turn-breakdown .tb-pick option").count()) === 3 && /\d+ min/.test(long),
    long.slice(0, 120),
  );
  const capped = await page.locator("#turn-breakdown .tb-row").count();
  check(
    "breakdown: long turn capped with Show all",
    capped === 40 && /Show all \d+ rows/.test(long),
    String(capped),
  );
  check(
    "breakdown: failure and retry marked in text",
    long.includes("failed") && /Retry 529 overloaded/.test(long),
    long.match(/.{40}(Retry|failed).{40}/g)?.join(" / "),
  );
  check("breakdown: steps list capped", /Show all 45 steps/.test(long));
  check("breakdown: long turn fits 390px", await fits());
  // bars encode duration, not position: short tools stay visible beside the longest segment, and lengths differ visibly
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll("#turn-breakdown .tb-row")].map((li) => ({
      n: li.querySelector(".tb-name")!.textContent,
      k: li.className,
      w: (li.querySelector(".tb-bar") as HTMLElement).getBoundingClientRect().width,
      at: li.querySelector(".tb-at")!.textContent,
    })),
  );
  const w = (re: RegExp) => widths.filter((x) => re.test(x.n || "")).map((x) => x.w);
  const reads = w(/^Read/),
    bashes = w(/^Bash/);
  check(
    "breakdown: short tool bars clearly visible (>= 8px)",
    Math.min(...reads) >= 8,
    JSON.stringify(reads.slice(0, 3)),
  );
  check(
    "breakdown: long bars clearly longer than short ones (>= 3x)",
    Math.max(...bashes) >= 3 * Math.max(...reads),
    JSON.stringify({ bash: Math.max(...bashes), read: Math.max(...reads) }),
  );
  check(
    "breakdown: start offsets as text",
    widths.every((x) => /^[+−]\d/.test(x.at || "")) &&
      widths.some((x) => /^\+\d+:\d\d$/.test(x.at || "")),
    widths
      .slice(-2)
      .map((x) => x.at)
      .join(","),
  );
  await page.screenshot({ path: `${OUT}/breakdown-long-dark.png` });
  await page.locator("#turn-breakdown .tb-fall").scrollIntoViewIfNeeded();
  await page
    .locator("#turn-breakdown .tb-fall")
    .evaluate((n) => n.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `${OUT}/breakdown-waterfall-dark.png` });
  await page.locator("#turn-breakdown .tb-more").click();
  check(
    "breakdown: show all expands rows",
    (await page.locator("#turn-breakdown .tb-row").count()) > 40 && (await fits()),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page
    .locator("#turn-breakdown .tb-fall")
    .evaluate((n) => n.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `${OUT}/breakdown-waterfall-light.png` });
  await page.locator("#run-details").evaluate((d) => (d.scrollTop = 0));
  await page.screenshot({ path: `${OUT}/breakdown-long-light.png` });
  await page.locator("#turn-breakdown .tb-pick select").selectOption("0");
  await page.locator("#turn-breakdown .tb-fall").waitFor();
  await page.screenshot({ path: `${OUT}/breakdown-short-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.keyboard.press("Escape");
  await page.locator("#turn-timing").waitFor();
  check(
    "breakdown: Escape goes back, focus returns to the button",
    (await page.locator("#run-details[open]").count()) === 1 &&
      (await page.evaluate(() => document.activeElement?.classList.contains("tb-open"))),
  );
  const cookie = { headers: { cookie: `__Host-ac_session=${makeToken()}` } };
  const detail = await (
    await fetch(`${base}/api/turn-latency?thread=mock-timing&detail=10`, cookie)
  ).json();
  check(
    "api: detail returns recent turns with timelines",
    detail.available &&
      detail.turns.length === 3 &&
      detail.turns[0].timeline.seg.some((x: any) => x.k === "tool" && x.n === "Bash") &&
      detail.turns[2].timeline.seg.length > 100,
  );
  check("api: detail has no prompt text", !JSON.stringify(detail).includes("tool first"));
  let groups: any = {};
  for (let i = 0; i < 30 && !groups.first_token; i++) {
    groups = (await (await fetch(`${base}/api/latency`, cookie)).json()).groups || {};
    if (!groups.first_token) await page.waitForTimeout(100);
  }
  check(
    "phone first_token samples stored",
    groups.first_token?.count === 2,
    JSON.stringify(groups.first_token || {}).slice(0, 80),
  );
  const api = await (
    await fetch(`${base}/api/turn-latency?from=${now - 60_000}&to=${Date.now() + 60_000}`, cookie)
  ).json();
  // Prewarm: opening the thread spawns its agent, so one process serves both turns and a turn is cold only if that spawn
  // happened at send time (prewarm off or lost the race). The cold flag must match the agent_process record either way.
  const { DatabaseSync } = await import("node:sqlite");
  const pdb = new DatabaseSync(path.join(data, "latency.sqlite"), { readOnly: true });
  const spawns = (
    pdb
      .prepare("SELECT at FROM agent_process WHERE thread = ? AND kind = 'spawn' ORDER BY at")
      .all("mock-timing") as any[]
  ).map((r) => r.at);
  const firstTurn = (
    pdb
      .prepare("SELECT MIN(turn_ts) t FROM turn_timing WHERE thread = ? AND turn_ts > ?")
      .get("mock-timing", now - 60_000) as any
  ).t;
  pdb.close();
  const expectCold = spawns.length && spawns[0] >= firstTurn ? 1 : 0;
  check(
    "api: one agent process served both turns",
    spawns.length === 1,
    JSON.stringify(spawns.length),
  );
  check(
    "api: turn latency stats",
    api.available &&
      api.turns === 2 &&
      api.cold.cold === expectCold &&
      api.tools[0]?.name === "Bash" &&
      api.ttft[0]?.provider === "mock",
    JSON.stringify({ turns: api.turns, cold: api.cold.cold, expectCold }),
  );
  check("api: no prompt text", !JSON.stringify(api).includes("tool first"));
  check(
    "api: refuses ranges over 400 days",
    (await fetch(`${base}/api/turn-latency?from=1&to=${Date.now()}`, cookie)).status === 400,
  );
  const logLines = fs
    .readFileSync(path.join(data, "logs", "mock-timing.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  check(
    "every persisted event has a server timestamp",
    logLines.every((e) => typeof e.ts === "number"),
  );
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    const dash = await browser.newPage({
      viewport,
      colorScheme: name === "phone" ? "dark" : "light",
    });
    await dash.context().addCookies([{ name: "__Host-ac_session", value: makeToken(), domain: new URL(base).hostname, path: "/", secure: true }]);
    dash.on("pageerror", (e) => errors.push(String(e)));
    await dash.goto(`${base}/dashboard#7`);
    await dash.locator(".panel h2", { hasText: "Turn latency" }).waitFor();
    const panelText =
      (await dash
        .locator(".panel", { has: dash.locator("h2", { hasText: "Turn latency" }) })
        .textContent()) || "";
    check(
      `${name} dashboard: TTFT, tools, cold share, retries`,
      [
        "First token p50",
        "Model time",
        "Cold starts",
        "Retries",
        "Time to first token by agent",
        "Tool time, top 5",
        "Bash",
        "Until shown on your device",
      ].every((s) => panelText.includes(s)),
      panelText.slice(0, 120),
    );
    check(
      `${name} dashboard: no horizontal overflow`,
      await dash.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    );
    const panel = dash.locator(".panel", { has: dash.locator("h2", { hasText: "Turn latency" }) });
    await panel.screenshot({ path: `${OUT}/obs-dashboard-${name}.png` });
    await dash.close();
  }
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  fs.rmSync(data, { recursive: true, force: true });
}
if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall turn timing UI checks passed");
