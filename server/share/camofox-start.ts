import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Starts the local camofox REST server when a share download finds it down. Same launch as
// dotfiles/bin/workspace-boot: detached node server.js in the camofox repo, log appended to ~/.cache/camofox.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const POLL_INTERVAL_MS = 250;

export interface CamofoxStartDeps {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => { unref(): void };
  repoDir: () => string;
  nodePath: () => string;
  logPath: () => string;
  waitMs: number;
  cooldownMs: number;
}

export const camofoxStartDeps: CamofoxStartDeps = {
  spawn: (command, args, options) => spawn(command, args, options as any),
  repoDir: () => process.env.CAMOFOX_REPO || path.join(os.homedir(), "repos", "camofox-browser"),
  nodePath: () => {
    const preferred = path.join(os.homedir(), ".local", "bin", "node");
    return fs.existsSync(preferred) ? preferred : process.execPath;
  },
  logPath: () => path.join(os.homedir(), ".cache", "camofox", "server.log"),
  waitMs: 45_000,
  cooldownMs: 60_000,
};

let inFlight: Promise<boolean> | null = null;
let failedAt = 0;

export function resetCamofoxStartState(): void {
  inFlight = null;
  failedAt = 0;
}

function localPort(base: string): number | null {
  try {
    const url = new URL(base);
    if (!LOCAL_HOSTS.has(url.hostname)) return null;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function canConnect(port: number): Promise<boolean> {
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

async function waitForPort(port: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

async function startServer(port: number, deps: CamofoxStartDeps): Promise<boolean> {
  const repo = deps.repoDir();
  if (!fs.existsSync(path.join(repo, "server.js"))) return false;
  try {
    const logFile = deps.logPath();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logFd = fs.openSync(logFile, "a");
    try {
      const child = deps.spawn(deps.nodePath(), ["server.js"], {
        cwd: repo,
        env: { ...process.env, CAMOFOX_PORT: String(port) },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();
    } finally {
      fs.closeSync(logFd);
    }
  } catch {
    return false;
  }
  return waitForPort(port, deps.waitMs);
}

// True when a local camofox now accepts connections and the caller may retry once.
export function ensureCamofoxStarted(base: string): Promise<boolean> {
  if (process.env.AGENT_CONSOLE_CAMOFOX_AUTOSTART === "0") return Promise.resolve(false);
  const port = localPort(base);
  if (port === null) return Promise.resolve(false);
  if (inFlight) return inFlight;
  if (failedAt && Date.now() - failedAt < camofoxStartDeps.cooldownMs)
    return Promise.resolve(false);
  const pending = startServer(port, camofoxStartDeps)
    .catch(() => false)
    .then((ok) => {
      failedAt = ok ? 0 : Date.now();
      return ok;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = pending;
  return pending;
}
