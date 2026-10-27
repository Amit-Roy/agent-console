import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TriageCliCleanup } from "./helpers/triage-cli-cleanup.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "triage-cleanup-regression-"));
const script = path.join(scratch, "service.mjs");
const children: ChildProcess[] = [];
const driverRuntimes = new Set<string>();
const detachedWorkers = new Set<number>();
fs.writeFileSync(
  script,
  `
import fs from "node:fs";
import path from "node:path";
if (process.argv[2] === "stop") {
  const runtime = process.env.AGENT_CONSOLE_TRIAGE_RUN;
  const worker = Number(fs.readFileSync(path.join(runtime, "pid"), "utf8"));
  process.kill(worker, "SIGTERM");
  process.exit(2);
}
if (process.env.RESIST_TERM) process.on("SIGTERM", () => {});
process.send?.("ready");
setInterval(() => {}, 1000);
`,
);
const alive = (worker: number) => {
  try {
    return fs.readFileSync(`/proc/${worker}/cmdline`, "utf8").includes(script);
  } catch {
    return false;
  }
};
async function service(env: NodeJS.ProcessEnv, filename = script) {
  const child = spawn(process.execPath, [filename, "serve"], {
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.push(child);
  await once(child, "message");
  return child;
}
const environment = (name: string) => ({
  ...process.env,
  AGENT_CONSOLE_TRIAGE_RUN: path.join(scratch, name),
});

try {
  const messages: string[] = [];
  const cleanup = new TriageCliCleanup(script, 150, (message) => messages.push(message));
  const ownedEnv = environment("owned");
  cleanup.register("owned", ownedEnv.AGENT_CONSOLE_TRIAGE_RUN, ownedEnv);
  const owned = await service({ ...ownedEnv, RESIST_TERM: "1" });
  const unrelated = await service(environment("unrelated"));
  // A valid pidfile exercises failed CLI stop and TERM-resistant escalation.
  fs.mkdirSync(ownedEnv.AGENT_CONSOLE_TRIAGE_RUN);
  fs.writeFileSync(path.join(ownedEnv.AGENT_CONSOLE_TRIAGE_RUN, "pid"), String(owned.pid));
  const staleEnv = environment("stale");
  cleanup.register("stale", staleEnv.AGENT_CONSOLE_TRIAGE_RUN, staleEnv);
  const stale = await service(staleEnv);
  fs.mkdirSync(staleEnv.AGENT_CONSOLE_TRIAGE_RUN);
  fs.writeFileSync(path.join(staleEnv.AGENT_CONSOLE_TRIAGE_RUN, "pid"), String(unrelated.pid));
  assert.equal(await cleanup.shutdown(), true);
  assert.equal(await cleanup.shutdown(), true, "Cleanup must be idempotent");
  assert.equal(alive(Number(owned.pid)), false);
  assert.equal(alive(Number(stale.pid)), false);
  assert.equal(
    alive(Number(unrelated.pid)),
    true,
    "Unregistered runtime must never receive a signal",
  );
  assert.ok(messages.some((message) => message.includes("graceful stop failed")));
  assert.ok(messages.some((message) => message.includes("escalating to SIGKILL")));
  assert.ok(
    messages.every(
      (message) =>
        message.includes("fixture=") && message.includes("pid=") && message.includes(scratch),
    ),
  );

  const missing = new TriageCliCleanup(script, 150, () => {});
  const home = path.join(scratch, "home");
  const homeEnv = { ...process.env, HOME: home };
  delete homeEnv.AGENT_CONSOLE_TRIAGE_RUN;
  missing.register("home", path.join(home, ".cache/agent-console/github-triage"), homeEnv);
  const homeWorker = await service(homeEnv);
  assert.equal(await missing.shutdown(), true, "Missing pidfile must not prevent HOME cleanup");
  assert.equal(alive(Number(homeWorker.pid)), false);

  const racing = new TriageCliCleanup(script, 150, () => {});
  const raceEnv = environment("race");
  racing.register("race", raceEnv.AGENT_CONSOLE_TRIAGE_RUN, raceEnv);
  let launcher!: ChildProcess;
  const launchDone = new Promise<void>((resolve) => {
    launcher = racing.execFile(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      {
        cwd: scratch,
        env: raceEnv,
        timeout: 3000,
      },
      () => resolve(),
    );
  });
  assert.ok(launcher.stdout);
  await once(launcher.stdout, "data");
  assert.equal(await racing.shutdown(), true);
  await launchDone;
  assert.ok(launcher.signalCode, "In-flight launcher must exit before sweeping services");
  assert.throws(
    () =>
      racing.execFile(process.execPath, [], { cwd: scratch, env: raceEnv, timeout: 100 }, () => {}),
    /refusing CLI launch/,
  );

  const helper = fileURLToPath(new URL("./helpers/triage-cli-cleanup.ts", import.meta.url));
  const driver = path.join(scratch, "driver.mjs");
  fs.writeFileSync(
    driver,
    `
import { spawn } from "node:child_process";
import { TriageCliCleanup } from ${JSON.stringify(helper)};
const cleanup = new TriageCliCleanup(${JSON.stringify(script)}, 150);
cleanup.register("signal", process.env.AGENT_CONSOLE_TRIAGE_RUN, process.env);
cleanup.installHooks();
if (process.env.FAIL_CLEANUP) cleanup.shutdown = () => Promise.reject(Object.assign(Error("fixture"), { code: "FIXTURE_FAILURE" }));
process.on("message", (message) => { if (message === "exit") process.exit(0); });
setInterval(() => {}, 1000);
const worker = spawn(process.execPath, [${JSON.stringify(script)}, "serve"], {
  env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"],
});
worker.once("message", () => { worker.disconnect(); worker.unref(); process.send(worker.pid); });
`,
  );
  for (const signal of ["SIGINT", "SIGTERM", "exit", "failure"] as const) {
    const driverEnv = environment(signal);
    driverRuntimes.add(driverEnv.AGENT_CONSOLE_TRIAGE_RUN);
    if (signal === "failure") driverEnv.FAIL_CLEANUP = "1";
    const driverChild = spawn(process.execPath, [driver], {
      env: driverEnv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(driverChild);
    let shutdownLog = "";
    driverChild.stderr?.on("data", (chunk) => {
      shutdownLog += chunk;
    });
    const [worker] = await once(driverChild, "message");
    detachedWorkers.add(Number(worker));
    const exited = once(driverChild, "exit");
    if (signal === "exit") driverChild.send("exit");
    else driverChild.kill(signal === "failure" ? "SIGTERM" : signal);
    const [code] = await exited;
    assert.equal(
      code,
      signal === "failure" ? 1 : signal === "exit" ? 0 : signal === "SIGINT" ? 130 : 143,
    );
    if (signal === "failure")
      assert.match(shutdownLog, /fixture=signal.*shutdown hook failed code=FIXTURE_FAILURE/);
    const deadline = Date.now() + 1000;
    while (alive(Number(worker)) && Date.now() < deadline) await delay(10);
    assert.equal(alive(Number(worker)), false, `${signal} must clean up detached service`);
  }
  console.log(
    "Triage CLI cleanup: failed stop, TERM escalation, missing/stale pidfile, launch gate, and signal hooks passed.",
  );
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(
    children
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => once(child, "exit")),
  );
  // Scan also catches a driver failure before its worker PID reaches the parent.
  for (const entry of fs.readdirSync("/proc")) detachedWorkers.add(Number(entry));
  const killed: number[] = [];
  for (const worker of detachedWorkers) {
    if (!Number.isSafeInteger(worker) || worker <= 1) continue;
    try {
      const args = fs.readFileSync(`/proc/${worker}/cmdline`, "utf8").split("\0");
      const entries = fs.readFileSync(`/proc/${worker}/environ`, "utf8").split("\0");
      const registered = [...driverRuntimes].some((runtime) =>
        entries.includes(`AGENT_CONSOLE_TRIAGE_RUN=${runtime}`),
      );
      if (args[1] === script && args[2] === "serve" && registered) {
        process.kill(worker, "SIGKILL");
        killed.push(worker);
      }
    } catch {}
  }
  const deadline = Date.now() + 1000;
  while (killed.some(alive) && Date.now() < deadline) await delay(10);
  assert.equal(killed.some(alive), false, "Regression fallback must not leak driver workers");
  fs.rmSync(scratch, { recursive: true, force: true });
}
