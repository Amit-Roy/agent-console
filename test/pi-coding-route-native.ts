// Native Pi retry integration against local endpoints only. No API quota is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DIRECT_CODING, ROUTER_CODING } from "../server/providers/pi-coding-route.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pi-route-native-"));
const requests: { source: string; messages: any[] }[] = [];
const marker = path.join(scratch, "tool-executions");
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", () => {
    const source = req.url!.startsWith("/nvidia/") ? "nvidia" : "openrouter";
    const body = JSON.parse(raw);
    requests.push({ source, messages: body.messages });
    assert.equal(body.model, source === "nvidia" ? DIRECT_CODING : ROUTER_CODING);
    if (source === "nvidia" && requests.filter(r => r.source === source).length > 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "429 Too Many Requests", type: "rate_limit_exceeded" } }));
      return;
    }
    const chunk = (delta: any, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (source === "nvidia") {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "write-once", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf 'once\\n' >> tool-executions" }) } }] }, null));
      res.end(chunk({}, "tool_calls") + "data: [DONE]\n\n");
    } else {
      res.write(chunk({ role: "assistant", content: "FALLBACK_OK" }, null));
      res.end(chunk({}, "stop") + "data: [DONE]\n\n");
    }
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;
const agent = path.join(scratch, "agent");
fs.mkdirSync(agent);
fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: Object.fromEntries([
  ["nvidia", DIRECT_CODING], ["openrouter", ROUTER_CODING],
].map(([provider, id]) => [provider, { baseUrl: `http://127.0.0.1:${port}/${provider}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id }] }])) }));
fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 5, provider: { maxRetries: 0 } } }));
try {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("pi", ["--print", "--mode", "json", "--no-session", "--offline", "--no-mcp", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve", "--tools", "bash", "--thinking", "off", "--provider", "agent-console", "--model", "auto-coding", "--extension", fileURLToPath(new URL("../server/providers/pi-coding-route.mjs", import.meta.url)), "--system-prompt", "Run the requested tool, then finish.", "Write the marker once."], { cwd: scratch, env: { ...process.env, HOME: scratch, NODE_OPTIONS: "", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(Error("Native Pi route test timed out.")); }, 30_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", code => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(Error(`Native Pi exited ${code}: ${stderr.slice(-2000)}`)); });
  });
  assert.equal(fs.readFileSync(marker, "utf8"), "once\n", "completed tool must execute exactly once across provider fallback");
  assert.deepEqual(requests.map(r => r.source), ["nvidia", "nvidia", "openrouter"]);
  const fallback = requests.at(-1)!;
  assert.equal(fallback.messages.filter(message => message.role === "tool").length, 1, "fallback receives the completed tool result");
  const events = output.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === "tool_execution_start").length, 1);
  assert.ok(events.some(event => event.type === "message_end" && event.message?.provider === "openrouter" && event.message?.model === ROUTER_CODING));
  assert.ok(output.includes("FALLBACK_OK"));
  console.log("pi-coding-route-native: NVIDIA tool then 429, OpenRouter fallback, no tool replay passed");
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
