import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Auto-backup after iron changes: debounced `iron backup`, single flight. Command output goes to a
// log file only; the status file carries fixed strings, never log text.
export type BackupState = "pending" | "running" | "ok" | "failed";
export type BackupStatus = {
  state: BackupState | null;
  at: number;
  error: string | null;
};

const DEFAULT_DEBOUNCE_MS = 30_000;
const DRIVE_HINT = /drive|verify/i;
const stateDir = () =>
  path.join(
    process.env.VAULT_HOME || os.homedir(),
    ".local",
    "state",
    "agent-console",
  );
const statusFile = () => path.join(stateDir(), "iron-backup.json");
const logFile = () => path.join(stateDir(), "iron-backup.log");
const debounceMs = () =>
  Number(process.env.VAULT_BACKUP_DEBOUNCE_MS) || DEFAULT_DEBOUNCE_MS;

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;

function writeStatus(state: BackupState, error: string | null = null) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      statusFile(),
      JSON.stringify({ state, at: Date.now(), error }),
      {
        mode: 0o600,
      },
    );
  } catch {
    /* status is best effort */
  }
}

export function backupStatus(): BackupStatus {
  try {
    const saved = JSON.parse(fs.readFileSync(statusFile(), "utf8"));
    return {
      state: saved.state ?? null,
      at: Number(saved.at) || 0,
      error: saved.error ?? null,
    };
  } catch {
    return { state: null, at: 0, error: null };
  }
}

function logMentionsDrive(): boolean {
  try {
    return DRIVE_HINT.test(fs.readFileSync(logFile(), "utf8").slice(-20_000));
  } catch {
    return false;
  }
}

function runOnce(): Promise<void> {
  return new Promise((resolve) => {
    fs.mkdirSync(stateDir(), { recursive: true });
    const logFd = fs.openSync(logFile(), "w", 0o600);
    const cmd = process.env.VAULT_BACKUP_CMD || "iron backup";
    writeStatus("running");
    const done = (code: number | null) => {
      fs.closeSync(logFd);
      if (code === 0) writeStatus("ok");
      else
        writeStatus("failed", logMentionsDrive() ? "failed: drive" : "failed");
      resolve();
    };
    const child = spawn("setsid", ["-w", "sh", "-c", cmd], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.on("error", () => done(null));
    child.on("close", done);
  });
}

async function runNow() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await runOnce();
    } while (again);
  } finally {
    running = false;
  }
}

export function scheduleBackup() {
  if (timer) clearTimeout(timer);
  if (!running) writeStatus("pending");
  timer = setTimeout(() => {
    timer = null;
    void runNow();
  }, debounceMs());
  timer.unref(); // a pending backup never keeps the process (or a test) alive
}

/* runs immediately; resolves when the backup (and any queued rerun) has finished */
export function retryBackup(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  return runNow();
}
