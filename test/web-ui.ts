import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { codexTranslator } from "../server/providers/codex.ts";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-web-ui-"));
const base = "http://127.0.0.1:17772",
  id = "web-fixture";
const thread = {
  id,
  provider: "mock",
  model: "echo",
  mode: "plan",
  title: "Web fixture",
  cwd: process.cwd(),
  status: "idle",
  cost: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([thread]));
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: { ...process.env, PORT: "17772", AGENT_CONSOLE_MOCK: "1" },
  stdio: "ignore",
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await ctx.addInitScript((id) => localStorage.setItem("ac_thread", id), id);
    const events: any[] = [{ type: "user_input", text: "Browse the web" }];
    let client: any;
    await ctx.routeWebSocket("**/ws", (socket) => {
      client = socket;
      const upstream = socket.connectToServer();
      upstream.onMessage((raw) => {
        const m = JSON.parse(String(raw));
        if (m.t === "history") {
          m.events = events;
          m.start = 0;
          m.end = events.length;
          m.total = events.length;
        }
        socket.send(JSON.stringify(m));
      });
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForSelector(".msg.user");
    const emit = (ev: any) => {
      events.push(ev);
      client.send(JSON.stringify({ t: "event", thread: id, event: ev }));
    };
    const trans = codexTranslator(emit);
    trans({ type: "item.started", item: { id: "web", type: "web_search", query: "" } });
    await page.waitForSelector('.card .name:has-text("WebBrowse")');
    trans({
      type: "item.completed",
      item: {
        id: "web",
        type: "web_search",
        query: "",
        action: { type: "search", queries: ["alpha", "beta"] },
      },
    });
    await page.waitForSelector('.card.done .sum:has-text("alpha · beta")');
    for (const [wid, action] of [
      ["open", { type: "open_page", url: "https://example.com" }],
      ["find", { type: "find_in_page", url: "https://example.com", pattern: "needle" }],
    ] as const)
      trans({ type: "item.completed", item: { id: wid, type: "web_search", query: "", action } });
    emit({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "legacy", name: "WebSearch", input: { query: "" } }],
      },
    });
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await page.waitForSelector('.card .name:has-text("WebFind")');
      assert.equal(await page.locator(".card").count(), 4);
      assert.equal(
        await page
          .locator(".card .name")
          .allTextContents()
          .then((a) => a.join(",")),
        "WebSearch,WebFetch,WebFind,WebBrowse",
      );
      assert.match(
        (await page.locator(".card .sum").allTextContents()).join("\n"),
        /needle · https:\/\/example.com/,
      );
      await page.locator(".card").last().locator("summary").click();
      assert.match(
        (await page.locator(".card").last().locator(".body").textContent()) || "",
        /not reported/,
      );
    }
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    console.log(
      `PASS ${width}px live metadata update, no duplicate cards, page/find details, legacy missing data, history replay`,
    );
    await ctx.close();
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((r) => server.once("exit", () => r()));
  }
  fs.rmSync(data, { recursive: true, force: true });
}
