import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { automationSandboxConfig } from "../server/automation/sandbox.ts";
import {
  autoChildEnv,
  checkToolToken,
  derivedToolToken,
  gateToolCall,
} from "../server/tool-token.ts";

const master = "master-fixture-token";
const derived = derivedToolToken(master, "auto-1");
assert.match(derived, /^[0-9a-f]{64}$/);
assert.equal(derived, derivedToolToken(master, "auto-1"));
assert.notEqual(derived, derivedToolToken(master, "auto-2"));
assert.notEqual(derived, master);

assert.deepEqual(checkToolToken(master, master, "manual-1"), {
  ok: true,
  threadId: "manual-1",
  derived: false,
});
assert.equal(checkToolToken(master, master, undefined).ok, true);
assert.deepEqual(checkToolToken(master, derived, "auto-1"), {
  ok: true,
  threadId: "auto-1",
  derived: true,
});
assert.equal(checkToolToken(master, derived, undefined).ok, false);
assert.equal(checkToolToken(master, derived, "").ok, false);
assert.equal(checkToolToken(master, derived, "auto-2").ok, false);
assert.equal(checkToolToken(master, "wrong", "auto-1").ok, false);

const isIssueRun = (threadId: string) => threadId === "auto-1";
const gate = (token: string, header: string | undefined, tool: string) =>
  gateToolCall(master, token, header, tool, isIssueRun);
assert.equal(gate(derived, undefined, "session_search").status, 401);
assert.equal(gate(derived, "auto-2", "session_search").status, 401);
assert.equal(gate(derived, "auto-1", "session_search").status, 200);
for (const tool of [
  "idea_list",
  "idea_read",
  "schedule_config_list",
  "schedule_get",
  "schedule_runs",
  "schedule_report",
  "schedule_transcript",
])
  assert.equal(gate(derived, "auto-1", tool).status, 200, tool);
for (const tool of ["schedule_create", "schedule_run_now", "schedule_config_update", "pi_research"])
  assert.equal(gate(derived, "auto-1", tool).status, 400, tool);
// a derived token for a thread the Console does not know as an issue run is still restricted
const other = derivedToolToken(master, "unknown");
assert.equal(gate(other, "unknown", "schedule_create").status, 400);
// master token stays unrestricted for manual threads and restricted when the header names an Auto thread
assert.equal(gate(master, "manual-1", "schedule_create").status, 200);
assert.equal(gate(master, undefined, "schedule_create").status, 200);
assert.equal(gate(master, "auto-1", "schedule_create").status, 400);

const hostEnv = {
  AGENT_CONSOLE_TOOL_TOKEN: master,
  AGENT_CONSOLE_PASSWORD: "x",
  CODER_AGENT_TOKEN: "x",
  CODER_URL: "x",
  SSH_AUTH_SOCK: "/tmp/sock",
  VSCODE_GIT_ASKPASS_NODE: "x",
  VSCODE_GIT_IPC_HANDLE: "x",
  GIT_ASKPASS: "x",
  HUGGING_FACE_TOKEN: "x",
  NVIDIA_API_KEY: "x",
  OPENROUTER_API_KEY: "x",
  DEEPSEEK_API_KEY: "x",
  DEEPAEEK_API_KEY: "x",
  KEPT: "kept",
};
const common = [
  "AGENT_CONSOLE_PASSWORD",
  "CODER_AGENT_TOKEN",
  "CODER_URL",
  "SSH_AUTH_SOCK",
  "VSCODE_GIT_ASKPASS_NODE",
  "VSCODE_GIT_IPC_HANDLE",
  "GIT_ASKPASS",
  "HUGGING_FACE_TOKEN",
];
const modelKeys = ["NVIDIA_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "DEEPAEEK_API_KEY"];
assert.equal(hostEnv.AGENT_CONSOLE_TOOL_TOKEN, master);
for (const provider of ["claude", "pi", "codex"]) {
  const env = autoChildEnv(hostEnv, "auto-1", provider);
  assert.equal(env.AGENT_CONSOLE_TOOL_TOKEN, derived);
  assert.equal(env.KEPT, "kept");
  for (const name of common) assert(!(name in env), `${provider} ${name}`);
  for (const name of modelKeys)
    assert.equal(name in env, provider !== "claude", `${provider} ${name}`);
}

// the real Auto launch path builds the same env for every provider
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tool-token-"));
try {
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, ".git", "agent-console-auto"), "private-checkout-v1\n");
  for (const provider of ["claude", "pi", "codex"]) {
    const thread = { id: "auto-1", cwd, provider, issueRun: { role: "work" } };
    const { env } = automationSandboxConfig(thread, hostEnv, {
      dataDir: path.join(root, "data"),
      home,
    });
    assert.equal(env.AGENT_CONSOLE_TOOL_TOKEN, derived, provider);
    for (const name of common) assert(!(name in env), `${provider} ${name}`);
    for (const name of modelKeys)
      assert.equal(name in env, provider !== "claude", `${provider} ${name}`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("tool-token ok");
