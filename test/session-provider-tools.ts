import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../server/providers/console-tools.mjs";
import { consoleMcpServer, consoleCodexMcpArgs, SESSION_INSTRUCTIONS } from "../server/providers/console-mcp.mjs";
import { claudeControl, leanMcpArgs } from "../server/providers/claude.ts";
import { harnessInstructions } from "../server/providers/brain.ts";

const saved = { ...process.env };
const calls: any[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  calls.push({ url: req.url, token: req.headers["x-agent-console-tool"], thread: req.headers["x-agent-console-thread"], body: JSON.parse(body) });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ results: [{ thread: "past-thread", citation: "session:past-thread:L7", text: "pr-standards promised" }] }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address: any = server.address();
process.env.AGENT_CONSOLE_TOOL_URL = `http://127.0.0.1:${address.port}/api/agent-tools`;
process.env.AGENT_CONSOLE_TOOL_TOKEN = "isolated-test-token";
process.env.AGENT_CONSOLE_THREAD = "calling-thread";
let child: ReturnType<typeof spawn> | undefined;
try {
  for (const mode of ["plan", "acceptEdits", "bypassPermissions"]) {
    const replies: any[] = [];
    const control = claudeControl((reply) => replies.push(reply), () => {}, mode);
    const allowed = ["mcp__agent_console__session_search", "mcp__agent_console__session_read", "mcp__agent_console__pi_research"];
    for (const name of [...allowed, "mcp__agent_console__schedule_delete", "mcp__other__session_search"]) {
      control.handle({ type: "control_request", request_id: name, request: { subtype: "can_use_tool", tool_name: name, input: { query: "past" } } });
      assert.equal(replies.at(-1).response.response.behavior, allowed.includes(name) ? "allow" : "deny");
    }
  }
  const config = consoleMcpServer()!;
  assert.equal(config.command, process.execPath);
  assert(!JSON.stringify(config).includes("isolated-test-token"));
  const args = consoleCodexMcpArgs();
  assert(args.some((v: string) => v.startsWith("mcp_servers.agent_console.env_vars=")));
  assert(!args.join(" ").includes("isolated-test-token"));
  process.env.AGENT_CONSOLE_MCP = "nonexistent";
  assert(JSON.parse(leanMcpArgs()[2]).mcpServers.agent_console);
  process.env.AGENT_CONSOLE_MCP = "all";
  const all = leanMcpArgs();
  assert(!all.includes("--strict-mcp-config"));
  assert(JSON.parse(all[1]).mcpServers.agent_console);
  assert((await harnessInstructions()).includes(SESSION_INSTRUCTIONS));
  assert(TOOLS.some((t: any) => t.name === "session_search"));
  assert(TOOLS.some((t: any) => t.name === "session_read"));

  child = spawn(process.execPath, [fileURLToPath(new URL("../server/providers/console-mcp.mjs", import.meta.url))], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (v: any) => void>();
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); });
  let id = 0;
  const request = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const current = ++id;
    const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
    pending.set(current, (reply) => { clearTimeout(timeout); pending.delete(current); resolve(reply); });
    child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
  });
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert(init.result.capabilities.tools);
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await request("tools/list");
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["session_search", "session_read", "pi_research"]);
  assert(list.result.tools.every((t: any) => t.annotations.readOnlyHint));
  const search = await request("tools/call", { name: "session_search", arguments: { query: "pr-standards", provider: "codex", limit: 3 } });
  assert(search.result.content[0].text.includes("session:past-thread:L7"));
  await request("tools/call", { name: "session_read", arguments: { thread: "past-thread", start: 7, limit: 5 } });
  const research = await request("tools/call", { name: "pi_research", arguments: { task: "map callers" } });
  assert(!research.result.isError);
  assert.deepEqual(calls.map((c) => c.url), ["/api/agent-tools/session_search", "/api/agent-tools/session_read", "/api/agent-tools/pi_research"]);
  assert.deepEqual(calls[2].body, { task: "map callers" });
  const registered: string[] = [];
  (await import("../server/providers/console-tools.mjs")).default({ registerTool: (t: any) => registered.push(t.name) });
  assert(registered.includes("session_search") && !registered.includes("pi_research"), "Pi must not delegate to Pi");
  assert(calls.every((c) => c.token === "isolated-test-token" && c.thread === "calling-thread"));
  assert.deepEqual(calls[0].body, { query: "pr-standards", provider: "codex", limit: 3 });
  const denied = await request("tools/call", { name: "schedule_delete", arguments: { id: "x" } });
  assert.equal(denied.error.code, -32602);
  delete process.env.AGENT_CONSOLE_TOOL_TOKEN;
  assert.equal(consoleMcpServer(), undefined);
  assert.deepEqual(consoleCodexMcpArgs(), []);
  console.log("session-provider-tools: native MCP handshake, HTTP forwarding, Pi discovery, and Claude/Codex wiring pass");
} finally {
  child?.kill();
  server.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}
