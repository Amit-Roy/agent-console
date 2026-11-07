import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.AGENT_CONSOLE_CAMOFOX_AUTOSTART = "0";
const stub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/tabs") {
    res.statusCode = stubMode === "wedged" ? 500 : 200;
    res.end(
      JSON.stringify(stubMode === "wedged" ? { error: "new page timed out" } : { tabId: "t1" }),
    );
  } else res.end("{}");
});
let stubMode: "wedged" | "healthy" = "wedged";
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as AddressInfo).port;
const stubUrl = `http://127.0.0.1:${stubPort}`;
process.env.AGENT_CONSOLE_CAMOFOX_URL = stubUrl;

const { probeCamofox, healCamofox, checkCamofox, camofoxHealthDeps, resetCamofoxHealState } =
  await import("../server/health/camofox.ts");

const REPO = "/fake/camofox-browser";
const PID = 4242;
let clock = 1_000_000;
let killed: [number, string][] = [];
let spawned = 0;
let procAlive = true;
let cmdline = `node\0server.js\0`;
let cwd = REPO;
let pidFile: string | null = String(PID);
let portIsUp = false;
let lockIsFree = true;

const deps = {
  ...camofoxHealthDeps,
  inChain: <T>(job: () => Promise<T>) => job(),
  base: () => stubUrl,
  readText: (file: string) => {
    if (file.endsWith(`serve-${stubPort}.pid`)) return pidFile;
    if (file === `/fakeproc/${PID}/cmdline`) return cmdline;
    return null;
  },
  readLink: (file: string) => (file === `/fakeproc/${PID}/cwd` ? cwd : null),
  alive: () => procAlive,
  kill: (pid: number, signal: NodeJS.Signals) => {
    killed.push([pid, signal]);
    if (signal === "SIGTERM") {
      procAlive = false;
      portIsUp = true; // supervisor respawns
      stubMode = "healthy";
    }
  },
  now: () => clock,
  sleep: async (ms: number) => {
    clock += ms;
  },
  portUp: async () => portIsUp,
  lockFree: () => lockIsFree,
  spawnServe: () => {
    spawned++;
    portIsUp = true;
    stubMode = "healthy";
  },
  cacheDir: () => "/fakecache",
  repoDir: () => REPO,
  procDir: "/fakeproc",
};

function reset() {
  resetCamofoxHealState();
  killed = [];
  spawned = 0;
  procAlive = true;
  cmdline = `node\0server.js\0`;
  cwd = REPO;
  pidFile = String(PID);
  portIsUp = false;
  lockIsFree = true;
  stubMode = "wedged";
}

// probe fails against a wedged stub, passes when healthy
reset();
const bad = await probeCamofox(deps);
assert.equal(bad.status, "error");
assert.match(bad.detail, /tabs 500/);
stubMode = "healthy";
assert.equal((await probeCamofox(deps)).status, "ok");

// heal: SIGTERM injected pid, recovered, recorded through checkCamofox
reset();
const check = await checkCamofox(deps);
assert.deepEqual(killed, [[PID, "SIGTERM"]]);
assert.equal(check.status, "ok");
assert.equal(check.healed?.action, "restart");
assert.match(check.healed!.result, /recovered/);
assert.equal(spawned, 0);

// rate limit: second restart within 10 min refused
stubMode = "wedged";
procAlive = true;
killed = [];
const second = await healCamofox(deps);
assert.equal(second.action, "skip");
assert.match(second.result, /under 10 min/);
assert.equal(killed.length, 0);

// 3 per day: restarts spaced 11 min apart, 4th refused
reset();
for (let run = 0; run < 3; run++) {
  stubMode = "wedged";
  procAlive = true;
  portIsUp = false;
  clock += 11 * 60_000;
  assert.equal((await healCamofox(deps)).action, "restart");
}
clock += 11 * 60_000;
const fourth = await healCamofox(deps);
assert.match(fourth.result, /3 restarts/);
assert.equal(killed.length, 3);
clock += 25 * 60 * 60_000;
procAlive = true;
assert.equal((await healCamofox(deps)).action, "restart", "window slides after 24 h");

// wrong cmdline or cwd or missing pid file: no kill
for (const mutate of [
  () => (cmdline = "sshd\0-D\0"),
  () => (cwd = "/somewhere/else"),
  () => (pidFile = null),
]) {
  reset();
  mutate();
  const refused = await healCamofox(deps);
  assert.equal(refused.action, "skip");
  assert.equal(killed.length, 0);
}

// SIGKILL escalation when the process ignores SIGTERM
reset();
deps.kill = (pid, signal) => {
  killed.push([pid, signal]);
  if (signal === "SIGKILL") {
    procAlive = false;
    portIsUp = true;
    stubMode = "healthy";
  }
};
assert.equal((await healCamofox(deps)).ok, true);
assert.deepEqual(killed, [
  [PID, "SIGTERM"],
  [PID, "SIGKILL"],
]);

// port never returns: spawn camofox-serve when the supervisor lock is free, not when held
reset();
deps.kill = (pid, signal) => {
  killed.push([pid, signal]);
  procAlive = false;
};
const respawned = await healCamofox(deps);
assert.equal(spawned, 1);
assert.equal(respawned.ok, true);
reset();
deps.kill = (pid, signal) => {
  killed.push([pid, signal]);
  procAlive = false;
};
lockIsFree = false;
const held = await healCamofox(deps);
assert.equal(spawned, 0);
assert.equal(held.ok, false);
assert.match(held.result, /not back/);

stub.close();
console.log("health-camofox: ok");
