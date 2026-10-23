// Reconnect robustness, isolated (mock thread, scratch data, no model calls): a half-dead socket is replaced quickly on wake or
// when a send goes unacknowledged, queued messages are delivered once after reconnecting, and the server drops pong-less sockets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocket } from "ws";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-reconnect-ui-"));
const port = 17779,
  base = `http://127.0.0.1:${port}`,
  id = "33333333-3333-4333-8333-333333333333";
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id,
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: "Reconnect",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
);
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "logs", id + ".jsonl"),
  JSON.stringify({ type: "user_input", text: "fixture" }) + "\n",
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_WS_PING_MS: "400",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: "ignore",
});
const inputs = (text: string) =>
  fs
    .readFileSync(path.join(data, "logs", id + ".jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "user_input" && e.text === text).length;
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // server: a client that never answers pings is terminated; a normal one stays
  const cookie = `ac_session=${makeToken()}`;
  const deaf = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie, origin: base },
      autoPong: false,
    } as any),
    ok = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
  const t0 = Date.now();
  const closedAt = await new Promise<number>((r) => deaf.on("close", () => r(Date.now() - t0)));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(ok.readyState, WebSocket.OPEN);
  assert.ok(closedAt < 2000, String(closedAt));
  ok.close();
  console.log(`PASS  server: pong-less socket terminated after ${closedAt} ms, live socket kept`);

  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  // every page socket goes through here; `mode` decides what the NEXT-opened connections do (the current one is changed in place)
  const conns: { up: any; toServer: boolean; toPage: boolean }[] = [];
  await context.routeWebSocket("**/ws", (socket) => {
    const c = { up: socket.connectToServer(), toServer: true, toPage: true };
    conns.push(c);
    c.up.onMessage((m: any) => c.toPage && socket.send(m));
    socket.onMessage((m: any) => c.toServer && c.up.send(m));
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(
    () =>
      document.getElementById("ttl")?.textContent === "Reconnect" &&
      !(document.getElementById("input") as HTMLTextAreaElement).disabled,
  );
  const sendText = async (text: string) => {
    await page.fill("#input", text);
    await page.click("#send");
  };

  // 1. half-dead socket (nothing passes either way): the unacknowledged send triggers a probe, reconnect, and one delivery
  const dead = conns.at(-1)!;
  dead.toServer = false;
  dead.toPage = false;
  const s1 = Date.now();
  await sendText("sent into a dead socket");
  await page.waitForFunction(
    () =>
      document.body.textContent?.includes(
        "mock reply (acceptEdits, echo): sent into a dead socket",
      ),
    null,
    { timeout: 10000 },
  );
  const took = Date.now() - s1;
  assert.equal(inputs("sent into a dead socket"), 1);
  assert.ok(conns.length >= 2);
  assert.ok(took < 6000, String(took));
  console.log(`PASS  client: send on a dead socket delivered once after reconnect (${took} ms)`);

  // 2. lost ack (server gets the message, replies never arrive): resend after reconnect is not run twice
  const deaf2 = conns.at(-1)!;
  deaf2.toPage = false;
  await sendText("ack lost in transit");
  await page.waitForFunction(
    () =>
      document.body.textContent?.includes("mock reply (acceptEdits, echo): ack lost in transit"),
    null,
    { timeout: 10000 },
  );
  await page.waitForTimeout(500);
  assert.equal(inputs("ack lost in transit"), 1, "server ran the resent message once");
  console.log("PASS  client: lost ack -> resent after reconnect, server ran it once");

  // 3. wake: a visibilitychange to visible probes the socket and replaces a dead one within ~1.5 s
  const sleepy = conns.at(-1)!;
  sleepy.toServer = false;
  sleepy.toPage = false;
  const before = conns.length;
  const w0 = Date.now();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  while (conns.length === before && Date.now() - w0 < 5000) await page.waitForTimeout(20);
  const wake = Date.now() - w0;
  assert.ok(conns.length > before && wake < 2500, String(wake));
  console.log(`PASS  client: wake detected a dead socket and reconnected in ${wake} ms`);

  // 4. a healthy socket survives the wake probe
  const healthy = conns.length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(2000);
  assert.equal(conns.length, healthy);
  console.log("PASS  client: healthy socket kept after the wake probe");
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
