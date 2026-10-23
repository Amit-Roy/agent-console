import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../auth.ts";
import { claudeConfigDir } from "../providers/claude-accounts.ts";

type AutoThread = {
  id: string;
  cwd: string;
  provider?: string;
  claudeAccount?: string;
  issueRun?: { role: string };
};
const launcher = fileURLToPath(new URL("../../scripts/auto-sandbox.py", import.meta.url));
let capabilityChecked = false;

function automated(t: AutoThread): boolean {
  if (t.issueRun === undefined) return false;
  if (
    !t.issueRun ||
    typeof t.issueRun !== "object" ||
    !["work", "review", "debug"].includes(t.issueRun.role)
  )
    throw new Error("Invalid Auto role.");
  return true;
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Auto must own its Git metadata; linked worktrees share writable refs with main. */
export function assertAutomationProject(t: AutoThread): void {
  if (!automated(t)) return;
  const cwd = path.resolve(t.cwd);
  if (fs.realpathSync(cwd) !== cwd)
    throw new Error("Auto sandbox requires a real project directory, not a symlink.");
  const gitDir = path.join(cwd, ".git");
  if (!fs.lstatSync(gitDir).isDirectory() || fs.lstatSync(gitDir).isSymbolicLink()) {
    throw new Error("Auto sandbox requires a private clone; shared Git worktrees are blocked.");
  }
  const marker = path.join(gitDir, "agent-console-auto");
  try {
    const stat = fs.lstatSync(marker);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.readFileSync(marker, "utf8") !== "private-checkout-v1\n"
    )
      throw new Error();
  } catch {
    throw new Error("Auto sandbox requires a Console-owned private checkout.");
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (fs.realpathSync(git("rev-parse", "--show-toplevel")) !== cwd)
    throw new Error("Auto sandbox project must be the repository root.");
  for (const option of ["--git-dir", "--git-common-dir"]) {
    const metadata = fs.realpathSync(git("rev-parse", "--path-format=absolute", option));
    if (!within(cwd, metadata))
      throw new Error("Auto sandbox requires private Git metadata inside the project.");
  }
}

/** Check confinement before a worker can contact any model. Unsupported hosts fail closed. */
export function assertAutomationSandbox(t: AutoThread): void {
  if (!automated(t)) return;
  assertAutomationProject(t);
  if (capabilityChecked) return;
  try {
    execFileSync("python3", [launcher, "--check"], {
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    capabilityChecked = true;
  } catch {
    throw new Error("Auto is blocked: filesystem sandbox is unavailable on this host.");
  }
}

function privateDir(dir: string): string {
  const absolute = path.resolve(dir);
  // Existing links must never turn a narrow writable grant into a home/main grant.
  let ancestor = path.parse(absolute).root;
  for (const part of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    try {
      const stat = fs.lstatSync(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Auto runtime directory contains a symlink or non-directory.");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(ancestor, { mode: 0o700 });
    }
  }
  fs.chmodSync(absolute, 0o700);
  return absolute;
}

function seedFile(source: string, target: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Auto runtime state must be a private regular file.");
    fs.chmodSync(target, 0o600);
    return;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    // Read the selected login file, never link private runtime state to shared state.
    const content = fs.readFileSync(source);
    fs.writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}

/** Resource links preserve discovery without granting writes to shared installs. */
function linkReadableResource(source: string, target: string): void {
  let original: string;
  try {
    original = fs.realpathSync(source);
  } catch (error: any) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink() || fs.readlinkSync(target) !== original)
      throw new Error("Auto resource must link to the selected shared installation.");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    fs.symlinkSync(original, target);
  }
}

/** Prepare only per-thread writable state. This function does not probe the kernel. */
export function automationSandboxConfig(
  t: AutoThread,
  env: NodeJS.ProcessEnv,
  options: { dataDir?: string; home?: string } = {},
) {
  if (!automated(t)) return { env, writable: [] as string[] };
  if (!/^[a-zA-Z0-9_-]+$/.test(t.id)) throw new Error("Invalid Auto thread ID.");
  assertAutomationProject(t);
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const home = options.home ?? os.homedir();
  const runtime = privateDir(path.join(dataDir, "auto-runtime", t.id));
  const tmp = privateDir(path.join(runtime, "tmp"));
  const cache = privateDir(path.join(runtime, "cache"));
  const result: NodeJS.ProcessEnv = {
    ...env,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: cache,
    npm_config_cache: privateDir(path.join(cache, "npm")),
    PLAYWRIGHT_BROWSERS_PATH:
      env.PLAYWRIGHT_BROWSERS_PATH ??
      path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright"),
  };
  const writable = [fs.realpathSync(t.cwd), runtime];
  if (t.provider === "pi") {
    const config = privateDir(path.join(runtime, "pi"));
    const original = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
    // Pi locks settings while reading them. Copies keep those locks and OAuth
    // refreshes private; resource symlinks remain read-only under Landlock.
    for (const file of [
      "auth.json",
      "settings.json",
      "models.json",
      "models-store.json",
      "mcp.json",
      "mcp-auth.json",
    ])
      seedFile(path.join(original, file), path.join(config, file));
    for (const resource of [
      "AGENTS.md",
      "extensions",
      "skills",
      "prompts",
      "themes",
      "bin",
      "vendor",
      "npm",
      "git",
    ])
      linkReadableResource(path.join(original, resource), path.join(config, resource));
    result.PI_CODING_AGENT_DIR = config;
    writable.push(privateDir(path.join(dataDir, "pi-sessions", t.id)));
  } else if (t.provider === "claude") {
    const config = privateDir(path.join(runtime, "claude"));
    const original = claudeConfigDir(t.claudeAccount, env, home);
    for (const file of [".credentials.json", ".claude.json", "settings.json"])
      seedFile(path.join(original, file), path.join(config, file));
    if ((!t.claudeAccount || t.claudeAccount === "sunny") && !env.CLAUDE_CONFIG_DIR)
      seedFile(path.join(home, ".claude.json"), path.join(config, ".claude.json"));
    result.CLAUDE_CONFIG_DIR = config;
  } else if (t.provider === "codex") {
    const config = privateDir(path.join(runtime, "codex"));
    const original = env.CODEX_HOME || path.join(home, ".codex");
    for (const file of ["auth.json", "config.toml", "models_cache.json"])
      seedFile(path.join(original, file), path.join(config, file));
    result.CODEX_HOME = config;
    // The standalone helper launcher resolves packages under CODEX_HOME; keep it on the shared install.
    result.CODEX_HELPER_PACKAGE_ROOT =
      env.CODEX_HELPER_PACKAGE_ROOT || path.join(original, "packages");
  } else {
    throw new Error("Auto sandbox requires a known provider.");
  }
  return { env: result, writable };
}

/** Manual launches are untouched; all Auto roles use the kernel filesystem boundary. */
export function launch(t: AutoThread, command: string, args: string[], env: NodeJS.ProcessEnv) {
  if (!automated(t)) return { command, args, env };
  assertAutomationSandbox(t);
  const config = automationSandboxConfig(
    { ...t, provider: t.provider ?? path.basename(command) },
    env,
  );
  return {
    command: "python3",
    args: [launcher, ...config.writable.flatMap((dir) => ["--write", dir]), "--", command, ...args],
    env: config.env,
  };
}
