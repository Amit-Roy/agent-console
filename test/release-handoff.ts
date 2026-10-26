// Release handoff: deploy A cold, deploy B while measure-gap watches the port, crash recovery, one supervisor.lock holder, rollback.
// Everything runs on a scratch HOME/RUN/DATA/AGENT_CONSOLE_HOME with MOCK=1 and a random port. Releases are built from two commits of a
// clone of this repo's HEAD (committed work only). Without server-side standby support (AGENT_CONSOLE_STANDBY) the second deploy
// must abort cleanly: old server still serving, current reverted.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-handoff-"));
const app = path.join(tmp, "app");
const run = path.join(tmp, "run");
const clone = path.join(tmp, "repo");
const dataDir = path.join(tmp, "data");
const port = await new Promise<number>((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(free));
  });
});
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("AGENT_CONSOLE_")) delete env[key];
Object.assign(env, {
  HOME: path.join(tmp, "home"),
  PORT: String(port),
  AGENT_CONSOLE_HOME: app,
  AGENT_CONSOLE_RUN: run,
  AGENT_CONSOLE_DATA: dataDir,
  AGENT_CONSOLE_REPO: clone,
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_PASSWORD: "handoff-test",
  AGENT_CONSOLE_ENV_FILES: path.join(tmp, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(tmp, "no-brain"),
});
fs.mkdirSync(env.HOME as string, { recursive: true });
Object.assign(process.env, { AGENT_CONSOLE_DATA: dataDir, AGENT_CONSOLE_PASSWORD: "handoff-test" });
const { makeToken } = await import("../server/auth.ts");

const cli = path.join(root, "bin", "agent-console");
const idleLog = path.join(run, "idle-restart.log");
const standbySupported = /AGENT_CONSOLE_STANDBY/.test(
  fs.readFileSync(path.join(root, "server", "index.ts"), "utf8"),
);
const TERMINAL =
  /answering \(build|already running; nothing|Gave up|build failed;|serving again|Rollback failed|to roll back to|already restarted/;
const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", clone, ...args],
    {
      encoding: "utf8",
    },
  ).trim();
const readText = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
const linkBuild = (name: string) => {
  try {
    return path.basename(fs.realpathSync(path.join(app, name)));
  } catch {
    return "";
  }
};

async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function helloBuild(): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: `http://127.0.0.1:${port}`, cookie: `ac_session=${makeToken()}` },
    });
    const timer = setTimeout(() => socket.terminate(), 1500);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve("");
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.t !== "hello") return;
      clearTimeout(timer);
      socket.terminate();
      resolve(message.build);
    });
  });
}

// Start a verb (it detaches) and wait for the line that ends its run in idle-restart.log.
async function runVerb(...args: string[]) {
  const offset = fs.existsSync(idleLog) ? fs.statSync(idleLog).size : 0;
  execFileSync(cli, args, { env, stdio: "ignore" });
  const fresh = () => fs.readFileSync(idleLog, "utf8").slice(offset);
  await eventually(
    () => fs.existsSync(idleLog) && TERMINAL.test(fresh()),
    `${args.join(" ")} to finish`,
    300_000,
  );
  return fresh();
}

// pids holding an open descriptor on supervisor.lock
function lockHolders(): number[] {
  const lock = path.join(run, "supervisor.lock");
  return fs
    .readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        return fs.readdirSync(`/proc/${pid}/fd`).some((fd) => {
          try {
            return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === lock;
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    })
    .map(Number);
}

type Gaps = { httpMaxGapMs: number; wsMaxGapMs: number };
function startMeasure(): {
  child: ChildProcess;
  output: () => string;
  summary: () => Promise<Gaps>;
} {
  const child = spawn(
    process.execPath,
    [path.join(root, "scripts", "measure-gap.mjs"), "--port", String(port)],
    {
      env: { ...env, AGENT_CONSOLE_DATA: dataDir },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let out = "";
  child.stdout?.on("data", (chunk) => {
    out += chunk;
  });
  const summary = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    return JSON.parse(out.trim().split("\n").pop() as string);
  };
  return { child, output: () => out, summary };
}

function killStragglers() {
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const line = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (line.includes(tmp) || line.includes("agent-console supervise")) {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (line.includes(tmp) || cwd.startsWith(tmp)) process.kill(Number(pid), "SIGKILL");
      }
    } catch {}
  }
}

let measure: ReturnType<typeof startMeasure> | undefined;
try {
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, clone]);
  const shaA = git("rev-parse", "HEAD");
  fs.appendFileSync(path.join(clone, "README.md"), "\nhandoff test\n");
  git("commit", "-q", "-am", "second commit");
  const shaB = git("rev-parse", "HEAD");
  const buildA = shaA.slice(0, 12);
  const buildB = shaB.slice(0, 12);

  // 1. cold deploy of A: no server yet, so the release is built, linked and started
  const coldBegan = Date.now();
  assert.match(await runVerb("deploy", shaA), /Started and answering/);
  assert.equal(linkBuild("current"), buildA);
  assert.equal(await helloBuild(), buildA);
  console.log(`deploy A (cold, includes release build): ${Date.now() - coldBegan} ms`);
  const supervisorA = Number(readText(path.join(run, "supervisor")));
  assert.deepEqual(lockHolders(), [supervisorA], "one supervisor.lock holder");
  const serverA = readText(path.join(run, "pid"));

  // 2. deploy B while the port is watched
  measure = startMeasure();
  await eventually(
    () => (measure as ReturnType<typeof startMeasure>).output().includes("ready"),
    "measure-gap ready",
  );
  const log = await runVerb("deploy", shaB);
  const gaps = await measure.summary();
  measure = undefined;
  console.log(`gaps: ${JSON.stringify(gaps)}`);

  if (!standbySupported) {
    // fallback: the server has no standby mode, so the handoff aborts and nothing changes
    assert.match(log, /Gave up/);
    assert.equal(linkBuild("current"), buildA, "current reverted");
    assert.equal(await helloBuild(), buildA, "old server still serves");
    assert.equal(readText(path.join(run, "pid")), serverA);
    assert.ok(!fs.existsSync(path.join(run, "handoff")), "handoff marker removed");
    assert.equal(lockHolders().length, 1, "old supervisor still the only lock holder");
    assert.match(await runVerb("rollback"), /to roll back to/);
    console.log(
      "standby unsupported by this server: abort path verified (old server serving, current reverted)",
    );
  } else {
    assert.match(log, /Restarted and answering/);
    assert.equal(linkBuild("current"), buildB);
    assert.equal(linkBuild("previous"), buildA);
    assert.equal(await helloBuild(), buildB);
    assert.ok(gaps.httpMaxGapMs < 1000, `HTTP gap ${gaps.httpMaxGapMs} ms`);
    assert.ok(gaps.wsMaxGapMs < 1000, `WebSocket gap ${gaps.wsMaxGapMs} ms`);
    const supervisorB = Number(readText(path.join(run, "supervisor")));
    assert.notEqual(supervisorB, supervisorA);
    assert.deepEqual(lockHolders(), [supervisorB], "one supervisor.lock holder after the handoff");
    assert.ok(!fs.existsSync(path.join(run, "handoff")), "handoff marker removed");

    // 3. the new supervisor restarts a crashed server (not as standby)
    const serverB = readText(path.join(run, "pid"));
    process.kill(Number(serverB), "SIGKILL");
    await eventually(
      async () => readText(path.join(run, "pid")) !== serverB && (await helloBuild()) === buildB,
      "restart after crash",
      60_000,
    );

    // 4. rollback goes back to A through the same handoff
    assert.match(await runVerb("rollback"), /Restarted and answering \(build/);
    assert.equal(await helloBuild(), buildA);
    assert.equal(linkBuild("current"), buildA);
    assert.deepEqual(lockHolders().length, 1);
  }
  console.log("handoff tests passed");
} finally {
  measure?.child.kill("SIGKILL");
  try {
    execFileSync(cli, ["stop"], { env, stdio: "ignore", timeout: 10_000 });
  } catch {}
  killStragglers();
  await delay(200);
  killStragglers();
  if (fs.existsSync(tmp)) {
    execFileSync("find", [tmp, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
