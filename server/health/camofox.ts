import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readListeningSockets } from "../host.ts";
import { CAMOFOX_DEFAULT_URL, camofoxBase, camofoxCall } from "../share/camofox.ts";
import { runInInstagramChain } from "../share/instagram.ts";
import { CAMOFOX_USER } from "../share/instagram-camofox.ts";

// Real liveness probe for camofox: opens a tab in the same per-user session context the share flow uses (the
// built-in /health self-probe uses a fresh context and passes while the session context is wedged). On failure,
// restart the server (supervisor dotfiles/bin/camofox-serve respawns it) with rate limits.

const PROBE_TIMEOUT_MS = 20_000;
const TERM_WAIT_MS = 10_000;
const PORT_WAIT_MS = 60_000;
const POLL_MS = 250;
const MIN_GAP_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_PER_DAY = 3;

export interface ProbeResult {
  status: "ok" | "error";
  detail: string;
}

export interface HealResult {
  action: "restart" | "skip";
  result: string;
  ok: boolean;
}

export interface CamofoxCheck {
  id: "camofox";
  label: "Camofox browser";
  status: "ok" | "warning" | "error";
  detail: string;
  healed?: { action: string; result: string };
}

export interface CamofoxHealthDeps {
  call: typeof camofoxCall;
  inChain: <T>(job: () => Promise<T>) => Promise<T>;
  base: () => string | null;
  listenerPids: (port: number) => number[];
  readText: (file: string) => string | null;
  readLink: (file: string) => string | null;
  alive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
  portUp: (port: number) => Promise<boolean>;
  lockFree: (lockFile: string) => boolean;
  spawnServe: (port: number) => void;
  cacheDir: () => string;
  repoDir: () => string;
  procDir: string;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readLink(file: string): string | null {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// Socket inode to owning pid via /proc/<pid>/fd; used only when the supervisor wrote no pid file.
function listenerPids(port: number): number[] {
  const inodes = new Set(
    readListeningSockets()
      .filter((socket) => socket.port === port)
      .map((socket) => socket.inode),
  );
  const pids: number[] = [];
  if (!inodes.size) return pids;
  for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const owns = fs
        .readdirSync(`/proc/${name}/fd`)
        .some((fdName) =>
          inodes.has(
            Number(/^socket:\[(\d+)\]$/.exec(readLink(`/proc/${name}/fd/${fdName}`) ?? "")?.[1]),
          ),
        );
      if (owns) pids.push(Number(name));
    } catch {}
  }
  return pids;
}

function lockFree(lockFile: string): boolean {
  try {
    execFileSync("flock", ["-n", lockFile, "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function spawnServe(port: number): void {
  const child = spawn("camofox-serve", [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CAMOFOX_PORT: String(port) },
  });
  child.on("error", () => {});
  child.unref();
}

export const camofoxHealthDeps: CamofoxHealthDeps = {
  call: camofoxCall,
  inChain: runInInstagramChain,
  base: camofoxBase,
  listenerPids,
  readText,
  readLink,
  alive,
  kill: (pid, signal) => process.kill(pid, signal),
  now: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  portUp,
  lockFree,
  spawnServe,
  cacheDir: () => path.join(os.homedir(), ".cache", "camofox"),
  repoDir: () => process.env.CAMOFOX_REPO || path.join(os.homedir(), "repos", "camofox-browser"),
  procDir: "/proc",
};

let restartTimes: number[] = [];
let healing: Promise<HealResult> | null = null;

export function resetCamofoxHealState(): void {
  restartTimes = [];
  healing = null;
}

function basePort(base: string): number {
  const url = new URL(base || CAMOFOX_DEFAULT_URL);
  return Number(url.port || 80);
}

const WEDGE_PATTERN = /\s5\d\d$|timed out|timeout|fetch failed|ECONNREFUSED|ECONNRESET|aborted/i;

/** True for a timeout, connection error or HTTP 5xx; a 4xx is a contract bug, not a wedged server. */
export function isWedgeFailure(detail: string): boolean {
  return WEDGE_PATTERN.test(detail);
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 160);
}

async function probeNow(deps: CamofoxHealthDeps): Promise<ProbeResult> {
  try {
    const created = await deps.call(
      "/tabs",
      {
        method: "POST",
        body: JSON.stringify({
          userId: CAMOFOX_USER,
          sessionKey: "health-probe",
          url: new URL("/health", deps.base() || CAMOFOX_DEFAULT_URL).href,
        }),
      },
      undefined,
      PROBE_TIMEOUT_MS,
    );
    const tabId = encodeURIComponent(String(created?.tabId ?? ""));
    await deps
      .call(`/tabs/${tabId}?userId=${CAMOFOX_USER}`, { method: "DELETE" }, undefined, 10_000)
      .catch(() => {});
    return { status: "ok", detail: "tab opened and closed" };
  } catch (error) {
    return { status: "error", detail: errorText(error) };
  }
}

/** Opens and closes a tab in the share session, queued behind any running share job. */
export function probeCamofox(deps: CamofoxHealthDeps = camofoxHealthDeps): Promise<ProbeResult> {
  return deps.inChain(() => probeNow(deps));
}

function rateLimited(deps: CamofoxHealthDeps): string | null {
  const now = deps.now();
  restartTimes = restartTimes.filter((restartedAt) => now - restartedAt < DAY_MS);
  const last = restartTimes[restartTimes.length - 1];
  if (last !== undefined && now - last < MIN_GAP_MS)
    return "rate limited: restarted under 10 min ago";
  if (restartTimes.length >= MAX_PER_DAY) return "rate limited: 3 restarts in 24 h";
  return null;
}

function isCamofoxProcess(deps: CamofoxHealthDeps, pid: number): boolean {
  const dir = path.join(deps.procDir, String(pid));
  const cmdline = deps.readText(path.join(dir, "cmdline"));
  if (!cmdline || !cmdline.split("\0").some((arg) => path.basename(arg) === "server.js"))
    return false;
  const cwd = deps.readLink(path.join(dir, "cwd"));
  return cwd !== null && path.resolve(cwd) === path.resolve(deps.repoDir());
}

function readPid(deps: CamofoxHealthDeps, port: number): number | null {
  const text = deps.readText(path.join(deps.cacheDir(), `serve-${port}.pid`));
  const pid = Number(text?.trim());
  if (Number.isInteger(pid) && pid > 1) return pid;
  const listeners = deps
    .listenerPids(port)
    .filter((candidate) => isCamofoxProcess(deps, candidate));
  return listeners.length === 1 ? listeners[0] : null;
}

async function waitUntil(
  deps: CamofoxHealthDeps,
  limitMs: number,
  done: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const deadline = deps.now() + limitMs;
  while (deps.now() < deadline) {
    if (await done()) return true;
    await deps.sleep(POLL_MS);
  }
  return done();
}

async function stopProcess(deps: CamofoxHealthDeps, pid: number): Promise<void> {
  deps.kill(pid, "SIGTERM");
  if (await waitUntil(deps, TERM_WAIT_MS, () => !deps.alive(pid))) return;
  deps.kill(pid, "SIGKILL");
  await waitUntil(deps, TERM_WAIT_MS, () => !deps.alive(pid));
}

async function bringUp(deps: CamofoxHealthDeps, port: number): Promise<boolean> {
  if (await waitUntil(deps, PORT_WAIT_MS, () => deps.portUp(port))) return true;
  if (!deps.lockFree(path.join(deps.cacheDir(), `serve-${port}.lock`))) return false;
  deps.spawnServe(port);
  return waitUntil(deps, PORT_WAIT_MS, () => deps.portUp(port));
}

async function healNow(deps: CamofoxHealthDeps): Promise<HealResult> {
  const base = deps.base();
  const host = base ? new URL(base).hostname : "";
  if (!base || (host !== "127.0.0.1" && host !== "localhost"))
    return { action: "skip", result: "camofox is not local", ok: false };
  const port = basePort(base);
  const limited = rateLimited(deps);
  if (limited) return { action: "skip", result: limited, ok: false };
  const pid = readPid(deps, port);
  if (!pid) return { action: "skip", result: "no pid file or listener", ok: false };
  if (!isCamofoxProcess(deps, pid))
    return { action: "skip", result: `pid ${pid} is not the camofox server`, ok: false };
  restartTimes.push(deps.now());
  await stopProcess(deps, pid);
  if (!(await bringUp(deps, port)))
    return { action: "restart", result: `killed pid ${pid}, port ${port} not back`, ok: false };
  const probe = await probeNow(deps);
  const ok = probe.status === "ok";
  return {
    action: "restart",
    result: ok
      ? `killed pid ${pid}, recovered`
      : `killed pid ${pid}, still failing: ${probe.detail}`,
    ok,
  };
}

/** Restarts the camofox server; concurrent callers share one run. Never throws. */
export function healCamofox(deps: CamofoxHealthDeps = camofoxHealthDeps): Promise<HealResult> {
  if (healing) return healing;
  const run = healNow(deps)
    .catch((error): HealResult => ({ action: "skip", result: errorText(error), ok: false }))
    .finally(() => {
      healing = null;
    });
  healing = run;
  return run;
}

export async function checkCamofox(
  deps: CamofoxHealthDeps = camofoxHealthDeps,
): Promise<CamofoxCheck> {
  const head = { id: "camofox", label: "Camofox browser" } as const;
  if (!deps.base()) return { ...head, status: "warning", detail: "camofox disabled" };
  const probe = await probeCamofox(deps);
  if (probe.status === "ok") return { ...head, status: "ok", detail: probe.detail };
  if (!isWedgeFailure(probe.detail)) return { ...head, status: "error", detail: probe.detail };
  const healed = await healCamofox(deps);
  const record = { action: healed.action, result: healed.result };
  if (healed.ok)
    return { ...head, status: "ok", detail: "recovered after restart", healed: record };
  return { ...head, status: "error", detail: probe.detail, healed: record };
}
