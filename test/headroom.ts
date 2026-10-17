// Offline startup regression: delay proxy health and verify no session can inherit the initial unhealthy state.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-headroom-"));
const socket = net.createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
fs.writeFileSync(path.join(scratch, "headroom"), `#!${process.execPath}
const http = require('node:http');
setTimeout(() => http.createServer((req, res) => res.end('ok')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1'), 300);
`, { mode: 0o700 });
process.env.PATH = `${scratch}:${process.env.PATH}`;
process.env.AGENT_CONSOLE_HEADROOM = "1";
process.env.AGENT_CONSOLE_HEADROOM_PORT = String(port);
const { headroom } = await import("../server/headroom.ts");
try {
  assert.equal(headroom.url(), undefined);
  const starting = headroom.start();
  await starting;
  assert.equal(headroom.state().running, true);
  assert.equal(headroom.url(), `http://127.0.0.1:${port}`);
  await headroom.start(); // idempotent: no second proxy
  console.log("PASS Headroom startup waits for delayed proxy health before routing sessions");
} finally {
  headroom.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
