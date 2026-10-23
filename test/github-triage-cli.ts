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
  console.log(
    "GitHub triage CLI: watchdog recovery, owner discovery, safe configuration, and webhook registration passed.",
  );
} finally {
  await cli("stop").catch(() => {
    try {
      process.kill(workerPid(), "SIGKILL");
    } catch {}
  });
  fs.rmSync(scratch, { recursive: true, force: true });
}
