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
fs.writeFileSync(path.join(fixtureBin, "gh"), "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
const server = http.createServer();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
await new Promise<void>(resolve => server.close(() => resolve()));
fs.writeFileSync(configuration, JSON.stringify({ repos: ["fixture/repository"], secret: "test-only-scratch-webhook-secret-1234567890", url: "https://example.invalid/api/github/webhook", port, host: "127.0.0.1" }), { mode: 0o600 });
const env = { ...process.env, PATH: `${fixtureBin}:${process.env.PATH}`, AGENT_CONSOLE_ENV_FILES: "/dev/null", AGENT_CONSOLE_TRIAGE_CONFIG: configuration, AGENT_CONSOLE_TRIAGE_RUN: runtime };
delete env.AGENT_CONSOLE_MOCK;
const cli = (...args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(process.execPath, [path.join(root, "scripts/github-triage.ts"), ...args], { cwd: root, env, timeout: 25_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
const workerPid = () => Number(fs.readFileSync(path.join(runtime, "pid"), "utf8"));
try {
  const retained = path.join(scratch, "history.json");
  fs.writeFileSync(retained, "Existing private calibration must survive a failed refresh.", { mode: 0o600 });
  await assert.rejects(new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [path.join(root, "scripts/github-triage.ts"), "calibrate"], {
      cwd: root, env: { ...env, AGENT_CONSOLE_DATA: path.join(scratch, "missing-source"), AGENT_CONSOLE_TRIAGE_HISTORY: retained }, timeout: 25_000,
    }, error => error ? reject(error) : resolve());
  }));
  assert.equal(fs.readFileSync(retained, "utf8"), "Existing private calibration must survive a failed refresh.");
  assert.match(await cli("watchdog"), /Reconciled 0 open items; queued 0 repairs/);
  const originalPid = workerPid();
  assert.equal(JSON.parse(await cli("status")).ok, true);
  const firstScan = fs.readFileSync(path.join(runtime, "last-reconcile"), "utf8");
  await cli("watchdog");
  assert.equal(workerPid(), originalPid, "Healthy watchdog must not restart the worker");
  assert.equal(fs.readFileSync(path.join(runtime, "last-reconcile"), "utf8"), firstScan, "Healthy watchdog must respect the reconciliation interval");
  process.kill(originalPid, "SIGKILL");
  await new Promise<void>((resolve, reject) => execFile("waitfor", ["-t", "5", "pid", String(originalPid)], { timeout: 8_000 }, error => error ? reject(error) : resolve()));
  assert.match(await cli("watchdog"), /Reconciled 0 open items; queued 0 repairs/);
  assert.notEqual(workerPid(), originalPid, "Watchdog must replace a crashed worker");
  assert.equal(JSON.parse(await cli("status")).ok, true);
  fs.writeFileSync(path.join(runtime, "last-reconcile"), "1");
  assert.match(await cli("watchdog"), /Reconciled 0 open items; queued 0 repairs/);
  assert.match(await cli("reconcile"), /Reconciled 0 open items; queued 0 repairs/);
  console.log("GitHub triage CLI watchdog: crash recovery, healthy-process preservation, and scheduled reconciliation passed.");
} finally {
  await cli("stop").catch(() => { try { process.kill(workerPid(), "SIGKILL"); } catch {} });
  fs.rmSync(scratch, { recursive: true, force: true });
}
