import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Boots the real server with monitoring on, in a scratch data dir with the mock agent. The monitor is tuned so that
// CPU "breaches" at 0%: the alert, the dry-run escalation and the owner notification must all reach the event log.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-monitor-boot-"));
const data = path.join(scratch, "data"), run = path.join(scratch, "run");
fs.mkdirSync(data, { recursive: true, mode: 0o700 }); fs.mkdirSync(run, { recursive: true });
fs.writeFileSync(path.join(data, "monitor.json"), JSON.stringify({ intervalMs: 1000, cpu: { pct: 0, breaches: 1 }, escalation: { mode: "dry-run" } }));
const port = await new Promise<number>(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
assert.notEqual(port, 7070);

const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOME: scratch, PORT: String(port), AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_RUN: run, AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_PAGE: "12" },
});
let output = "";
child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
const events = () => { try { return fs.readFileSync(path.join(data, "automation-events.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const until = async (what: string, ok: () => boolean, ms = 45_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    assert.equal(child.exitCode, null, `server exited while waiting for ${what}:\n${output.slice(-1500)}`);
    assert.ok(Date.now() < end, `timed out waiting for ${what}:\n${output.slice(-1500)}`);
    await new Promise(r => setTimeout(r, 200));
  }
};
try {
  await until("server to listen", () => output.includes("listening on"));
  assert.doesNotMatch(output, /TypeError/);
  await until("monitor start event", () => events().some(e => e.step === "monitor" && /monitor started/.test(e.msg ?? "")));
  await until("cpu alert", () => events().some(e => e.step === "monitor" && e.ref === "cpu" && e.data?.state === "firing"));
  await until("dry-run escalation", () => events().some(e => e.step === "escalate" && /dry run: would start L3/.test(e.msg ?? "")));
  await until("owner notification", () => events().some(e => e.step === "escalate" && /owner notified/.test(e.msg ?? "")));
  const log = events();
  assert.ok(!log.some(e => e.step === "escalate" && /started thread/.test(e.msg ?? "")), "dry run never starts a thread");
  assert.ok(!log.some(e => e.step === "monitor" && (e.ref === "console" || e.ref === "agents") && e.data?.state === "firing"), "a healthy mock server raises no console or agent alert");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, `shutdown must not throw:\n${output.slice(-1500)}`);
  assert.doesNotMatch(output, /TypeError|Cannot read/);
  console.log("monitor startup ok");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(scratch, { recursive: true, force: true });
}
