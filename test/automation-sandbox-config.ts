import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertAutomationProject, automationSandboxConfig, launch } from "../server/automation/sandbox.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sandbox-config-"));
const home = path.join(root, "home");
const dataDir = path.join(root, "data");
const cwd = path.join(root, "project");
const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });
fs.mkdirSync(home);
fs.mkdirSync(cwd);
git("init", "-q", cwd);
assert.throws(() => assertAutomationProject({ id: "unowned", cwd, issueRun: { role: "work" } }), /Console-owned/);
fs.writeFileSync(path.join(cwd, ".git", "agent-console-auto"), "private-checkout-v1\n");
const t = { id: "thread-1", cwd, provider: "pi", issueRun: { role: "work" } };
const options = { dataDir, home };
const env = { ORIGINAL: "kept", TMPDIR: "/tmp" };
try {
  const manual = { id: "manual", cwd: "/not/a/repository" };
  const args = ["--help"];
  const passthrough = launch(manual, "pi", args, env);
  assert.equal(passthrough.env, env);
  assert.equal(passthrough.args, args);
  assert.equal(passthrough.command, "pi");

  const originalPi = path.join(home, ".pi", "agent");
  fs.mkdirSync(originalPi, { recursive: true });
  for (const file of ["auth.json", "settings.json", "models.json", "models-store.json", "mcp.json", "mcp-auth.json"]) fs.writeFileSync(path.join(originalPi, file), `original-${file}`);
  fs.mkdirSync(path.join(originalPi, "extensions"));
  fs.mkdirSync(path.join(originalPi, "skills"));
  fs.writeFileSync(path.join(originalPi, "AGENTS.md"), "shared instructions");
  const pi = automationSandboxConfig(t, env, options);
  const runtime = path.join(dataDir, "auto-runtime", t.id);
  assert.deepEqual(pi.writable, [cwd, runtime, path.join(dataDir, "pi-sessions", t.id)]);
  assert.equal(pi.env.TMPDIR, path.join(runtime, "tmp"));
  assert.equal(pi.env.TMP, pi.env.TMPDIR);
  assert.equal(pi.env.TEMP, pi.env.TMPDIR);
  assert.equal(pi.env.XDG_CACHE_HOME, path.join(runtime, "cache"));
  assert.equal(pi.env.ORIGINAL, "kept");
  assert.equal(env.TMPDIR, "/tmp");
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  assert.ok(!pi.writable.includes(home) && !pi.writable.includes("/tmp"));
  assert.equal(pi.env.PI_CODING_AGENT_DIR, path.join(runtime, "pi"));
  for (const file of ["auth.json", "settings.json", "models.json", "models-store.json", "mcp.json", "mcp-auth.json"]) {
    const target = path.join(pi.env.PI_CODING_AGENT_DIR!, file);
    assert.equal(fs.readFileSync(target, "utf8"), `original-${file}`);
    assert.ok(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink());
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
  for (const resource of ["extensions", "skills", "AGENTS.md"]) {
    const target = path.join(pi.env.PI_CODING_AGENT_DIR!, resource);
    assert.ok(fs.lstatSync(target).isSymbolicLink());
    assert.equal(fs.realpathSync(target), path.join(originalPi, resource));
    assert.ok(!pi.writable.includes(path.join(originalPi, resource)));
  }
  fs.writeFileSync(path.join(pi.env.PI_CODING_AGENT_DIR!, "auth.json"), "refreshed-pi-login");
  automationSandboxConfig(t, env, options);
  assert.equal(fs.readFileSync(path.join(pi.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"), "refreshed-pi-login");
  assert.equal(fs.readFileSync(path.join(originalPi, "auth.json"), "utf8"), "original-auth.json");
  const selectedPi = path.join(root, "selected-pi");
  fs.mkdirSync(selectedPi);
  fs.writeFileSync(path.join(selectedPi, "auth.json"), "selected-pi-login");
  const selected = automationSandboxConfig({ ...t, id: "pi-selected" }, { ...env, PI_CODING_AGENT_DIR: selectedPi }, options);
  assert.equal(fs.readFileSync(path.join(selected.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"), "selected-pi-login");

  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".claude-nefro"));
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "sunny-login");
  fs.writeFileSync(path.join(home, ".claude.json"), "sunny-metadata");
  fs.writeFileSync(path.join(home, ".claude-nefro", ".credentials.json"), "nefro-login");
  fs.writeFileSync(path.join(home, ".claude-nefro", ".claude.json"), "nefro-metadata");
  fs.writeFileSync(path.join(home, ".claude-nefro", "settings.json"), '{"permissions":{}}');
  const sunny = automationSandboxConfig({ ...t, provider: "claude", id: "sunny", issueRun: { role: "review" } }, env, options);
  assert.equal(fs.readFileSync(path.join(sunny.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"), "sunny-metadata");
  const nefro = automationSandboxConfig({ ...t, provider: "claude", claudeAccount: "nefro", id: "nefro" }, env, options);
  assert.equal(fs.readFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "utf8"), "nefro-login");
  assert.equal(fs.readFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"), "nefro-metadata");
  assert.equal(fs.statSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json")).mode & 0o777, 0o600);
  assert.deepEqual(nefro.writable, [cwd, path.join(dataDir, "auto-runtime", "nefro")]);
  fs.writeFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "refreshed-login");
  automationSandboxConfig({ ...t, provider: "claude", claudeAccount: "nefro", id: "nefro" }, env, options);
  assert.equal(fs.readFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "utf8"), "refreshed-login");

  const originalCodex = path.join(root, "original-codex");
  fs.mkdirSync(originalCodex);
  for (const name of ["auth.json", "config.toml", "models_cache.json"]) fs.writeFileSync(path.join(originalCodex, name), name === "config.toml" ? 'command = "/absolute/mcp/path"' : "original");
  const codex = automationSandboxConfig({ ...t, provider: "codex", id: "codex", issueRun: { role: "debug" } }, { ...env, CODEX_HOME: originalCodex }, options);
  assert.notEqual(codex.env.CODEX_HOME, originalCodex);
  assert.equal(fs.readFileSync(path.join(codex.env.CODEX_HOME!, "config.toml"), "utf8"), 'command = "/absolute/mcp/path"');

  assert.throws(() => automationSandboxConfig({ ...t, id: "../../escape" }, env, options), /Invalid Auto thread/);
  assert.throws(() => automationSandboxConfig({ ...t, issueRun: false as any }, env, options), /Invalid Auto role/);
  assert.throws(() => automationSandboxConfig({ ...t, issueRun: { role: "other" } }, env, options), /Invalid Auto role/);
  fs.symlinkSync(home, path.join(dataDir, "auto-runtime", "symlink"));
  assert.throws(() => automationSandboxConfig({ ...t, id: "symlink" }, env, options), /symlink/);
  const linkRuntime = path.join(dataDir, "auto-runtime", "codex-link");
  fs.mkdirSync(linkRuntime);
  fs.symlinkSync(originalCodex, path.join(linkRuntime, "codex"));
  assert.throws(() => automationSandboxConfig({ ...t, provider: "codex", id: "codex-link" }, env, options), /symlink/);

  git("-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "fixture");
  const linked = path.join(root, "linked");
  git("-C", cwd, "worktree", "add", "-q", "-b", "linked", linked);
  assert.throws(() => assertAutomationProject({ ...t, cwd: linked }), /private clone/);
  const sub = path.join(cwd, "sub");
  fs.mkdirSync(sub);
  assert.throws(() => assertAutomationProject({ ...t, cwd: sub }));
  console.log("automation-sandbox-config: private runtime, credentials, clone boundary, and manual passthrough passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
