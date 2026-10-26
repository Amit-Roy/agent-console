// probeHello (scripts/idle-restart.mjs) on a fake WebSocket server: an open socket waits for a slow hello (#347), a wrong build fails,
// and a server that is not up yet is retried.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-probe-"));
const port = await new Promise<number>((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(free));
  });
});
Object.assign(process.env, {
  PORT: String(port),
  AGENT_CONSOLE_DATA: scratch,
  AGENT_CONSOLE_PASSWORD: "probe-test",
});
const { probeHello } = await import("../scripts/idle-restart.mjs");

const logWrite = console.log;
console.log = () => {};

function fakeServer(build: string, helloAfterMs: number | null): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port }, () => resolve(server));
    server.on("connection", (socket) => {
      if (helloAfterMs === null) return;
      setTimeout(() => socket.send(JSON.stringify({ t: "hello", build })), helloAfterMs);
    });
  });
}
const stop = (server: WebSocketServer) => {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => server.close(resolve));
};

try {
  // Slower than the old fixed 1500 ms attempt, and the server comes up 300 ms after the probe starts.
  const late = delay(300).then(() => fakeServer("want", 2000));
  const slow = await probeHello("want", 8000);
  assert.deepEqual(slow, { ok: true, build: "want" });
  await stop(await late);

  const wrong = await fakeServer("other", 0);
  assert.deepEqual(await probeHello("want", 3000), { ok: false, build: "other" });
  await stop(wrong);

  const silent = await fakeServer("want", null);
  const started = Date.now();
  assert.deepEqual(await probeHello("want", 600), { ok: false, build: null });
  assert.ok(Date.now() - started >= 550, "waits for hello until the deadline");
  await stop(silent);
} finally {
  console.log = logWrite;
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("idle-restart probe ok");
process.exit(0);
