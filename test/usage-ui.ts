import assert from "node:assert/strict";
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";
const base = process.env.BASE || "http://127.0.0.1:7071";
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    const page = await ctx.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    let hello: any, client: any;
    await page.routeWebSocket(/\/ws$/, socket => {
      client = socket;
      const server = socket.connectToServer(); socket.onMessage(m => server.send(m));
      server.onMessage(raw => {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") {
          hello = m;
          const codex = m.threads.find((t: any) => t.provider === "codex" && t.context?.source === "codex/last_request");
          assert.ok(codex && codex.context.used < codex.context.max, "persisted cumulative context is replaced with actual session telemetry");
          m.usage = {
            claude: { updatedAt: Date.now(), windows: [{ label: "5-hour", used: 100, limit: 100, unit: "%" }] },
            codex: { updatedAt: Date.now(), windows: [{ label: "5-hour", used: 15, limit: 100, unit: "%" }, { label: "7-day", used: 4, limit: 100, unit: "%" }] },
            pi: { updatedAt: Date.now(), windows: [{ label: "Free/day", used: 40, limit: 50 }], spendToday: 0 },
          };
        }
        socket.send(JSON.stringify(m));
      });
    });
    await page.goto(base);
    await page.waitForSelector("#usage [role=tab]", { state: "attached" });
    if (width === 390) await page.locator("#menu").click();
    assert.deepEqual(await page.locator("#usage [role=tab]").allTextContents(), ["Sunny", "Nefro", "OpenRouter", "Codex"]);
    const color = async () => page.locator("#usage .bar i").first().evaluate(e => getComputedStyle(e).backgroundColor);
    await page.getByRole("tab", { name: "Sunny", exact: true }).click(); const red = await color();
    assert.match(await page.locator("#usage").innerText(), /Claude · Sunny/);
    await page.getByRole("tab", { name: "Codex", exact: true }).click(); const green = await color();
    const info = page.locator("#usage-ctx-info");
    assert.equal(await info.getAttribute("aria-haspopup"), "dialog");
    await info.click();
    const forecast = page.getByRole("dialog");
    await forecast.waitFor();
    assert.match(await forecast.innerText(), /Context: continue or compact\?/);
    await page.keyboard.press("Escape");
    await forecast.waitFor({ state: "detached" });
    const tabNode = await page.locator("#usage-tab-codex").elementHandle();
    const refreshThread = hello.threads.find((t: any) => t.provider === "codex");
    client.send(JSON.stringify({ t: "thread", thread: { ...refreshThread, title: refreshThread.title + " usage refresh" } }));
    await page.waitForFunction(() => [...document.querySelectorAll("#threads .t")].some(t => t.textContent?.includes(" usage refresh")));
    assert.ok(await tabNode!.evaluate(e => e.isConnected), "background telemetry retains tab nodes and focus/click targets");
    await page.getByRole("tab", { name: "OpenRouter", exact: true }).click(); const amber = await color();
    assert.equal(new Set([red, green, amber]).size, 3, JSON.stringify({ red, green, amber }));
    assert.match(await page.locator("#usage").innerText(), /40 \/ 50/);
    await page.getByRole("tab", { name: "OpenRouter", exact: true }).press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: "Codex", exact: true }).getAttribute("aria-selected"), "true");
    const claude = hello.threads.find((t: any) => t.provider === "claude");
    if (claude) {
      await page.locator("#threads li", { has: page.locator(".t", { hasText: claude.title }) }).first().click();
      assert.equal(await page.locator("#effort").isVisible(), true);
      await page.locator("#effort").click();
      assert.ok(await page.getByRole("option", { name: "Effort · High", exact: true }).count());
      await page.keyboard.press("Escape");
      if (width === 390) {
        // a real running state from the server: settings stay visible on mobile (user rule), Stop replaces Send until text is typed
        client.send(JSON.stringify({ t: "thread", thread: { ...claude, status: "running" } }));
        await page.locator("#stop").waitFor();
        assert.equal(await page.locator("#effort").isVisible(), true, "effort stays visible during a run");
        assert.equal(await page.locator("#model").isVisible(), true, "model stays visible during a run");
        assert.equal(await page.locator("#mode").isVisible(), true, "permissions stay visible during a run");
        assert.equal(await page.locator("#send").isVisible(), false);
        await page.locator("#input").fill("queued follow-up");
        assert.equal(await page.locator("#send").isVisible(), true, "typing mid-run offers Send (queues)");
        assert.equal(await page.locator("#stop").isVisible(), false);
        await page.locator("#input").fill("");
        assert.ok(await page.evaluate(() => { const toolbar = document.querySelector(".toolbar")!; return toolbar.scrollWidth <= toolbar.clientWidth + 1 && [...toolbar.querySelectorAll("button")].every(b => { const r = b.getBoundingClientRect(); return !r.width || r.right <= innerWidth; }); }), "running toolbar fits the phone width");
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/ac-provider-usage-${width}.png` });
    console.log(`PASS ${width}px provider tabs, real context migration, green/amber/red meters, keyboard navigation, composer effort, no overflow`);
    await ctx.close();
  }
} finally { await browser.close(); }
