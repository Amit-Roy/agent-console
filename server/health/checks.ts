import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDoctor } from "../doctor.ts";

export type HealthStatus = "ok" | "warning" | "error" | "info";
export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  healed?: { action: string; result: string };
}

export interface CommandResult {
  code: number;
  out: string;
}
export interface DiskUsage {
  target: string;
  pcent: number;
}
export interface ReportDeps {
  run: (cmd: string, args: string[]) => Promise<CommandResult>;
  readFile: (file: string) => string;
  mtimeMs: (file: string) => number;
  readlink: (file: string) => string;
  fetchJson: (url: string) => Promise<{ ok: boolean; status: number }>;
  disks: () => DiskUsage[] | Promise<DiskUsage[]>;
  doctor: () => Promise<{
    checks: { id: string; label: string; status: string; detail: string }[];
  }>;
  home: string;
  brainBin: string;
  now: () => number;
  timeoutMs: number;
}

const HOME = os.homedir();
const BOOT_STALE_MS = 3 * 24 * 3600_000;

function execRun(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export function defaultDeps(doctor?: ReportDeps["doctor"]): ReportDeps {
  return {
    run: execRun,
    readFile: (file) => fs.readFileSync(file, "utf8"),
    mtimeMs: (file) => fs.statSync(file).mtimeMs,
    readlink: (file) => fs.readlinkSync(file),
    fetchJson: (url) => fetch(url, { signal: AbortSignal.timeout(3000) }),
    disks: async () => (await import("../host.ts")).diskRows(),
    doctor:
      doctor ??
      (async () => {
        throw new Error("doctor dependency not provided");
      }),
    home: HOME,
    brainBin: path.join(HOME, "repos/brain/bin"),
    now: Date.now,
    timeoutMs: 15_000,
  };
}

const row = (
  checkId: string,
  label: string,
  status: HealthStatus,
  detail: string,
  healed?: HealthCheck["healed"],
): HealthCheck => ({ id: checkId, label, status, detail, ...(healed ? { healed } : {}) });

function doctorStatus(raw: string): HealthStatus {
  return raw === "ok" || raw === "warning" || raw === "error" ? raw : "info";
}

async function doctorChecks(deps: ReportDeps): Promise<HealthCheck[]> {
  const report = await deps.doctor();
  return report.checks.map((item) =>
    row(`doctor:${item.id}`, item.label, doctorStatus(item.status), item.detail),
  );
}

export function diskStatus(pcent: number): HealthStatus {
  if (pcent >= 95) return "error";
  return pcent >= 85 ? "warning" : "ok";
}

async function diskCheck(deps: ReportDeps): Promise<HealthCheck> {
  const rows = await deps.disks();
  const worst = rows.reduce<DiskUsage | undefined>(
    (top, item) => (!top || item.pcent > top.pcent ? item : top),
    undefined,
  );
  if (!worst) return row("disk", "Disk", "info", "no disks reported");
  return row("disk", "Disk", diskStatus(worst.pcent), `${worst.target} ${worst.pcent}% used`);
}

async function vpsCheck(deps: ReportDeps): Promise<HealthCheck> {
  const res = await deps.run("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "vps",
    "true",
  ]);
  return res.code === 0
    ? row("vps", "VPS ssh", "ok", "reachable")
    : row("vps", "VPS ssh", "error", res.out || `ssh exit ${res.code}`);
}

async function releaseCheck(deps: ReportDeps): Promise<HealthCheck> {
  const current = path
    .basename(deps.readlink(path.join(deps.home, ".local/share/agent-console/current")))
    .slice(0, 12);
  const git = ["-C", path.join(deps.home, "repos/agent-console"), "rev-parse", "--short=12"];
  let head = await deps.run("git", [...git, "origin/main"]);
  if (head.code !== 0) head = await deps.run("git", [...git, "main"]);
  if (head.code !== 0)
    return row("release-drift", "Release drift", "error", head.out || "git failed");
  const latest = head.out.trim();
  return current === latest
    ? row("release-drift", "Release drift", "ok", `release ${current} matches main`)
    : row("release-drift", "Release drift", "warning", `release ${current}, main ${latest}`);
}

async function triageCheck(deps: ReportDeps): Promise<HealthCheck> {
  const label = "GitHub triage";
  let port: number;
  try {
    const file = path.join(deps.home, ".config/agent-console/github-triage.json");
    port = Number(JSON.parse(deps.readFile(file)).port);
  } catch {
    return row("github-triage", label, "info", "not configured");
  }
  try {
    const res = await deps.fetchJson(`http://127.0.0.1:${port}/health`);
    return res.ok
      ? row("github-triage", label, "ok", `receiver healthy on ${port}`)
      : row("github-triage", label, "warning", `health HTTP ${res.status}`);
  } catch (err) {
    return row("github-triage", label, "warning", `receiver down: ${(err as Error).message}`);
  }
}

async function bootCheck(deps: ReportDeps): Promise<HealthCheck> {
  const label = "Workspace boot";
  const log = path.join(deps.home, ".cache/workspace-boot.log");
  let age: number;
  let text: string;
  try {
    age = deps.now() - deps.mtimeMs(log);
    text = deps.readFile(log);
  } catch {
    return row("workspace-boot", label, "info", "no boot log");
  }
  const lastRun = text.slice(Math.max(0, text.lastIndexOf("workspace-boot")));
  const days = Math.floor(age / 86_400_000);
  const failed = /failed|error/i.test(lastRun);
  const done = /== \S+ done/.test(lastRun);
  if (failed)
    return row("workspace-boot", label, "warning", `last boot reported errors (${days}d ago)`);
  if (!done)
    return row("workspace-boot", label, "warning", `last boot did not finish (${days}d ago)`);
  return row(
    "workspace-boot",
    label,
    age > BOOT_STALE_MS ? "info" : "ok",
    `last boot ${days}d ago`,
  );
}

async function phoneCheck(deps: ReportDeps): Promise<HealthCheck> {
  const res = await deps.run(path.join(deps.brainBin, "phone-link"), ["status"]);
  return res.code === 0
    ? row("phone-link", "Phone link", "ok", res.out.split("\n")[0] || "up")
    : row(
        "phone-link",
        "Phone link",
        "info",
        res.out.split("\n")[0] || "down (often intentionally off)",
      );
}

async function codegraphCheck(deps: ReportDeps): Promise<HealthCheck> {
  const label = "CodeGraph watcher";
  const status = await deps.run(path.join(deps.brainBin, "codegraph-watch"), ["status"]);
  if (status.code === 0 && status.out.startsWith("up"))
    return row("codegraph-watch", label, "ok", status.out);
  const start = await deps.run(path.join(deps.brainBin, "codegraph-watch"), ["start"]);
  const result = start.code === 0 ? start.out || "started" : `failed: ${start.out || start.code}`;
  const healed = { action: "start", result };
  return start.code === 0
    ? row("codegraph-watch", label, "ok", "was down, restarted", healed)
    : row("codegraph-watch", label, "error", "down, restart failed", healed);
}

function withTimeout<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), limitMs);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

const SINGLE_CHECKS: [string, string, (deps: ReportDeps) => Promise<HealthCheck>][] = [
  ["disk", "Disk", diskCheck],
  ["vps", "VPS ssh", vpsCheck],
  ["release-drift", "Release drift", releaseCheck],
  ["github-triage", "GitHub triage", triageCheck],
  ["workspace-boot", "Workspace boot", bootCheck],
  ["phone-link", "Phone link", phoneCheck],
  ["codegraph-watch", "CodeGraph watcher", codegraphCheck],
];

export async function runReportChecks(
  overrides: Partial<ReportDeps> & { threads?: Parameters<typeof createDoctor>[0] } = {},
): Promise<HealthCheck[]> {
  const { threads, ...rest } = overrides;
  const doctor = threads ? () => createDoctor(threads).inspect() : undefined;
  const deps = { ...defaultDeps(doctor), ...rest };
  const jobs: { id: string; label: string; run: Promise<HealthCheck[]> }[] = [
    { id: "doctor", label: "Doctor", run: doctorChecks(deps) },
    ...SINGLE_CHECKS.map(([checkId, label, probe]) => ({
      id: checkId,
      label,
      run: probe(deps).then((item) => [item]),
    })),
  ];
  const settled = await Promise.allSettled(jobs.map((job) => withTimeout(job.run, deps.timeoutMs)));
  return settled.flatMap((res, idx) =>
    res.status === "fulfilled"
      ? res.value
      : [row(jobs[idx].id, jobs[idx].label, "error", (res.reason as Error).message)],
  );
}
