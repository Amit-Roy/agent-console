// All children are offline fixtures. No Headroom inference or provider requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-headroom-safety-"));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const listener = net.createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
process.env.AGENT_CONSOLE_HEADROOM = "1";
process.env.AGENT_CONSOLE_HEADROOM_PORT = String(port);
process.env.AGENT_CONSOLE_RUN = path.join(scratch, "run");
process.env.CAPTURE = path.join(scratch, "capture");
fs.writeFileSync(process.env.CAPTURE, "");
process.env.PATH = `${scratch}:${process.env.PATH}`;
fs.writeFileSync(
  path.join(scratch, "headroom"),
  `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.CAPTURE, String(process.pid) + '\\n');
if (process.env.FIXTURE === 'crash') process.exit(1);
if (process.env.FIXTURE === 'delayed-stop') process.on('SIGTERM', () => setTimeout(() => process.exit(0), 600));
if (process.env.FIXTURE === 'ignore-term') process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
  { mode: 0o700 },
);
const nativeTimeout = globalThis.setTimeout;
const nativeFetch = globalThis.fetch;
const nativeReadFile = fs.promises.readFile;
const queued: { callback: () => any; timer: NodeJS.Timeout }[] = [];
let active: { stop(): void } | undefined;
try {
  // Intercept monitor/escalation intervals only. Startup polling remains real.
  globalThis.setTimeout = ((callback: () => any, ms: number, ...args: any[]) => {
    if (ms !== 5000) return nativeTimeout(callback, ms, ...args);
    const timer = nativeTimeout(callback, 60_000);
    queued.push({ callback, timer });
    return timer;
  }) as typeof setTimeout;
  globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;

  const race = (await import("../server/headroom.ts?race")).headroom;
  active = race;
  const pending = race.start();
  await delay(100);
  race.stop();
  await pending;
  await delay(150);
  assert.equal(race.url(), undefined);
  assert.equal(
    queued.length,
    1,
    "Only owned-child shutdown escalation may remain; no monitor after stop",
  );
  const countBefore = fs.existsSync(process.env.CAPTURE)
    ? fs.readFileSync(process.env.CAPTURE, "utf8")
    : "";
  await delay(250);
  assert.equal(
    fs.existsSync(process.env.CAPTURE) ? fs.readFileSync(process.env.CAPTURE, "utf8") : "",
    countBefore,
  );
  for (const item of queued.splice(0)) clearTimeout(item.timer);

  process.env.FIXTURE = "delayed-stop";
  const restart = (await import("../server/headroom.ts?restart")).headroom;
  active = restart;
  const oldCapture = fs.readFileSync(process.env.CAPTURE, "utf8");
  globalThis.fetch = (async () => {
    const lines = fs
      .readFileSync(process.env.CAPTURE, "utf8")
      .slice(oldCapture.length)
      .trim()
      .split("\n");
    const pid = Number(lines.at(-1));
    let alive = false;
    if (pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
    }
    return new Response("", { status: alive ? 200 : 503 });
  }) as typeof fetch;
  await restart.start();
  assert.ok(restart.url());
  restart.stop();
  const restarting = restart.start();
  await delay(100);
  assert.equal(
    restart.url(),
    undefined,
    "Do not route through an owned proxy awaiting termination",
  );
  await restarting;
  assert.ok(restart.url());
  assert.equal(
    fs.readFileSync(process.env.CAPTURE, "utf8").slice(oldCapture.length).trim().split("\n").length,
    2,
  );
  restart.stop();
  await delay(700);
  for (const item of queued.splice(0)) clearTimeout(item.timer);
  globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;

  process.env.FIXTURE = "crash";
  const failure = (await import("../server/headroom.ts?failure")).headroom;
  active = failure;
  await failure.start();
  for (let i = 0; i < 3; i++) {
    await delay(200);
    const item = queued.shift()!;
    assert.ok(item);
    clearTimeout(item.timer);
    await item.callback();
  }
  assert.match(failure.state().error!, /three launch attempts/);
  assert.equal(queued.length, 0);
  const attempts = fs.readFileSync(process.env.CAPTURE, "utf8");
  await failure.start();
  assert.equal(
    fs.readFileSync(process.env.CAPTURE, "utf8"),
    attempts,
    "Failure breaker remains latched",
  );
  failure.stop();

  delete process.env.FIXTURE;
  const breaker = (await import("../server/headroom.ts?breaker")).headroom;
  active = breaker;
  let healthCalls = 0;
  globalThis.fetch = (async () =>
    new Response("", { status: ++healthCalls > 1 ? 200 : 503 })) as typeof fetch;
  await breaker.start();
  await delay(150);
  const monitor = queued.shift()!;
  clearTimeout(monitor.timer);
  fs.promises.readFile = (async (file: any, ...args: any[]) => {
    if (String(file).startsWith("/proc/") && String(file).endsWith("/status"))
      return "VmRSS: 8388609 kB\n";
    return (nativeReadFile as any)(file, ...args);
  }) as typeof fs.promises.readFile;
  await monitor.callback();
  fs.promises.readFile = nativeReadFile;
  assert.equal(breaker.url(), undefined);
  assert.match(breaker.state().error!, /RSS exceeded/);
  await delay(100);
  await breaker.start();
  assert.equal(breaker.url(), undefined, "Resource breaker remains latched");
  breaker.stop();
  for (const item of queued.splice(0)) clearTimeout(item.timer);

  const external = (await import("../server/headroom.ts?external")).headroom;
  active = external;
  globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
  await external.start();
  assert.equal(external.state().owned, false);
  assert.ok(external.url());
  const launchCount = fs.readFileSync(process.env.CAPTURE, "utf8");
  external.stop();
  assert.equal(external.url(), undefined);
  assert.equal(fs.readFileSync(process.env.CAPTURE, "utf8"), launchCount);
  for (const item of queued.splice(0)) clearTimeout(item.timer);

  // Server shutdown awaits this promise before exiting. An uncooperative owned
  // child must be killed before that promise resolves, using the real grace timer.
  globalThis.setTimeout = nativeTimeout;
  process.env.FIXTURE = "ignore-term";
  const stubbornCapture = fs.readFileSync(process.env.CAPTURE, "utf8");
  globalThis.fetch = (async () => {
    const latest = fs
      .readFileSync(process.env.CAPTURE, "utf8")
      .slice(stubbornCapture.length)
      .trim();
    return new Response("", { status: latest ? 200 : 503 });
  }) as typeof fetch;
  const stubborn = (await import("../server/headroom.ts?stubborn")).headroom;
  active = stubborn;
  await stubborn.start();
  const stubbornPid = Number(
    fs.readFileSync(process.env.CAPTURE, "utf8").slice(stubbornCapture.length).trim(),
  );
  assert.ok(stubbornPid > 0);
  const shutdownAt = Date.now();
  let shutdownComplete = false;
  const shutdown = stubborn.stop().then(() => {
    shutdownComplete = true;
  });
  await delay(100);
  assert.equal(shutdownComplete, false, "Shutdown must await a child that ignores SIGTERM");
  process.kill(stubbornPid, 0);
  await shutdown;
  assert.ok(
    Date.now() - shutdownAt >= 4900,
    "SIGKILL escalation must preserve the five-second grace period",
  );
  assert.throws(() => process.kill(stubbornPid, 0), /ESRCH/);
  if (process.platform === "linux") assert.equal(fs.existsSync(`/proc/${stubbornPid}`), false);
  console.log(
    "PASS Headroom startup cancellation, external ownership, three-attempt latch, and RSS breaker latch",
  );
} finally {
  active?.stop();
  globalThis.setTimeout = nativeTimeout;
  globalThis.fetch = nativeFetch;
  fs.promises.readFile = nativeReadFile;
  for (const item of queued) clearTimeout(item.timer);
  fs.rmSync(scratch, { recursive: true, force: true });
}
