import fs from "node:fs";
import path from "node:path";

export type ReadPolicyInput = {
  home: string;
  dataDir: string;
  /** Per-run private directory (already writable). */
  runtime: string;
  thread: { id: string; provider?: string; repo?: string };
  /** Directory the provider login files were copied from (Pi agent dir, Claude or Codex home). */
  providerSource?: string;
  env: NodeJS.ProcessEnv;
  /** Checkout of the running Console; Pi children preload scripts from it. */
  appRoot?: string;
};

const SYSTEM_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc"];
const DEVICE_ROOTS = ["/proc", "/sys", "/dev", "/run"];
const HOME_TOOLCHAINS = [
  ".bun",
  ".cargo",
  "go",
  ".codegraph",
  ".agents",
  ".cache/ms-playwright",
  ".npmrc",
  ".gitconfig",
  ".config/git",
  ".config/gh",
];
/** Narrow ~/.local entries: never ~/.local/share/rtk, uv credentials, Console data or state as a whole. */
const LOCAL_EXACT = [
  "bin",
  "lib",
  "node",
  "bun",
  "go",
  "android",
  "share/claude",
  "share/uv/python",
  "share/uv/tools",
  "share/pipx",
  "share/code-quality-guard",
  "share/man",
  "state/task-issue",
];
const LOCAL_VERSIONED = ["node-v", "bun-", "go-"];

function localToolchains(home: string): string[] {
  const local = path.join(home, ".local");
  let names: string[] = [];
  try {
    names = fs.readdirSync(local);
  } catch {}
  const versioned = names
    .filter((name) => LOCAL_VERSIONED.some((prefix) => name.startsWith(prefix)))
    .sort();
  return [
    ...LOCAL_EXACT.map((rel) => path.join(local, rel)),
    ...versioned.map((name) => path.join(local, name)),
  ];
}

const PI_RESOURCES = [
  "extensions",
  "skills",
  "prompts",
  "themes",
  "bin",
  "vendor",
  "npm",
  "git",
  "AGENTS.md",
];

function real(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function protectedPaths(home: string, dataDir: string): string[] {
  const list = ["/", home, dataDir];
  for (const rel of [".ssh", ".config", ".config/coderv2", ".claude", ".codex", ".pi"])
    list.push(path.join(home, rel));
  return list.map((entry) => real(entry) ?? path.resolve(entry));
}

function providerRoots(input: ReadPolicyInput): string[] {
  const { home, dataDir, thread, providerSource } = input;
  if (thread.provider === "claude")
    return [path.join(home, ".claude", "skills"), path.join(home, ".claude", "agents")];
  if (thread.provider === "codex")
    return [input.env.CODEX_HELPER_PACKAGE_ROOT || path.join(providerSource ?? home, "packages")];
  if (thread.provider === "pi") {
    const agent = providerSource ?? path.join(home, ".pi", "agent");
    return [
      path.join(dataDir, "pi-sessions", thread.id),
      ...PI_RESOURCES.map((name) => path.join(agent, name)),
    ];
  }
  return [];
}

/** Same base as window-dispatch defaultDirs(); its addWorktree() joins that base with the repo name. */
function repoRoots(home: string, env: NodeJS.ProcessEnv, repo?: string): string[] {
  const base = env.AGENT_CONSOLE_REPOS || path.join(home, "repos");
  const roots = [
    path.join(base, "brain"),
    path.join(base, "agent-console"),
    path.join(base, "dotfiles", "bin"),
  ];
  const name = repo ? path.basename(repo) : "";
  if (name && name !== "." && name !== "..") roots.push(path.join(base, name));
  return roots;
}

/**
 * Exact read allow-list for an Auto child. Existing entries are realpathed, missing ones skipped.
 * Throws when a root equals or contains a protected credential or data path.
 */
export function autoReadRoots(input: ReadPolicyInput): string[] {
  const { home, dataDir, runtime, thread, env } = input;
  const extras = (env.AGENT_CONSOLE_AUTO_READ ?? "").split(":").filter(Boolean);
  const candidates = [
    ...SYSTEM_ROOTS,
    ...DEVICE_ROOTS,
    ...HOME_TOOLCHAINS.map((rel) => path.join(home, rel)),
    ...localToolchains(home),
    ...repoRoots(home, env, thread.repo),
    ...(input.appRoot ? [input.appRoot] : []),
    runtime,
    ...providerRoots(input),
    path.join(dataDir, "uploads", thread.id),
    ...extras.map((entry) => path.resolve(entry)),
  ];
  const guarded = protectedPaths(home, dataDir);
  const roots: string[] = [];
  for (const candidate of candidates) {
    const resolved = real(candidate);
    if (resolved === null) continue;
    const bad = guarded.find((protect) => within(resolved, protect));
    if (bad) throw new Error(`Auto read policy refuses ${resolved}: it contains ${bad}.`);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}
