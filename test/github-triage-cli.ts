import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-triage-cli-"));
const runtime = path.join(scratch, "run");
const configuration = path.join(scratch, "configuration.json");
const fixtureBin = path.join(scratch, "bin");
fs.mkdirSync(fixtureBin);
const githubState = path.join(scratch, "github.json");
fs.writeFileSync(githubState, JSON.stringify({ calls: [], hooks: {}, pages: [[]], failPage: 0 }));
// Each GitHub API request launches this fixture, so use a minimal Python process.
fs.writeFileSync(
  path.join(fixtureBin, "gh"),
  `#!/usr/bin/env -S python3 -S
import json
import os
import re
import sys

state_path = os.environ["TRIAGE_TEST_GITHUB"]
with open(state_path) as source:
    state = json.load(source)
args = sys.argv[1:]
method = args[args.index("--method") + 1]
endpoint = next((arg for arg in args if re.match(r"^(?:user|repos/)", arg)), "")
state["calls"].append({"method": method, "endpoint": endpoint})
def save():
    with open(state_path, "w") as target:
        json.dump(state, target)
result = []
if endpoint == "user":
    result = {"login": "fixture"}
elif endpoint.startswith("user/repos?"):
    page = int(re.search(r"(?:[?&])page=(\\d+)", endpoint).group(1))
    if page == state["failPage"]:
        save()
        sys.exit(1)
    result = state["pages"][page - 1] if page <= len(state["pages"]) else []
elif re.search(r"/hooks(?:\\?|/\\d+|$)", endpoint):
    repo = "/".join(endpoint.split("/")[1:3])
    hooks = state["hooks"].setdefault(repo, [])
    if method == "GET":
        result = hooks
    else:
        body = json.load(sys.stdin)
        hook_id = int(endpoint.split("/")[-1]) if method == "PATCH" else 100 + len(hooks)
        result = {**body, "id": hook_id}
        existing = next((i for i, hook in enumerate(hooks) if hook["id"] == hook_id), None)
        if existing is None:
            hooks.append(result)
        else:
            hooks[existing] = result
save()
json.dump(result, sys.stdout)
`,
  { mode: 0o700 },
);
const server = http.createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
await new Promise<void>((resolve) => server.close(() => resolve()));
fs.writeFileSync(
  configuration,
  JSON.stringify({
    repos: ["fixture/repository"],
    secret: "test-only-scratch-webhook-secret-1234567890",
    url: "https://example.invalid/api/github/webhook",
    port,
    host: "127.0.0.1",
  }),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  PATH: `${fixtureBin}:${process.env.PATH}`,
  TRIAGE_TEST_GITHUB: githubState,
  AGENT_CONSOLE_ENV_FILES: "/dev/null",
  AGENT_CONSOLE_TRIAGE_CONFIG: configuration,
  AGENT_CONSOLE_TRIAGE_RUN: runtime,
  // Reuse the runner cache across CLI processes, with a scratch cache for direct runs.
  NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || path.join(scratch, "compile-cache"),
};
delete env.AGENT_CONSOLE_MOCK;
const cli = (...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(root, "scripts/github-triage.ts"), ...args],
      { cwd: root, env, timeout: 25_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
const workerPid = () => Number(fs.readFileSync(path.join(runtime, "pid"), "utf8"));
const readGithub = () => JSON.parse(fs.readFileSync(githubState, "utf8"));
const readConfig = () => JSON.parse(fs.readFileSync(configuration, "utf8"));
const saveGithub = (state: any) => fs.writeFileSync(githubState, JSON.stringify(state));
// --- Weekly effort calibration fixtures ---
const quantileStats = (p80: number, p95: number, champion: boolean) => ({
  status: "validated",
  sampleCount: 100,
  quantiles: Object.fromEntries(
    [
      ["p50", 0.5],
      ["p75", 0.75],
      ["p80", p80],
      ["p95", p95],
      ["p99", 0.99],
    ].map(([key, coverage]) => [key, { pinball: 1, coverage }]),
  ),
  beatsPinballBaseline: true,
  meanPinball: 1,
  ...(champion
    ? { champion: { scoreable: true, reason: null, sampleCount: 40, meanPinball: 1 } }
    : {}),
});
const treeLeaf = (value: number) => ({ f: [0], t: [0], l: [-1], r: [-1], v: [value] });
const fixtureArtifact = (p80 = 0.82, champion = true) => ({
  schemaVersion: 1,
  method: "nonnegative-ridge-log-work-v1",
  scope: "completed-session",
  workloadMetric: "totalTokens",
  tokenYieldBasis: "workload",
  featureNames: ["breadth", "complexity", "uncertainty", "risk"],
  workload: {
    intercept: Math.log1p(1000),
    coefficients: [0, 0, 0, 0],
    missingCoefficients: [0, 0, 0, 0],
    imputation: [1, 1, 2, 1],
    scale: [1, 1, 1, 1],
    featureRanges: [0, 1, 2, 3].map(() => ({ min: 0, max: 3, known: 5, missing: 0 })),
    residualQuantiles: { p50: 0, p80: 0.2, p95: 0.4 },
  },
  scenarios: [-0.4, -0.2, 0, 0.2, 0.4].map((_, index) => ({
    sampleId: `sample-${index}`,
    logResidual: 0,
    inputPerWork: 0.8,
    outputPerWork: 0.2,
    freshInputPerWork: null,
    cachedInputPerWork: null,
    roundsPerWork: null,
  })),
  workCutoffs: { trivialMax: 4, deepMin: 12 },
  validation: {
    status: "experimental",
    modelMae: 3,
    baselineMae: 4,
    quantileModel: quantileStats(p80, 0.95, champion),
  },
  training: {
    sampleIds: Array.from({ length: 5 }, (_, index) => `sample-${index}`),
    sampleCount: 5,
    groupCount: 5,
  },
  quantileModel: {
    features: ["size", "lines", "refs", "verbs"],
    quantiles: { p50: 0.5, p75: 0.75, p80: 0.8, p95: 0.95, p99: 0.99 },
    baseline: { p50: 1, p75: 2, p80: 2.5, p95: 4, p99: 5 },
    trees: {
      p50: [treeLeaf(1)],
      p75: [treeLeaf(1)],
      p80: [treeLeaf(1)],
      p95: [treeLeaf(1)],
      p99: [treeLeaf(1)],
    },
    offsets: { p50: 0, p75: 0, p80: 0, p95: 0, p99: 0 },
    ceiling: 1_000_000,
  },
});
// Fake fit: records its arguments and dataset, then emits the fixture artifact (or fails on request).
const fakeFit = path.join(fixtureBin, "fake-fit");
fs.writeFileSync(
  fakeFit,
  `#!/bin/sh
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --dataset) dataset="$2" ;;
    --output) output="$2" ;;
    --report) report="$2" ;;
    --champion) champion="$2" ;;
  esac
  shift
done
echo "champion=$champion" > "$FAKE_FIT_LOG"
cat "$dataset" >> "$FAKE_FIT_LOG"
if [ -n "$FAKE_FIT_EXIT" ]; then
  echo "boom-detail from fit" >&2
  exit "$FAKE_FIT_EXIT"
fi
cp "$FAKE_FIT_ARTIFACT" "$output"
echo '{"report":true}' > "$report"
chmod 600 "$output" "$report"
`,
  { mode: 0o700 },
);
type CalibrationCase = {
  name: string;
  artifact?: object;
  exit?: string;
  steps?: Record<string, boolean>;
  preseed?: boolean;
  dataset?: string;
};
type CalibrationResult = {
  failed: boolean;
  stdout: string;
  stderr: string;
  model: string;
  run: string;
  log: string;
};
type EventRow = { ts: number; run: string; step: string; kind: string; msg?: string };
const eventsOf = (model: string): EventRow[] => {
  try {
    return fs
      .readFileSync(path.join(path.dirname(model), "triage-calibration-events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const calibrationRun = (spec: CalibrationCase) =>
  new Promise<CalibrationResult>((resolve) => {
    const base = path.join(scratch, `calibration-${spec.name}`);
    const model = path.join(base, "model", "triage-effort-model.json");
    const data = path.join(base, "data");
    const run = path.join(base, "run");
    const log = path.join(base, "fit.log");
    fs.mkdirSync(path.dirname(model), { recursive: true, mode: 0o700 });
    fs.mkdirSync(data, { recursive: true });
    const steps = { reprice: false, ...spec.steps };
    fs.writeFileSync(
      path.join(data, "effort-model.json"),
      JSON.stringify({ enabled: true, steps: { ...steps } }),
    );
    const artifactFile = path.join(base, "artifact.json");
    fs.writeFileSync(artifactFile, JSON.stringify(spec.artifact ?? fixtureArtifact()));
    if (spec.preseed) fs.writeFileSync(model, "old-model", { mode: 0o600 });
    if (spec.dataset !== undefined)
      fs.writeFileSync(path.join(path.dirname(model), "triage-effort-training.json"), spec.dataset);
    execFile(
      process.execPath,
      [path.join(root, "scripts/github-triage.ts"), "calibrate"],
      {
        cwd: root,
        env: {
          ...env,
          AGENT_CONSOLE_DATA: data,
          AGENT_CONSOLE_TRIAGE_RUN: run,
          AGENT_CONSOLE_TRIAGE_EFFORT_MODEL: model,
          AGENT_CONSOLE_TRIAGE_PYTHON: fakeFit,
          FAKE_FIT_ARTIFACT: artifactFile,
          FAKE_FIT_LOG: log,
          ...(spec.exit ? { FAKE_FIT_EXIT: spec.exit } : {}),
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => resolve({ failed: !!error, stdout, stderr, model, run, log }),
    );
  });
const stateOf = (run: string) =>
  JSON.parse(fs.readFileSync(path.join(run, "calibration-state.json"), "utf8"));
const stepKinds = (events: EventRow[], step: string) =>
  events.filter((event) => event.step === step).map((event) => event.kind);

try {
  const retained = path.join(scratch, "history.json");
  fs.writeFileSync(retained, "Existing private calibration must survive a failed refresh.", {
    mode: 0o600,
  });
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [path.join(root, "scripts/github-triage.ts"), "calibrate"],
        {
          cwd: root,
          env: {
            ...env,
            AGENT_CONSOLE_DATA: path.join(scratch, "missing-source"),
            AGENT_CONSOLE_TRIAGE_HISTORY: retained,
            AGENT_CONSOLE_TRIAGE_EFFORT_MODEL: path.join(scratch, "retained-model", "model.json"),
            // Deterministic failing fit step: never boots a developer machine's real training venv (several seconds).
            AGENT_CONSOLE_TRIAGE_PYTHON: "/bin/false",
          },
          timeout: 25_000,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    }),
  );
  assert.equal(
    fs.readFileSync(retained, "utf8"),
    "Existing private calibration must survive a failed refresh.",
  );
  assert.match(await cli("watchdog"), /Reconciled 0 open items; queued 0 repairs/);
  const originalPid = workerPid();
  assert.equal(JSON.parse(await cli("status")).ok, true);
  const firstScan = fs.readFileSync(path.join(runtime, "last-reconcile"), "utf8");
  await cli("watchdog");
  assert.equal(workerPid(), originalPid, "Healthy watchdog must not restart the worker");
  assert.equal(
    fs.readFileSync(path.join(runtime, "last-reconcile"), "utf8"),
    firstScan,
    "Healthy watchdog must respect the reconciliation interval",
  );
  process.kill(originalPid, "SIGKILL");
  for (
    const deadline = Date.now() + 5_000;
    ;
    await new Promise((resolve) => setTimeout(resolve, 20))
  ) {
    try {
      process.kill(originalPid, 0);
    } catch {
      break;
    }
    assert.ok(Date.now() < deadline, "Killed worker must exit");
  }
  assert.match(await cli("watchdog"), /Reconciled 0 open items; queued 0 repairs/);
  assert.notEqual(workerPid(), originalPid, "Watchdog must replace a crashed worker");
  assert.equal(JSON.parse(await cli("status")).ok, true);
  fs.writeFileSync(path.join(runtime, "last-reconcile"), "1");
  assert.match(await cli("watchdog"), /Reconciled 0 open items; queued 0 repairs/);
  assert.match(await cli("reconcile"), /Reconciled 0 open items; queued 0 repairs/);
  assert.equal(
    readGithub().calls.some((call: any) => call.endpoint?.startsWith("user/repos?")),
    false,
    "Explicit repository mode must not discover owned repositories",
  );

  const initial = { ...readConfig(), deploy: "fixture/repository" };
  fs.writeFileSync(configuration, JSON.stringify(initial), { mode: 0o600 });
  await assert.rejects(cli("configure", "--owner", "invalid/owner", initial.url));
  assert.deepEqual(
    readConfig(),
    initial,
    "Invalid owner configuration must not replace the existing configuration",
  );
  await assert.rejects(cli("configure", "--owner", "someone-else", initial.url));
  assert.deepEqual(
    readConfig(),
    initial,
    "A different authenticated owner must not replace the existing configuration",
  );
  const owned = (name: string, extra: any = {}) => ({
    full_name: `fixture/${name}`,
    owner: { login: "fixture" },
    permissions: { admin: true },
    has_issues: true,
    archived: false,
    disabled: false,
    ...extra,
  });
  const state = readGithub();
  state.pages = [
    [
      owned("private", { private: true }),
      owned("fork", { fork: true }),
      owned("archived", { archived: true }),
      owned("disabled", { disabled: true }),
      owned("no-issues", { has_issues: false }),
      owned("no-admin", { permissions: { admin: false } }),
      owned("collaborator", { full_name: "someone/other", owner: { login: "someone" } }),
      ...Array.from({ length: 93 }, (_, n) => owned(`ignored-${n}`, { archived: true })),
    ],
    [owned("second-page")],
  ];
  state.hooks["fixture/repository"] = [{ id: 7, config: { url: initial.url }, events: ["push"] }];
  saveGithub(state);
  state.failPage = 2;
  saveGithub(state);
  await assert.rejects(cli("configure", "--owner", "fixture", initial.url));
  assert.deepEqual(
    readConfig(),
    initial,
    "Failed owner discovery must preserve existing configuration",
  );
  state.failPage = 0;
  saveGithub(state);
  await cli("configure", "--owner", "fixture", initial.url);
  const ownerConfig = readConfig();
  assert.equal(ownerConfig.owner, "fixture");
  for (const key of ["secret", "deploy", "port", "host", "url"]) {
    assert.deepEqual(ownerConfig[key], initial[key], `Owner configuration must preserve ${key}`);
  }
  assert.deepEqual([...ownerConfig.repos].sort(), [
    "fixture/fork",
    "fixture/private",
    "fixture/repository",
    "fixture/second-page",
  ]);
  assert.equal(fs.statSync(configuration).mode & 0o777, 0o600);
  await cli("sync");
  assert.deepEqual([...readConfig().repos].sort(), [
    "fixture/fork",
    "fixture/private",
    "fixture/repository",
    "fixture/second-page",
  ]);
  assert.equal(readConfig().secret, initial.secret);
  assert.equal(readConfig().deploy, initial.deploy);
  const synced = readGithub();
  assert.ok(
    synced.calls.some(
      (call: any) => call.endpoint === "user/repos?affiliation=owner&per_page=100&page=2",
    ),
    "Discovery must fetch repositories after the first full page",
  );
  assert.deepEqual([...synced.hooks["fixture/repository"][0].events].sort(), [
    "issues",
    "pull_request",
    "push",
    "workflow_run",
  ]);
  for (const repo of ["fixture/fork", "fixture/private", "fixture/second-page"]) {
    assert.deepEqual([...synced.hooks[repo][0].events].sort(), ["issues", "pull_request"]);
  }
  const postCount = synced.calls.filter((call: any) => call.method === "POST").length;
  const savedConfiguration = fs.readFileSync(configuration, "utf8");
  const savedMtime = fs.statSync(configuration).mtimeMs;
  await cli("sync");
  assert.equal(
    readGithub().calls.filter((call: any) => call.method === "POST").length,
    postCount,
    "Repeated sync must not create duplicate webhooks",
  );
  assert.equal(fs.readFileSync(configuration, "utf8"), savedConfiguration);
  assert.equal(
    fs.statSync(configuration).mtimeMs,
    savedMtime,
    "An unchanged sync must not rewrite configuration",
  );

  const failing = readGithub();
  failing.pages[0][0] = owned("must-not-save");
  failing.failPage = 2;
  saveGithub(failing);
  await assert.rejects(cli("sync"));
  assert.equal(
    fs.readFileSync(configuration, "utf8"),
    savedConfiguration,
    "A later discovery-page failure must retain the complete previous allowlist",
  );
  failing.failPage = 0;
  failing.pages = [[owned("watchdog-added")]];
  saveGithub(failing);
  const beforeWatchdog = workerPid();
  fs.writeFileSync(path.join(runtime, "last-reconcile"), "1");
  await cli("watchdog");
  assert.ok(
    readConfig().repos.includes("fixture/watchdog-added"),
    "Watchdog must discover new owned repositories",
  );
  assert.equal(workerPid(), beforeWatchdog, "Repository discovery must not restart the worker");
  // --- Weekly effort calibration: champion/challenger gate, toggles, events, schedule ---
  const promoted = await calibrationRun({
    name: "promote",
    preseed: true,
    steps: { reprice: true },
  });
  assert.equal(promoted.failed, false, promoted.stderr);
  assert.match(fs.readFileSync(promoted.log, "utf8"), /^champion=.*triage-effort-model\.json/);
  assert.equal(
    JSON.parse(fs.readFileSync(promoted.model, "utf8")).quantileModel.baseline.p50,
    1,
    "A passing challenger replaces the installed model",
  );
  const modelDir = path.dirname(promoted.model);
  for (const name of [
    "triage-session-history.json",
    "triage-effort-training.json",
    "triage-effort-report.json",
  ])
    assert.ok(fs.existsSync(path.join(modelDir, name)), `${name} is installed on promotion`);
  assert.equal(stateOf(promoted.run).lastOutcome, "promoted");
  assert.equal(typeof stateOf(promoted.run).lastCompletedAt, "number");
  const promotedEvents = eventsOf(promoted.model);
  for (const event of promotedEvents) {
    assert.equal(typeof event.ts, "number");
    assert.match(event.run, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(stepKinds(promotedEvents, "effort_sessions"), ["start", "ok"]);
  assert.deepEqual(stepKinds(promotedEvents, "effort_features"), ["start", "ok"]);
  assert.deepEqual(stepKinds(promotedEvents, "effort_fit"), ["start", "ok"]);
  assert.deepEqual(stepKinds(promotedEvents, "effort_gate"), ["ok"]);
  assert.deepEqual(stepKinds(promotedEvents, "effort_promote"), ["ok"]);
  assert.deepEqual(stepKinds(promotedEvents, "effort_reprice"), ["start", "ok"]);
  assert.equal(stepKinds(promotedEvents, "effort_schedule").length, 1);
  assert.equal(
    fs.statSync(path.join(modelDir, "triage-calibration-events.jsonl")).mode & 0o777,
    0o600,
  );

  const bootstrap = await calibrationRun({
    name: "bootstrap",
    artifact: fixtureArtifact(0.82, false),
  });
  assert.equal(bootstrap.failed, false, bootstrap.stderr);
  assert.match(fs.readFileSync(bootstrap.log, "utf8"), /^champion=\n/, "No champion argument");
  const bootstrapEvents = eventsOf(bootstrap.model);
  assert.ok(
    bootstrapEvents.some((event) => event.step === "effort_gate" && event.msg === "bootstrap"),
  );
  assert.deepEqual(stepKinds(bootstrapEvents, "effort_reprice"), ["info"]);
  assert.equal(bootstrapEvents.find((event) => event.step === "effort_reprice").msg, "disabled");
  assert.equal(stateOf(bootstrap.run).lastOutcome, "promoted");

  const rejected = await calibrationRun({
    name: "reject",
    preseed: true,
    artifact: fixtureArtifact(0.5),
  });
  assert.equal(rejected.failed, false, "A rejected challenger is not a crash");
  assert.equal(fs.readFileSync(rejected.model, "utf8"), "old-model");
  const rejectedDir = path.dirname(rejected.model);
  for (const name of [
    "triage-effort-model.challenger.json",
    "triage-effort-report.challenger.json",
  ])
    assert.equal(fs.statSync(path.join(rejectedDir, name)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(rejectedDir, "triage-session-history.json")), false);
  const rejectedState = stateOf(rejected.run);
  assert.equal(rejectedState.lastOutcome, "rejected");
  assert.match(rejectedState.reasons.join(" "), /p80 coverage 0\.500 is below/);
  const rejectedEvents = eventsOf(rejected.model);
  assert.deepEqual(stepKinds(rejectedEvents, "effort_gate"), ["fail"]);
  assert.deepEqual(stepKinds(rejectedEvents, "effort_promote"), []);

  const crashed = await calibrationRun({ name: "crash", preseed: true, exit: "3" });
  assert.equal(crashed.failed, true);
  assert.match(
    crashed.stderr,
    /Effort calibration stage=effort-fit exit=3 signal=none killed=false/,
  );
  assert.match(crashed.stderr, /boom-detail from fit/);
  assert.match(crashed.stderr, /failed at stage effort-fit/);
  assert.equal(fs.readFileSync(crashed.model, "utf8"), "old-model");
  const crashedState = stateOf(crashed.run);
  assert.equal(crashedState.lastOutcome, "failed");
  assert.equal(crashedState.lastCompletedAt, null);
  assert.deepEqual(stepKinds(eventsOf(crashed.model), "effort_fit"), ["start", "fail"]);

  const shadow = await calibrationRun({ name: "shadow", preseed: true, steps: { promote: false } });
  assert.equal(shadow.failed, false, shadow.stderr);
  assert.equal(fs.readFileSync(shadow.model, "utf8"), "old-model");
  assert.ok(
    fs.existsSync(path.join(path.dirname(shadow.model), "triage-effort-model.challenger.json")),
  );
  assert.deepEqual(stepKinds(eventsOf(shadow.model), "effort_promote"), ["info"]);
  assert.equal(stateOf(shadow.run).lastOutcome, "rejected");

  const reused = await calibrationRun({
    name: "features-off",
    steps: { features: false },
    dataset: '{"reused":"dataset"}',
  });
  assert.equal(reused.failed, false, reused.stderr);
  assert.match(fs.readFileSync(reused.log, "utf8"), /\{"reused":"dataset"\}/);
  assert.deepEqual(stepKinds(eventsOf(reused.model), "effort_features"), ["info"]);
  assert.equal(
    fs.existsSync(path.join(path.dirname(reused.model), "triage-effort-features.json")),
    false,
    "Disabled features step must not run",
  );

  // Watchdog schedule: a scratch HOME makes the default-path guard hold without touching real data.
  const home = path.join(scratch, "home");
  const homeRun = path.join(home, ".cache/agent-console/github-triage");
  const homeData = path.join(home, ".config/agent-console");
  fs.mkdirSync(homeData, { recursive: true, mode: 0o700 });
  fs.mkdirSync(homeRun, { recursive: true, mode: 0o700 });
  fs.copyFileSync(configuration, path.join(homeData, "github-triage.json"));
  const watchEnv = { ...env, HOME: home, AGENT_CONSOLE_TRIAGE_PYTHON: "/bin/false" };
  for (const key of [
    "AGENT_CONSOLE_TRIAGE_CONFIG",
    "AGENT_CONSOLE_TRIAGE_RUN",
    "AGENT_CONSOLE_TRIAGE_EFFORT_MODEL",
    "AGENT_CONSOLE_TRIAGE_HISTORY",
    "AGENT_CONSOLE_DATA",
  ])
    delete watchEnv[key];
  const watchdog = () =>
    new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [path.join(root, "scripts/github-triage.ts"), "watchdog"],
        { cwd: root, env: watchEnv, timeout: 25_000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  const attemptFile = path.join(homeRun, "calibration-attempt");
  const stateFile = path.join(homeRun, "calibration-state.json");
  const setState = (ageDays: number, outcome: string) =>
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        lastCompletedAt: Date.now() - ageDays * 86_400_000,
        lastOutcome: outcome,
        reasons: [],
      }),
    );
  setState(1, "rejected");
  await watchdog();
  assert.equal(fs.existsSync(attemptFile), false, "A rejected run waits the full seven days");
  setState(8, "promoted");
  fs.writeFileSync(path.join(homeData, "effort-model.json"), JSON.stringify({ enabled: false }));
  await watchdog();
  assert.equal(fs.existsSync(attemptFile), false, "enabled=false must skip automatic starts");
  fs.writeFileSync(path.join(homeData, "effort-model.json"), JSON.stringify({ enabled: true }));
  await watchdog();
  assert.equal(fs.existsSync(attemptFile), true, "A run older than seven days starts");
  const failedState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8")).lastOutcome === "failed";
    } catch {
      return false;
    }
  };
  for (const deadline = Date.now() + 30_000; !failedState(); ) {
    assert.ok(Date.now() < deadline, "Background calibration must finish");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const scheduled = eventsOf(path.join(homeData, "triage-effort-model.json"));
  assert.ok(
    scheduled.some((event) => event.step === "effort_schedule" && /^due/.test(event.msg)),
    "The watchdog records why it started a run",
  );
  assert.match(fs.readFileSync(path.join(homeRun, "calibration.log"), "utf8"), /stage=effort-fit/);
  console.log(
    "GitHub triage CLI: watchdog recovery, owner discovery, safe configuration, webhook registration, and weekly effort calibration passed.",
  );
} finally {
  await cli("stop").catch(() => {
    try {
      process.kill(workerPid(), "SIGKILL");
    } catch {}
  });
  fs.rmSync(scratch, { recursive: true, force: true });
}
