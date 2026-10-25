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
/** Single files: copied into the run directory when they resolve into a credential store. */
const HOME_FILES = [".npmrc", ".gitconfig"];
const HOME_TOOLCHAINS = [
  ".bun",
  ".cargo",
  "go",
  ".codegraph",
  ".agents",
  ".cache/ms-playwright",
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

/** Roots that may neither be granted nor contain a grant: ancestors of legitimate narrow grants. */
function ancestorGuards(home: string, dataDir: string): string[] {
  const list = [
    "/",
    home,
    dataDir,
    ...[".config", ".local/share", ".local/state"].map(inHome(home)),
  ];
  return list.map(canonical);
}

/** Credential and data stores: nothing may equal, contain or sit inside them, except exact policy allowances. */
function storeGuards(home: string, dataDir: string): string[] {
  const rels = [
    ".ssh",
    ".config/coderv2",
    ".claude",
    ".claude.json",
    ".codex",
    ".pi",
    ".aws",
    ".gnupg",
    ".local/share/rtk",
    ".local/share/uv/credentials",
  ];
  let names: string[] = [];
  try {
    names = fs.readdirSync(home).filter((name) => name.startsWith(".claude-"));
  } catch {}
  return [dataDir, ...rels.map(inHome(home)), ...names.map(inHome(home))].map(canonical);
}

const inHome = (home: string) => (rel: string) => path.join(home, rel);
const canonical = (entry: string) => real(entry) ?? path.resolve(entry);

/** True when target is a store root or inside one (for example a dotfile symlinked into a credential directory). */
export function insideProtectedStore(home: string, dataDir: string, target: string): boolean {
  const resolved = real(target) ?? path.resolve(target);
  return storeGuards(home, dataDir).some((guard) => within(guard, resolved));
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

type Candidate = { target: string; policyOwned: boolean; soft?: boolean };

function candidateList(input: ReadPolicyInput): Candidate[] {
  const { home, dataDir, runtime, thread, env } = input;
  const own = (targets: string[]): Candidate[] =>
    targets.map((target) => ({ target, policyOwned: true }));
  const plain = (targets: string[]): Candidate[] =>
    targets.map((target) => ({ target, policyOwned: false }));
  const softFiles = HOME_FILES.map((rel) => ({
    target: path.join(home, rel),
    policyOwned: false,
    soft: true,
  }));
  const extras = (env.AGENT_CONSOLE_AUTO_READ ?? "").split(":").filter(Boolean);
  return [
    ...plain([...SYSTEM_ROOTS, ...DEVICE_ROOTS]),
    ...plain(HOME_TOOLCHAINS.map(inHome(home))),
    ...softFiles,
    ...plain(localToolchains(home)),
    ...plain(repoRoots(home, env, thread.repo)),
    ...plain(input.appRoot ? [input.appRoot] : []),
    ...own([runtime, ...providerRoots(input), path.join(dataDir, "uploads", thread.id)]),
    ...plain(extras.map((entry) => path.resolve(entry))),
  ];
}

/**
 * Exact read allow-list for an Auto child. Existing entries are realpathed, missing ones skipped.
 * Throws when a root equals or contains a protected path, or sits inside a credential or data store.
 * Only the policy's own run, provider-resource and per-thread data roots may sit inside a store.
 */
export function autoReadRoots(input: ReadPolicyInput): string[] {
  const { home, dataDir } = input;
  const ancestors = ancestorGuards(home, dataDir);
  const stores = storeGuards(home, dataDir);
  const roots: string[] = [];
  for (const candidate of candidateList(input)) {
    const resolved = real(candidate.target);
    if (resolved === null) continue;
    const inside = stores.find((guard) => within(guard, resolved));
    if (inside && candidate.soft) continue; // copied into the run directory instead
    const bad =
      [...ancestors, ...stores].find((guard) => within(resolved, guard)) ??
      (candidate.policyOwned ? undefined : inside);
    if (bad) throw new Error(`Auto read policy refuses ${resolved}: it overlaps protected ${bad}.`);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}
