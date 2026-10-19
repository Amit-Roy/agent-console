import "../server/privacy.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { sign } from "@octokit/webhooks-methods";
import { childEnv } from "../server/providers/env.ts";
import { createTriageService } from "../server/github-triage.ts";
import { historyPath } from "../server/providers/triage-history.ts";
import { effortModelPath, loadEffortModel, quoteEffort } from "../server/providers/triage-effort.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const CONFIG = process.env.AGENT_CONSOLE_TRIAGE_CONFIG || path.join(os.homedir(), ".config/agent-console/github-triage.json");
const RUN = process.env.AGENT_CONSOLE_TRIAGE_RUN || path.join(os.homedir(), ".cache/agent-console/github-triage");
const PID = path.join(RUN, "pid");
const LAST_RECONCILE = path.join(RUN, "last-reconcile");
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const CALIBRATION_INTERVAL_MS = 24 * 60 * 60_000;
const CALIBRATION_RETRY_MS = 60 * 60_000;
const CALIBRATION_PID = path.join(RUN, "calibration-pid");
const CALIBRATION_ATTEMPT = path.join(RUN, "calibration-attempt");
type Config = { repos: string[]; secret: string; url: string; port: number; host: string };

function config(): Config {
  const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  if (!Array.isArray(c.repos) || !c.repos.length || !c.repos.every((r: unknown) => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r))) throw Error("Configure an explicit repository allowlist first.");
  if (typeof c.secret !== "string" || c.secret.length < 32) throw Error("Webhook secret must contain at least 32 characters.");
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw Error("Invalid webhook port.");
  if (!c.host || new URL(c.url).protocol !== "https:") throw Error("Configure an HTTPS webhook URL.");
  return c;
}

function pid(): number | undefined {
  try {
    const n = Number(fs.readFileSync(PID, "utf8"));
    if (!Number.isSafeInteger(n) || n <= 1) return;
    const args = fs.readFileSync(`/proc/${n}/cmdline`, "utf8").split("\0");
    return args.includes(SCRIPT) && args.includes("serve") ? n : undefined;
  } catch { return; }
}

function github(method: string, endpoint: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = ["api", "--method", method, endpoint];
    if (body !== undefined) args.push("--input", "-");
    const p = execFile("gh", args, { env: childEnv(), timeout: 30_000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(Error(`GitHub ${method} request failed.`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : undefined); } catch { reject(Error("GitHub returned invalid JSON.")); }
    });
    p.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function health(c: Config) {
  const r = await fetch(`http://127.0.0.1:${c.port}/health`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw Error(`Webhook health check failed: HTTP ${r.status}.`);
  return r.json();
}

function start() {
  if (process.env.AGENT_CONSOLE_MOCK === "1" || !fs.existsSync(CONFIG)) return;
  config();
  if (pid()) { console.log("GitHub triage already running."); return; }
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(RUN, "log"), "a", 0o600);
  try {
    const p = spawn(process.execPath, [SCRIPT, "serve"], { cwd: ROOT, env: childEnv(), detached: true, stdio: ["ignore", out, out] });
    p.unref();
  } finally { fs.closeSync(out); }
  console.log("GitHub triage starting.");
}

async function reconcile(c: Config) {
  let scanned = 0;
  let queued = 0;
  for (const repo of c.repos) {
    const body = JSON.stringify({ repository: { full_name: repo } });
    const response = await fetch(`http://127.0.0.1:${c.port}/reconcile`, { method: "POST", headers: {
      "Content-Type": "application/json", "X-Hub-Signature-256": await sign(c.secret, body),
    }, body, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw Error(`Reconciliation failed: HTTP ${response.status}.`);
    const result = await response.json() as { scanned: number; queued: number };
    if (!Number.isSafeInteger(result.scanned) || !Number.isSafeInteger(result.queued)) throw Error("Invalid reconciliation response.");
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
    if (!Number.isSafeInteger(calibrationPid) || calibrationPid <= 1) return Date.now() - fs.statSync(CALIBRATION_PID).mtimeMs < 120_000;
    const args = fs.readFileSync(`/proc/${calibrationPid}/cmdline`, "utf8").split("\0");
    return args.includes(SCRIPT) && args.includes("calibrate");
  } catch { return false; }
}

function startCalibration() {
  if (calibrationRunning()) return;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CALIBRATION_ATTEMPT, String(Date.now()), { mode: 0o600 });
  const log = fs.openSync(path.join(RUN, "calibration.log"), "a", 0o600);
  try { spawn(process.execPath, [SCRIPT, "calibrate"], { cwd: ROOT, env: childEnv(), detached: true, stdio: ["ignore", log, log] }).unref(); }
  finally { fs.closeSync(log); }
  console.log("Effort calibration started in the background.");
}

async function calibrate() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  let lock: number;
  try { lock = fs.openSync(CALIBRATION_PID, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (calibrationRunning()) throw Error("Effort calibration is already running.");
    fs.rmSync(CALIBRATION_PID, { force: true });
    lock = fs.openSync(CALIBRATION_PID, "wx", 0o600);
  }
  fs.writeFileSync(lock, String(process.pid)); fs.closeSync(lock);
  const temporary = fs.mkdtempSync(path.join(RUN, "calibration-"));
  const history = path.join(temporary, "history.json");
  const dataset = path.join(temporary, "dataset.json");
  const artifact = path.join(temporary, "model.json");
  const report = path.join(temporary, "report.json");
  const run = (command: string, args: string[], timeout: number) => new Promise<void>((resolve, reject) => {
    execFile(command, args, { env: childEnv(), timeout, maxBuffer: 1_000_000 }, error => error
      ? reject(Error("Effort calibration failed; the previous model was retained. See the private calibration log and setup instructions.")) : resolve());
  });
  try {
    const destination = effortModelPath();
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const features = path.join(path.dirname(destination), "triage-effort-features.json");
    await run(process.execPath, [path.join(ROOT, "scripts/triage-history-build.ts"), "--repo-dir", ROOT,
      "--data", process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config/agent-console"), "--output", history], 120_000);
    await run(process.execPath, [path.join(ROOT, "scripts/triage-effort-features.ts"), "--history", history,
      "--output", features, "--dataset", dataset], 30 * 60_000);
    const python = process.env.AGENT_CONSOLE_TRIAGE_PYTHON || path.join(os.homedir(), ".local/share/agent-console/triage-venv/bin/python");
    await run(python, [path.join(ROOT, "scripts/triage-effort-fit.py"), "--dataset", dataset,
      "--output", artifact, "--report", report], 120_000);
    const model = loadEffortModel(artifact);
    const quote = quoteEffort({ breadth: { value: null }, complexity: { value: null }, uncertainty: { value: null }, risk: { value: null } }, model);
    if (model.status !== "ready" || quote.status !== "ready") throw Error("The learned effort model failed validation; previous calibration retained.");
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true, mode: 0o700 });
    fs.renameSync(history, historyPath());
    fs.renameSync(dataset, path.join(path.dirname(destination), "triage-effort-training.json"));
    fs.renameSync(report, path.join(path.dirname(destination), "triage-effort-report.json"));
    fs.renameSync(artifact, destination);
    console.log(JSON.stringify({ status: model.model.validation.status, samples: model.model.training.sampleCount,
      groups: model.model.training.groupCount, heldout: model.model.validation.sampleCount,
      workError: model.model.validation.work, baselineWorkError: model.model.validation.baselineWork,
      coefficients: model.model.workload.coefficients }));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    try { if (Number(fs.readFileSync(CALIBRATION_PID, "utf8")) === process.pid) fs.rmSync(CALIBRATION_PID); } catch {}
  }
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "calibrate") { if (process.argv.includes("--background")) startCalibration(); else await calibrate(); return; }
  if (command === "configure") {
    const repos = (process.argv[3] || "Amit-Roy/agent-console").split(",");
    const url = process.argv[4];
    if (!url || new URL(url).protocol !== "https:") throw Error("Usage: bin/github-triage configure owner/repo[,owner/repo] https://host/api/github/webhook");
    let secret = crypto.randomBytes(32).toString("hex");
    try { secret = config().secret; } catch { /* First setup generates a private signing secret. */ }
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG, JSON.stringify({ repos, secret, url, port: 7077, host: "0.0.0.0" }, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(CONFIG, 0o600);
    config();
    console.log("Webhook configuration saved. Signing secret remains private.");
    return;
  }
  if (command === "start") {
    start();
    return;
  }
  if (command === "watchdog") {
    if (process.env.AGENT_CONSOLE_MOCK === "1" || !fs.existsSync(CONFIG)) return;
    const c = config();
    let restarted = false;
    try { await health(c); }
    catch {
      start();
      await new Promise<void>((resolve, reject) => {
        execFile("waitfor", ["-t", "15", "url", `http://127.0.0.1:${c.port}/health`], { env: childEnv(), timeout: 20_000 }, err => {
          if (err) reject(Error("Triage did not become healthy within 15 seconds.")); else resolve();
        });
      });
      await health(c);
      restarted = true;
    }
    // Recover the receiver first. Slow offline training must never block supervision.
    if (CONFIG === path.join(os.homedir(), ".config/agent-console/github-triage.json")
      && RUN === path.join(os.homedir(), ".cache/agent-console/github-triage")
      && !process.env.AGENT_CONSOLE_TRIAGE_HISTORY && !process.env.AGENT_CONSOLE_TRIAGE_EFFORT_MODEL) {
      let updated = 0, attempted = 0;
      try { updated = fs.statSync(effortModelPath()).mtimeMs; } catch {}
      try { attempted = Number(fs.readFileSync(CALIBRATION_ATTEMPT, "utf8")); } catch {}
      if ((updated > Date.now() || Date.now() - updated >= CALIBRATION_INTERVAL_MS)
        && (!Number.isFinite(attempted) || attempted > Date.now() || Date.now() - attempted >= CALIBRATION_RETRY_MS)) startCalibration();
    }
    let last = 0;
    try { last = Number(fs.readFileSync(LAST_RECONCILE, "utf8")); } catch {}
    if (restarted || !Number.isFinite(last) || last > Date.now() || Date.now() - last >= RECONCILE_INTERVAL_MS) await reconcile(c);
    return;
  }
  if (command === "stop" || command === "restart") {
    const n = pid();
    if (n) {
      process.kill(n, "SIGTERM");
      await new Promise<void>((resolve, reject) => {
        execFile("waitfor", ["-t", "180", "pid", String(n)], { timeout: 185_000 }, err => {
          if (err) reject(Error("Triage is still draining. Wait for its PID to exit before restarting."));
          else resolve();
        });
      });
    }
    if (command === "restart") {
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [SCRIPT, "start"], { env: childEnv(), timeout: 10_000 }, (err, stdout) => {
          if (err) reject(Error("GitHub triage restart failed."));
          else { process.stdout.write(stdout); resolve(); }
        });
      });
    } else console.log(n ? "GitHub triage stopped." : "GitHub triage is down.");
    return;
  }
  const c = config();
  if (command === "serve") {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    let service: ReturnType<typeof createTriageService> | undefined;
    const server = http.createServer((req, res) => {
      if (service) service.handler(req, res);
      else { res.writeHead(503); res.end(); }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.on("error", () => { console.error("GitHub triage listener failed."); process.exitCode = 1; void service?.close(); });
    server.listen(c.port, c.host, () => {
      // Claim the port before opening the queue, so a duplicate start cannot recover another worker's active job.
      service = createTriageService({ secret: c.secret, repos: c.repos, dbPath: path.join(path.dirname(CONFIG), "github-triage.sqlite"),
        log: metadata => console.info(JSON.stringify(metadata)) });
      fs.writeFileSync(PID, String(process.pid), { mode: 0o600 });
      console.log(`GitHub triage listening on port ${c.port}.`);
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => { void (service?.close() ?? Promise.resolve()).then(() => {
        if (pid() === process.pid) fs.rmSync(PID, { force: true });
      }); });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await health(c), null, 2));
    return;
  }
  if (command === "reconcile") {
    await health(c);
    await reconcile(c);
    return;
  }
  if (command === "register") {
    await health(c);
    for (const repo of c.repos) {
      const hooks = await github("GET", `repos/${repo}/hooks?per_page=100`);
      const existing = hooks.find((h: any) => h.config?.url === c.url);
      const body = { name: "web", active: true, events: ["issues", "pull_request"], config: { url: c.url, content_type: "json", insecure_ssl: "0", secret: c.secret } };
      const hook = await github(existing ? "PATCH" : "POST", `repos/${repo}/hooks${existing ? `/${existing.id}` : ""}`, body);
      console.log(`Registered ${repo} webhook ${hook.id}.`);
    }
    return;
  }
  if (command === "backfill") {
    await health(c);
    let count = 0;
    for (const repo of c.repos) {
      for (let page = 1; ; page++) {
        const items = await github("GET", `repos/${repo}/issues?state=open&per_page=100&page=${page}`);
        for (const item of items) {
          const event = item.pull_request ? "pull_request" : "issues";
          const body = JSON.stringify({ action: "opened", repository: { full_name: repo }, [item.pull_request ? "pull_request" : "issue"]: { number: item.number, state: "open" }, number: item.number });
          const r = await fetch(`http://127.0.0.1:${c.port}/api/github/webhook`, { method: "POST", headers: {
            "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": crypto.randomUUID(), "X-Hub-Signature-256": await sign(c.secret, body),
          }, body, signal: AbortSignal.timeout(8000) });
          if (!r.ok) throw Error(`Backfill ${repo}#${item.number} failed: HTTP ${r.status}.`);
          count++;
        }
        if (items.length < 100) break;
      }
    }
    console.log(`Queued ${count} open issues and pull requests for model triage.`);
    return;
  }
  throw Error("Usage: bin/github-triage configure|start|stop|restart|status|watchdog|register|backfill|reconcile|calibrate");
}

main().catch(err => { console.error(err instanceof Error ? err.message : "GitHub triage failed."); process.exitCode = 1; });
