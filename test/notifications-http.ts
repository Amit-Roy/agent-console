import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createECDH } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-notifications-http-"));
const data = path.join(directory, "data");
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(directory, "run"), AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_AUTH: "password", AGENT_CONSOLE_PASSWORD: password },
  stdio: ["ignore", "pipe", "pipe"],
});
// Server logs can contain credentials. Consume them without displaying or persisting them.
child.stderr.resume();
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Scratch server exited: ${code}`)); });
    let output = "";
    child.stdout.on("data", chunk => {
      output = (output + chunk.toString()).slice(-2048);
      if (output.includes("agent-console listening on")) { clearTimeout(timer); resolve(); }
    });
  });
  const route = "/api/notifications/subscriptions";
  assert.equal((await fetch(origin + "/api/notifications")).status, 401);
  for (const method of ["POST", "DELETE"]) {
    assert.equal((await fetch(origin + route, { method })).status, 401);
  }
  const login = await fetch(origin + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const headers = { Cookie: cookie, "Content-Type": "application/json", Origin: origin };
  const settings = await fetch(origin + "/api/notifications", { headers });
  assert.equal(settings.headers.get("cache-control"), "no-store");
  const config = await settings.json();
  assert.equal(config.enabled, true);
  assert.equal(Buffer.from(config.publicKey, "base64url").length, 65);
  assert.equal("privateKey" in config, false);
  for (const method of ["POST", "DELETE"]) {
    for (const requestHeaders of [{ ...headers, Origin: "https://example.invalid" },
      { Cookie: cookie, "Content-Type": "application/json" }]) {
      assert.equal((await fetch(origin + route, { method, headers: requestHeaders, body: "{}" })).status, 403);
    }
  }
  const ecdh = createECDH("prime256v1");
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/scratch-only",
    keys: { p256dh: ecdh.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  const request = (method: string, body: unknown) => fetch(origin + route, { method, headers, body: JSON.stringify(body) });
  assert.equal((await request("POST", { ...subscription, endpoint: "http://127.0.0.1/private" })).status, 400);
  assert.equal((await request("POST", subscription)).status, 200);
  const stateFile = path.join(data, "notifications.json");
  const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(readState().devices.length, 1);
  assert.equal(readState().devices[0].origin, origin);
  assert.equal((await request("POST", subscription)).status, 200);
  assert.equal(readState().devices.length, 1, "Repeated subscription updates the same device.");
  assert.equal((await request("DELETE", {})).status, 400);
  assert.equal((await request("DELETE", { endpoint: subscription.endpoint })).status, 200);
  assert.deepEqual(readState().devices, []);
  console.log("PASS notification HTTP authentication, origin checks, subscription lifecycle and private-key exclusion");
} finally {
  const exited = once(child, "exit");
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
  fs.rmSync(directory, { recursive: true, force: true });
}
