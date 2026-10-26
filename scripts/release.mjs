#!/usr/bin/env node
// Build an immutable release of agent-console: `agent-console release [ref] [--repo PATH]`.
// The release lives in $AGENT_CONSOLE_HOME/releases/<sha12>/ (default ~/.local/share/agent-console), independent of any git tree:
// committed content only (git archive), production node_modules hardlinked from a lockfile-keyed store, server bundle built in place
// (the bundle embeds absolute source paths, so it cannot be built elsewhere and moved), smoke-booted read-only, then marked `.ready`.
// stdout: the release path (last line). stderr: progress and timings. Exit non-zero on any failure, leaving no `.ready`.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const KEEP_RELEASES = 5;
const BOOT_TIMEOUT_MS = 20_000;
const STALE_TMP_MS = 3600_000;
const SMOKE_PASSWORD = "release-smoke";
const BUNDLE_ENTRY = path.join(".bundle", "server", "index.ts.mjs");
const SELF_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const began = performance.now();

const lap = (label) =>
  console.error(`[release] ${label}: ${((performance.now() - began) / 1000).toFixed(1)}s`);
const exists = (file) => fs.existsSync(file);
const hashFile = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
// Child output goes to stderr so stdout carries only the release path.
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { stdio: ["ignore", 2, 2], ...options });

function parseArgs(argv) {
  let repo = SELF_ROOT;
  let ref = "HEAD";
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--repo") repo = path.resolve(argv[++index] ?? "");
    else if (argv[index].startsWith("-")) throw new Error(`unknown option ${argv[index]}`);
    else ref = argv[index];
  }
  return { repo, ref };
}

// Directories need u+w to lose entries; files stay read-only (their inodes are shared with other releases).
function removeTree(target) {
  if (!exists(target)) return;
  execFileSync("find", [target, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
  fs.rmSync(target, { recursive: true, force: true });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("AGENT_CONSOLE_") || key === "PORT") delete env[key];
  return env;
}

function lockFiles(repo, sha) {
  const names = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", sha], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .split("\n")
    .filter(
      (name) => path.basename(name) === "package-lock.json" && !name.includes("node_modules/"),
    );
  if (!names.includes("package-lock.json")) throw new Error(`${sha} has no root package-lock.json`);
  return names.map((name) => path.dirname(name));
}

// One node_modules store per lockfile hash, built once in a temp dir and renamed into place.
function ensureStore(app, sourceDir, hash) {
  const store = path.join(app, "deps", hash);
  if (exists(path.join(store, ".ready"))) return store;
  removeTree(store);
  const tmp = path.join(app, "deps", `.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  for (const name of ["package.json", "package-lock.json"])
    fs.copyFileSync(path.join(sourceDir, name), path.join(tmp, name));
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: tmp });
  fs.writeFileSync(path.join(tmp, ".ready"), "");
  try {
    fs.renameSync(tmp, store);
  } catch (failure) {
    if (!exists(path.join(store, ".ready"))) throw failure; // lost the race to a concurrent build of the same store
    removeTree(tmp);
  }
  return store;
}

function installDeps(app, dest, dirs) {
  const hashes = [];
  for (const dir of dirs) {
    const sourceDir = path.join(dest, dir);
    const hash = hashFile(path.join(sourceDir, "package-lock.json"));
    const store = ensureStore(app, sourceDir, hash);
    run("cp", ["-al", path.join(store, "node_modules"), path.join(sourceDir, "node_modules")]);
    hashes.push(hash);
  }
  return hashes;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function checkSyntax(dest, entry) {
  const files = [entry, "scripts/bundle-server.mjs", "scripts/idle-restart.mjs"].filter((file) =>
    exists(path.join(dest, file)),
  );
  for (const file of files)
    execFileSync(process.execPath, ["--check", path.join(dest, file)], { stdio: "pipe" });
}

async function waitForHttp(port, child, logFile) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`scratch server exited during boot\n${tail(logFile)}`);
    const answer = await fetch(`http://127.0.0.1:${port}/login`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    if (answer?.status === 200) return;
    await delay(100);
  }
  throw new Error(
    `scratch server did not answer GET /login within ${BOOT_TIMEOUT_MS / 1000}s\n${tail(logFile)}`,
  );
}

const tail = (file) => fs.readFileSync(file, "utf8").split("\n").slice(-25).join("\n");

async function expectStatus(url, headers, want) {
  const answer = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (answer.status !== want)
    throw new Error(`GET ${url} answered ${answer.status}, wanted ${want}`);
}

async function probeServer(dest, port) {
  const base = `http://127.0.0.1:${port}`;
  await expectStatus(`${base}/login`, {}, 200);
  if (!exists(path.join(dest, "public", "vendor", "marked.js"))) return;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    // POST /login needs a same-origin Origin header since #350.
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: SMOKE_PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (login.status !== 200 || !cookie) throw new Error(`scratch login answered ${login.status}`);
  await expectStatus(`${base}/vendor/marked.js`, { cookie }, 200);
}

async function stopScratch(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  try {
    process.kill(-child.pid, "SIGKILL"); // stragglers in the process group
  } catch {}
}

// Boot the release exactly as the supervisor would, but on a scratch port with scratch data, in mock mode.
async function smokeBoot(dest, entry, compileCache) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-release-smoke-"));
  const logFile = path.join(scratch, "server.log");
  const port = await freePort();
  const env = {
    ...cleanEnv(),
    HOME: scratch,
    PORT: String(port),
    AGENT_CONSOLE_RUN: path.join(scratch, "run"),
    AGENT_CONSOLE_DATA: path.join(scratch, "data"),
    AGENT_CONSOLE_ENV_FILES: path.join(scratch, "no-env"),
    AGENT_CONSOLE_BRAIN: path.join(scratch, "no-brain"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_PASSWORD: SMOKE_PASSWORD,
    NODE_COMPILE_CACHE: compileCache, // the live server uses this dir too, so its first boot of this bundle is warm
  };
  fs.mkdirSync(env.AGENT_CONSOLE_RUN, { recursive: true });
  const logFd = fs.openSync(logFile, "w");
  const child = spawn(process.execPath, [entry], {
    cwd: dest,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  try {
    await waitForHttp(port, child, logFile);
    await probeServer(dest, port);
    const denied = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .find((line) => /EACCES|EROFS/.test(line));
    if (denied) throw new Error(`server tried to write inside the read-only release: ${denied}`);
  } finally {
    await stopScratch(child);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function buildRelease(app, repo, ref, sha, dest) {
  removeTree(dest);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync(
    "bash",
    ["-o", "pipefail", "-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "bash", repo, sha, dest],
    { stdio: ["ignore", 2, 2] },
  );
  lap("archive");
  const hashes = installDeps(app, dest, lockFiles(repo, sha));
  lap("deps");
  const hasBundler = exists(path.join(dest, "scripts", "bundle-server.mjs"));
  if (hasBundler) run(process.execPath, ["scripts/bundle-server.mjs"], { cwd: dest });
  const entry = hasBundler ? BUNDLE_ENTRY : path.join("server", "index.ts");
  lap("bundle");
  checkSyntax(dest, entry);
  const info = {
    sha,
    ref,
    repo,
    lockhash: hashes[0],
    depsHashes: hashes,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dest, "RELEASE.json"), `${JSON.stringify(info, null, 2)}\n`);
  run("chmod", ["-R", "a-w", dest]); // the smoke boot proves the server needs no writes inside its own tree
  fs.mkdirSync(path.join(app, "compile-cache"), { recursive: true });
  await smokeBoot(dest, entry, path.join(app, "compile-cache"));
  lap("smoke");
  fs.chmodSync(dest, 0o755);
  fs.writeFileSync(path.join(dest, ".ready"), "");
  fs.chmodSync(path.join(dest, ".ready"), 0o444);
  fs.chmodSync(dest, 0o555);
}

function readInfo(releaseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(releaseDir, "RELEASE.json"), "utf8"));
  } catch {
    return {};
  }
}

function pinnedReleases(app) {
  const pinned = new Set();
  for (const name of ["current", "previous"]) {
    try {
      pinned.add(fs.realpathSync(path.join(app, name)));
    } catch {}
  }
  return pinned;
}

function listReady(app) {
  const root = path.join(app, "releases");
  if (!exists(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => exists(path.join(dir, ".ready")))
    .map((dir) => ({
      dir,
      builtAt: readInfo(dir).builtAt ?? fs.statSync(path.join(dir, ".ready")).mtime.toISOString(),
    }))
    .sort((left, right) => right.builtAt.localeCompare(left.builtAt));
}

function pruneDeps(app, kept) {
  const wanted = new Set(
    kept.flatMap((release) => readInfo(release.dir).depsHashes ?? [readInfo(release.dir).lockhash]),
  );
  const root = path.join(app, "deps");
  if (!exists(root)) return;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const stale = name.startsWith(".tmp-")
      ? Date.now() - fs.statSync(dir).mtimeMs > STALE_TMP_MS
      : !wanted.has(name);
    if (stale) removeTree(dir);
  }
}

function prune(app) {
  const ready = listReady(app);
  const pinned = pinnedReleases(app);
  const kept = ready.filter(
    (release, index) => index < KEEP_RELEASES || pinned.has(fs.realpathSync(release.dir)),
  );
  for (const release of ready) if (!kept.includes(release)) removeTree(release.dir);
  pruneDeps(app, kept);
  lap(`prune (kept ${kept.length})`);
}

// Re-run this script under flock(1), which holds the lock for the lifetime of the child; stdout stays the release path.
function relockUnderFlock(lockFile) {
  const child = spawnSync("flock", [lockFile, process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, AGENT_CONSOLE_RELEASE_LOCKED: "1" },
  });
  if (child.status !== 0) process.exit(child.status ?? 1);
}

async function main() {
  const { repo, ref } = parseArgs(process.argv.slice(2));
  const app =
    process.env.AGENT_CONSOLE_HOME || path.join(os.homedir(), ".local", "share", "agent-console");
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const dest = path.join(app, "releases", sha.slice(0, 12));
  if (exists(path.join(dest, ".ready"))) {
    console.log(dest);
    return;
  }
  fs.mkdirSync(path.join(app, "deps"), { recursive: true });
  if (!process.env.AGENT_CONSOLE_RELEASE_LOCKED) {
    // Builds of one sha share a destination dir: serialize them. The loser of the race finds `.ready` once it gets the lock.
    relockUnderFlock(path.join(app, `.build-${sha.slice(0, 12)}.lock`));
    return;
  }
  try {
    await buildRelease(app, repo, ref, sha, dest);
  } catch (failure) {
    removeTree(dest);
    throw failure;
  }
  prune(app);
  lap("done");
  console.log(dest);
}

main().catch((failure) => {
  console.error(`[release] failed: ${failure?.message ?? failure}`);
  process.exit(1);
});
