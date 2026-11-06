// Persisted `pr-ship` jobs for the PR cockpit (#421). One detached sh wrapper per PR runs
// `pr-ship N -R owner/repo`, appends its output and then `exit:<code>` to a file under the data dir,
// and a JSON record {pid, key, thread, startedAt, outFile} lets a restarted Console reattach:
// a live pid keeps being watched (polling the output file and /proc), a dead one is read from its output.
// Exit 0 -> merged, 1 -> attention, anything else (or no exit line) -> failed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./automation/events.ts";
import { childEnv } from "./providers/env.ts";

export interface ShipState {
  state: "running" | "merged" | "attention" | "failed";
  line?: string;
  code?: number;
  startedAt: number;
}
export interface ShipRecord {
  pid: number;
  key: string;
  thread: string;
  startedAt: number;
  outFile: string;
  done?: ShipState;
}
export interface ShipStart {
  key: string;
  thread: string;
  repo: string;
  number: number;
  cwd: string;
}
export interface ShipJobOptions {
  dir: string;
  onUpdate(record: ShipRecord, ship: ShipState): void;
  pollMs?: number;
  /** Kept records of finished jobs are dropped at load after this age. */
  keepMs?: number;
  command?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export class ShipBusyError extends Error {
  constructor() {
    super("A ship job for this PR is already running.");
  }
}

// $1 = output file, $2 = command, the rest = its arguments. The output file in argv identifies the job in /proc.
const WRAPPER = 'out="$1"; shift; "$@" >> "$out" 2>&1; echo "exit:$?" >> "$out"';
const EXIT_RE = /^exit:(\d+)$/;
const TAIL_BYTES = 8192;
const LINE_MAX = 500;

const fileBase = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "_");
const clip = (line: string) => redact(line).slice(0, LINE_MAX);

function readTail(file: string): string {
  try {
    const handle = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(handle).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return "";
  }
}

const outputLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const stateFor = (code: number): ShipState["state"] =>
  code === 0 ? "merged" : code === 1 ? "attention" : "failed";

/** Final state from the wrapper's output, or null while the `exit:` line is missing. */
export function readOutcome(text: string, startedAt: number): ShipState | null {
  const lines = outputLines(text);
  const exitAt = lines.findLastIndex((line) => EXIT_RE.test(line));
  if (exitAt < 0) return null;
  const code = Number(EXIT_RE.exec(lines[exitAt])![1]);
  const last = lines.slice(0, exitAt).pop();
  return { state: stateFor(code), code, startedAt, ...(last ? { line: clip(last) } : {}) };
}

/** True when the pid runs and (where /proc exists) is still this job's wrapper, not a reused pid. */
export function jobAlive(pid: number, outFile: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    if (error?.code !== "EPERM") return false;
  }
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return argv.split("\0").includes(outFile) && !isZombie(pid);
  } catch {
    return !fs.existsSync("/proc/self");
  }
}

function isZombie(pid: number): boolean {
  try {
    return /\)\s+Z\s/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

function readRecord(file: string): ShipRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const valid =
      typeof record?.key === "string" &&
      typeof record.thread === "string" &&
      typeof record.outFile === "string" &&
      Number.isSafeInteger(record.pid) &&
      Number.isFinite(record.startedAt);
    return valid ? record : null;
  } catch {
    return null;
  }
}

const startFailure = (startedAt: number): ShipState => ({
  state: "failed",
  startedAt,
  line: "pr-ship could not start.",
});

export class ShipJobs {
  private options: ShipJobOptions;
  private now: () => number;
  private records = new Map<string, ShipRecord>();
  private progress = new Map<string, string | undefined>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ShipJobOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.load();
  }

  running(key: string): boolean {
    const record = this.records.get(key);
    return !!record && !record.done;
  }

  get(key: string): ShipState | undefined {
    return this.current(this.records.get(key));
  }

  record(key: string): ShipRecord | undefined {
    return this.records.get(key);
  }

  start(job: ShipStart): ShipState {
    if (this.running(job.key)) throw new ShipBusyError();
    const outFile = path.join(this.options.dir, `${fileBase(job.key)}.out`);
    fs.writeFileSync(outFile, "", { mode: 0o600 });
    const args = [outFile, this.options.command ?? "pr-ship", String(job.number), "-R", job.repo];
    const child = spawn("sh", ["-c", WRAPPER, "sh", ...args], {
      cwd: job.cwd,
      env: this.options.env ?? childEnv(),
      detached: true,
      stdio: "ignore",
    });
    const record: ShipRecord = {
      pid: child.pid ?? 0,
      key: job.key,
      thread: job.thread,
      startedAt: this.now(),
      outFile,
    };
    child.on("error", () => {
      if (!record.done) this.finish(record, startFailure(record.startedAt));
    });
    child.unref();
    this.records.set(job.key, record);
    this.progress.delete(job.key);
    this.persist(record);
    if (record.pid) this.watch();
    else this.finish(record, startFailure(record.startedAt));
    return this.current(record)!;
  }

  /** One watch pass over running jobs; driven by the unref'd interval, public for tests. */
  tick() {
    const live = [...this.records.values()].filter((record) => !record.done);
    for (const record of live) this.check(record);
    if (!live.some((record) => !record.done)) this.stop();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private watch() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.pollMs ?? 2000);
    this.timer.unref();
  }

  private load() {
    const keepMs = this.options.keepMs ?? 7 * 24 * 3600_000;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.options.dir).filter((name) => name.endsWith(".json"));
    } catch {}
    for (const name of names) {
      const record = readRecord(path.join(this.options.dir, name));
      const expired = !!record?.done && this.now() - record.startedAt > keepMs;
      if (record && !expired) this.records.set(record.key, record);
    }
    if ([...this.records.values()].some((record) => !record.done)) this.watch();
  }

  private persist(record: ShipRecord) {
    const file = path.join(this.options.dir, `${fileBase(record.key)}.json`);
    const staging = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(staging, file);
  }

  private finish(record: ShipRecord, ship: ShipState) {
    record.done = ship;
    this.progress.delete(record.key);
    this.persist(record);
    this.options.onUpdate(record, ship);
  }

  private check(record: ShipRecord) {
    const text = readTail(record.outFile);
    const outcome = readOutcome(text, record.startedAt);
    if (outcome) return this.finish(record, outcome);
    const last = outputLines(text).pop();
    const line = last ? clip(last) : undefined;
    if (!jobAlive(record.pid, record.outFile))
      return this.finish(record, {
        state: "failed",
        startedAt: record.startedAt,
        line: line ?? "pr-ship stopped without reporting an exit code.",
      });
    if (this.progress.get(record.key) === line) return;
    this.progress.set(record.key, line);
    this.options.onUpdate(record, this.current(record)!);
  }

  private current(record: ShipRecord | undefined): ShipState | undefined {
    if (!record) return undefined;
    if (record.done) return record.done;
    const line = this.progress.get(record.key);
    return { state: "running", startedAt: record.startedAt, ...(line ? { line } : {}) };
  }
}

export const createShipJobs = (options: ShipJobOptions) => new ShipJobs(options);
