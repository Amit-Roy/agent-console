// Unsent prompts survive thread navigation and closing the page; sending clears only that thread.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-drafts-ui-"));
const port = Number(process.env.DRAFTS_UI_PORT || 7075),
  base = `http://127.0.0.1:${port}`;
const ids = ["draft-a", "draft-b"];
fs.mkdirSync(path.join(data, "uploads"));
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify(
    ids.map((id, i) => ({
      id,
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: `Draft ${i + 1}`,
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 2 - i,
      updatedAt: 2 - i,
    })),
  ),
);
for (const id of ids)
  fs.writeFileSync(
    path.join(data, "logs", `${id}.jsonl`),
    JSON.stringify({ type: "user_input", text: "fixture" }) + "\n",
  );
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: ["ignore", "pipe", "ignore"],
});
let browser: Browser;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server did not start")), 15000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("agent-console listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Scratch server exited: ${code}`));
    });
  });
  browser = await chromium.launch();
  let context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  let hello: string | undefined, replay: ((raw: string) => void) | undefined;
  await context.routeWebSocket("**/ws", (socket) => {
    const up = socket.connectToServer();
    replay = (raw) => socket.send(raw);
    up.onMessage((raw) => {
      if (JSON.parse(String(raw)).t === "hello") hello = String(raw);
      socket.send(raw);
    });
    socket.onMessage((raw) => up.send(raw));
  });
  let page = await context.newPage();
  const errors: string[] = [];
  const open = async () => {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(
      () => !(document.getElementById("input") as HTMLTextAreaElement)?.disabled,
    );
  };
  const thread = async (title: string) => {
    await page.locator("#threads li .t", { hasText: title }).click();
    await page.waitForFunction((t) => document.getElementById("ttl")?.textContent === t, title);
  };
  await open();
  await thread("Draft 1");
  const first = "First draft\n  keep whitespace  ";
  await page.fill("#input", first);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("ac_draft:draft-a")),
    first,
    "input persists immediately",
  );
  await thread("Draft 2");
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    "",
    "new thread starts empty",
  );
  await page.fill("#input", "Second draft");
  await thread("Draft 1");
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    first,
    "return restores exact draft",
  );
  await page.locator("#ttl").evaluate((title) => {
    title.textContent = "Waiting for reconnect hello";
  });
  replay!(hello!);
  await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "Draft 1");
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    first,
    "reconnect hello keeps current draft",
  );
  await page.reload();
  await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "Draft 1");
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    first,
    "reload restores draft",
  );
  const saved = await context.storageState();
  await context.close();
  context = await browser.newContext({
    storageState: saved,
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  await open();
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    first,
    "closing and reopening page restores draft",
  );
  await thread("Draft 2");
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    "Second draft",
    "other thread survives reload and close",
  );
  await page.fill("#input", "");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("ac_draft:draft-b")),
    null,
    "clearing deletes stored draft",
  );
  await thread("Draft 1");
  await page.click("#send");
  await page.waitForFunction(
    () => (document.getElementById("input") as HTMLTextAreaElement).value === "",
  );
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    "",
    "send clears composer",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("ac_draft:draft-a")),
    null,
    "send deletes stored draft",
  );
  await page.waitForFunction(
    () => !Object.keys(localStorage).some((key) => key.startsWith("ac_sending:")),
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document.getElementById("ttl")?.textContent &&
      !(document.getElementById("input") as HTMLTextAreaElement).disabled,
  );
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    "",
    "sent draft does not return",
  );
  await page.evaluate(() => {
    localStorage.removeItem("ac_draft:draft-a");
    sessionStorage.setItem("ac_draft", "Legacy draft");
  });
  await page.reload();
  await page.waitForFunction(
    () => (document.getElementById("input") as HTMLTextAreaElement).value === "Legacy draft",
  );
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("ac_draft")),
    null,
    "legacy draft consumed",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("ac_draft:draft-a")),
    "Legacy draft",
    "legacy draft migrated",
  );
  // Keep sends away from the mock server to control acknowledgement and rejection precisely.
  let reply: ((message: any) => void) | undefined;
  const outgoing: any[] = [];
  await context.routeWebSocket("**/ws", (socket) => {
    const upstream = socket.connectToServer();
    reply = (message) => socket.send(JSON.stringify(message));
    upstream.onMessage((raw) => socket.send(raw));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "send") outgoing.push(message);
      else upstream.send(raw);
    });
  });
  await page.reload();
  await page.waitForFunction(() => !(document.getElementById("input") as any)?.disabled);
  const recovery = "Keep this until accepted\n  including whitespace  ";
  await page.fill("#input", recovery);
  await page.click("#send");
  await page.waitForFunction(() => (document.getElementById("input") as any).value === "");
  assert.equal(outgoing.length, 1, "send is held before server acceptance");
  assert.equal(
    await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.startsWith("ac_sending:")).length,
    ),
    1,
    "recovery copy remains until acknowledgement",
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      (document.getElementById("input") as any).value ===
      "Keep this until accepted\n  including whitespace  ",
  );
  assert.equal(
    outgoing.length,
    1,
    "recovered send stays unsent instead of replaying automatically",
  );
  await page.click("#send");
  await page.waitForFunction(() => (document.getElementById("input") as any).value === "");
  reply!({ t: "error", cid: outgoing.at(-1).cid, message: "Rejected fixture" });
  await page.waitForFunction(
    () =>
      (document.getElementById("input") as any).value ===
      "Keep this until accepted\n  including whitespace  ",
  );
  await page.click("#send");
  await page.waitForFunction(() => (document.getElementById("input") as any).value === "");
  await page.fill("#input", "Newer edits");
  reply!({ t: "ack", cid: outgoing.at(-1).cid });
  await page.waitForFunction(
    () => !Object.keys(localStorage).some((k) => k.startsWith("ac_sending:")),
  );
  assert.equal(
    await page.locator("#input").evaluate((e: any) => e.value),
    "Newer edits",
    "late acknowledgement preserves newer typing",
  );
  await page.reload();
  await page.waitForFunction(
    () => (document.getElementById("input") as any).value === "Newer edits",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS drafts: thread isolation, exact text, reconnect, reload, close, clear, send, unacknowledged recovery, rejection, newer edits",
  );
} finally {
  await browser?.close();
  const exited = once(server, "exit");
  server.kill();
  await exited;
  fs.rmSync(data, { recursive: true, force: true });
}
