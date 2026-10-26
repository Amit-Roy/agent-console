// Claude threads keep one fixed tools array for their whole life. Any change to these surfaces
// invalidates the prompt cache of every live thread, so the hashes below only change deliberately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleMcp } from "../server/providers/console-mcp.mjs";
import consoleTools from "../server/providers/console-tools.mjs";

const MCP_TOOLS_LIST_SHA256 = "223bba49a7ee01a77d2eb996c3905866b8f64b0199a3bceb681ee3ed5a5eb0d4";
const PI_CONSOLE_TOOLS_SHA256 = "9701d8565d550ed452d832edfe1da69e3b8bd0250c780dfaa5ef75b122e0e44e";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const MESSAGE = "tool change breaks every live thread's prompt cache; update the hash deliberately";

const listed = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const mcpHash = sha256(JSON.stringify(listed.result));

const piTools: { name: string; description: string }[] = [];
consoleTools({ registerTool: (tool: any) => piTools.push(tool) });
const piHash = sha256(
  JSON.stringify(
    piTools
      .map(({ name, description }) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ),
);

assert.equal(mcpHash, MCP_TOOLS_LIST_SHA256, `MCP tools/list changed (${mcpHash}): ${MESSAGE}`);
assert.equal(piHash, PI_CONSOLE_TOOLS_SHA256, `Pi consoleTools changed (${piHash}): ${MESSAGE}`);
console.log("tool-surface-freeze: MCP tools/list and Pi consoleTools match the pinned hashes");
