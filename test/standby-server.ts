// Restart handoff (#348) on scratch servers: a standby server writes nothing and binds nothing before `go`,
// serves its first request soon after `go`, and a running server exits fast on SIGTERM with WebSocket close 1012.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-standby-"));
const home = path.join(scratch, "home");
const data = path.join(scratch, "data");
const runtime = path.join(scratch, "run");
for (const dir of [home, data, runtime]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const pidFile = path.join(runtime, "pid");
fs.writeFileSync(path.join(data, "threads.json"), "[]"); // a previous install's saved threads

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  HOME: home,
  PORT: String(PORT),
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_RUN: runtime,
  AGENT_CONSOLE_PID_FILE: pidFile,
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_HEADROOM: "0",
  AGENT_CONSOLE_HEADROOM_PORT: String(await freePort()),
};
delete env.AGENT_CONSOLE_STANDBY;
delete env.NODE_COMPILE_CACHE;
// The test signs its own session cookie with the scratch secret.
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_HEADROOM_PORT = env.AGENT_CONSOLE_HEADROOM_PORT;
const { makeToken } = await import("../server/auth.ts");
const cookie = `ac_session=${makeToken()}`;

const servers: ChildProcess[] = [];
const output = new Map<ChildProcess, string>();
const start = (standby: boolean) => {
  const child = spawn(process.execPath, [path.join(root, "server/index.ts")], {
    cwd: root,
    env: standby ? { ...env, AGENT_CONSOLE_STANDBY: "1" } : env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  output.set(child, "");
  const keep = (chunk: Buffer) =>
    output.set(child, (output.get(child) + String(chunk)).slice(-8000));
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  servers.push(child);
  return child;
};
const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
  });
const eventually = async <T>(what: string, probe: () => T | undefined, ms = 15_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const fileText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
};
const get = (pathname: string) =>
  fetch(BASE + pathname, { headers: { cookie } }).then(async (reply) => {
    await reply.arrayBuffer();
    return reply.status;
  });
// Retries refused connections only: the first answer after `go` is the number that matters.
const firstResponse = async (pathname: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await get(pathname);
    } catch (error: any) {
      if (error?.cause?.code !== "ECONNREFUSED" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
};
const openSocket = () =>
  new Promise<{ socket: WebSocket; closed: Promise<number> }>((resolve, reject) => {
    const socket = new WebSocket(`${BASE.replace("http", "ws")}/ws`, {
      headers: { cookie, origin: BASE },
    });
    const closed = new Promise<number>((done) => socket.once("close", (code) => done(code)));
    socket.once("message", () => resolve({ socket, closed })); // hello: the server finished building state
    socket.once("error", reject);
  });
const stopTimed = async (child: ChildProcess) => {
  const began = performance.now();
  child.kill("SIGTERM");
  const code = await exited(child);
  return { code, ms: Math.round(performance.now() - began) };
};
// Whether a process holds a listening TCP socket on the port (socket inode in its fd table).
const listensOn = (pid: number, port: number) => {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = new Set(
    ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((table) =>
      (fileText(table) ?? "")
        .split("\n")
        .slice(1)
        .map((row) => row.trim().split(/\s+/))
        .filter((cols) => cols[1]?.endsWith(hex) && cols[3] === "0A")
        .map((cols) => cols[9]),
    ),
  );
  return fs.readdirSync(`/proc/${pid}/fd`).some((entry) => {
    try {
      const link = fs.readlinkSync(`/proc/${pid}/fd/${entry}`);
      return inodes.has(/^socket:\[(\d+)\]$/.exec(link)?.[1] ?? "");
    } catch {
      return false;
    }
  });
};
const stateFiles = () =>
  fs
    .readdirSync(data)
    .filter((name) => name === "threads.json" || name === "schedules.json" || /\.sqlite/.test(name))
    .sort()
    .map((name) => `${name}:${fs.statSync(path.join(data, name)).mtimeMs}`);
const deferredDone = () =>
  (fileText(path.join(data, "boot.jsonl")) ?? "")
    .split("\n")
    .filter((line) => line.includes('"deferred"')).length;

try {
  // A: the running server (also seeds the data folder like a previous install would).
  const old = start(false);
  assert.equal(await firstResponse("/login", 20_000), 200);
  await eventually("first deferred boot phase", () => (deferredDone() >= 1 ? true : undefined));
  const tab = await openSocket();
  const oldPid = Number(fileText(pidFile));
  assert.equal(oldPid, old.pid, "the running server claims the pid file");

  // B: standby next to A.
  const before = stateFiles();
  assert.ok(
    before.some((entry) => entry.startsWith("threads.json")),
    "seeded threads.json",
  );
  const next = start(true);
  const readyPid = await eventually(
    "standby-ready",
    () => fileText(path.join(runtime, "standby-ready")) || undefined,
  );
  assert.equal(Number(readyPid), next.pid, "standby-ready holds the standby pid");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(next.exitCode, null, "standby waits for go");
  assert.equal(listensOn(next.pid!, PORT), false, "standby does not bind the port");
  assert.deepEqual(stateFiles(), before, "standby writes no threads.json, schedules or sqlite");
  assert.equal(Number(fileText(pidFile)), old.pid, "standby leaves the pid file alone");

  // Fast exit of A: tabs get 1012.
  const oldStop = await stopTimed(old);
  const closeCode = await Promise.race([
    tab.closed,
    new Promise((resolve) => setTimeout(resolve, 1000, -1)),
  ]);
  assert.equal(oldStop.code, 0);
  assert.equal(closeCode, 1012, "tabs are told the service restarts");
  assert.ok(oldStop.ms <= 300, `SIGTERM exit took ${oldStop.ms} ms`);

  // go: B binds and answers.
  const go = performance.now();
  next.stdin!.write("go\n");
  const status = await firstResponse("/login");
  const goToFirstResponse = Math.round(performance.now() - go);
  assert.equal(status, 200);
  assert.equal(await get("/api/boot-timing"), 200);
  await eventually("pid file claimed by B", () =>
    Number(fileText(pidFile)) === next.pid ? true : undefined,
  );
  assert.ok(goToFirstResponse <= 500, `go to first response took ${goToFirstResponse} ms`);

  const tabB = await openSocket();
  const nextStop = await stopTimed(next);
  const closeCodeB = await Promise.race([
    tabB.closed,
    new Promise((resolve) => setTimeout(resolve, 1000, -1)),
  ]);
  assert.equal(nextStop.code, 0);
  assert.equal(closeCodeB, 1012);
  assert.ok(nextStop.ms <= 300, `SIGTERM exit took ${nextStop.ms} ms`);

  // A standby whose supervisor goes away before go gives up.
  const orphaned = start(true);
  fs.rmSync(path.join(runtime, "standby-ready"), { force: true });
  await eventually(
    "second standby-ready",
    () => fileText(path.join(runtime, "standby-ready")) || undefined,
  );
  orphaned.stdin!.end();
  assert.equal(await exited(orphaned), 1, "stdin EOF before go exits 1");

  // The proxy the old server left exiting: the new one waits, then SIGKILLs it 5 s after the orphan file was written.
  const { headroom } = await import("../server/headroom.ts");
  const orphanFile = path.join(runtime, "headroom-orphan.pid");
  const stubborn = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)",
      "proxy",
      "--port",
      env.AGENT_CONSOLE_HEADROOM_PORT,
    ],
    { stdio: "ignore" },
  );
  servers.push(stubborn);
  await eventually("stub proxy", () =>
    fileText(`/proc/${stubborn.pid}/cmdline`)?.includes("proxy") ? true : undefined,
  );
  fs.writeFileSync(orphanFile, String(stubborn.pid));
  const released = (Date.now() - 4700) / 1000;
  fs.utimesSync(orphanFile, released, released);
  const reapStart = performance.now();
  await headroom.reapOrphan(orphanFile);
  const reapMs = Math.round(performance.now() - reapStart);
  assert.equal(stubborn.signalCode ?? (await exited(stubborn), stubborn.signalCode), "SIGKILL");
  assert.ok(reapMs >= 200 && reapMs < 1500, `orphan reaped after ${reapMs} ms`);
  assert.equal(fs.existsSync(orphanFile), false, "orphan file removed");
  fs.writeFileSync(orphanFile, String(process.pid)); // not a proxy: never signalled
  await headroom.reapOrphan(orphanFile);
  assert.equal(fs.existsSync(orphanFile), false);

  const boots = (fileText(path.join(data, "boot.jsonl")) ?? "")
    .split("\n")
    .map((line) => JSON.parse(line));
  const listen = boots.filter((record) => record.kind === "listen").at(-1);
  console.log(
    JSON.stringify({
      goToFirstResponseMs: goToFirstResponse,
      sigtermExitMs: [oldStop.ms, nextStop.ms],
      closeCodes: [closeCode, closeCodeB],
      standbyBootPhases: listen.phases
        .map((p: { name: string; ms: number }) => `${p.name}=${p.ms}`)
        .join(" "),
    }),
  );
  console.log("standby-server ok");
} catch (error) {
  for (const [child, text] of output) console.error(`--- server ${child.pid} output ---\n${text}`);
  throw error;
} finally {
  for (const child of servers)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(servers.map(exited));
  fs.rmSync(scratch, { recursive: true, force: true });
}
