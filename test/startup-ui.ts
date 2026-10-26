// Startup: no "No thread selected" flash before the thread list arrives, and a reload reopens the last thread.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-startup-ui-"));
const base = "http://127.0.0.1:17776";
const mk = (id: string, title: string, at: number) => ({
  id,
  provider: "mock",
  model: "echo",
  effort: "medium",
  mode: "bypassPermissions",
  title,
  cwd: "/home/coder/repos",
  status: "idle",
  cost: 0,
  createdAt: at,
  updatedAt: at,
});
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    mk("t-a", "First thread", 3),
    mk("t-b", "Second thread", 2),
    mk("t-c", "Third thread", 1),
  ]),
);
fs.mkdirSync(path.join(data, "logs"));
for (const id of ["t-a", "t-b", "t-c"])
  fs.writeFileSync(
    path.join(data, "logs", id + ".jsonl"),
    JSON.stringify({ type: "user_input", text: "hello from " + id }) + "\n",
  );
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: { ...process.env, PORT: "17776", AGENT_CONSOLE_MOCK: "1" },
  stdio: "ignore",
});
let browser: Browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([
    {
      name: "__Host-ac_session",
      value: makeToken(),
      domain: new URL(base).hostname,
      path: "/",
      secure: true,
    },
  ]);
  // record every empty-state / "No thread" title that is ever painted, from the first frame on
  await context.addInitScript(() => {
    (window as any).__flash = [];
    new MutationObserver(() => {
      const d = document;
      if (
        d.querySelector("#chat .empty h2")?.textContent === "No thread selected" ||
        d.getElementById("ttl")?.textContent === "No thread"
      )
        (window as any).__flash.push(performance.now());
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  let hold = true;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await context.routeWebSocket("**/ws", (socket) => {
    const up = socket.connectToServer();
    up.onMessage(async (raw) => {
      if (hold && JSON.parse(String(raw)).t === "hello") await gate;
      socket.send(raw);
    });
    socket.onMessage((m) => up.send(m));
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForTimeout(500); // the window before hello: must stay neutral
  assert.deepEqual(
    await page.evaluate(() => (window as any).__flash),
    [],
    "no empty state before the thread list arrives",
  );
  assert.equal(await page.textContent("#ttl"), "");
  release();
  hold = false;
  await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "First thread");
  assert.deepEqual(
    await page.evaluate(() => (window as any).__flash),
    [],
    "no empty state while opening the first thread",
  );
  await page.click("#menu");
  await page.click("text=Third thread");
  await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "Third thread");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "Third thread");
  assert.deepEqual(
    await page.evaluate(() => (window as any).__flash),
    [],
    "no empty state on reload",
  );
  console.log("PASS  startup: no empty-state flash, last thread restored");
  // with no threads at all, the empty state must still appear once the list arrives
  fs.writeFileSync(path.join(data, "threads.json"), "[]");
  await context.routeWebSocket("**/ws", (socket) => {
    const up = socket.connectToServer();
    up.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "hello") m.threads = [];
      socket.send(JSON.stringify(m));
    });
    socket.onMessage((m) => up.send(m));
  });
  const empty = await context.newPage();
  await empty.goto(base);
  await empty.waitForSelector('#chat .empty h2:text("No thread selected")');
  assert.equal(await empty.textContent("#ttl"), "No thread");
  console.log("PASS  startup: empty state shown when there are no threads");
} finally {
  await browser?.close();
  server.kill();
}
