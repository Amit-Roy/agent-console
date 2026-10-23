import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The broker is the one door to the model queue: it must reject strangers, honour priority, and keep providers apart.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-rate-broker-"));
const data = path.join(directory, "data");
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const child = spawn(process.execPath, [process.env.TEST_SERVER_ENTRY || "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(directory, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_PASSWORD: "fixture-password-0123456789",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
child.stderr.on("data", (chunk) => {
  errors = (errors + chunk.toString()).slice(-600);
});
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Scratch server exited: ${code} ${errors.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")}`,
        ),
      );
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-2048);
      if (output.includes("agent-console listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const broker = JSON.parse(fs.readFileSync(path.join(data, "model-rate-broker.json"), "utf8"));
  assert.equal(broker.url, `http://127.0.0.1:${port}/api/model-request`);
  assert.equal(fs.statSync(path.join(data, "model-rate-broker.json")).mode & 0o777, 0o600);
  const call = (body: object, token = broker.token) =>
    fetch(broker.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-console-tool": token },
      body: JSON.stringify(body),
    });
  assert.equal((await call({ action: "acquire" }, "wrong")).status, 401);
  assert.equal((await fetch(broker.url, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await call({ action: "nonsense" })).status, 400);
  assert.equal(
    (await call({ action: "acquire", provider: "nvidia", priority: "label" })).status,
    200,
  );
  // An unknown priority cannot jump the queue: it is treated as the default, not as a number.
  assert.equal((await call({ action: "acquire", provider: "nvidia", priority: 999 })).status, 200);
  assert.equal(
    (await call({ action: "cooldown", provider: "nvidia", retryAfter: "8" })).status,
    200,
  );
  const started = Date.now();
  assert.equal(
    (await call({ action: "acquire", provider: "openrouter", priority: "label" })).status,
    200,
  );
  assert.ok(Date.now() - started < 6_000, "an NVIDIA cooldown must not hold OpenRouter requests");
  console.log(
    "model-rate-broker: authentication, priorities and provider isolation over HTTP passed",
  );
} finally {
  child.kill();
  fs.rmSync(directory, { recursive: true, force: true });
}
