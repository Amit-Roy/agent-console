import "../server/privacy.ts";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "@octokit/webhooks-methods";
import { announceClosed } from "../server/automation/closed-signal.ts";
import { childEnv } from "../server/providers/env.ts";
import {
  effortModelPath,
  loadEffortModel,
  quoteEffort,
  requestShape,
} from "../server/providers/triage-effort.ts";
import {
  type EffortConfig,
  type PromotionDecision,
  promotionDecision,
  readEffortConfig,
} from "../server/triage-promotion.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const CONFIG =
  process.env.AGENT_CONSOLE_TRIAGE_CONFIG ||
  path.join(os.homedir(), ".config/agent-console/github-triage.json");
const RUN =
  process.env.AGENT_CONSOLE_TRIAGE_RUN ||
  path.join(os.homedir(), ".cache/agent-console/github-triage");
const PID = path.join(RUN, "pid");
const LAST_RECONCILE = path.join(RUN, "last-reconcile");
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const CALIBRATION_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const CALIBRATION_RETRY_MS = 6 * 60 * 60_000;
const CALIBRATION_PID = path.join(RUN, "calibration-pid");
const CALIBRATION_ATTEMPT = path.join(RUN, "calibration-attempt");
type Config = {
  repos: string[];
  secret: string;
  url: string;
  port: number;
  host: string;
  deploy?: string;
  owner?: string;
};
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function validateConfig(c: Config): Config {
  if (
    !Array.isArray(c.repos) ||
    !c.repos.length ||
    !c.repos.every((r: unknown) => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r))
  )
    throw Error("Configure an explicit repository allowlist first.");
  if (typeof c.secret !== "string" || c.secret.length < 32)
    throw Error("Webhook secret must contain at least 32 characters.");
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)
    throw Error("Invalid webhook port.");
  if (!c.host || new URL(c.url).protocol !== "https:")
    throw Error("Configure an HTTPS webhook URL.");
  if (c.deploy !== undefined && !c.repos.includes(c.deploy))
    throw Error("The deploy repository must be in the allowlist.");
  if (c.owner !== undefined && (typeof c.owner !== "string" || !OWNER.test(c.owner)))
    throw Error("Invalid repository owner.");
  return c;
}

function config(): Config {
  return validateConfig(JSON.parse(fs.readFileSync(CONFIG, "utf8")));
}

function saveConfig(c: Config) {
  validateConfig(c);
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG}.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, CONFIG);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Green CI on main: fast-forward this checkout, then restart the console when idle and this worker after it drains.
// Detached, because restarting the worker stops the process that started the deploy. A dirty or diverged tree fails the pull and skips both restarts.
function deploy() {
  const log = fs.openSync(path.join(RUN, "deploy.log"), "a", 0o600);
  const script = `echo "deploy $(date -Is)"; git -C "$1" pull --ff-only -q && "$1/bin/agent-console" restart-when-idle && "$1/bin/github-triage" restart`;
  spawn("bash", ["-c", script, "deploy", ROOT], {
    cwd: ROOT,
    env: childEnv(),
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
  fs.closeSync(log);
}

async function exited(n: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(n, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function pid(): number | undefined {
  try {
    const n = Number(fs.readFileSync(PID, "utf8"));
    if (!Number.isSafeInteger(n) || n <= 1) return;
    const args = fs.readFileSync(`/proc/${n}/cmdline`, "utf8").split("\0");
    return args.includes(SCRIPT) && args.includes("serve") ? n : undefined;
  } catch {
    return;
  }
}

function github(method: string, endpoint: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = ["api", "--hostname", "github.com", "--method", method, endpoint];
    if (body !== undefined) args.push("--input", "-");
    const p = execFile(
      "gh",
      args,
      { env: childEnv(), timeout: 30_000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        if (err) return reject(Error(`GitHub ${method} request failed.`));
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : undefined);
        } catch {
          reject(Error("GitHub returned invalid JSON."));
        }
      },
    );
    p.stdin?.on("error", () => {});
    p.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function pages(endpoint: string): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; ; page++) {
    const batch = await github(
      "GET",
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw Error("GitHub returned an invalid repository or webhook list.");
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

async function ownedRepos(owner: string): Promise<string[]> {
  const user = await github("GET", "user");
  if (typeof user?.login !== "string" || user.login.toLowerCase() !== owner.toLowerCase()) {
    throw Error("Repository owner must match the authenticated GitHub account.");
  }
  const rows = await pages("user/repos?affiliation=owner");
  return [
    ...new Set<string>(
      rows
        .filter(
          (repo) =>
            repo?.owner?.login?.toLowerCase() === owner.toLowerCase() &&
            repo.permissions?.admin === true &&
            repo.has_issues === true &&
            !repo.archived &&
            !repo.disabled &&
            typeof repo.full_name === "string" &&
            /^[\w.-]+\/[\w.-]+$/.test(repo.full_name) &&
            repo.full_name.split("/")[0].toLowerCase() === owner.toLowerCase(),
        )
        .map((repo) => repo.full_name),
    ),
  ].sort();
}

async function registerHooks(c: Config, force = false) {
  for (const repo of c.repos) {
    const hooks = await pages(`repos/${repo}/hooks`);
    const existing = hooks.find((h) => h.config?.url === c.url);
    const required = ["issues", "pull_request", ...(repo === c.deploy ? ["workflow_run"] : [])];
    const events = [...new Set<string>([...(existing?.events ?? []), ...required])];
    const current =
      existing?.active &&
      existing.config?.content_type === "json" &&
      existing.config?.insecure_ssl === "0" &&
      (existing.events?.includes("*") ||
        required.every((event) => existing.events?.includes(event)));
    if (!force && current) continue;
    const body = {
      name: "web",
      active: true,
      events: existing?.events?.includes("*") ? ["*"] : events,
      config: { url: c.url, content_type: "json", insecure_ssl: "0", secret: c.secret },
    };
    const hook = await github(
      existing ? "PATCH" : "POST",
      `repos/${repo}/hooks${existing ? `/${existing.id}` : ""}`,
      body,
    );
    console.log(`Registered ${repo} webhook ${hook.id}.`);
  }
}

async function syncRepos(c: Config): Promise<Config> {
  if (c.owner) {
    const discovered = await ownedRepos(c.owner);
    // Reload before writing so discovery does not overwrite another command's settings.
    const latest = config();
    if (latest.owner !== c.owner)
      throw Error("Repository owner changed during discovery; retry sync.");
    const repos = [...new Set([...latest.repos, ...discovered])];
    c = { ...latest, repos };
    if (repos.length !== latest.repos.length) saveConfig(c);
  }
  // The receiver reloads the allowlist per request, before a new hook can deliver.
  await registerHooks(c);
  console.log(`Repository sync complete: ${c.repos.length} allowed repositories.`);
  return c;
}

async function health(c: Config) {
  const r = await fetch(`http://127.0.0.1:${c.port}/health`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw Error(`Webhook health check failed: HTTP ${r.status}.`);
  return r.json();
}

function start() {
  if (process.env.AGENT_CONSOLE_MOCK === "1" || !fs.existsSync(CONFIG)) return;
  config();
  if (pid()) {
    console.log("GitHub triage already running.");
    return;
  }
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(RUN, "log"), "a", 0o600);
  try {
    const p = spawn(process.execPath, [SCRIPT, "serve"], {
      cwd: ROOT,
      env: childEnv(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    p.unref();
  } finally {
    fs.closeSync(out);
  }
  console.log("GitHub triage starting.");
}

async function reconcile(c: Config) {
  let scanned = 0;
  let queued = 0;
  for (const repo of c.repos) {
    const body = JSON.stringify({ repository: { full_name: repo } });
    const response = await fetch(`http://127.0.0.1:${c.port}/reconcile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": await sign(c.secret, body),
      },
      body,
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw Error(`Reconciliation failed: HTTP ${response.status}.`);
    const result = (await response.json()) as { scanned: number; queued: number };
    if (!Number.isSafeInteger(result.scanned) || !Number.isSafeInteger(result.queued))
      throw Error("Invalid reconciliation response.");
    scanned += result.scanned;
    queued += result.queued;
  }
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const temporary = `${LAST_RECONCILE}.${process.pid}`;
  fs.writeFileSync(temporary, String(Date.now()), { mode: 0o600 });
  fs.renameSync(temporary, LAST_RECONCILE);
  console.log(`Reconciled ${scanned} open items; queued ${queued} repairs.`);
}

function calibrationRunning(): boolean {
  try {
    const calibrationPid = Number(fs.readFileSync(CALIBRATION_PID, "utf8"));
    if (!Number.isSafeInteger(calibrationPid) || calibrationPid <= 1)
      return Date.now() - fs.statSync(CALIBRATION_PID).mtimeMs < 120_000;
    const args = fs.readFileSync(`/proc/${calibrationPid}/cmdline`, "utf8").split("\0");
    return args.includes(SCRIPT) && args.includes("calibrate");
  } catch {
    return false;
  }
}

type CalibrationOutcome = "promoted" | "rejected" | "failed";
type CalibrationState = {
  lastCompletedAt: number | null;
  lastOutcome: CalibrationOutcome;
  reasons: string[];
};
type Calibration = {
  runId: string;
  steps: EffortConfig["steps"];
  modelDir: string;
  destination: string;
  temporary: string;
  history: string;
  dataset: string;
  artifact: string;
  report: string;
};
const CALIBRATION_STATE = path.join(RUN, "calibration-state.json");
const CALIBRATION_EVENT_LIMIT = 2000;
const SMOKE_REQUEST = "Fix the login button crash in public/app.js and add a test";

function calibrationEventsPath(): string {
  return path.join(path.dirname(effortModelPath()), "triage-calibration-events.jsonl");
}

function trimCalibrationEvents(file: string) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (lines.length <= CALIBRATION_EVENT_LIMIT) return;
  const kept = lines.slice(-CALIBRATION_EVENT_LIMIT).join("\n");
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${kept}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Best effort: the Automation page reads these lines, so a write failure must never fail a run. */
function calibrationEvent(
  run: string,
  step: string,
  kind: "start" | "ok" | "fail" | "info",
  msg?: string,
  data?: Record<string, unknown>,
) {
  try {
    const file = calibrationEventsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const event = {
      ts: Date.now(),
      run,
      step,
      kind,
      ...(msg ? { msg: msg.slice(0, 300) } : {}),
      ...(data ? { data } : {}),
    };
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    trimCalibrationEvents(file);
  } catch {}
}

function readCalibrationState(): CalibrationState | null {
  try {
    const value = JSON.parse(fs.readFileSync(CALIBRATION_STATE, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** A failed run keeps the previous completion time so the retry window, not the weekly one, applies. */
function writeCalibrationState(outcome: CalibrationOutcome, reasons: string[]) {
  const previous = readCalibrationState()?.lastCompletedAt;
  const carried = typeof previous === "number" && Number.isFinite(previous) ? previous : null;
  const state: CalibrationState = {
    lastCompletedAt: outcome === "failed" ? carried : Date.now(),
    lastOutcome: outcome,
    reasons: reasons.slice(0, 10).map((reason) => reason.slice(0, 300)),
  };
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const temporary = `${CALIBRATION_STATE}.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, CALIBRATION_STATE);
}

function calibrationLastCompleted(): number {
  const completed = readCalibrationState()?.lastCompletedAt;
  if (typeof completed === "number" && Number.isFinite(completed)) return completed;
  try {
    return fs.statSync(effortModelPath()).mtimeMs;
  } catch {
    return 0;
  }
}

function calibrationLastAttempt(): number {
  try {
    return Number(fs.readFileSync(CALIBRATION_ATTEMPT, "utf8"));
  } catch {
    return 0;
  }
}

function calibrationDue(now = Date.now()): boolean {
  const completed = calibrationLastCompleted();
  const attempted = calibrationLastAttempt();
  const completedDue = completed > now || now - completed >= CALIBRATION_INTERVAL_MS;
  const retryDue =
    !Number.isFinite(attempted) || attempted > now || now - attempted >= CALIBRATION_RETRY_MS;
  return completedDue && retryDue;
}

function maybeStartCalibration() {
  if (readEffortConfig().enabled === false || !calibrationDue()) return;
  startCalibration("due: started by the watchdog");
}

function startCalibration(reason: string) {
  if (calibrationRunning()) return;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CALIBRATION_ATTEMPT, String(Date.now()), { mode: 0o600 });
  const runId = new Date().toISOString();
  calibrationEvent(runId, "effort_schedule", "info", reason);
  const log = fs.openSync(path.join(RUN, "calibration.log"), "a", 0o600);
  try {
    spawn(process.execPath, [SCRIPT, "calibrate", "--run", runId], {
      cwd: ROOT,
      env: childEnv(),
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
  } finally {
    fs.closeSync(log);
  }
  console.log("Effort calibration started in the background.");
}

function describeStageFailure(stage: string, error: unknown, stderr: unknown): string {
  const failure = error as { code?: unknown; signal?: unknown; killed?: unknown };
  const tail = String(stderr ?? "").slice(-1500);
  return `Effort calibration stage=${stage} exit=${failure.code ?? "none"} signal=${failure.signal ?? "none"} killed=${failure.killed === true} stderr=${JSON.stringify(tail)}`;
}

/** The child stderr tail goes to the calibration log. The environment is never printed. */
function runStage(command: string, args: string[], timeout: number, stage: string) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      { env: childEnv(), timeout, maxBuffer: 1_000_000 },
      (error, _out, err) => {
        if (!error) return resolve();
        console.error(describeStageFailure(stage, error, err));
        reject(
          Error(
            `Effort calibration failed at stage ${stage}; the previous model was retained. See the private calibration log and setup instructions.`,
          ),
        );
      },
    );
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Emits start/ok/fail around enabled work and an info "disabled" event otherwise. */
async function calibrationStep(
  ctx: Calibration,
  step: string,
  enabled: boolean,
  work: () => Promise<void>,
  whenDisabled?: () => void,
): Promise<boolean> {
  const failWith = (error: unknown): never => {
    calibrationEvent(ctx.runId, step, "fail", errorText(error));
    throw error;
  };
  if (!enabled) {
    calibrationEvent(ctx.runId, step, "info", "disabled");
    try {
      whenDisabled?.();
    } catch (error) {
      failWith(error);
    }
    return false;
  }
  calibrationEvent(ctx.runId, step, "start");
  try {
    await work();
  } catch (error) {
    failWith(error);
  }
  calibrationEvent(ctx.runId, step, "ok");
  return true;
}

function reuseInstalled(target: string, installed: string) {
  if (!fs.existsSync(installed))
    throw Error(`No installed ${path.basename(installed)} to reuse; enable the earlier steps.`);
  fs.copyFileSync(installed, target);
}

const installedFile = (ctx: Calibration, name: string) => path.join(ctx.modelDir, name);

function sessionsStep(ctx: Calibration) {
  const data = process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config/agent-console");
  const script = path.join(ROOT, "scripts/triage-session-build.ts");
  return calibrationStep(
    ctx,
    "effort_sessions",
    ctx.steps.sessions,
    () =>
      runStage(
        process.execPath,
        [script, "--data", data, "--output", ctx.history],
        120_000,
        "session-build",
      ),
    () => reuseInstalled(ctx.history, installedFile(ctx, "triage-session-history.json")),
  );
}

function featuresStep(ctx: Calibration) {
  const script = path.join(ROOT, "scripts/triage-effort-features.ts");
  const cache = installedFile(ctx, "triage-effort-features.json");
  return calibrationStep(
    ctx,
    "effort_features",
    ctx.steps.features,
    () =>
      runStage(
        process.execPath,
        [script, "--history", ctx.history, "--output", cache, "--dataset", ctx.dataset],
        30 * 60_000,
        "effort-features",
      ),
    () => reuseInstalled(ctx.dataset, installedFile(ctx, "triage-effort-training.json")),
  );
}

function fitStep(ctx: Calibration) {
  const python =
    process.env.AGENT_CONSOLE_TRIAGE_PYTHON ||
    path.join(os.homedir(), ".local/share/agent-console/triage-venv/bin/python");
  const args = [
    path.join(ROOT, "scripts/triage-effort-fit.py"),
    "--dataset",
    ctx.dataset,
    "--output",
    ctx.artifact,
    "--report",
    ctx.report,
  ];
  if (fs.existsSync(ctx.destination)) args.push("--champion", ctx.destination);
  // Five boosted quantile heads fit in about a minute locally and longer under a busy
  // worker; the old 120 s ceiling killed valid fits.
  return calibrationStep(ctx, "effort_fit", ctx.steps.fit, () =>
    runStage(python, args, 600_000, "effort-fit"),
  );
}

function gateDecision(ctx: Calibration): PromotionDecision {
  if (!ctx.steps.gate)
    calibrationEvent(ctx.runId, "effort_gate", "info", "disabled", { compareChampion: false });
  let decision: PromotionDecision;
  try {
    const artifact = JSON.parse(fs.readFileSync(ctx.artifact, "utf8"));
    decision = promotionDecision(artifact, { compareChampion: ctx.steps.gate });
  } catch (error) {
    calibrationEvent(ctx.runId, "effort_gate", "fail", errorText(error));
    throw error;
  }
  if (decision.bootstrap)
    calibrationEvent(ctx.runId, "effort_gate", "info", "bootstrap", { reasons: decision.reasons });
  if (decision.promote)
    calibrationEvent(ctx.runId, "effort_gate", "ok", undefined, { metrics: decision.metrics });
  else
    calibrationEvent(ctx.runId, "effort_gate", "fail", "rejected", {
      reasons: decision.reasons,
      metrics: decision.metrics,
    });
  return decision;
}

/** Realistic request text so the smoke quote exercises the quantile trees, not only the ridge fallback. */
function validateChallenger(ctx: Calibration) {
  const model = loadEffortModel(ctx.artifact);
  const quote = quoteEffort(
    {
      breadth: { value: null },
      complexity: { value: null },
      uncertainty: { value: null },
      risk: { value: null },
      ...requestShape(SMOKE_REQUEST),
    },
    model,
    SMOKE_REQUEST,
  );
  if (model.status !== "ready" || quote.status !== "ready")
    throw Error("The learned effort model failed validation; previous calibration retained.");
  if (model.model.quantileModel && quote.method !== "boosted-trees-quantile-v1")
    throw Error(
      "The learned effort model did not use its quantile trees; previous calibration retained.",
    );
  return model.model;
}

function checkChallenger(ctx: Calibration) {
  try {
    return validateChallenger(ctx);
  } catch (error) {
    calibrationEvent(ctx.runId, "effort_gate", "fail", errorText(error));
    throw error;
  }
}

function storeChallenger(ctx: Calibration) {
  const pairs: [string, string][] = [
    [ctx.artifact, installedFile(ctx, "triage-effort-model.challenger.json")],
    [ctx.report, installedFile(ctx, "triage-effort-report.challenger.json")],
  ];
  for (const [source, target] of pairs) {
    if (!fs.existsSync(source)) continue;
    fs.renameSync(source, target);
    fs.chmodSync(target, 0o600);
  }
}

function installChallenger(ctx: Calibration) {
  const moves: [string, string][] = [
    [ctx.history, installedFile(ctx, "triage-session-history.json")],
    [ctx.dataset, installedFile(ctx, "triage-effort-training.json")],
    [ctx.report, installedFile(ctx, "triage-effort-report.json")],
    [ctx.artifact, ctx.destination],
  ];
  for (const [source, target] of moves) if (fs.existsSync(source)) fs.renameSync(source, target);
}

async function repriceStep(ctx: Calibration) {
  // The model is already installed: a reprice failure is reported, never a failed calibration.
  try {
    await calibrationStep(ctx, "effort_reprice", ctx.steps.reprice, () => reconcile(config()));
  } catch (error) {
    console.error(`Effort calibration stage=reprice failed: ${errorText(error)}`);
  }
}

function finishCalibration(outcome: CalibrationOutcome, reasons: string[]) {
  writeCalibrationState(outcome, reasons);
  if (outcome !== "promoted") console.log(JSON.stringify({ status: outcome, reasons }));
}

async function promoteChallenger(ctx: Calibration, decision: PromotionDecision) {
  const model = checkChallenger(ctx);
  if (!ctx.steps.promote) {
    storeChallenger(ctx);
    calibrationEvent(ctx.runId, "effort_promote", "info", "disabled: challenger kept in shadow");
    finishCalibration("rejected", ["promotion disabled (shadow)"]);
    return;
  }
  installChallenger(ctx);
  const summary = {
    status: model.validation.status,
    samples: model.training.sampleCount,
    groups: model.training.groupCount,
  };
  calibrationEvent(ctx.runId, "effort_promote", "ok", undefined, summary);
  finishCalibration("promoted", decision.reasons);
  console.log(
    JSON.stringify({
      ...summary,
      heldout: model.validation.sampleCount,
      workError: model.validation.work,
      baselineWorkError: model.validation.baselineWork,
      coefficients: model.workload.coefficients,
    }),
  );
  await repriceStep(ctx);
}

async function runCalibration(ctx: Calibration) {
  await sessionsStep(ctx);
  await featuresStep(ctx);
  if (!(await fitStep(ctx))) return finishCalibration("rejected", ["fit disabled"]);
  const decision = gateDecision(ctx);
  if (!decision.promote) {
    storeChallenger(ctx);
    return finishCalibration("rejected", decision.reasons);
  }
  await promoteChallenger(ctx, decision);
}

function acquireCalibrationLock() {
  let lock: number;
  try {
    lock = fs.openSync(CALIBRATION_PID, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (calibrationRunning()) throw Error("Effort calibration is already running.");
    fs.rmSync(CALIBRATION_PID, { force: true });
    lock = fs.openSync(CALIBRATION_PID, "wx", 0o600);
  }
  fs.writeFileSync(lock, String(process.pid));
  fs.closeSync(lock);
}

function newCalibration(runId: string): Calibration {
  const destination = effortModelPath();
  const modelDir = path.dirname(destination);
  fs.mkdirSync(modelDir, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(RUN, "calibration-"));
  return {
    runId,
    steps: readEffortConfig().steps,
    modelDir,
    destination,
    temporary,
    history: path.join(temporary, "history.json"),
    dataset: path.join(temporary, "dataset.json"),
    artifact: path.join(temporary, "model.json"),
    report: path.join(temporary, "report.json"),
  };
}

async function calibrate(runId = new Date().toISOString()) {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  acquireCalibrationLock();
  const ctx = newCalibration(runId);
  try {
    await runCalibration(ctx);
  } catch (error) {
    writeCalibrationState("failed", [errorText(error)]);
    throw error;
  } finally {
    fs.rmSync(ctx.temporary, { recursive: true, force: true });
    try {
      if (Number(fs.readFileSync(CALIBRATION_PID, "utf8")) === process.pid)
        fs.rmSync(CALIBRATION_PID);
    } catch {}
  }
}

function calibrateCommand() {
  if (process.argv.includes("--background")) return startCalibration("manual: run now");
  const flag = process.argv.indexOf("--run");
  const given = flag > 0 ? process.argv[flag + 1] : undefined;
  const runId = given || new Date().toISOString();
  if (!given) calibrationEvent(runId, "effort_schedule", "info", "manual: command line");
  return calibrate(runId);
}

async function configureCommand() {
  const ownerMode = process.argv[3] === "--owner";
  const owner = ownerMode ? process.argv[4] : undefined;
  const url = process.argv[ownerMode ? 5 : 4];
  if (ownerMode && (!owner || !OWNER.test(owner))) throw Error("Invalid repository owner.");
  if (!url || new URL(url).protocol !== "https:")
    throw Error(
      "Usage: bin/github-triage configure owner/repo[,owner/repo]|--owner OWNER https://host/api/github/webhook",
    );
  let previous: Config | undefined;
  if (fs.existsSync(CONFIG)) previous = config();
  const repos = owner
    ? [...new Set([...(previous?.repos ?? []), ...(await ownedRepos(owner))])]
    : (process.argv[3] || "example-owner/agent-console").split(",");
  const next = {
    port: 7077,
    host: "0.0.0.0",
    ...previous,
    repos,
    secret: previous?.secret ?? crypto.randomBytes(32).toString("hex"),
    url,
    owner,
  };
  saveConfig(next);
  console.log("Webhook configuration saved. Signing secret remains private.");
}

/** Returns true when the worker had to be restarted. */
async function recoverReceiver(settings: Config): Promise<boolean> {
  try {
    await health(settings);
    return false;
  } catch {}
  start();
  // Poll in-process: the worker must not depend on host tools that CI runners lack.
  const deadline = Date.now() + 15_000;
  while (
    await health(settings).then(
      () => false,
      () => true,
    )
  ) {
    if (Date.now() > deadline) throw Error("Triage did not become healthy within 15 seconds.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

function usesDefaultCalibrationPaths(): boolean {
  return (
    CONFIG === path.join(os.homedir(), ".config/agent-console/github-triage.json") &&
    RUN === path.join(os.homedir(), ".cache/agent-console/github-triage") &&
    !process.env.AGENT_CONSOLE_TRIAGE_HISTORY &&
    !process.env.AGENT_CONSOLE_TRIAGE_EFFORT_MODEL
  );
}

function reconcileDue(restarted: boolean): boolean {
  let last = 0;
  try {
    last = Number(fs.readFileSync(LAST_RECONCILE, "utf8"));
  } catch {}
  return (
    restarted ||
    !Number.isFinite(last) ||
    last > Date.now() ||
    Date.now() - last >= RECONCILE_INTERVAL_MS
  );
}

async function watchdogCommand() {
  if (process.env.AGENT_CONSOLE_MOCK === "1" || !fs.existsSync(CONFIG)) return;
  let settings = config();
  const restarted = await recoverReceiver(settings);
  // Recover the receiver first. Slow offline training must never block supervision.
  if (usesDefaultCalibrationPaths()) maybeStartCalibration();
  if (!reconcileDue(restarted)) return;
  if (settings.owner) settings = await syncRepos(settings);
  await reconcile(settings);
}

function restartWorker() {
  return new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT, "start"],
      { env: childEnv(), timeout: 10_000 },
      (err, stdout) => {
        if (err) reject(Error("GitHub triage restart failed."));
        else {
          process.stdout.write(stdout);
          resolve();
        }
      },
    );
  });
}

async function stopCommand(command: string) {
  const workerPid = pid();
  if (workerPid) {
    process.kill(workerPid, "SIGTERM");
    if (!(await exited(workerPid, 180_000)))
      throw Error("Triage is still draining. Wait for its PID to exit before restarting.");
  }
  if (command === "restart") await restartWorker();
  else console.log(workerPid ? "GitHub triage stopped." : "GitHub triage is down.");
}

type TriageService = ReturnType<typeof import("../server/github-triage.ts").createTriageService>;

function serviceHandler(getService: () => TriageService | undefined): http.RequestListener {
  return (req, res) => {
    const service = getService();
    if (!service) {
      res.writeHead(503);
      res.end();
      return;
    }
    try {
      service.updateRepos(config().repos);
    } catch {
      res.writeHead(503);
      res.end();
      return;
    }
    service.handler(req, res);
  };
}

function installStopHandlers(server: http.Server, getService: () => TriageService | undefined) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void (getService()?.close() ?? Promise.resolve()).then(() => {
        if (pid() === process.pid) fs.rmSync(PID, { force: true });
      });
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function serveCommand(settings: Config) {
  const [{ createTriageService }, { createTelemetryService }] = await Promise.all([
    import("../server/github-triage.ts"),
    import("../server/token-telemetry.ts"),
  ]);
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  let service: TriageService | undefined;
  const getService = () => service;
  const telemetry = createTelemetryService({
    repos: () => config().repos,
    dataDir: process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console"),
    log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  });
  const server = http.createServer(serviceHandler(getService));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on("error", () => {
    console.error("GitHub triage listener failed.");
    process.exitCode = 1;
    void service?.close();
  });
  server.listen(settings.port, settings.host, () => {
    // Claim the port before opening the queue, so a duplicate start cannot recover another worker's active job.
    service = createTriageService({
      secret: settings.secret,
      repos: settings.repos,
      dbPath: path.join(path.dirname(CONFIG), "github-triage.sqlite"),
      deploy: settings.deploy
        ? {
            workflow: "CI",
            run: (repo) => {
              if (repo === settings.deploy) deploy();
            },
          }
        : undefined,
      // Items without agent threads get "No agent usage recorded." so the required CI check can pass honestly.
      onClosed: (item) => announceClosed(path.join(path.dirname(CONFIG), "github-events"), item),
      onItem: (item) => telemetry.ensureComment(item.repo, item.number),
      log: (metadata) => console.info(JSON.stringify(metadata)),
    });
    fs.writeFileSync(PID, String(process.pid), { mode: 0o600 });
    console.log(`GitHub triage listening on port ${settings.port}.`);
  });
  installStopHandlers(server, getService);
}

async function queueBackfillItem(settings: Config, repo: string, item: any) {
  const event = item.pull_request ? "pull_request" : "issues";
  const body = JSON.stringify({
    action: "opened",
    repository: { full_name: repo },
    [item.pull_request ? "pull_request" : "issue"]: { number: item.number, state: "open" },
    number: item.number,
  });
  const response = await fetch(`http://127.0.0.1:${settings.port}/api/github/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": await sign(settings.secret, body),
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw Error(`Backfill ${repo}#${item.number} failed: HTTP ${response.status}.`);
}

async function backfillRepo(settings: Config, repo: string): Promise<number> {
  let count = 0;
  for (let page = 1; ; page++) {
    const items = await github("GET", `repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    for (const item of items) {
      await queueBackfillItem(settings, repo, item);
      count++;
    }
    if (items.length < 100) return count;
  }
}

async function backfillCommand(settings: Config) {
  await health(settings);
  let count = 0;
  for (const repo of settings.repos) count += await backfillRepo(settings, repo);
  console.log(`Queued ${count} open issues and pull requests for model triage.`);
}

const USAGE =
  "Usage: bin/github-triage configure|start|stop|restart|status|watchdog|sync|register|backfill|reconcile|calibrate";

async function main() {
  const command = process.argv[2] || "status";
  const standalone: Record<string, () => unknown> = {
    calibrate: calibrateCommand,
    configure: configureCommand,
    start,
    watchdog: watchdogCommand,
    stop: () => stopCommand("stop"),
    restart: () => stopCommand("restart"),
  };
  if (standalone[command]) return void (await standalone[command]());
  const settings = config();
  const configured: Record<string, () => unknown> = {
    serve: () => serveCommand(settings),
    status: async () => console.log(JSON.stringify(await health(settings), null, 2)),
    reconcile: async () => {
      await health(settings);
      await reconcile(settings);
    },
    register: async () => {
      await health(settings);
      await registerHooks(settings, true);
    },
    sync: async () => {
      await health(settings);
      await syncRepos(settings);
    },
    backfill: () => backfillCommand(settings),
  };
  if (!configured[command]) throw Error(USAGE);
  await configured[command]();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "GitHub triage failed.");
  process.exitCode = 1;
});
