import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import { type BackupStep, backupNow } from "./vault-backup.ts";
import { type CheckResult, providerCheck } from "./vault-doctor.ts";

// One global in-memory iron key save job. Labels and errors come only from the tables below, never
// from command output or values, so everything streamed or snapshotted is safe to show.
export type StepId =
  | "provider"
  | "set"
  | "pins"
  | "proxy"
  | "check"
  | "backup_fetch"
  | "drive_upload"
  | "drive_verify"
  | "drive_prune";
type StepState = "pending" | "running" | "ok" | "skip" | "fail";
type JobStep = { id: StepId; label: string; state: StepState; error?: string };
export type Msg = { t: string; [field: string]: unknown };
export type Sink = (msg: Msg) => void;
export type JobKind = "replace" | "add";
type Retry = "set" | "verify";
export type Job = {
  id: string;
  name: string;
  steps: JobStep[];
  sink: Sink | null;
  running: boolean;
  ok: boolean | null;
  retry: Retry | null;
  restartNeeded: boolean;
  warnings: string[] | null;
};

export const LABELS: Record<StepId, string> = {
  provider: "Add provider on iron",
  set: "Store key in iron",
  pins: "Update egress pins",
  proxy: "Check proxy",
  check: "Check provider key",
  backup_fetch: "Fetch backup on host",
  drive_upload: "Upload to Drive",
  drive_verify: "Verify Drive copy",
  drive_prune: "Remove old Drive copies",
};
export const ERR = {
  setFailed: "iron set failed",
  unreachable: "iron unreachable, nothing saved",
  providerFailed: "iron provider add failed",
  proxyOff: "Proxy not active",
  proxyDeaf: "Proxy not listening",
  noToken: "No env file holds the proxy token",
  rejected: "Provider rejected the key",
  hostBackup: "Backup on host failed",
  driveUpload: "Drive upload failed: check Google Drive connector",
  driveVerify: "Drive copy did not verify, old copies kept",
  drivePrune: "Old Drive copies not removed",
  timeout: "Backup timed out",
} as const;
const ALLOWED = new Set<string>(Object.values(ERR));
const BACKUP_ERR: Partial<Record<StepId, string>> = {
  backup_fetch: ERR.hostBackup,
  drive_upload: ERR.driveUpload,
  drive_verify: ERR.driveVerify,
  drive_prune: ERR.drivePrune,
};
const BACKUP_IDS: StepId[] = ["backup_fetch", "drive_upload", "drive_verify", "drive_prune"];
const KIND_STEPS: Record<JobKind, StepId[]> = {
  replace: ["set", "proxy", "check", ...BACKUP_IDS],
  add: ["provider", "set", "pins", "proxy", "check", ...BACKUP_IDS],
};
const HTTP = /^\d{3}$/;
const REJECTED = /^Provider rejected the key( \(HTTP \d{3}\))?$/;

let current: Job | null = null;

const planMsg = (job: Job): Msg => ({
  t: "plan",
  job: job.id,
  steps: job.steps.map((entry) => ({ id: entry.id, label: entry.label })),
});

function emit(job: Job, msg: Msg) {
  try {
    job.sink?.({ ...msg, at: Date.now() });
  } catch {
    job.sink = null; // the client went away; the job carries on
  }
}

export const jobBusy = (): boolean => current?.running === true;

export function beginJob(kind: JobKind, sink: Sink): Job {
  const steps = KIND_STEPS[kind].map((stepId) => ({
    id: stepId,
    label: LABELS[stepId],
    state: "pending" as const,
  }));
  const job: Job = {
    id: crypto.randomBytes(6).toString("hex"),
    name: "",
    steps,
    sink,
    running: true,
    ok: null,
    retry: null,
    restartNeeded: false,
    warnings: null,
  };
  current = job;
  emit(job, planMsg(job));
  return job;
}

const stepOf = (job: Job, stepId: StepId) => job.steps.find((entry) => entry.id === stepId);
const needs = (job: Job, stepId: StepId) => {
  const state = stepOf(job, stepId)?.state;
  return state !== "ok" && state !== "skip";
};

export function stepStart(job: Job | null, stepId: StepId) {
  const step = job && stepOf(job, stepId);
  if (!job || !step) return;
  step.state = "running";
  emit(job, { t: "step", id: stepId });
}

export function stepDone(job: Job | null, stepId: StepId, state: "ok" | "skip" = "ok") {
  const step = job && stepOf(job, stepId);
  if (!job || !step) return;
  step.state = state;
  emit(job, { t: state, id: stepId });
}

function stepFail(job: Job, stepId: StepId, error: string): false {
  const step = stepOf(job, stepId);
  if (!step) return false;
  step.state = "fail";
  step.error = ALLOWED.has(error) || REJECTED.test(error) ? error : ERR.setFailed;
  emit(job, { t: "fail", id: stepId, error: step.error });
  return false;
}

export function endJob(job: Job, success: boolean, retry?: Retry) {
  job.running = false;
  job.ok = success;
  job.retry = retry ?? null;
  const extra = {
    ...(retry ? { retry } : {}),
    ...(job.restartNeeded ? { restartNeeded: true } : {}),
    ...(job.warnings?.length ? { warnings: job.warnings } : {}),
  };
  emit(job, { t: "done", ok: success, ...extra });
}

/* the running step failed before the verify stage: only a new save can fix it */
export function failSave(job: Job, message: string) {
  const running = job.steps.find((entry) => entry.state === "running");
  stepFail(job, running?.id ?? "set", message);
  endJob(job, false, "set");
}

/* set (and provider, pins) finished: verification and backup run on their own from here */
export function startTail(job: Job, extra: { restartNeeded: boolean; warnings?: string[] }) {
  job.restartNeeded = extra.restartNeeded;
  job.warnings = extra.warnings ?? null;
  void tail(job).catch(() => crash(job));
}

function crash(job: Job) {
  const running = job.steps.find((entry) => entry.state === "running");
  stepFail(job, running?.id ?? "proxy", ERR.hostBackup);
  endJob(job, false, "verify");
}

async function tail(job: Job) {
  const good = (await runVerify(job)) && (await runBackup(job));
  if (good) endJob(job, true);
  else endJob(job, false, "verify");
}

function proxyError(code: string): string {
  return code === "listener" ? ERR.proxyDeaf : ERR.proxyOff;
}

function checkError(check: Extract<CheckResult, { ok: false }>): string {
  if (check.code === "token") return ERR.noToken;
  if (check.code === "doctor") return ERR.proxyOff;
  return check.http && HTTP.test(check.http)
    ? `${ERR.rejected} (HTTP ${check.http})`
    : ERR.rejected;
}

function settleCheck(job: Job, check: CheckResult): boolean {
  if ("skip" in check) {
    stepDone(job, "check", "skip");
    return true;
  }
  if (check.ok) {
    stepDone(job, "check");
    return true;
  }
  return stepFail(job, "check", checkError(check));
}

async function runVerify(job: Job): Promise<boolean> {
  if (!needs(job, "proxy") && !needs(job, "check")) return true;
  stepStart(job, "proxy");
  const result = await providerCheck(job.name);
  if (!result.proxy.ok) return stepFail(job, "proxy", proxyError(result.proxy.code));
  stepDone(job, "proxy");
  stepStart(job, "check");
  return settleCheck(job, result.check);
}

function onBackupStep(job: Job, entry: BackupStep) {
  if (entry.step === "backup") return;
  if (entry.state === "running") stepStart(job, entry.step);
  else if (entry.state === "ok") stepDone(job, entry.step);
  else stepFail(job, entry.step, BACKUP_ERR[entry.step] ?? ERR.hostBackup);
}

function failBackup(job: Job, reason: string | undefined) {
  const backup = job.steps.filter((entry) => BACKUP_IDS.includes(entry.id));
  if (backup.some((entry) => entry.state === "fail")) return;
  const target = backup.find((entry) => entry.state === "running") ?? backup[0];
  stepFail(job, target.id, reason === "timeout" ? ERR.timeout : ERR.hostBackup);
}

async function runBackup(job: Job): Promise<boolean> {
  const result = await backupNow((entry) => onBackupStep(job, entry));
  if (!result.ok) {
    failBackup(job, result.failed);
    return false;
  }
  for (const entry of job.steps)
    if (BACKUP_IDS.includes(entry.id) && entry.state !== "ok") stepDone(job, entry.id, "skip");
  return true;
}

/* back to the failed step: proxy and check rerun together, backup always reruns whole */
function rewind(job: Job) {
  const redo = new Set<StepId>(BACKUP_IDS);
  if (needs(job, "proxy") || needs(job, "check")) redo.add("proxy").add("check");
  for (const entry of job.steps)
    if (redo.has(entry.id)) {
      entry.state = "pending";
      delete entry.error;
    }
}

export type ResumeResult = "started" | "busy" | "none";

export function resumeJob(sink: Sink): ResumeResult {
  const job = current;
  if (!job || job.running) return job ? "busy" : "none";
  if (job.retry !== "verify") return "none";
  rewind(job);
  job.sink = sink;
  job.running = true;
  job.ok = null;
  job.retry = null;
  emit(job, planMsg(job));
  for (const entry of job.steps)
    if (entry.state !== "pending") emit(job, { t: entry.state, id: entry.id });
  void tail(job).catch(() => crash(job));
  return "started";
}

/* ids, labels, states and error strings only */
export function ironJobSnapshot() {
  if (!current) return null;
  const { id: jobId, running, ok: success, retry, steps } = current;
  return {
    id: jobId,
    job: jobId,
    running,
    done: !running,
    ok: success,
    retry,
    steps: steps.map(({ id: stepId, label, state, error }) => ({
      id: stepId,
      label,
      state: state === "fail" ? "failed" : state,
      ...(error ? { error } : {}),
    })),
  };
}

/* NDJSON response that only opens when the first message arrives; otherwise the caller answers JSON */
export function ndjsonStream(res: ServerResponse) {
  let started = false;
  const sink: Sink = (msg) => {
    if (res.writableEnded) return;
    if (!started) {
      started = true;
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }
    res.write(`${JSON.stringify({ at: Date.now(), ...msg })}\n`);
    if (msg.t === "done" || msg.t === "error") res.end();
  };
  return { sink, started: () => started };
}
