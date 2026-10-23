// Offline startup regression: delay proxy health and verify no session can inherit the initial unhealthy state.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { diagnostic, ResourceGuard } from "../server/headroom-diagnostics.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-headroom-"));
const socket = net.createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
fs.writeFileSync(path.join(scratch, "headroom"), `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
fs.appendFileSync(process.env.CAPTURE, JSON.stringify({args: process.argv.slice(2), env: Object.fromEntries(['HEADROOM_WORKERS','HEADROOM_COMPRESS_WORKERS','OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMEXPR_NUM_THREADS','TOKENIZERS_PARALLELISM','HEADROOM_LOG_MESSAGES'].map(k => [k, process.env[k]])), nice: require('node:os').getPriority()}) + '\\n');
process.stdout.write('PROMPT_SECRET auth=AUTH_SECRET');
process.stderr.write('ERROR AUTH_SECRET');
setTimeout(() => http.createServer((req, res) => res.end('ok')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1'), 300);
`, { mode: 0o700 });
process.env.PATH = `${scratch}:${process.env.PATH}`;
process.env.CAPTURE = path.join(scratch, "capture");
process.env.AGENT_CONSOLE_RUN = path.join(scratch, "run");
process.env.HEADROOM_LOG_MESSAGES = "1";
process.env.AGENT_CONSOLE_HEADROOM = "0";
process.env.AGENT_CONSOLE_HEADROOM_PORT = String(port);
const { headroom } = await import("../server/headroom.ts");
try {
  const external = net.createServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
  await new Promise<void>((resolve) => external.listen(port, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/`;
  await headroom.start();
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined, "Disabled proxy URL is removed from inherited server environment");
  process.env.ANTHROPIC_BASE_URL = "https://provider.example";
  await headroom.start();
  assert.equal(process.env.ANTHROPIC_BASE_URL, "https://provider.example", "External endpoints remain user controlled");
  delete process.env.ANTHROPIC_BASE_URL;
  assert.equal(headroom.url(), undefined);
  assert.equal(headroom.state().enabled, false);
  assert.equal(fs.existsSync(process.env.CAPTURE), false);
  headroom.stop();
  await new Promise<void>((resolve) => external.close(() => resolve()));
  delete process.env.AGENT_CONSOLE_HEADROOM;
  assert.equal(headroom.state().enabled, true, "Headroom defaults on without an override");
  assert.equal(headroom.url(), undefined);
  const starting = headroom.start();
  await starting;
  assert.equal(headroom.state().running, true);
  assert.equal(headroom.url(), `http://127.0.0.1:${port}`);
  await headroom.start(); // idempotent: no second proxy
  const nativeFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new Error("Fixture transient timeout"); }) as typeof fetch;
    const observation = await headroom.probe();
    assert.equal(observation.reachable, false);
    assert.equal(observation.running, true, "Read-only inspection preserves cached routing on transient probe failure");
    assert.equal(headroom.url(), `http://127.0.0.1:${port}`);
    const refreshed = await headroom.probe(true);
    assert.equal(refreshed.reachable, false);
    assert.equal(refreshed.running, false, "Explicit repair invalidates unavailable proxy routing");
    assert.equal(headroom.url(), undefined);
    globalThis.fetch = nativeFetch;
    assert.equal((await headroom.probe(true)).reachable, true);
    assert.equal(headroom.url(), undefined, "A successful probe never enables routing or resets a safety latch");
  } finally { globalThis.fetch = nativeFetch; }
  const launches = fs.readFileSync(process.env.CAPTURE, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.ok(launch.nice >= 15);
  assert.ok(launch.args.includes("--no-code-aware"));
  assert.ok(launch.args.includes("--no-ccr"), "Clients without a retrieval tool must receive output instead of unresolved CCR markers");
  assert.ok(!launch.args.includes("--lossless"), "Disabling CCR must preserve the existing compression pipeline");
  assert.ok(launch.args.includes("--disable-kompress"));
  assert.ok(launch.args.includes("--disable-kompress-fallback"));
  assert.ok(!launch.args.includes("--no-rate-limit"));
  for (const flag of ["--compression-max-workers", "--workers", "--anthropic-pre-upstream-concurrency"]) assert.equal(launch.args[launch.args.indexOf(flag) + 1], "1");
  assert.deepEqual(Object.values(launch.env), ["1", "1", "1", "1", "1", "1", "false", "0"]);
  const guard = new ResourceGuard();
  guard.sample({ rssBytes: 100, ticks: 0, time: 1000 });
  for (let sec = 5; sec < 30; sec += 5) assert.equal(guard.sample({ rssBytes: 100, ticks: sec * 90, time: 1000 + sec * 1000 }).reason, 0);
  assert.equal(guard.sample({ rssBytes: 100, ticks: 2700, time: 31_000 }).reason, 2);
  assert.equal(new ResourceGuard().sample({ rssBytes: 1024 ** 3 + 1, ticks: 0, time: 1 }).reason, 1);
  for (let i = 0; i < 5000; i++) diagnostic("resource", { rssBytes: i, cpuPercent: 12, PROMPT_SECRET: 1 });
  const files = fs.readdirSync(process.env.AGENT_CONSOLE_RUN);
  assert.equal(files.length, 2);
  for (const file of files) {
    const full = path.join(process.env.AGENT_CONSOLE_RUN, file);
    assert.ok(fs.statSync(full).size <= 256 * 1024);
    assert.equal(fs.statSync(full).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(full, "utf8"), /PROMPT_SECRET|AUTH_SECRET|auth=/);
  }
  const log = path.join(process.env.AGENT_CONSOLE_RUN, "headroom-diagnostics.jsonl");
  const beforeInvalid = fs.statSync(log).size;
  diagnostic("PROMPT_SECRET" as any);
  assert.equal(fs.statSync(log).size, beforeInvalid, "Runtime event allowlist rejects untrusted event names");
  fs.writeFileSync(log, Buffer.alloc(300 * 1024));
  fs.writeFileSync(`${log}.1`, Buffer.alloc(300 * 1024));
  diagnostic("stop");
  for (const file of fs.readdirSync(process.env.AGENT_CONSOLE_RUN)) assert.ok(fs.statSync(path.join(process.env.AGENT_CONSOLE_RUN, file)).size <= 256 * 1024);
  console.log("PASS Headroom default-on, explicit opt-out, delayed startup, bounded private diagnostics, priority/worker caps, and resource guard");
} finally {
  await headroom.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
