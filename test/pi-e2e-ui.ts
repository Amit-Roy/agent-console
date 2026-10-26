// End-to-end smoke through the real Pi harness: browser → server → `pi --mode rpc` → model API → browser.
// The model is a local OpenAI-compatible stub, so no quota is spent and CI needs no secrets.
// Needs `pi` on PATH and Playwright Chromium. Starts its own scratch server and stub; no running console required.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pi-e2e-"));
const port = Number(process.env.PI_E2E_PORT || 7076),
  base = `http://127.0.0.1:${port}`;

// The stub streams one chat-completions answer that echoes the last user message.
const requests: any[] = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const json = JSON.parse(body);
    requests.push(json);
    const last = [...json.messages].reverse().find((m: any) => m.role === "user");
    const text =
      typeof last?.content === "string"
        ? last.content
        : (last?.content ?? []).map((p: any) => p.text ?? "").join("");
    const chunk = (delta: any, finish: string | null, extra = {}) =>
      `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: "echo", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: `PI_E2E_OK ${text.trim()}` }, null));
    res.end(
      chunk({}, "stop", { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) +
        "data: [DONE]\n\n",
    );
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = (stub.address() as any).port;

const piDir = path.join(data, "pi");
fs.mkdirSync(piDir);
fs.writeFileSync(
  path.join(piDir, "models.json"),
  JSON.stringify({
    providers: {
      stub: {
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        api: "openai-completions",
        apiKey: "stub",
        models: [{ id: "echo" }],
      },
    },
  }),
);
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id: "pi-e2e",
      provider: "pi",
      model: "stub/echo",
      mode: "acceptEdits",
      title: "Pi smoke",
      cwd: data,
      status: "idle",
      cost: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, [process.env.TEST_SERVER_ENTRY || "server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
    PI_CODING_AGENT_DIR: piDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (c) => (log += c));
server.stderr.on("data", (c) => (log += c));
let browser: Browser;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server did not start")), 20000);
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([
    {
      name: "__Host-ac_session",
      value: makeToken(),
      domain: new URL(base).hostname,
      path: "/",
      secure: true,
    },
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#threads li .t", { hasText: "Pi smoke" }).click();
  await page.waitForFunction(
    () => !(document.getElementById("input") as HTMLTextAreaElement)?.disabled,
  );
  await page.fill("#input", "ping from playwright");
  await page.click("#send");
  const reply = page.locator(".msg.asst", { hasText: "PI_E2E_OK ping from playwright" });
  await reply.waitFor({ timeout: 60000 });
  assert.equal(requests.length >= 1, true, "pi called the model API");
  assert.equal(requests[0].model, "echo", "pi sent the selected model");
  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS  pi e2e: browser → pi rpc → model stub → browser");
} catch (e) {
  console.error(log.slice(-4000));
  throw e;
} finally {
  await browser?.close();
  server.kill();
  stub.close();
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
