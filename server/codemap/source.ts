// Codemap source resolution: validate user input, clone or refresh GitHub repos with hardening.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodemapSource =
  | { kind: "local"; path: string }
  | { kind: "github"; owner: string; repo: string };

export type CloneLimits = { maxBytes?: number; maxFiles?: number };
export type CloneOpts = CloneLimits & {
  authUser?: string | null;
  urlBase?: string;
  timeoutMs?: number;
};

export const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 25_000;
const CLONE_TIMEOUT_MS = 120_000;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function defaultRoot(): string {
  return path.join(os.homedir(), "repos");
}

function githubSource(owner: string, repoRaw: string): CodemapSource {
  const repo = repoRaw.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") {
    throw new Error(`invalid GitHub owner/repo: ${owner}/${repoRaw}`);
  }
  return { kind: "github", owner, repo };
}

function parseGithubUrl(text: string): CodemapSource | null {
  const m = /^(?:https:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)\/?$/i.exec(text);
  return m ? githubSource(m[1], m[2]) : null;
}

export function parseSource(input: string): CodemapSource {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("empty source");
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https:\/\//i.test(text)) {
    throw new Error("unsupported source scheme");
  }
  if (/^git@/i.test(text) || text.includes("\0")) throw new Error("unsupported source");
  if (/^https:\/\//i.test(text) || /^(?:www\.)?github\.com\//i.test(text)) {
    const parsed = parseGithubUrl(text);
    if (!parsed) throw new Error("only github.com/owner/repo URLs are supported");
    return parsed;
  }
  if (text === "~" || text.startsWith("~/")) {
    return { kind: "local", path: path.join(os.homedir(), text.slice(1)) };
  }
  if (path.isAbsolute(text)) return { kind: "local", path: path.normalize(text) };
  const parts = text.split("/");
  if (parts.length === 2) return githubSource(parts[0], parts[1]);
  throw new Error("source must be an absolute path, owner/repo or a github.com URL");
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Resolve a local source to its real path; must live under root and be a git checkout. */
export function resolveLocal(source: CodemapSource, root: string = defaultRoot()): string {
  if (source.kind !== "local") throw new Error("not a local source");
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(source.path);
    realRoot = fs.realpathSync(root);
  } catch {
    throw new Error("local path not found");
  }
  if (!isInside(realRoot, real)) throw new Error("local path must be inside the repos root");
  if (!fs.existsSync(path.join(real, ".git"))) throw new Error("local path is not a git repo");
  return real;
}

export function slugFor(source: CodemapSource): string {
  const raw =
    source.kind === "local"
      ? path.basename(source.path)
      : `gh-${source.owner}-${source.repo}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("cannot derive slug");
  return slug;
}

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runGit(args: string[], cwd: string | undefined, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-8192)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8192)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function git(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  const res = await runGit(args, cwd, timeoutMs);
  if (res.timedOut) throw new Error(`git ${args[0]} timed out`);
  if (res.code !== 0) throw new Error(`git failed: ${res.stderr.trim().split("\n").pop()}`);
  return res.stdout;
}

let loginCache: Promise<string | null> | null = null;

/** GitHub login of the authenticated gh user, cached; null when gh is missing or logged out. */
export function ghLogin(): Promise<string | null> {
  loginCache ??= new Promise<string | null>((resolve) => {
    const child = spawn("gh", ["api", "user", "--jq", ".login"], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : null);
    });
  });
  return loginCache;
}

function hardening(source: CodemapSource, opts: CloneOpts): string[] {
  const fileAllow = opts.urlBase ? "always" : "never";
  const args = ["-c", "core.hooksPath=/dev/null", "-c", `protocol.file.allow=${fileAllow}`];
  const owned =
    source.kind === "github" &&
    !!opts.authUser &&
    opts.authUser.toLowerCase() === source.owner.toLowerCase();
  if (owned) args.push("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential");
  return args;
}

function remoteUrl(source: CodemapSource, opts: CloneOpts): string {
  if (source.kind !== "github") throw new Error("not a github source");
  const base = opts.urlBase ?? "https://github.com";
  return `${base}/${source.owner}/${source.repo}.git`;
}

type Tally = { bytes: number; files: number };

function walkTally(dir: string, tally: Tally, limits: Required<CloneLimits>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTally(full, tally, limits);
    } else {
      tally.files += 1;
      tally.bytes += fs.lstatSync(full).size;
    }
    if (tally.files > limits.maxFiles || tally.bytes > limits.maxBytes) {
      throw new Error("repo exceeds size limits");
    }
  }
}

/** Walk dir with lstat (no symlink follow); on breach remove dir and throw. */
export function enforceLimits(dir: string, limits: CloneLimits = {}): Tally {
  const resolved = {
    maxBytes: limits.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: limits.maxFiles ?? DEFAULT_MAX_FILES,
  };
  const tally: Tally = { bytes: 0, files: 0 };
  try {
    walkTally(dir, tally, resolved);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return tally;
}

export async function cloneGithub(
  source: CodemapSource,
  destDir: string,
  opts: CloneOpts = {},
): Promise<void> {
  const args = [
    ...hardening(source, opts),
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "-c",
    "core.symlinks=false",
    remoteUrl(source, opts),
    destDir,
  ];
  try {
    await git(args, undefined, opts.timeoutMs ?? CLONE_TIMEOUT_MS);
  } catch (err) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw err;
  }
  enforceLimits(destDir, opts);
}

export async function refreshGithub(
  source: CodemapSource,
  cloneDir: string,
  opts: CloneOpts = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? CLONE_TIMEOUT_MS;
  const base = hardening(source, opts);
  await git([...base, "fetch", "--depth", "1", "--no-tags", "origin"], cloneDir, timeout);
  await git(["reset", "--hard", "FETCH_HEAD"], cloneDir, timeout);
  enforceLimits(cloneDir, opts);
}

export async function headSha(dir: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], dir, 15_000)).trim();
}
