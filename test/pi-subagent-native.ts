import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real Pi parent and children use only this local OpenAI-compatible fixture.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-native-"));
let pending: (() => void)[] = [];
const tools: string[][] = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    const body = JSON.parse(raw);
    const last = body.messages.at(-1);
    const finish = (delta: any, reason: string) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d: any, r: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: d, finish_reason: r }] })}\n\n`;
      res.end(chunk(delta, null) + chunk({}, reason) + "data: [DONE]\n\n");
    };
    if (last.role === "tool") {
      finish({ role: "assistant", content: "PARENT_DONE" }, "stop");
      return;
    }
    if (
      (typeof last.content === "string"
        ? last.content
        : (last.content ?? []).map((b: any) => b.text ?? "").join("")) === "delegate"
    ) {
      finish(
        {
          role: "assistant",
          tool_calls: ["one", "two"].map((label, index) => ({
            index,
            id: `task-${label}`,
            type: "function",
            function: {
              name: "subagent",
              arguments: JSON.stringify({
                description: label,
                prompt: `child-${label}`,
                model: "fixture/child",
              }),
            },
          })),
        },
        "tool_calls",
      );
      return;
    }
    tools.push((body.tools ?? []).map((t: any) => t.function.name));
    pending.push(() => finish({ role: "assistant", content: "CHILD_DONE" }, "stop"));
    // A sequential tool implementation deadlocks here and fails the timeout.
    if (pending.length === 2) {
      const both = pending;
      pending = [];
      for (const reply of both) reply();
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const agent = path.join(scratch, "agent");
fs.mkdirSync(agent);
fs.writeFileSync(
  path.join(agent, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        api: "openai-completions",
        apiKey: "fixture",
        models: [{ id: "parent" }, { id: "child" }],
      },
    },
  }),
);
try {
  for (const mode of ["bypassPermissions", "plan"]) {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "pi",
        [
          "--print",
          "--mode",
          "json",
          "--no-session",
          "--offline",
          "--no-mcp",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
          "--no-approve",
          "--tools",
          "subagent",
          "--thinking",
          "off",
          "--model",
          "fixture/parent",
          "--extension",
          fileURLToPath(new URL("../server/providers/pi-subagent-extension.mjs", import.meta.url)),
          "delegate",
        ],
        {
          cwd: scratch,
          env: {
            ...process.env,
            HOME: scratch,
            NODE_OPTIONS: "",
            PI_CODING_AGENT_DIR: agent,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            AGENT_CONSOLE_PI_MODE: mode,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Parallel Pi children timed out"));
      }, 10_000);
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve(stdout) : reject(Error(stderr || stdout));
      });
    });
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const done = events.filter((e) => e.type === "tool_execution_end");
    assert.equal(done.length, 2);
    assert.ok(
      done.every((e) => !e.isError && e.result.content[0].text === "CHILD_DONE"),
      output,
    );
    assert.ok(output.includes("PARENT_DONE"));
    if (mode === "plan")
      for (const names of tools.slice(-2)) {
        assert.deepEqual([...names].sort(), ["find", "grep", "ls", "read"]);
      }
  }
  console.log(
    "pi-subagent native: real Pi runs parallel children, returns both results, and limits Plan tools; no external network",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
