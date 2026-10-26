import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clipOutput, OUTPUT_LIMIT, parseConsoleToolArgs } from "../scripts/console-tool.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calls: any[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  calls.push({
    url: req.url,
    token: req.headers["x-agent-console-tool"],
    thread: req.headers["x-agent-console-thread"],
    body: JSON.parse(body),
  });
  res.setHeader("content-type", "application/json");
  if (req.url?.endsWith("/session_read")) {
    res.statusCode = 400;
    return void res.end(JSON.stringify({ error: "Unknown session." }));
  }
  res.end(JSON.stringify({ text: "x".repeat(OUTPUT_LIMIT * 2), marker: req.url }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as any).port;
const env = {
  ...process.env,
  AGENT_CONSOLE_TOOL_URL: `http://127.0.0.1:${port}/api/agent-tools`,
  AGENT_CONSOLE_TOOL_TOKEN: "isolated-test-token",
  AGENT_CONSOLE_THREAD: "calling-thread",
};
function invoke(args: string[], extra: NodeJS.ProcessEnv = env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      path.join(root, "bin", "console-tool"),
      args,
      { env: extra, timeout: 10_000 },
      (failure, stdout, stderr) =>
        resolve({ code: failure ? Number(failure.code) || 1 : 0, stdout, stderr }),
    );
  });
}
try {
  assert.deepEqual(parseConsoleToolArgs(["search", "git", "worktree", "--provider", "pi"]), {
    tool: "session_search",
    input: { query: "git worktree", provider: "pi" },
    timeoutMs: 30_000,
  });
  assert.deepEqual(parseConsoleToolArgs(["read", "thread-1", "7", "--limit", "5"])?.input, {
    thread: "thread-1",
    start: 7,
    limit: 5,
  });
  assert.deepEqual(parseConsoleToolArgs(["cli", "wait", "pr"])?.input, { terms: ["wait", "pr"] });
  const research = parseConsoleToolArgs(["research", "map callers", "--folder", "/tmp"]);
  assert.deepEqual(research?.input, { task: "map callers", folder: "/tmp" });
  assert.equal(research?.timeoutMs, 11 * 60_000);
  assert.deepEqual(parseConsoleToolArgs(["redact", "status", "--job", "j1"])?.input, {
    action: "status",
    job: "j1",
  });
  assert.equal(parseConsoleToolArgs([]), undefined);
  assert.equal(parseConsoleToolArgs(["--help"]), undefined);
  for (const bad of [
    ["search"],
    ["search", "x", "--provider", "gpt"],
    ["read", "only-session"],
    ["read", "t", "abc"],
    ["redact", "delete"],
    ["research"],
    ["nonsense"],
    ["toString", "x"],
  ])
    assert.throws(() => parseConsoleToolArgs(bad), undefined, bad.join(" "));
  assert(clipOutput("a".repeat(OUTPUT_LIMIT + 5)).includes("clipped 5 chars"));

  const search = await invoke(["search", "worktree", "--limit", "3"]);
  assert.equal(search.code, 0, search.stderr);
  assert(search.stdout.length < OUTPUT_LIMIT + 500, "output is bounded");
  assert(search.stdout.includes("clipped"));
  assert.equal(calls[0].url, "/api/agent-tools/session_search");
  assert.deepEqual(calls[0].body, { query: "worktree", limit: 3 });
  assert.equal(calls[0].token, "isolated-test-token");
  assert.equal(calls[0].thread, "calling-thread");
  assert.equal((await invoke(["cli", "wait"])).code, 0);
  assert.equal(calls.at(-1).url, "/api/agent-tools/cli_search");
  assert.equal((await invoke(["redact", "scan"])).code, 0);
  assert.equal(calls.at(-1).url, "/api/agent-tools/session_redact");
  assert.equal((await invoke(["research", "map callers"])).code, 0);
  assert.equal(calls.at(-1).url, "/api/agent-tools/pi_research");

  const failed = await invoke(["read", "missing", "1"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /console-tool: Unknown session\./);
  const usage = await invoke(["--help"]);
  assert.equal(usage.code, 0);
  assert.match(usage.stdout, /run_in_background/);
  const outside = await invoke(["search", "x"], {
    ...env,
    AGENT_CONSOLE_TOOL_URL: "",
    AGENT_CONSOLE_TOOL_TOKEN: "",
  });
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /not reachable/);
  console.log("console-tool: verbs map to the agent-tool routes, output is bounded, errors exit 1");
} finally {
  server.close();
}
