import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { reconstructClaudeHistory } from "../server/usage-repair.ts";

const logs = {
  sunny: [{ type: "user_input", ts: 1000 }, { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.3 } } } }],
  nefro: [{ type: "user_input", ts: 1000 }, { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.3 } } } }],
};
const result = reconstructClaudeHistory({
  rows: [{ ts: 1000, provider: "claude", label: "5-hour", used: 30, limit: 100 }],
  logs,
  threads: [{ id: "sunny", claudeAccount: "sunny" }, { id: "nefro", claudeAccount: "nefro" }],
});
assert.equal(result.rows.length, 1, "copied legacy events must not credit two accounts");
assert.equal(result.rows[0].provider, "claude:unknown");
assert.equal(result.rows[0].timestampSource, "turn-start");
const receipts = reconstructClaudeHistory({ rows: [{ ts: 500, provider: "pi", label: "Budget", used: 3, limit: 10 }], logs: {
  a: [{ type: "rate_limit_event", observedAt: 900, usageProvider: "claude", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.7 } } } }],
  b: [{ type: "rate_limit_event", observedAt: 900, usageProvider: "claude:nefro", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2 } } } }],
  old: [{ type: "user_input", ts: 800 }, { type: "rate_limit_event", ts: 850, rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1 } } } }],
  missing: [{ type: "rate_limit_event", ts: 850, rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4 } } } }],
}, threads: [{ id: "a", claudeAccount: "sunny" }, { id: "b", claudeAccount: "nefro" }, { id: "old" }] });
assert.deepEqual(receipts.rows.filter(r => r.provider.startsWith("claude")).map(r => [r.provider, r.ts, r.used]).sort(), [
  ["claude", 900, 70], ["claude", 850, 10], ["claude:nefro", 900, 20], ["claude:unknown", 850, 40],
].sort());
assert.deepEqual(receipts.rows.find(r => r.provider === "pi"), { ts: 500, provider: "pi", label: "Budget", used: 3, limit: 10 });

// Exercise explicit migration only against a scratch data directory.
const data = fs.mkdtempSync(path.join(os.tmpdir(), "usage-repair-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_MOCK = "1";
const historyPath = path.join(data, "usage-history.jsonl"), snapshotsPath = path.join(data, "usage.json");
const originalHistory = [
  { ts: 1000, provider: "claude", label: "5-hour", used: 30, limit: 100 },
  { ts: 900, provider: "claude:nefro", label: "5-hour", used: 12, limit: 100, schemaVersion: 2, provenance: "received", observedAt: 900, usageProvider: "claude:nefro" },
  { ts: 1200, provider: "claude", label: "7-day", used: 60, limit: 100 },
  { ts: 1100, provider: "pi", label: "Budget", used: 5, limit: 10 },
].map(x => JSON.stringify(x)).join("\n") + "\n";
fs.writeFileSync(historyPath, originalHistory, { mode: 0o600 });
fs.writeFileSync(snapshotsPath, JSON.stringify({ claude: { updatedAt: 9999, windows: [] }, pi: { updatedAt: 123, windows: [] } }), { mode: 0o600 });
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify(["a", "b"].map(id => ({ id, provider: "claude", cwd: data, mode: "default", status: "idle", model: "fixture", title: id, cost: 0, createdAt: 1, updatedAt: 1, ...(id === "b" ? { claudeAccount: "nefro" } : {}) }))));
fs.mkdirSync(path.join(data, "logs"));
const events = (observedAt: number) => JSON.stringify({ type: "user_input", ts: 1000 }) + "\n" + JSON.stringify({ type: "rate_limit_event", observedAt, usageProvider: "claude", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.3 } } } }) + "\n";
fs.writeFileSync(path.join(data, "logs/a.jsonl"), events(2000));
fs.writeFileSync(path.join(data, "logs/b.jsonl"), JSON.stringify({ type: "user_input", ts: 1000 }) + "\n" + JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.3 } } } }) + "\n");
try {
  const { repairUsageHistory } = await import("../server/usage.ts");
  assert.equal(fs.existsSync(path.join(data, "usage-history.schema-v2")), false, "import alone never migrates");
  const unrelatedPid = path.join(data, "unrelated.pid");
  fs.writeFileSync(unrelatedPid, String(process.ppid));
  repairUsageHistory({ pidFile: unrelatedPid });
  assert.equal(fs.existsSync(path.join(data, "usage-history.schema-v2")), true, "unrelated live PID does not block repair");
  const repaired = fs.readFileSync(historyPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(repaired.some(r => r.provider === "claude:unknown" && r.accountUnresolved));
  assert.ok(repaired.some(r => r.provider === "pi"));
  assert.ok(repaired.some(r => r.provider === "claude" && r.ts === 2000 && r.timestampSource === "received"));
  assert.ok(repaired.some(r => r.provider === "claude:nefro" && r.schemaVersion === 2 && r.ts === 900), "trustworthy versioned rows survive migration");
  assert.equal(fs.readFileSync(`${historyPath}.repair-v2.original`, "utf8"), originalHistory);
  assert.equal(fs.statSync(`${historyPath}.repair-v2.original`).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(data, "usage-history.schema-v2")), true);
  const migratedOnce = fs.readFileSync(historyPath, "utf8");
  repairUsageHistory();
  assert.equal(fs.readFileSync(historyPath, "utf8"), migratedOnce, "completed migration rerun is a no-op");
  assert.doesNotThrow(() => repairUsageHistory({ pidFile: unrelatedPid }), "completed marker makes owner checks unnecessary");
  fs.unlinkSync(unrelatedPid);
  const snapshots = JSON.parse(fs.readFileSync(snapshotsPath, "utf8"));
  assert.equal(snapshots.claude, undefined, "legacy latest quota snapshots are discarded");
  assert.ok(snapshots.pi, "non-Claude latest snapshots survive");
  const beforeRerun = fs.readFileSync(historyPath, "utf8");
  const marker = path.join(data, "usage-history.schema-v2");
  fs.rmSync(marker);
  fs.appendFileSync(historyPath, JSON.stringify({ ts: 3000, provider: "codex", label: "7-day", used: 8, limit: 100 }) + "\n");
  fs.writeFileSync(snapshotsPath, JSON.stringify({ claude: { updatedAt: 3100, observedAt: 3100, usageProvider: "claude", windows: [{ label: "5-hour", used: 8, limit: 100 }] }, pi: { updatedAt: 3200, windows: [] } }));
  repairUsageHistory({ pidFile: path.join(data, "owner.pid") });
  const afterRetry = fs.readFileSync(historyPath, "utf8");
  assert.ok(afterRetry.includes('"provider":"codex","label":"7-day"'), "retry keeps current non-Claude history");
  assert.ok(JSON.parse(fs.readFileSync(snapshotsPath, "utf8")).claude.observedAt === 3100, "retry keeps newer receipt snapshot");
  assert.notEqual(beforeRerun, afterRetry);
  const { Threads } = await import("../server/threads.ts");
  const { PROVIDERS } = await import("../server/providers/index.ts");
  const claude = PROVIDERS.get("claude")!;
  const realStart = claude.start;
  const threads = new Threads(() => {});
  const thread: any = { id: "held-event", provider: "claude", claudeAccount: "nefro", cwd: data, mode: "default", model: "fixture", status: "idle", cost: 0, createdAt: 1, updatedAt: 1 };
  (threads as any).threads.set(thread.id, thread);
  claude.start = (_opts: any, ctx: any) => {
    ctx.event({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4 } } } });
    return { alive: true, send() {}, abort() {}, kill() {} } as any;
  };
  const receivedBefore = Date.now();
  try {
    const live = (threads as any).start(thread, true);
    const heldEvent = live.held[0];
    assert.ok(heldEvent.observedAt >= receivedBefore && heldEvent.observedAt <= Date.now());
    assert.equal(heldEvent.usageProvider, "claude:nefro", "warm-held event stamped before buffering");
  } finally { claude.start = realStart; threads.shutdown(); }
} finally { fs.rmSync(data, { recursive: true, force: true }); }

const broken = fs.mkdtempSync(path.join(os.tmpdir(), "usage-repair-bad-"));
try {
  const file = path.join(broken, "usage-history.jsonl");
  const malformed = "{broken\n";
  fs.writeFileSync(file, malformed);
  fs.writeFileSync(path.join(broken, "usage.json"), "{}");
  const usageUrl = new URL("../server/usage.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const { repairUsageHistory } = await import(${JSON.stringify(usageUrl)}); repairUsageHistory();`], {
    env: { ...process.env, AGENT_CONSOLE_DATA: broken, AGENT_CONSOLE_MOCK: "1" }, encoding: "utf8",
  });
  assert.notEqual(child.status, 0, "malformed history aborts migration");
  assert.equal(fs.readFileSync(file, "utf8"), malformed);
  assert.equal(fs.existsSync(`${file}.repair-v2.original`), false, "parse failure precedes backup/replacement");
  assert.equal(fs.existsSync(path.join(broken, "usage-history.schema-v2")), false);
} finally { fs.rmSync(broken, { recursive: true, force: true }); }

const ownerTest = fs.mkdtempSync(path.join(os.tmpdir(), "usage-repair-owner-"));
const ownerData = path.join(ownerTest, "data"), stubServer = path.join(ownerTest, "server", "index.ts");
fs.mkdirSync(path.dirname(stubServer), { recursive: true }); fs.mkdirSync(ownerData);
fs.writeFileSync(stubServer, "setInterval(() => {}, 1000);\n");
const serverStub = spawn(process.execPath, [stubServer], { stdio: "ignore" });
try {
  await Promise.race([once(serverStub, "spawn"), once(serverStub, "error").then(([error]) => Promise.reject(error))]);
  const command = fs.readFileSync(`/proc/${serverStub.pid}/cmdline`);
  assert.ok(command.includes(Buffer.from("server/index.ts")), "stub PID matches the launcher’s Agent Console process check");
  const history = path.join(ownerData, "usage-history.jsonl"), pid = path.join(ownerTest, "owner.pid");
  const original = JSON.stringify({ ts: 1, provider: "claude", label: "5-hour", used: 1, limit: 100 }) + "\n";
  fs.writeFileSync(history, original); fs.writeFileSync(path.join(ownerData, "usage.json"), "{}"); fs.writeFileSync(pid, String(serverStub.pid));
  const usageUrl = new URL("../server/usage.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const { repairUsageHistory } = await import(${JSON.stringify(usageUrl)}); repairUsageHistory({ pidFile: ${JSON.stringify(pid)} });`], {
    env: { ...process.env, AGENT_CONSOLE_DATA: ownerData, AGENT_CONSOLE_MOCK: "1" }, encoding: "utf8",
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Another Agent Console server owns the data directory/);
  assert.equal(fs.readFileSync(history, "utf8"), original, "live owner rejection precedes mutation");
  assert.equal(fs.existsSync(`${history}.repair-v2.original`), false);
  assert.equal(fs.existsSync(path.join(ownerData, "usage-history.schema-v2")), false);
} finally {
  if (serverStub.exitCode == null) { serverStub.kill(); await once(serverStub, "exit"); }
  fs.rmSync(ownerTest, { recursive: true, force: true });
}
console.log("usage repair: ok");
