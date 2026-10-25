import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertAutomationProject,
  automationSandboxConfig,
  bindTaskIssue,
  launch,
} from "../server/automation/sandbox.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sandbox-config-"));
const home = path.join(root, "home");
const dataDir = path.join(root, "data");
const cwd = path.join(root, "project");
const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });
fs.mkdirSync(home);
fs.mkdirSync(cwd);
git("init", "-q", cwd);
assert.throws(
  () => assertAutomationProject({ id: "unowned", cwd, issueRun: { role: "work" } }),
  /Console-owned/,
);
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
  for (const file of [
    "auth.json",
    "settings.json",
    "models.json",
    "models-store.json",
    "mcp.json",
    "mcp-auth.json",
  ])
    fs.writeFileSync(path.join(originalPi, file), `original-${file}`);
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
  assert.equal(pi.env.npm_config_cache, path.join(runtime, "cache", "npm"));
  assert.equal(pi.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, ".cache", "ms-playwright"));
  assert.equal(pi.env.ORIGINAL, "kept");
  assert.equal(env.TMPDIR, "/tmp");
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  assert.ok(!pi.writable.includes(home) && !pi.writable.includes("/tmp"));
  assert.equal(pi.env.PI_CODING_AGENT_DIR, path.join(runtime, "pi"));
  for (const file of [
    "auth.json",
    "settings.json",
    "models.json",
    "models-store.json",
    "mcp.json",
    "mcp-auth.json",
  ]) {
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
  assert.equal(
    fs.readFileSync(path.join(pi.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"),
    "refreshed-pi-login",
  );
  assert.equal(fs.readFileSync(path.join(originalPi, "auth.json"), "utf8"), "original-auth.json");
  const selectedPi = path.join(root, "selected-pi");
  fs.mkdirSync(selectedPi);
  fs.writeFileSync(path.join(selectedPi, "auth.json"), "selected-pi-login");
  const selected = automationSandboxConfig(
    { ...t, id: "pi-selected" },
    { ...env, PI_CODING_AGENT_DIR: selectedPi },
    options,
  );
  assert.equal(
    fs.readFileSync(path.join(selected.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"),
    "selected-pi-login",
  );

  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".claude-nefro"));
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "sunny-login");
  fs.writeFileSync(path.join(home, ".claude.json"), "sunny-metadata");
  fs.writeFileSync(path.join(home, ".claude-nefro", ".credentials.json"), "nefro-login");
  fs.writeFileSync(path.join(home, ".claude-nefro", ".claude.json"), "nefro-metadata");
  fs.writeFileSync(path.join(home, ".claude-nefro", "settings.json"), '{"permissions":{}}');
  const sunny = automationSandboxConfig(
    { ...t, provider: "claude", id: "sunny", issueRun: { role: "review" } },
    env,
    options,
  );
  assert.equal(
    fs.readFileSync(path.join(sunny.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"),
    "sunny-metadata",
  );
  const nefro = automationSandboxConfig(
    { ...t, provider: "claude", claudeAccount: "nefro", id: "nefro" },
    env,
    options,
  );
  assert.equal(
    fs.readFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "utf8"),
    "nefro-login",
  );
  assert.equal(
    fs.readFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"),
    "nefro-metadata",
  );
  assert.equal(
    fs.statSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json")).mode & 0o777,
    0o600,
  );
  assert.deepEqual(nefro.writable, [cwd, path.join(dataDir, "auto-runtime", "nefro")]);
  fs.writeFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "refreshed-login");
  automationSandboxConfig(
    { ...t, provider: "claude", claudeAccount: "nefro", id: "nefro" },
    env,
    options,
  );
  assert.equal(
    fs.readFileSync(path.join(nefro.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "utf8"),
    "refreshed-login",
  );

  const originalCodex = path.join(root, "original-codex");
  fs.mkdirSync(originalCodex);
  for (const name of ["auth.json", "config.toml", "models_cache.json"])
    fs.writeFileSync(
      path.join(originalCodex, name),
      name === "config.toml" ? 'command = "/absolute/mcp/path"' : "original",
    );
  const codex = automationSandboxConfig(
    { ...t, provider: "codex", id: "codex", issueRun: { role: "debug" } },
    { ...env, CODEX_HOME: originalCodex },
    options,
  );
  assert.notEqual(codex.env.CODEX_HOME, originalCodex);
  assert.equal(codex.env.CODEX_HELPER_PACKAGE_ROOT, path.join(originalCodex, "packages"));
  assert.equal(
    fs.readFileSync(path.join(codex.env.CODEX_HOME!, "config.toml"), "utf8"),
    'command = "/absolute/mcp/path"',
  );

  // Read allow-list: exact fake-home entries per provider; system roots are host dependent.
  const realHome = fs.realpathSync(home);
  const realData = fs.realpathSync(dataDir);
  for (const rel of [
    ".local/bin",
    ".local/node-v1.2.3",
    ".local/share/uv/tools",
    ".local/share/rtk",
    ".local/share/uv/credentials",
    ".cargo",
    ".config/git",
    ".config/gh",
    ".claude/skills",
    ".claude/agents",
    "repos/brain",
    "repos/agent-console",
    "repos/fixture",
    "repos/other",
    ".codex/packages",
    ".ssh",
    ".config/coderv2",
  ])
    fs.mkdirSync(path.join(home, rel), { recursive: true });
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n");
  fs.writeFileSync(path.join(dataDir, "secret"), "fake-secret");
  fs.mkdirSync(path.join(dataDir, "uploads", "rd-pi"), { recursive: true });
  fs.mkdirSync(path.join(originalPi, "git"), { recursive: true });
  const sharedSkills = path.join(root, "shared-skills");
  fs.mkdirSync(sharedSkills);
  fs.rmSync(path.join(originalPi, "skills"), { recursive: true });
  fs.symlinkSync(sharedSkills, path.join(originalPi, "skills"));
  const underHome = (list: string[]) =>
    list.filter((entry) => entry.startsWith(realHome) || entry.startsWith(realData));
  const fixture = {
    ...t,
    id: "rd-pi",
    issueRun: { role: "work", repo: "owner/fixture" },
  };
  const common = [
    ".cargo",
    ".config/git",
    ".config/gh",
    ".gitconfig",
    ".local/bin",
    ".local/share/uv/tools",
    ".local/node-v1.2.3",
    "repos/brain",
    "repos/agent-console",
    "repos/fixture",
  ].map((rel) => path.join(realHome, rel));
  const piRead = underHome(automationSandboxConfig(fixture, env, options).readable);
  // The linked skills resource resolves outside home, so underHome() drops it; the shared install is still listed.
  assert.deepEqual(piRead, [
    ...common,
    path.join(realData, "auto-runtime", "rd-pi"),
    path.join(realData, "pi-sessions", "rd-pi"),
    path.join(realHome, ".pi", "agent", "extensions"),
    path.join(realHome, ".pi", "agent", "git"),
    path.join(realHome, ".pi", "agent", "AGENTS.md"),
    path.join(realData, "uploads", "rd-pi"),
  ]);
  assert.ok(
    automationSandboxConfig({ ...fixture, id: "rd-pi" }, env, options).readable.includes(
      fs.realpathSync(sharedSkills),
    ),
  );
  const claudeRead = underHome(
    automationSandboxConfig({ ...fixture, provider: "claude", id: "rd-cl" }, env, options).readable,
  );
  assert.deepEqual(claudeRead, [
    ...common,
    path.join(realData, "auto-runtime", "rd-cl"),
    path.join(realHome, ".claude", "skills"),
    path.join(realHome, ".claude", "agents"),
  ]);
  const codexRead = underHome(
    automationSandboxConfig({ ...fixture, provider: "codex", id: "rd-cx" }, env, options).readable,
  );
  assert.deepEqual(codexRead, [
    ...common,
    path.join(realData, "auto-runtime", "rd-cx"),
    path.join(realHome, ".codex", "packages"),
  ]);
  for (const list of [piRead, claudeRead, codexRead]) {
    for (const rel of [".local", ".local/share", ".local/share/rtk", ".local/share/uv/credentials"])
      assert.ok(!list.includes(path.join(realHome, rel)), `${rel} must not be readable`);
    for (const bad of [
      realHome,
      realData,
      "/",
      path.join(realHome, ".ssh"),
      path.join(realHome, "repos/other"),
    ])
      assert.ok(!list.includes(bad), `${bad} must not be readable`);
    assert.ok(!list.some((entry) => entry.startsWith(path.join(realHome, ".config", "coderv2"))));
  }
  const extra = path.join(root, "extra-read");
  fs.mkdirSync(extra);
  const withExtra = automationSandboxConfig(
    { ...fixture, id: "rd-extra" },
    { ...env, AGENT_CONSOLE_AUTO_READ: `${extra}:${path.join(root, "missing")}` },
    options,
  );
  assert.ok(withExtra.readable.includes(fs.realpathSync(extra)));
  for (const bad of [home, path.join(home, ".config"), dataDir, "/", path.join(home, ".claude")])
    assert.throws(
      () =>
        automationSandboxConfig(
          { ...fixture, id: "rd-bad" },
          { ...env, AGENT_CONSOLE_AUTO_READ: bad },
          options,
        ),
      /refuses/,
    );
  // Extras and roots inside a credential store or data dir throw, in both directions.
  fs.mkdirSync(path.join(home, ".local", "share"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "x"), "fake-key");
  for (const bad of [
    path.join(home, ".ssh", "x"),
    path.join(home, ".local", "share"),
    path.join(home, ".local", "share", "rtk"),
    path.join(home, ".local", "share", "uv", "credentials"),
    path.join(home, ".claude", "skills", "nested"),
    path.join(dataDir, "secret"),
    path.join(home, ".config", "coderv2", "x"),
    path.join(home, ".local", "state"),
  ]) {
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    if (!fs.existsSync(bad)) fs.writeFileSync(bad, "fake");
    assert.throws(
      () =>
        automationSandboxConfig(
          { ...fixture, id: "rd-bad" },
          { ...env, AGENT_CONSOLE_AUTO_READ: bad },
          options,
        ),
      /refuses/,
      bad,
    );
  }
  // A dotfile symlinked into a credential directory is copied into the run directory, never granted.
  const dotHome = path.join(root, "dot-home");
  const storeFile = path.join(dotHome, ".config", "coderv2", "dotfiles", "git", ".gitconfig");
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, "[user]\n\tname = fake\n");
  fs.symlinkSync(storeFile, path.join(dotHome, ".gitconfig"));
  const dotted = automationSandboxConfig({ ...fixture, id: "rd-dot" }, env, {
    dataDir,
    home: dotHome,
  });
  const gitCopy = path.join(fs.realpathSync(dataDir), "auto-runtime", "rd-dot", "gitconfig");
  assert.equal(
    dotted.env.GIT_CONFIG_GLOBAL,
    path.join(dataDir, "auto-runtime", "rd-dot", "gitconfig"),
  );
  assert.equal(fs.readFileSync(gitCopy, "utf8"), "[user]\n\tname = fake\n");
  assert.ok(!fs.lstatSync(gitCopy).isSymbolicLink());
  assert.ok(
    !dotted.readable.some((entry) => entry.includes("coderv2") || entry.endsWith(".gitconfig")),
  );
  // Claude's shared tool-env file is copied into the run dir.
  fs.writeFileSync(path.join(dataDir, "tool-env.sh"), "renice\n");
  const claudeEnv = automationSandboxConfig(
    { ...fixture, provider: "claude", id: "rd-cl" },
    { ...env, CLAUDE_ENV_FILE: path.join(dataDir, "tool-env.sh") },
    options,
  ).env;
  assert.equal(
    claudeEnv.CLAUDE_ENV_FILE,
    path.join(dataDir, "auto-runtime", "rd-cl", "tool-env.sh"),
  );
  assert.equal(fs.readFileSync(claudeEnv.CLAUDE_ENV_FILE!, "utf8"), "renice\n");
  // launch() passes --read per root, and the kill switch removes them.
  const launched = launch(fixture, "pi", ["--x"], { ...env });
  const readFlags = launched.args.filter((arg, index) => launched.args[index - 1] === "--read");
  assert.ok(readFlags.length > 5 && readFlags.every((entry) => entry.startsWith("/")));
  assert.ok(launched.args.indexOf("--read") < launched.args.indexOf("--write"));
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    const off = launch({ ...fixture, id: "rd-off" }, "pi", [], {
      ...env,
      AGENT_CONSOLE_AUTO_READ_SANDBOX: "off",
    });
    assert.ok(!off.args.includes("--read") && off.args.includes("--write"));
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = warn;
  }

  assert.throws(
    () => automationSandboxConfig({ ...t, id: "../../escape" }, env, options),
    /Invalid Auto thread/,
  );
  assert.throws(
    () => automationSandboxConfig({ ...t, issueRun: false as any }, env, options),
    /Invalid Auto role/,
  );
  assert.throws(
    () => automationSandboxConfig({ ...t, issueRun: { role: "other" } }, env, options),
    /Invalid Auto role/,
  );
  fs.symlinkSync(home, path.join(dataDir, "auto-runtime", "symlink"));
  assert.throws(() => automationSandboxConfig({ ...t, id: "symlink" }, env, options), /symlink/);
  const linkRuntime = path.join(dataDir, "auto-runtime", "codex-link");
  fs.mkdirSync(linkRuntime);
  fs.symlinkSync(originalCodex, path.join(linkRuntime, "codex"));
  assert.throws(
    () => automationSandboxConfig({ ...t, provider: "codex", id: "codex-link" }, env, options),
    /symlink/,
  );

  git(
    "-C",
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const linked = path.join(root, "linked");
  git("-C", cwd, "worktree", "add", "-q", "-b", "linked", linked);
  assert.throws(() => assertAutomationProject({ ...t, cwd: linked }), /private clone/);
  const sub = path.join(cwd, "sub");
  fs.mkdirSync(sub);
  assert.throws(() => assertAutomationProject({ ...t, cwd: sub }));
  const stateHome = path.join(root, "state");
  const bound = { id: "bound-1", cwd, issueRun: { role: "work", repo: "o/r", number: 42 } };
  bindTaskIssue(bound, { XDG_STATE_HOME: stateHome });
  const record = path.join(stateHome, "task-issue", "bound-1.json");
  const first = fs.readFileSync(record, "utf8");
  const parsed = JSON.parse(first);
  assert.deepEqual(
    { ...parsed, created: typeof parsed.created },
    {
      repo: "o/r",
      url: "https://github.com/o/r/issues/42",
      number: 42,
      title: "",
      thread: "bound-1",
      created: "number",
      source: "auto",
    },
  );
  assert.equal(fs.statSync(path.join(stateHome, "task-issue")).mode & 0o777, 0o700);
  fs.writeFileSync(record, first.replace("o/r", "kept/existing"));
  const kept = fs.readFileSync(record, "utf8");
  bindTaskIssue(bound, { XDG_STATE_HOME: stateHome });
  assert.equal(fs.readFileSync(record, "utf8"), kept, "existing record is kept");
  bindTaskIssue(
    { ...bound, id: "no-issue", issueRun: { role: "debug" } },
    { XDG_STATE_HOME: stateHome },
  );
  assert.ok(!fs.existsSync(path.join(stateHome, "task-issue", "no-issue.json")));
  bindTaskIssue(
    { ...bound, id: "debug-1", issueRun: { role: "debug", repo: "o/r", number: 0 } },
    { XDG_STATE_HOME: stateHome },
  );
  const debugRecord = JSON.parse(
    fs.readFileSync(path.join(stateHome, "task-issue", "debug-1.json"), "utf8"),
  );
  assert.equal(debugRecord.url, "", "debug runs are bound without an issue URL");
  const guard = path.join(os.homedir(), "repos", "brain", "bin", "task-issue-guard");
  // The guard lives in the brain repository, which CI does not check out.
  if (fs.existsSync(guard)) {
    execFileSync("python3", [guard, "check", "edit", "/home/coder/repos/x"], {
      env: { PATH: process.env.PATH, AGENT_CONSOLE_THREAD: "bound-1", XDG_STATE_HOME: stateHome },
      stdio: "pipe",
    });
    assert.throws(() =>
      execFileSync("python3", [guard, "check", "edit", "/home/coder/repos/x"], {
        env: { PATH: process.env.PATH, AGENT_CONSOLE_THREAD: "other", XDG_STATE_HOME: stateHome },
        stdio: "pipe",
      }),
    );
  }
  console.log(
    "automation-sandbox-config: private runtime, credentials, clone boundary, and manual passthrough passed",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
