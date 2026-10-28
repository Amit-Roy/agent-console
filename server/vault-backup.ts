import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

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
  path.join(process.env.VAULT_HOME || os.homedir(), ".local", "state", "agent-console");
const statusFile = () => path.join(stateDir(), "iron-backup.json");
const logFile = () => path.join(stateDir(), "iron-backup.log");
const debounceMs = () => Number(process.env.VAULT_BACKUP_DEBOUNCE_MS) || DEFAULT_DEBOUNCE_MS;

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;
let active: Promise<void> | null = null;

export type BackupStepId =
  | "backup_fetch"
  | "drive_upload"
  | "drive_verify"
  | "drive_prune"
  | "backup";
export type BackupStepState = "running" | "ok" | "failed";
export type BackupStep = { step: BackupStepId; state: BackupStepState };
export type BackupNowResult = { ok: boolean; failed?: string };

const STEP_IDS = new Set(["backup_fetch", "drive_upload", "drive_verify", "drive_prune", "backup"]);
const STEP_STATES = new Set(["running", "ok", "failed"]);
const NOW_TIMEOUT_MS = 10 * 60_000;

function writeStatus(state: BackupState, error: string | null = null) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify({ state, at: Date.now(), error }), {
      mode: 0o600,
    });
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
    let finished = false;
    const done = (code: number | null) => {
      if (finished) return; // spawn failure emits both "error" and "close"
      finished = true;
      fs.closeSync(logFd);
      if (code === 0) writeStatus("ok");
      else writeStatus("failed", logMentionsDrive() ? "failed: drive" : "failed");
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

function parseStep(line: string): BackupStep | null {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const { step, state } = parsed;
    if (typeof step !== "string" || typeof state !== "string") return null;
    if (!STEP_IDS.has(step) || !STEP_STATES.has(state)) return null;
    return { step, state } as BackupStep;
  } catch {
    return null;
  }
}

function killGroup(child: ReturnType<typeof spawn>) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

type StepRun = { failedStep?: string; sawDone: boolean; timedOut: boolean };

function handleStepLine(
  run: StepRun,
  logFd: number,
  line: string,
  onStep: (step: BackupStep) => void,
) {
  const step = parseStep(line);
  if (!step) {
    fs.appendFileSync(logFd, `${line}\n`);
    return;
  }
  if (step.state === "failed") run.failedStep = step.step;
  if (step.step === "backup" && step.state === "ok") run.sawDone = true;
  onStep(step);
}

function settleRun(run: StepRun, code: number | null): BackupNowResult {
  if (code === 0 && !run.failedStep && !run.timedOut && run.sawDone) {
    writeStatus("ok");
    return { ok: true };
  }
  const failed = run.timedOut ? "timeout" : (run.failedStep ?? "backup");
  const drive = failed.startsWith("drive_") || (!run.failedStep && logMentionsDrive());
  writeStatus("failed", drive ? "failed: drive" : "failed");
  return { ok: false, failed };
}

// One run with contract lines on stdout; everything else goes to the log file only.
function runSteps(onStep: (step: BackupStep) => void): Promise<BackupNowResult> {
  return new Promise((resolve) => {
    fs.mkdirSync(stateDir(), { recursive: true });
    const logFd = fs.openSync(logFile(), "w", 0o600);
    const cmd = process.env.VAULT_BACKUP_CMD || "iron backup --json";
    writeStatus("running");
    const run: StepRun = { sawDone: false, timedOut: false };
    let finished = false;
    const child = spawn("setsid", ["-w", "sh", "-c", cmd], {
      stdio: ["ignore", "pipe", logFd],
      detached: true,
    });
    const timeout = setTimeout(() => {
      run.timedOut = true;
      killGroup(child);
    }, Number(process.env.VAULT_BACKUP_NOW_TIMEOUT_MS) || NOW_TIMEOUT_MS);
    const lines = child.stdout ? readline.createInterface({ input: child.stdout }) : null;
    lines?.on("line", (line) => handleStepLine(run, logFd, line, onStep));
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      fs.closeSync(logFd);
      resolve(settleRun(run, code));
    };
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
  active = (async () => {
    try {
      do {
        again = false;
        await runOnce();
      } while (again);
    } finally {
      running = false;
      active = null;
    }
  })();
  await active;
}

/* manual backup with live steps: waits for any active run, then does one fresh run */
export async function backupNow(onStep: (step: BackupStep) => void): Promise<BackupNowResult> {
  if (timer) clearTimeout(timer);
  timer = null;
  while (active) await active;
  running = true;
  const mine = runSteps(onStep);
  active = mine.then(() => undefined);
  try {
    return await mine;
  } finally {
    running = false;
    active = null;
    if (again) void runNow();
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
