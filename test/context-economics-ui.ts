// Isolated browser checks: provider messages are intercepted; no provider turns run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-context-ui-"));
const root = process.env.APP_ROOT || process.cwd();
const port = process.env.TEST_PORT || "7074", base = `http://127.0.0.1:${port}`;
fs.mkdirSync(path.join(data, "uploads"));
const now = Date.now();
const fixture = { id: "forecast-codex", provider: "codex", model: "gpt-6.1-sol", title: "Forecast fixture", cwd: root, mode: "bypassPermissions", effort: "medium", status: "idle", cost: 0, createdAt: now, updatedAt: now, sessionId: "scratch-only", context: { used: 100000, max: 272000, source: "codex/last_request" } };
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([fixture]));
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], { cwd: root, env: { ...process.env, PORT: port, AGENT_CONSOLE_RUN: path.join(data, "run"), AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_HEADROOM: "0", AGENT_CONSOLE_WARM_MAX: "0", AGENT_CONSOLE_IDLE_COMPACT_CODEX_TTL_MS: "300000" }, stdio: "ignore" });
let browser;
try {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(timer); reject(Error("Scratch startup timeout")); }, 15000);
    const timer = setInterval(async () => { try { if ((await fetch(base)).status < 500) { clearTimeout(deadline); clearInterval(timer); resolve(); } } catch {} }, 100);
  });
  browser = await chromium.launch();
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark" });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await context.addInitScript(() => localStorage.setItem("ac_thread", "forecast-codex"));
    const page = await context.newPage(), errors: string[] = [], sent: any[] = [];
    page.on("pageerror", e => errors.push(e.message));
    let client: any, current: any;
    await page.routeWebSocket(/\/ws$/, socket => {
      client = socket;
      const upstream = socket.connectToServer();
      socket.onMessage(raw => { const m = JSON.parse(String(raw)); if (["compact", "update"].includes(m.t)) sent.push(m); else upstream.send(raw); });
      upstream.onMessage(raw => {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") {
          current = { ...m.threads[0], ...fixture, context: { used: 100000, max: 272000, source: "codex/last_request" }, lastProviderActivityAt: Date.now() - 60000, idleCompactionTtlMs: 300000, idleCompaction: true };
          m.threads = [current];
        }
        socket.send(JSON.stringify(m));
      });
    });
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 15000 }); 
    await page.locator("#usage-ctx-info").waitFor({ state: "attached" });
    await page.locator("#ctx").click();
    await page.waitForFunction(() => !!document.querySelector(".context-forecast-summary")?.textContent);
    assert.match(await page.getByRole("dialog").innerText(), /Forecast fixture/);
    await page.locator(".context-token-grid span").first().waitFor({state: "attached"});
    assert.equal(await page.locator(".context-token-grid span").count(), 100);
    assert.match(await page.locator(".context-allocation").innerText(), /Other \/ unobserved/i);
    const allocationResponse = await page.request.get(`${base}/api/context-allocation/${fixture.id}`);
    assert.equal(allocationResponse.ok(), true);
    const allocation = await allocationResponse.json();
    assert.equal(allocation.used, 100000);
    assert.equal(allocation.categories.reduce((sum: number, c: any) => sum + c.tokens, 0), 272000);
    await page.route("**/api/context-allocation/**", route => route.fulfill({ json: {
      used: 100000, max: 272000, source: "codex/last_request", note: "Fixture category estimates.", categories: [
        { id: "system", label: "System instructions", tokens: 10000, estimated: true },
        { id: "tools", label: "Tool definitions", tokens: 10000, estimated: true },
        { id: "messages", label: "Messages", tokens: 50000, estimated: true },
        { id: "tool_results", label: "Tool results", tokens: 20000, estimated: true },
        { id: "unknown", label: "Unattributed context", tokens: 10000, estimated: true },
        { id: "free", label: "Free space", tokens: 172000, estimated: false },
      ],
    } }));
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(await page.locator("#ctx").evaluate(e => e === document.activeElement), true);
    await page.locator("#ctx").press("Enter");
    await page.waitForFunction(() => !!document.querySelector(".context-forecast-summary")?.textContent);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    if (width === 390) await page.locator("#menu").click();
    const open = async () => { await page.locator("#usage .u-ctx").click(); await page.waitForFunction(() => !!document.querySelector(".context-forecast-summary")?.textContent); };
    const change = async (label: string, value: string) => { await page.getByLabel(label, { exact: true }).fill(value); await page.getByLabel(label, { exact: true }).dispatchEvent("change"); };
    await open();
    const dialog = page.getByRole("dialog");
    await page.getByText("Fixture category estimates.", { exact: true }).waitFor();
    assert.equal(await page.locator(".context-token-grid span").count(), 100);
    assert.equal(await page.locator(".context-allocation-legend li").count(), 6);
    assert.match(await page.locator(".context-allocation-legend").innerText(), /System instructions[\s\S]*est\./);
    await change("Future requests", "1");
    const recommendation = page.locator(".context-recommendation");
    assert.equal(await recommendation.locator(".context-recommendation-label").innerText(), "Recommendation");
    assert.equal(await recommendation.locator(".context-recommendation-title").innerText(), "Continue for now");
    assert.equal(await recommendation.getAttribute("data-action"), "continue");
    assert.ok((await recommendation.locator(".context-recommendation-detail").innerText()).trim().length > 0);
    assert.equal(await recommendation.getAttribute("aria-live"), "polite");
    assert.equal(await recommendation.getAttribute("aria-atomic"), "true");
    assert.equal(await recommendation.evaluate(el => document.getElementById(el.getAttribute("aria-labelledby") || "")?.textContent), "Continue for now");
    assert.equal(await recommendation.evaluate(el => {
      const style = getComputedStyle(el), title = el.querySelector(".context-recommendation-title")!;
      const card = el.getBoundingClientRect(), dialog = el.closest("dialog, [role=dialog]")!.getBoundingClientRect();
      return parseFloat(style.borderLeftWidth) > 0 && parseInt(getComputedStyle(title).fontWeight, 10) >= 600
        && card.top - dialog.top < 180 && card.left >= dialog.left && card.right <= dialog.right;
    }), true, "accented recommendation with bold title stays near dialog top");
    await change("Future requests", "40");
    await dialog.evaluate(e => { e.scrollTop = 0; });
    fs.mkdirSync(path.join(root, "test-output"), { recursive: true });
    await page.screenshot({ timeout: 10000, animations: "disabled", path: path.join(root, `test-output/guidance-${width}.png`) });
    assert.match(await dialog.innerText(), /Cache estimated warm at resume/);
    assert.match(await page.locator(".context-forecast-summary").innerText(), /continue \$/);
    assert.equal(await page.locator("canvas").evaluate((el: any) => (window as any).Chart.getChart(el).data.datasets.length), 2);
    const warm = await page.locator(".context-forecast-summary").innerText();
    await change("Resume in (minutes)", "10");
    assert.match(await dialog.innerText(), /Cache estimated stale at resume/);
    assert.notEqual(await page.locator(".context-forecast-summary").innerText(), warm);
    assert.equal(await recommendation.locator(".context-recommendation-title").innerText(), "Compact now");
    assert.equal(await recommendation.getAttribute("data-action"), "now");
    assert.match(await recommendation.locator(".context-recommendation-detail").innerText(), /\$/);
    await change("Gap per request (minutes)", "10");
    await change("Cache lifetime estimate (minutes)", "0");
    assert.match(await dialog.innerText(), /No cache assumed/);
    await dialog.getByRole("combobox").selectOption("tokens");
    assert.match(await page.locator("canvas").getAttribute("aria-label") || "", /Processed tokens/);
    await page.getByText("Forecast data and assumptions", { exact: true }).click();
    assert.ok(await dialog.locator("table tr").count() > 2);
    assert.equal(await dialog.evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
    await page.screenshot({ timeout: 10000, animations: "disabled", path: `/tmp/context-economics-${width}.png` });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.locator("#usage .u-ctx").evaluate(e => e === document.activeElement), true);
    assert.equal(await page.locator("#usage-ctx-info").isVisible(), true, "Escape keeps the sidebar open");
    await page.locator("#usage-ctx-info").click();
    await page.getByRole("button", { name: "Disable automatic compaction", exact: true }).click();
    assert.deepEqual(sent.pop(), { t: "update", thread: fixture.id, idleCompaction: false });
    await open();
    await page.getByRole("button", { name: "Compact now", exact: true }).click();
    assert.deepEqual(sent.pop(), { t: "compact", thread: fixture.id });
    current = { ...current, waiting: true };
    client.send(JSON.stringify({ t: "thread", thread: current }));
    await open();
    assert.equal(await page.getByRole("button", { name: "Compact now", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Close context forecast" }).click();
    current = { ...current, waiting: false, model: "unknown-price-model" };
    client.send(JSON.stringify({ t: "thread", thread: current }));
    await open();
    assert.match(await page.locator(".context-forecast-summary").innerText(), /showing tokens only/);
    assert.equal(await page.locator(".context-recommendation-label").innerText(), "Recommendation");
    assert.equal(await page.locator(".context-recommendation-title").innerText(), "More data needed");
    await page.keyboard.press("Escape");
    current = { ...current, context: null };
    client.send(JSON.stringify({ t: "thread", thread: current }));
    await page.locator("#usage-ctx-info").click();
    await page.getByText("Context size is not reported yet.", { exact: false }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px graph paths, staleness controls, tokens, table, actions, unknown model/context, focus, overflow`);
    await context.close();
  }
} catch (error) { console.error(error); throw error; } finally { await browser?.close(); await new Promise<void>(resolve => { if (server.exitCode != null) resolve(); else { server.once("exit", () => resolve()); server.kill(); } }); fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); }
