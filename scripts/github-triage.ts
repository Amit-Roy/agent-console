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
const CALIBRATION_INTERVAL_MS = 24 * 60 * 60_000;
const CALIBRATION_RETRY_MS = 60 * 60_000;
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

function startCalibration() {
  if (calibrationRunning()) return;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CALIBRATION_ATTEMPT, String(Date.now()), { mode: 0o600 });
  const log = fs.openSync(path.join(RUN, "calibration.log"), "a", 0o600);
  try {
    spawn(process.execPath, [SCRIPT, "calibrate"], {
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

async function calibrate() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
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
  const temporary = fs.mkdtempSync(path.join(RUN, "calibration-"));
  const history = path.join(temporary, "history.json");
  const dataset = path.join(temporary, "dataset.json");
  const artifact = path.join(temporary, "model.json");
  const report = path.join(temporary, "report.json");
  const run = (command: string, args: string[], timeout: number) =>
    new Promise<void>((resolve, reject) => {
      execFile(command, args, { env: childEnv(), timeout, maxBuffer: 1_000_000 }, (error) =>
        error
          ? reject(
              Error(
                "Effort calibration failed; the previous model was retained. See the private calibration log and setup instructions.",
              ),
            )
          : resolve(),
      );
    });
  try {
    const destination = effortModelPath();
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const features = path.join(path.dirname(destination), "triage-effort-features.json");
    await run(
      process.execPath,
      [
        path.join(ROOT, "scripts/triage-session-build.ts"),
        "--data",
        process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config/agent-console"),
        "--output",
        history,
      ],
      120_000,
    );
    await run(
      process.execPath,
      [
        path.join(ROOT, "scripts/triage-effort-features.ts"),
        "--history",
        history,
        "--output",
        features,
        "--dataset",
        dataset,
      ],
      30 * 60_000,
    );
    const python =
      process.env.AGENT_CONSOLE_TRIAGE_PYTHON ||
      path.join(os.homedir(), ".local/share/agent-console/triage-venv/bin/python");
    await run(
      python,
      [
        path.join(ROOT, "scripts/triage-effort-fit.py"),
        "--dataset",
        dataset,
        "--output",
        artifact,
        "--report",
        report,
      ],
      120_000,
    );
    const model = loadEffortModel(artifact);
    const quote = quoteEffort(
      {
        breadth: { value: null },
        complexity: { value: null },
        uncertainty: { value: null },
        risk: { value: null },
        ...requestShape(""),
      },
      model,
    );
    if (model.status !== "ready" || quote.status !== "ready")
      throw Error("The learned effort model failed validation; previous calibration retained.");
    fs.renameSync(history, path.join(path.dirname(destination), "triage-session-history.json"));
    fs.renameSync(dataset, path.join(path.dirname(destination), "triage-effort-training.json"));
    fs.renameSync(report, path.join(path.dirname(destination), "triage-effort-report.json"));
    fs.renameSync(artifact, destination);
    console.log(
      JSON.stringify({
        status: model.model.validation.status,
        samples: model.model.training.sampleCount,
        groups: model.model.training.groupCount,
        heldout: model.model.validation.sampleCount,
        workError: model.model.validation.work,
        baselineWorkError: model.model.validation.baselineWork,
        coefficients: model.model.workload.coefficients,
      }),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    try {
      if (Number(fs.readFileSync(CALIBRATION_PID, "utf8")) === process.pid)
        fs.rmSync(CALIBRATION_PID);
    } catch {}
  }
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "calibrate") {
    if (process.argv.includes("--background")) startCalibration();
    else await calibrate();
    return;
  }
  if (command === "configure") {
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
      : (process.argv[3] || "Amit-Roy/agent-console").split(",");
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
    return;
  }
  if (command === "start") {
    start();
    return;
  }
  if (command === "watchdog") {
    if (process.env.AGENT_CONSOLE_MOCK === "1" || !fs.existsSync(CONFIG)) return;
    let c = config();
    let restarted = false;
    try {
      await health(c);
    } catch {
      start();
      // Poll in-process: the worker must not depend on host tools that CI runners lack.
      const deadline = Date.now() + 15_000;
      while (
        await health(c).then(
          () => false,
          () => true,
        )
      ) {
        if (Date.now() > deadline) throw Error("Triage did not become healthy within 15 seconds.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      restarted = true;
    }
    // Recover the receiver first. Slow offline training must never block supervision.
    if (
      CONFIG === path.join(os.homedir(), ".config/agent-console/github-triage.json") &&
      RUN === path.join(os.homedir(), ".cache/agent-console/github-triage") &&
      !process.env.AGENT_CONSOLE_TRIAGE_HISTORY &&
      !process.env.AGENT_CONSOLE_TRIAGE_EFFORT_MODEL
    ) {
      let updated = 0,
        attempted = 0;
      try {
        updated = fs.statSync(effortModelPath()).mtimeMs;
      } catch {}
      try {
        attempted = Number(fs.readFileSync(CALIBRATION_ATTEMPT, "utf8"));
      } catch {}
      if (
        (updated > Date.now() || Date.now() - updated >= CALIBRATION_INTERVAL_MS) &&
        (!Number.isFinite(attempted) ||
          attempted > Date.now() ||
          Date.now() - attempted >= CALIBRATION_RETRY_MS)
      )
        startCalibration();
    }
    let last = 0;
    try {
      last = Number(fs.readFileSync(LAST_RECONCILE, "utf8"));
    } catch {}
    if (
      restarted ||
      !Number.isFinite(last) ||
      last > Date.now() ||
      Date.now() - last >= RECONCILE_INTERVAL_MS
    ) {
      if (c.owner) c = await syncRepos(c);
      await reconcile(c);
    }
    return;
  }
  if (command === "stop" || command === "restart") {
    const n = pid();
    if (n) {
      process.kill(n, "SIGTERM");
      if (!(await exited(n, 180_000)))
        throw Error("Triage is still draining. Wait for its PID to exit before restarting.");
    }
    if (command === "restart") {
      await new Promise<void>((resolve, reject) => {
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
    } else console.log(n ? "GitHub triage stopped." : "GitHub triage is down.");
    return;
  }
  const c = config();
  if (command === "serve") {
    const [{ createTriageService }, { createTelemetryService }] = await Promise.all([
      import("../server/github-triage.ts"),
      import("../server/token-telemetry.ts"),
    ]);
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    let service: ReturnType<typeof createTriageService> | undefined;
    const telemetry = createTelemetryService({
      repos: () => config().repos,
      dataDir:
        process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console"),
      log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
    });
    const server = http.createServer((req, res) => {
      if (service) {
        try {
          service.updateRepos(config().repos);
        } catch {
          res.writeHead(503);
          res.end();
          return;
        }
        service.handler(req, res);
      } else {
        res.writeHead(503);
        res.end();
      }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.on("error", () => {
      console.error("GitHub triage listener failed.");
      process.exitCode = 1;
      void service?.close();
    });
    server.listen(c.port, c.host, () => {
      // Claim the port before opening the queue, so a duplicate start cannot recover another worker's active job.
      service = createTriageService({
        secret: c.secret,
        repos: c.repos,
        dbPath: path.join(path.dirname(CONFIG), "github-triage.sqlite"),
        deploy: c.deploy
          ? {
              workflow: "CI",
              run: (repo) => {
                if (repo === c.deploy) deploy();
              },
            }
          : undefined,
        // Items without agent threads get "No agent usage recorded." so the required CI check can pass honestly.
        onClosed: (item) => announceClosed(path.join(path.dirname(CONFIG), "github-events"), item),
        onItem: (item) => telemetry.ensureComment(item.repo, item.number),
        log: (metadata) => console.info(JSON.stringify(metadata)),
      });
      fs.writeFileSync(PID, String(process.pid), { mode: 0o600 });
      console.log(`GitHub triage listening on port ${c.port}.`);
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        void (service?.close() ?? Promise.resolve()).then(() => {
          if (pid() === process.pid) fs.rmSync(PID, { force: true });
        });
      });
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
    await registerHooks(c, true);
    return;
  }
  if (command === "sync") {
    await health(c);
    await syncRepos(c);
    return;
  }
  if (command === "backfill") {
    await health(c);
    let count = 0;
    for (const repo of c.repos) {
      for (let page = 1; ; page++) {
        const items = await github(
          "GET",
          `repos/${repo}/issues?state=open&per_page=100&page=${page}`,
        );
        for (const item of items) {
          const event = item.pull_request ? "pull_request" : "issues";
          const body = JSON.stringify({
            action: "opened",
            repository: { full_name: repo },
            [item.pull_request ? "pull_request" : "issue"]: { number: item.number, state: "open" },
            number: item.number,
          });
          const r = await fetch(`http://127.0.0.1:${c.port}/api/github/webhook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-GitHub-Event": event,
              "X-GitHub-Delivery": crypto.randomUUID(),
              "X-Hub-Signature-256": await sign(c.secret, body),
            },
            body,
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw Error(`Backfill ${repo}#${item.number} failed: HTTP ${r.status}.`);
          count++;
        }
        if (items.length < 100) break;
      }
    }
    console.log(`Queued ${count} open issues and pull requests for model triage.`);
    return;
  }
  throw Error(
    "Usage: bin/github-triage configure|start|stop|restart|status|watchdog|sync|register|backfill|reconcile|calibrate",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "GitHub triage failed.");
  process.exitCode = 1;
});
