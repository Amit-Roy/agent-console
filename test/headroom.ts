// Offline startup regression: delay proxy health and verify no session can inherit the initial unhealthy state.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { diagnostic, ResourceGuard } from "../server/headroom-diagnostics.ts";
import { HeadroomProfileStore } from "../server/headroom-profile.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-headroom-"));
const inheritedHeadroomCommand = process.env.AGENT_CONSOLE_HEADROOM_COMMAND;
const inheritedHeadroomKompress = process.env.AGENT_CONSOLE_HEADROOM_KOMPRESS;
const inheritedEnvFiles = process.env.AGENT_CONSOLE_ENV_FILES;
delete process.env.AGENT_CONSOLE_HEADROOM_COMMAND;
delete process.env.AGENT_CONSOLE_HEADROOM_KOMPRESS;
const fixtureEnvFile = path.join(scratch, "agent-console.env");
fs.writeFileSync(fixtureEnvFile, "");
process.env.AGENT_CONSOLE_ENV_FILES = fixtureEnvFile;
const profilePort = 7391;
const socket = net.createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
fs.writeFileSync(
  path.join(scratch, "headroom"),
  `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
fs.appendFileSync(process.env.CAPTURE, JSON.stringify({args: process.argv.slice(2), env: Object.fromEntries(['HEADROOM_WORKERS','HEADROOM_COMPRESS_WORKERS','OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMEXPR_NUM_THREADS','TOKENIZERS_PARALLELISM','HEADROOM_LOG_MESSAGES','MALLOC_ARENA_MAX','MALLOC_TRIM_THRESHOLD_'].map(k => [k, process.env[k]])), profile: Object.fromEntries(['PYTHONPATH','AGENT_CONSOLE_HEADROOM_PROFILE','AGENT_CONSOLE_HEADROOM_TRACEMALLOC','OTEL_EXPORTER_OTLP_METRICS_ENDPOINT','OTEL_METRIC_EXPORT_INTERVAL','OTEL_SERVICE_NAME','OTEL_TRACES_EXPORTER','OTEL_LOGS_EXPORTER'].map(k => [k, process.env[k]])), nice: require('node:os').getPriority()}) + '\\n');
process.stdout.write('PROMPT_SECRET auth=AUTH_SECRET');
process.stderr.write('ERROR AUTH_SECRET');
setTimeout(() => http.createServer((req, res) => res.end('ok')).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1'), 300);
`,
  { mode: 0o700 },
);
const customCommand = path.join(scratch, "custom-headroom");
fs.writeFileSync(
  customCommand,
  fs
    .readFileSync(path.join(scratch, "headroom"), "utf8")
    .replace("JSON.stringify({args:", "JSON.stringify({command: process.argv[1], args:"),
  { mode: 0o700 },
);
process.env.PATH = `${scratch}:${process.env.PATH}`;
process.env.CAPTURE = path.join(scratch, "capture");
process.env.AGENT_CONSOLE_RUN = path.join(scratch, "run");
process.env.HEADROOM_LOG_MESSAGES = "1";
process.env.AGENT_CONSOLE_HEADROOM = "0";
process.env.AGENT_CONSOLE_HEADROOM_PORT = String(port);
const { headroom, metricsIngest } = await import("../server/headroom.ts");
try {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const routingBeforeStats = headroom.state();
  try {
    let requests = 0;
    AbortSignal.timeout = (milliseconds) => {
      assert.ok(milliseconds >= 4000, "History budget permits the observed 3.51-second response");
      return originalTimeout(milliseconds);
    };
    const measuredEmpty = { series: { daily: [] }, lifetime: { tokens_saved: 1234 } };
    globalThis.fetch = (async (input, options) => {
      requests++;
      assert.equal(String(input), `http://127.0.0.1:${port}/stats-history`);
      assert.ok(options?.signal);
      await Promise.resolve();
      assert.equal(options.signal.aborted, false, "History receives a live timeout signal");
      return Response.json(measuredEmpty);
    }) as typeof fetch;
    const [first, second] = await Promise.all([headroom.stats(), headroom.stats()]);
    assert.deepEqual(
      first,
      measuredEmpty,
      "Disabled and unhealthy routing still exposes measured history",
    );
    assert.deepEqual(second, measuredEmpty);
    assert.equal(requests, 1, "Concurrent dashboard ranges share one history request");
    assert.deepEqual(
      headroom.state(),
      routingBeforeStats,
      "History reads never change routing state",
    );
    assert.equal(fs.existsSync(process.env.CAPTURE), false, "History reads never start the proxy");
    for (const invalid of [{}, { series: { daily: null } }]) {
      globalThis.fetch = (async () => {
        requests++;
        return Response.json(invalid);
      }) as typeof fetch;
      assert.equal(await headroom.stats(), null, "Malformed history is unavailable");
    }
    assert.equal(requests, 3, "Completed history requests are not cached");
    globalThis.fetch = (async () => {
      throw new Error("Fixture unavailable");
    }) as typeof fetch;
    assert.equal(await headroom.stats(), null);
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    assert.equal(await headroom.stats(), null);
    globalThis.fetch = (async () => Response.json(measuredEmpty)) as typeof fetch;
    assert.deepEqual(
      await headroom.stats(),
      measuredEmpty,
      "A failed collection can immediately retry",
    );
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
  const external = net.createServer((socket) =>
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"),
  );
  await new Promise<void>((resolve) => external.listen(port, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/`;
  await headroom.start();
  assert.equal(
    process.env.ANTHROPIC_BASE_URL,
    undefined,
    "Disabled proxy URL is removed from inherited server environment",
  );
  process.env.ANTHROPIC_BASE_URL = "https://provider.example";
  await headroom.start();
  assert.equal(
    process.env.ANTHROPIC_BASE_URL,
    "https://provider.example",
    "External endpoints remain user controlled",
  );
  delete process.env.ANTHROPIC_BASE_URL;
  assert.equal(headroom.url(), undefined);
  assert.equal(headroom.state().enabled, false);
  assert.equal(fs.existsSync(process.env.CAPTURE), false);
  headroom.stop();
  await new Promise<void>((resolve) => external.close(() => resolve()));
  delete process.env.AGENT_CONSOLE_HEADROOM;
  headroom.attachProfile(undefined, profilePort);
  assert.equal(headroom.state().enabled, true, "Headroom defaults on without an override");
  assert.equal(headroom.url(), undefined);
  const starting = headroom.start();
  await starting;
  assert.equal(headroom.state().running, true);
  assert.equal(headroom.url(), `http://127.0.0.1:${port}`);
  await headroom.start(); // idempotent: no second proxy
  const nativeFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("Fixture transient timeout");
    }) as typeof fetch;
    const observation = await headroom.probe();
    assert.equal(observation.reachable, false);
    assert.equal(
      observation.running,
      true,
      "Read-only inspection preserves cached routing on transient probe failure",
    );
    assert.equal(headroom.url(), `http://127.0.0.1:${port}`);
    const refreshed = await headroom.probe(true);
    assert.equal(refreshed.reachable, false);
    assert.equal(refreshed.running, false, "Explicit repair invalidates unavailable proxy routing");
    assert.equal(headroom.url(), undefined);
    globalThis.fetch = ((input: RequestInfo | URL) =>
      new Promise<Response>((resolve, reject) => {
        const request = http.get(String(input), (response) => {
          response.resume();
          resolve(new Response(null, { status: response.statusCode ?? 500 }));
        });
        request.once("error", reject);
      })) as typeof fetch;
    assert.equal((await headroom.probe(true)).reachable, true);
    assert.equal(
      headroom.url(),
      undefined,
      "A successful probe never enables routing or resets a safety latch",
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
  const launches = fs
    .readFileSync(process.env.CAPTURE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.ok(launch.nice >= 15);
  assert.ok(launch.args.includes("--no-code-aware"));
  assert.ok(
    launch.args.includes("--no-ccr"),
    "Clients without a retrieval tool must receive output instead of unresolved CCR markers",
  );
  assert.ok(
    !launch.args.includes("--lossless"),
    "Disabling CCR must preserve the existing compression pipeline",
  );
  assert.ok(launch.args.includes("--disable-kompress"));
  assert.ok(launch.args.includes("--disable-kompress-fallback"));
  assert.ok(!launch.args.includes("--no-rate-limit"));
  for (const flag of [
    "--compression-max-workers",
    "--workers",
    "--anthropic-pre-upstream-concurrency",
  ])
    assert.equal(launch.args[launch.args.indexOf(flag) + 1], "1");
  assert.deepEqual(Object.values(launch.env), [
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "false",
    "0",
    "2",
    "131072",
  ]);
  const shimDir = path.join(import.meta.dirname, "..", "server", "headroom-profile");
  assert.equal(launch.profile.PYTHONPATH.split(path.delimiter)[0], shimDir);
  assert.equal(launch.profile.AGENT_CONSOLE_HEADROOM_PROFILE, "1");
  assert.equal(launch.profile.AGENT_CONSOLE_HEADROOM_TRACEMALLOC, undefined);
  assert.equal(launch.env.MALLOC_ARENA_MAX, "2");
  assert.equal(launch.env.MALLOC_TRIM_THRESHOLD_, "131072");
  assert.equal(
    launch.profile.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    `http://127.0.0.1:${profilePort}/v1/metrics`,
  );
  assert.equal(launch.profile.OTEL_METRIC_EXPORT_INTERVAL, "30000");
  assert.equal(launch.profile.OTEL_SERVICE_NAME, "headroom-proxy");
  assert.equal(launch.profile.OTEL_TRACES_EXPORTER, "none");
  assert.equal(launch.profile.OTEL_LOGS_EXPORTER, "none");
  await headroom.stop();
  fs.writeFileSync(
    fixtureEnvFile,
    `AGENT_CONSOLE_HEADROOM_COMMAND=${customCommand}\nAGENT_CONSOLE_HEADROOM_KOMPRESS=1\n`,
  );
  await headroom.start();
  const optInLaunch = fs
    .readFileSync(process.env.CAPTURE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[1];
  assert.equal(optInLaunch.command, customCommand, "Environment file executable path is spawned");
  assert.ok(!optInLaunch.args.includes("--disable-kompress"));
  assert.ok(optInLaunch.args.includes("--disable-kompress-fallback"));
  assert.ok(optInLaunch.args.includes("--no-ccr"));
  await headroom.stop();
  const guard = new ResourceGuard();
  guard.sample({ rssBytes: 100, ticks: 0, time: 1000 });
  for (let sec = 5; sec < 30; sec += 5)
    assert.equal(
      guard.sample({ rssBytes: 100, ticks: sec * 90, time: 1000 + sec * 1000 }).reason,
      0,
    );
  assert.equal(guard.sample({ rssBytes: 100, ticks: 2700, time: 31_000 }).reason, 2);
  assert.equal(
    new ResourceGuard().sample({ rssBytes: 8 * 1024 ** 3 + 1, ticks: 0, time: 1 }).reason,
    1,
  );
  for (let i = 0; i < 5000; i++)
    diagnostic("resource", { rssBytes: i, cpuPercent: 12, PROMPT_SECRET: 1 });
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
  assert.equal(
    fs.statSync(log).size,
    beforeInvalid,
    "Runtime event allowlist rejects untrusted event names",
  );
  fs.writeFileSync(log, Buffer.alloc(300 * 1024));
  fs.writeFileSync(`${log}.1`, Buffer.alloc(300 * 1024));
  diagnostic("stop");
  for (const file of fs.readdirSync(process.env.AGENT_CONSOLE_RUN))
    assert.ok(fs.statSync(path.join(process.env.AGENT_CONSOLE_RUN, file)).size <= 256 * 1024);
  const profileStore = new HeadroomProfileStore(path.join(scratch, "profile.sqlite"));
  const ingest = metricsIngest(() => profileStore);
  const sink = http.createServer((req, res) => void ingest(req, res));
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const sinkPort = (sink.address() as net.AddressInfo).port;
  const fixture = fs.readFileSync(
    path.join(import.meta.dirname, "fixtures", "headroom-otlp-metrics.bin"),
  );
  const post = (body: Buffer, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${sinkPort}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", ...headers },
      body,
    });
  assert.equal((await post(fixture)).status, 200);
  assert.ok(Object.keys(profileStore.query(60_000).metrics).length > 0);
  assert.equal((await post(Buffer.from([0xff, 0xff, 0xff]))).status, 400);
  assert.equal((await post(fixture, { "x-forwarded-for": "203.0.113.9" })).status, 403);
  assert.equal((await post(fixture, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(Buffer.alloc(1024 * 1024 + 1))).status, 413);
  await new Promise<void>((resolve) => sink.close(() => resolve()));
  console.log(
    "PASS Headroom default-on, explicit opt-out, delayed startup, bounded private diagnostics, priority/worker caps, and resource guard",
  );
} finally {
  await headroom.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
  if (inheritedHeadroomCommand === undefined) delete process.env.AGENT_CONSOLE_HEADROOM_COMMAND;
  else process.env.AGENT_CONSOLE_HEADROOM_COMMAND = inheritedHeadroomCommand;
  if (inheritedHeadroomKompress === undefined) delete process.env.AGENT_CONSOLE_HEADROOM_KOMPRESS;
  else process.env.AGENT_CONSOLE_HEADROOM_KOMPRESS = inheritedHeadroomKompress;
  if (inheritedEnvFiles === undefined) delete process.env.AGENT_CONSOLE_ENV_FILES;
  else process.env.AGENT_CONSOLE_ENV_FILES = inheritedEnvFiles;
}
