// Offline routing regression: fixture proxy and CLI only; no provider calls or quota.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-headroom-"));
const previous = { ...process.env };
const external = http.createServer((_req, res) => res.end("ok"));
await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
const proxy = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
const base = `${proxy}/v1`;
const capture = path.join(scratch, "capture.jsonl");
const home = path.join(scratch, "codex-home");
fs.mkdirSync(home);
Object.assign(process.env, {
  PATH: `${scratch}${path.delimiter}${previous.PATH}`,
  CODEX_HOME: home,
  OPENAI_API_KEY: "fixture-only-key",
  AGENT_CONSOLE_ENV_FILES: path.join(scratch, "absent-env"),
  AGENT_CONSOLE_RUN: path.join(scratch, "run"),
  AGENT_CONSOLE_HEADROOM: "1",
  AGENT_CONSOLE_HEADROOM_PORT: String((external.address() as AddressInfo).port),
  CODEX_FIXTURE_CAPTURE: capture,
  OPENAI_BASE_URL: `${base}/`,
});
fs.writeFileSync(path.join(scratch, "headroom"), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(path.join(scratch, "unexpected-proxy-spawn"))}, 'unexpected');
process.exit(1);
`, { mode: 0o700 });
fs.writeFileSync(path.join(scratch, "codex"), `#!${process.execPath}
const fs = require('node:fs');
const record = value => fs.appendFileSync(process.env.CODEX_FIXTURE_CAPTURE, JSON.stringify(value) + '\\n');
record({args: process.argv.slice(2), env: Object.fromEntries(['OPENAI_BASE_URL', 'CODEX_HOME', 'OPENAI_API_KEY'].map(key => [key, process.env[key]]))});
let buffer = '', thread;
const send = value => console.log(JSON.stringify(value));
const note = (method, params) => send({method, params: {threadId: thread, ...params}});
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    record({method: message.method, params: message.params});
    if (message.method === 'initialize') send({id: message.id, result: {}});
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      thread = message.params.threadId || 'fixture-new-session';
      send({id: message.id, result: {thread: {id: thread}}});
    }
    if (message.method === 'turn/start') {
      send({id: message.id, result: {turn: {id: 'fixture-turn'}}});
      note('turn/started', {turn: {id: 'fixture-turn'}});
      note('item/completed', {item: {id: 'answer', type: 'agentMessage', text: 'fixture answer'}});
      note('turn/completed', {turn: {id: 'fixture-turn', status: 'completed'}});
    }
    if (message.method === 'thread/compact/start') {
      send({id: message.id, result: {}});
      note('item/completed', {item: {id: 'compact', type: 'contextCompaction'}});
      note('turn/completed', {turn: {status: 'completed'}});
    }
  }
});
`, { mode: 0o700 });

const { headroom } = await import("../server/headroom.ts");
const { codexRouting } = await import("../server/providers/codex-routing.ts");
const { codex } = await import("../server/providers/codex.ts");
const { compactCodex } = await import("../server/providers/codex-compact.ts");
const expectedArgs = ["-c", `openai_base_url=${JSON.stringify(base)}`];
const lines = () => fs.readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
function assertLaunch(launch: any) {
  assert.equal(launch.args[0], "app-server");
  assert.equal(launch.env.OPENAI_BASE_URL, base);
  assert.equal(launch.env.CODEX_HOME, home);
  assert.equal(launch.env.OPENAI_API_KEY, "fixture-only-key");
  const config = launch.args.flatMap((arg: string, i: number) => arg === "-c" || arg === "--config" ? [launch.args[i + 1]] : []);
  assert.ok(config.includes(expectedArgs[1]));
  assert.ok(!config.some((arg: string) => /^model_provider(?:s\.|=)|^chatgpt_base_url=|^forced_login_method=/.test(arg)), "Native provider and auth selection remain intact");
}
function events() {
  const collected: any[] = [];
  const listeners: ((event: any) => void)[] = [];
  let resolveResult: (event: any) => void;
  let resolveExit: () => void;
  const result = new Promise<any>(resolve => { resolveResult = resolve; });
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });
  return { collected, result, exit, nextResult: () => new Promise<any>(resolve => listeners.push(resolve)), ctx: {
    event(event: any) { collected.push(event); if (event.type === "result") { resolveResult(event); for (const resolve of listeners.splice(0)) resolve(event); } },
    commands() {}, exited() { resolveExit(); },
  } };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture timed out")), 5000); })]); }
  finally { clearTimeout(timer!); }
}
try {
  // Disabled/unhealthy state must drop only an inherited managed route.
  for (const enabled of ["0", "1"]) {
    process.env.AGENT_CONSOLE_HEADROOM = enabled;
    const input = { OPENAI_BASE_URL: `${base}/`, CODEX_HOME: home, OPENAI_API_KEY: "fixture-only-key" };
    const snapshot = { ...input };
    const routed = codexRouting(input);
    assert.equal(routed.env.OPENAI_BASE_URL, undefined);
    assert.deepEqual(routed.args, []);
    assert.deepEqual(input, snapshot);
    const custom = { OPENAI_BASE_URL: "https://provider.example/v1" };
    assert.equal(codexRouting(custom).env.OPENAI_BASE_URL, custom.OPENAI_BASE_URL);
  }
  await headroom.start();
  assert.equal(headroom.url(), proxy);
  assert.equal(fs.existsSync(path.join(scratch, "unexpected-proxy-spawn")), false);
  const input = { CODEX_HOME: home, OPENAI_API_KEY: "fixture-only-key" };
  assert.deepEqual(codexRouting(input).args, expectedArgs);
  assert.deepEqual(input, { CODEX_HOME: home, OPENAI_API_KEY: "fixture-only-key" });
  const custom = { OPENAI_BASE_URL: "https://provider.example/v1" };
  assert.deepEqual(codexRouting(custom), { env: custom, args: [] });
  assert.deepEqual(codexRouting({ OPENAI_BASE_URL: `${base}/` }).args, expectedArgs);

  for (const sessionId of [undefined, "fixture-resumed-session"]) {
    const start = fs.existsSync(capture) ? lines().length : 0;
    const e = events();
    const agent = codex.start({ id: "fixture", cwd: scratch, mode: "bypassPermissions", model: "default", sessionId }, e.ctx);
    try {
      agent.send("fixture");
      assert.equal((await bounded(e.result)).is_error, false);
      const captured = lines().slice(start);
      assertLaunch(captured[0]);
      const request = captured.find((row: any) => row.method === (sessionId ? "thread/resume" : "thread/start"));
      assert.ok(request);
      assert.equal(request.params.threadId, sessionId);
      if (sessionId) {
        // The persistent process must retain its routing for native compaction.
        const finished = e.nextResult();
        agent.compact!();
        assert.equal((await bounded(finished)).is_error, false);
        assert.ok(lines().slice(start).some((row: any) => row.method === "thread/compact/start"));
      }
    } finally { agent.kill(); await bounded(e.exit); }
  }
  const start = lines().length;
  const e = events();
  const compact = compactCodex({ id: "fixture", cwd: scratch, mode: "bypassPermissions", model: "default", sessionId: "fixture-native-session" }, e.ctx);
  try {
    assert.equal((await bounded(e.result)).is_error, false);
    const captured = lines().slice(start);
    assertLaunch(captured[0]);
    assert.equal(captured.find((row: any) => row.method === "thread/resume").params.threadId, "fixture-native-session");
    assert.ok(captured.some((row: any) => row.method === "thread/compact/start"));
  } finally { compact.kill(); }
  await headroom.stop();
  assert.equal(headroom.url(), undefined);
  assert.equal((await fetch(`${proxy}/livez`)).status, 200, "Stopping adoption leaves external proxy alive");
  console.log("PASS Codex Headroom: healthy routing, new/resumed sessions, native compaction, stale-route cleanup, endpoint/auth/home preservation, external proxy ownership (offline fixtures)");
} finally {
  await headroom.stop();
  await new Promise<void>(resolve => external.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(scratch, { recursive: true, force: true });
}
