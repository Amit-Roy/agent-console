// Offline: a fake `pi` on PATH. A 429 that outlives pi's own auto-retry is re-sent once, only if no tool ran.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi429-"));
process.env.AGENT_CONSOLE_DATA = tmp;
process.env.PATH = `${tmp}/bin:${process.env.PATH}`;
fs.mkdirSync(`${tmp}/bin`);
// FAKE_PI_MODE: "recover" = 2nd prompt works; "always" = every prompt 429s; "tool" = 1st reply made a tool call, then 429s
fs.writeFileSync(`${tmp}/bin/pi`, `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => console.log(JSON.stringify(o));
const mode = process.env.FAKE_PI_MODE; let n = 0;
rl.on("line", (l) => {
  const r = JSON.parse(l); if (r.type !== "prompt") return;
  n++; out({ id: r.id, type: "response", command: "prompt", success: true });
  out({ type: "agent_start" });
  const fail = mode !== "recover" || n === 1;
  const content = mode === "tool" ? [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x" } }] : [];
  if (fail) {
    out({ type: "message_end", message: { role: "assistant", content, stopReason: "error", errorMessage: '429 {"status":429,"title":"Too Many Requests"}' } });
    out({ type: "auto_retry_end", success: false, attempt: 3, finalError: '429 {"status":429,"title":"Too Many Requests"}' });
  } else out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok:" + r.message }], stopReason: "stop" } });
  out({ type: "agent_settled" });
});
`, { mode: 0o755 });

const { pi } = await import("../server/providers/pi.ts");
const { startModelRateBroker } = await import("../server/providers/model-rate-client.ts");
startModelRateBroker(1, tmp); // the queue runs in this process; the fake Pi never calls the broker

async function run(mode: string) {
  process.env.FAKE_PI_MODE = mode;
  const events: any[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const agent = pi.start({ id: `t-${mode}`, model: "nvidia/x", cwd: tmp, mode: "bypassPermissions" } as any, {
    event(ev) { events.push(ev); if (ev.type === "result") done(); },
    commands() {},
    exited() {},
  });
  agent.send("hello", []);
  await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${mode}: ${JSON.stringify(events)}`)), 15_000))]);
  await new Promise((r) => setTimeout(r, 300)); // any stray second result
  agent.kill();
  return events;
}

const ok = await run("recover");
assert.equal(ok.filter((e) => e.type === "result").length, 1, "one result");
assert.equal(ok.find((e) => e.type === "result").is_error, false, "recovered turn succeeds");
assert.ok(ok.some((e) => e.subtype === "api_retry" && e.error_status === 429), "retry notice shown");
assert.ok(!ok.some((e) => e.type === "console_error"), "no error surfaced");

const again = await run("always");
assert.equal(again.find((e) => e.type === "result").is_error, true, "second 429 fails the turn");
assert.equal(again.filter((e) => e.subtype === "api_retry").length, 1, "only one re-send");

const tool = await run("tool");
assert.equal(tool.find((e) => e.type === "result").is_error, true, "tool call blocks re-send");
assert.ok(!tool.some((e) => e.subtype === "api_retry"), "no re-send after tool call");
console.log("pi-429-retry ok");
process.exit(0);
