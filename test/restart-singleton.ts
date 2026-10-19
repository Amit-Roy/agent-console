import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-restart-singleton-"));
const fixture = path.join(scratch, "app");
const fixtureBin = path.join(scratch, "bin");
const runtime = path.join(scratch, "run");
const calls = path.join(scratch, "calls.jsonl");
for (const dir of [path.join(fixture, "bin"), fixtureBin, runtime]) fs.mkdirSync(dir, { recursive: true });
const cli = path.join(fixture, "bin/agent-console");
fs.copyFileSync(path.join(root, "bin/agent-console"), cli);
fs.chmodSync(cli, 0o700);
fs.writeFileSync(path.join(fixtureBin, "node"), `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({ pid:process.pid, args:process.argv.slice(2) }) + "\\n");
if (process.argv[2] === "scripts/idle-restart.mjs") {
  // Deliberately inherit every open descriptor: detached descendants must not retain the lock.
  const descriptors = fs.readdirSync("/proc/self/fd").map(Number);
  const stdio = Array.from({ length: Math.max(...descriptors) + 1 }, (_, fd) => {
    try { fs.fstatSync(fd); return fd; } catch { return "ignore"; }
  });
  const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio });
  fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({ pid:child.pid, args:["descendant"] }) + "\\n");
}
setInterval(() => {}, 1000);
`, { mode: 0o700 });
const env = { ...process.env, HOME: scratch, PATH: `${fixtureBin}:${process.env.PATH}`, AGENT_CONSOLE_RUN: runtime, TEST_CALLS: calls };
const children: ChildProcess[] = [];
const recorded = () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const eventually = async (check: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Expected fixture process did not start");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
try {
  for (let i = 0; i < 2; i++) children.push(spawn(cli, ["supervise"], { env, detached: true, stdio: "ignore" }));
  await eventually(() => recorded().some(call => call.args[0] === "server/index.ts"));
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 150);
  })));
  assert.equal(recorded().filter(call => call.args[0] === "server/index.ts").length, 1, "Concurrent supervisors must launch only one server");
  for (let i = 0; i < 2; i++) execFileSync(cli, ["restart-when-idle"], { env, stdio: "ignore" });
  await eventually(() => recorded().some(call => call.args[0] === "scripts/idle-restart.mjs"));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(recorded().filter(call => call.args[0] === "scripts/idle-restart.mjs").length, 1, "Concurrent restart requests must share one watcher");
  await eventually(() => recorded().some(call => call.args[0] === "descendant"));
  const firstWatcher = recorded().find(call => call.args[0] === "scripts/idle-restart.mjs");
  const descendant = recorded().find(call => call.args[0] === "descendant");
  process.kill(firstWatcher.pid, "SIGTERM");
  await eventually(() => {
    try { execFileSync("flock", ["-n", path.join(runtime, "idle-restart.lock"), "true"], { stdio: "ignore" }); return true; }
    catch { return false; }
  });
  process.kill(descendant.pid, 0);
  execFileSync(cli, ["restart-when-idle"], { env, stdio: "ignore" });
  await eventually(() => recorded().filter(call => call.args[0] === "scripts/idle-restart.mjs").length === 2);
  const originalSupervisor = Number(fs.readFileSync(path.join(runtime, "supervisor"), "utf8"));
  process.kill(originalSupervisor, "SIGTERM");
  await eventually(() => children.some(child => child.pid === originalSupervisor && (child.exitCode !== null || child.signalCode !== null)));
  const originalServer = recorded().find(call => call.args[0] === "server/index.ts");
  process.kill(originalServer.pid, 0);
  children.push(spawn(cli, ["supervise"], { env, detached: true, stdio: "ignore" }));
  await eventually(() => recorded().filter(call => call.args[0] === "server/index.ts").length === 2);
  console.log("Restart singleton tests passed.");
} finally {
  for (const call of recorded()) { try { process.kill(call.pid, "SIGKILL"); } catch {} }
  for (const child of children) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
  fs.rmSync(scratch, { recursive: true, force: true });
}
