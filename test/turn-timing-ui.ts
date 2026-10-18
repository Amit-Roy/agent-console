// Turn timing in a real browser against an isolated mock backend: Run details shows the last run's timing facts at phone width,
// the phone's send -> first token sample reaches the latency store, and /dashboard draws the Turn latency panel. Spends nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-turn-timing-ui-"));
const PORT = process.env.TIMING_UI_PORT || "7075", base = `http://127.0.0.1:${PORT}`, OUT = process.env.OUT || "/tmp";
const now = Date.now();
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([{ id: "mock-timing", provider: "mock", model: "echo", title: "Timing", cwd: process.cwd(), mode: "acceptEdits", effort: "default", status: "idle", cost: 0, createdAt: now, updatedAt: now }]));
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const env = { ...process.env, PORT, AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_RUN: path.join(data, "run"), AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_HEADROOM: "0", AGENT_CONSOLE_LABELS: "0", AGENT_CONSOLE_BRAIN: path.join(data, "no-brain") };
delete env.AGENT_CONSOLE_PID_FILE;
const server = spawn(process.execPath, ["server/index.ts"], { env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let failed = 0;
const check = (n: string, ok: boolean, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) failed++; };
try {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    if (server.exitCode != null) throw Error("Scratch server exited before readiness");
    try { ready = (await fetch(base)).status < 500; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "scratch backend ready");
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", hasTouch: true });
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  await context.addInitScript(() => localStorage.setItem("ac_thread", "mock-timing"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base);
  await page.locator("#input:not([disabled])").waitFor().catch(async (e) => { await page.screenshot({ path: `${OUT}/obs-debug.png` }); console.log("errors:", errors.join(" | ").slice(0, 400)); throw e; });
  for (const text of ["tool first", "tool second"]) {
    await page.fill("#input", text);
    await page.locator("#send").click();
    await page.locator(".msg.asst").filter({ hasText: `mock reply (acceptEdits, echo): ${text}` }).waitFor();
    await page.waitForFunction(() => !document.querySelector("#state") || (document.querySelector("#state") as HTMLElement).hidden);
  }
  await page.locator("#more").click();
  await page.getByRole("menuitem", { name: /^Run details/ }).click();
  await page.waitForSelector("#run-details[open]");
  const timing = (await page.locator("#turn-timing").textContent()) || "";
  check("run details: first token, warm process", /\d+ ms\s*to first token\s*Warm/.test(timing) && timing.includes("Agent process was already running"), timing.slice(0, 160));
  check("run details: model vs tools split bar", (await page.locator("#turn-timing .tt-bar i").count()) >= 2 && /Model\s*\d+ ms/.test(timing) && /Tools\s*\d+ ms/.test(timing) && /^Of \d+ ms: model \d+ ms, tools \d+ ms, other \d+ ms$/.test((await page.locator("#turn-timing .tt-bar").getAttribute("aria-label")) || ""));
  check("run details: slowest tools", /Slowest tools\s*Bash\s*\d+ ms/.test(timing));
  check("run details: phone first-token shown", timing.includes("until shown here"));
  check("run details: thread id prefix prominent", (await page.locator("#run-thread .tid b").textContent()) === "mock-tim");
  const copy = page.locator("#run-thread .tid-copy");
  const box = await copy.boundingBox();
  check("run details: copy button is a 44px touch target", (box?.height || 0) >= 43.9, JSON.stringify(box));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await copy.click();
  await page.locator("#run-thread .tid-copy", { hasText: "Copied" }).waitFor();
  check("run details: copy takes the full id", (await page.evaluate(() => navigator.clipboard.readText())) === "mock-timing");
  check("run details: fits 390px", await page.evaluate(() => { const d = document.getElementById("run-details")!; return d.scrollWidth <= d.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; }));
  await page.locator("#run-thread .tid-copy", { hasText: "Copy id" }).waitFor();
  await page.locator("#turn-timing").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/obs-run-details-after-dark.png` });
  await page.emulateMedia({ colorScheme: "light" });
  await page.mouse.move(0, 0); await page.waitForTimeout(400); // let color transitions settle
  await page.screenshot({ path: `${OUT}/obs-run-details-after-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  const cookie = { headers: { cookie: `ac_session=${makeToken()}` } };
  let groups: any = {};
  for (let i = 0; i < 30 && !groups.first_token; i++) { groups = (await (await fetch(`${base}/api/latency`, cookie)).json()).groups || {}; if (!groups.first_token) await page.waitForTimeout(100); }
  check("phone first_token samples stored", groups.first_token?.count === 2, JSON.stringify(groups.first_token || {}).slice(0, 80));
  const api = await (await fetch(`${base}/api/turn-latency?from=${now - 60_000}&to=${Date.now() + 60_000}`, cookie)).json();
  check("api: turn latency stats", api.available && api.turns === 2 && api.cold.cold === 1 && api.tools[0]?.name === "Bash" && api.ttft[0]?.provider === "mock", JSON.stringify({ turns: api.turns, cold: api.cold }));
  check("api: no prompt text", !JSON.stringify(api).includes("tool first"));
  check("api: refuses ranges over 400 days", (await fetch(`${base}/api/turn-latency?from=1&to=${Date.now()}`, cookie)).status === 400);
  const logLines = fs.readFileSync(path.join(data, "logs", "mock-timing.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("every persisted event has a server timestamp", logLines.every((e) => typeof e.ts === "number"));
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    const dash = await browser.newPage({ viewport, colorScheme: name === "phone" ? "dark" : "light" });
    await dash.context().addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    dash.on("pageerror", (e) => errors.push(String(e)));
    await dash.goto(`${base}/dashboard#7`);
    await dash.locator(".panel h2", { hasText: "Turn latency" }).waitFor();
    const panelText = (await dash.locator(".panel", { has: dash.locator("h2", { hasText: "Turn latency" }) }).textContent()) || "";
    check(`${name} dashboard: TTFT, tools, cold share, retries`, ["First token p50", "Model / tools", "Cold starts", "Retries", "Time to first token by agent", "Tool time, top 5", "Bash", "Until shown on your device"].every((s) => panelText.includes(s)), panelText.slice(0, 120));
    check(`${name} dashboard: no horizontal overflow`, await dash.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const panel = dash.locator(".panel", { has: dash.locator("h2", { hasText: "Turn latency" }) });
    await panel.screenshot({ path: `${OUT}/obs-dashboard-${name}.png` });
    await dash.close();
  }
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
} finally {
  await browser?.close();
  if (server.exitCode == null) { server.kill("SIGTERM"); await once(server, "exit"); }
  fs.rmSync(data, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall turn timing UI checks passed");
