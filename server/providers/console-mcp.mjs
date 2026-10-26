// Minimal newline-delimited stdio MCP bridge. No network listener or credentials in arguments.
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callTool, TOOLS } from "./console-tools.mjs";

export const SESSION_INSTRUCTIONS = [
  "# Agent Console",
  "When you need a decision or input from the user, use your structured question tool (AskUserQuestion, request_user_input or ask_user) instead of asking in chat. It shows an answer card in Agent Console. Use plain chat only for open-ended discussion or when no such tool exists.",
  "Use thread_list and thread_send to contact other Agent Console threads.",
  "Session history, CLI lookup, Pi research, transcript redaction: skill `agent-console-tools` (CLI `console-tool`).",
].join("\n");

// The tool surface is frozen for a thread's whole life: any change busts every live thread's prompt cache (test/tool-surface-freeze.ts).
const exposed = (name) => name === "thread_list" || name === "thread_send";

export function consoleMcpServer() {
  if (!process.env.AGENT_CONSOLE_TOOL_URL || !process.env.AGENT_CONSOLE_TOOL_TOKEN)
    return undefined;
  return { command: process.execPath, args: [fileURLToPath(import.meta.url)] };
}

export function consoleCodexMcpArgs() {
  const server = consoleMcpServer();
  if (!server) return [];
  // TOML accepts JSON string/array literals. Credentials remain inherited environment values.
  return [
    "-c",
    `mcp_servers.agent_console.command=${JSON.stringify(server.command)}`,
    "-c",
    `mcp_servers.agent_console.args=${JSON.stringify(server.args)}`,
    "-c",
    'mcp_servers.agent_console.env_vars=["AGENT_CONSOLE_TOOL_URL","AGENT_CONSOLE_TOOL_TOKEN","AGENT_CONSOLE_THREAD"]',
  ];
}

export async function handleMcp(request) {
  if (request.id === undefined) return undefined;
  const result = (value) => ({ jsonrpc: "2.0", id: request.id, result: value });
  const error = (code, message) => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  switch (request.method) {
    case "initialize":
      return result({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-console-sessions", version: "1.0.0" },
        instructions: SESSION_INSTRUCTIONS,
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({
        tools: TOOLS.filter((t) => exposed(t.name)).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
          annotations: {
            readOnlyHint: t.name !== "thread_send",
            destructiveHint: false,
          },
        })),
      });
    case "tools/call": {
      const name = request.params?.name;
      if (!TOOLS.some((t) => t.name === name && exposed(name)))
        return error(-32602, "Unknown session tool.");
      const text = await callTool(name, request.params?.arguments, AbortSignal.timeout(30_000));
      return result({
        content: [{ type: "text", text }],
        ...(text.startsWith("Error:") ? { isError: true } : {}),
      });
    }
    default:
      return error(-32601, "Method not found.");
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", async (line) => {
    try {
      const reply = await handleMcp(JSON.parse(line));
      if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON-RPC request." },
        }) + "\n",
      );
    }
  });
}
