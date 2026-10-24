// Isolated browser regression (issue #252): an older-history page whose reply lands while the reader's finger is down must wait
// for the touch to end instead of rewriting scrollTop and arming the history anchor under the finger.
// Run: rtk proxy node test/earlier-mid-drag-ui.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";

const port = "7087",
  base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mid-drag-"));
const threadId = "66666666-6666-4666-8666-666666666666";
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id: threadId,
      provider: "mock",
      model: "echo",
      effort: "medium",
      mode: "plan",
      title: "Long tool-heavy history",
      cwd: process.cwd(),
      status: "idle",
      cost: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
);
fs.writeFileSync(path.join(data, "commands.json"), "{}");
const events: object[] = [];
for (let turn = 0; turn < 60; turn++) {
  events.push({ type: "user_input", text: `question ${turn}` });
  events.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: `tool-${turn}`, name: "Bash", input: { command: `echo ${turn}` } },
      ],
    },
  });
  events.push({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `tool-${turn}`, content: `out ${turn}\n`.repeat(20) },
      ],
    },
  });
  events.push({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: `answer ${turn} `.repeat(30) }] },
  });
}
fs.writeFileSync(
  path.join(data, "logs", `${threadId}.jsonl`),
  events.map((event) => `${JSON.stringify(event)}\n`).join(""),
);
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_ENV_FILES = "/dev/null";
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, [process.env.TEST_SERVER_ENTRY || "server/index.ts"], {
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_CONSOLE_")),
    ),
    PORT: port,
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_PID_FILE: "",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_PAGE: "12",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_ENV_FILES: "/dev/null",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverError = "";
server.stderr.on("data", (chunk) => {
  serverError += String(chunk);
});
let browser: Browser | undefined;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`scratch server exited (${server.exitCode}): ${serverError}`);
    try {
      if ((await fetch(`${base}/login`)).ok) break;
    } catch {}
    if (attempt === 99) throw new Error("scratch server did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
  });
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  await context.addInitScript((thread) => localStorage.setItem("ac_thread", thread), threadId);
  const page = await context.newPage();
  // Park history replies on demand: the page reply is held until the "finger" is down, then released.
  let parked: string[] | null = null;
  let onParked = () => {};
  let release = () => {};
  await page.routeWebSocket(/\/ws$/, (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => upstream.send(message));
    release = () => {
      for (const held of parked?.splice(0) ?? []) socket.send(held);
    };
    upstream.onMessage((message) => {
      if (parked && /"t":"history"/.test(String(message).slice(0, 20))) {
        parked.push(String(message));
        onParked();
      } else socket.send(message);
    });
  });
  await page.goto(base);
  await page.waitForFunction(
    () => {
      const earlier = document.querySelector(".earlier") as HTMLButtonElement | null;
      const chat = document.getElementById("chat") as HTMLElement;
      return (
        earlier &&
        !earlier.disabled &&
        chat.getAttribute("aria-busy") === "false" && // the newest page has finished drawing and settling
        chat.querySelectorAll(":scope > .msg").length > 3
      );
    },
    null,
    { timeout: 8000 },
  );
  const arrived = new Promise<void>((resolve) => {
    parked = [];
    onParked = resolve;
  });
  const before = await page.evaluate(() => {
    const chat = document.getElementById("chat") as HTMLElement;
    chat.dispatchEvent(new Event("touchstart")); // finger down until touchend
    chat.scrollTop = 0;
    (chat.querySelector(":scope > .earlier") as HTMLButtonElement).click();
    return { count: chat.querySelectorAll(":scope > .msg").length, top: chat.scrollTop };
  });
  await arrived; // the page reply is in hand, mid-drag
  release();
  parked = null;
  // ~40 animation frames with the finger still down: the page must not be drawn or scrolled in.
  const during = await page.evaluate(async () => {
    const chat = document.getElementById("chat") as HTMLElement;
    for (let frame = 0; frame < 40; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    return { count: chat.querySelectorAll(":scope > .msg").length, top: chat.scrollTop };
  });
  assert.deepEqual(during, before, "page inserted or scroll moved while the finger was down");
  await page.evaluate(() =>
    (document.getElementById("chat") as HTMLElement).dispatchEvent(new Event("touchend")),
  );
  await page.waitForFunction(
    (count) => document.querySelectorAll("#chat > .msg").length > count,
    before.count,
    { timeout: 5000 },
  );
  console.log(
    `PASS earlier page waits for touchend: ${before.count} msgs, scrollTop ${before.top} held mid-drag`,
  );
} finally {
  await browser?.close();
  server.kill();
}
