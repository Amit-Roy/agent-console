import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMonitor, createEscalation, loadMonitorConfig, DEFAULTS, type Alert, type MonitorDeps } from "../server/monitor.ts";
import { createEventLog } from "../server/automation/events.ts";

const min = 60_000;
let t = 1_800_000_000_000;
const now = () => t;
const advance = (ms: number) => { t += ms; };

// ---- config: defaults are conservative, files are clamped, escalation never starts live by accident
assert.equal(DEFAULTS.escalation.mode, "dry-run", "agent threads are off until someone opts in");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-monitor-"));
const cfgFile = path.join(scratch, "monitor.json");
assert.deepEqual(loadMonitorConfig(path.join(scratch, "missing.json"), {}), DEFAULTS);
fs.writeFileSync(cfgFile, JSON.stringify({ cpu: { pct: 75 }, intervalMs: 1, escalation: { mode: "live", maxThreadsPerDay: 99999 } }));
const loaded = loadMonitorConfig(cfgFile, {});
assert.equal(loaded.cpu.pct, 75);
assert.ok(loaded.intervalMs >= 1000, "a tight loop would make the monitor the problem");
assert.ok(loaded.escalation.maxThreadsPerDay <= 20);
assert.equal(loaded.escalation.mode, "live");
assert.equal(loadMonitorConfig(cfgFile, { AGENT_CONSOLE_MONITOR_ESCALATION: "off" }).escalation.mode, "off", "env wins");
fs.writeFileSync(cfgFile, "{ not json");
assert.deepEqual(loadMonitorConfig(cfgFile, {}), DEFAULTS, "a broken file falls back to defaults");
assert.equal(loadMonitorConfig(cfgFile, { AGENT_CONSOLE_MONITOR: "off" }).enabled, false);

// ---- monitor: each signal on its own
type Fake = { host?: { cpu: number; mem: number }; failures: number; probe: { ok: boolean; ms: number }; lag: number; headroom: { enabled: boolean; running: boolean; latched: boolean; error?: string } };
function rig(over: Partial<Fake> = {}, cfg = DEFAULTS) {
  const fake: Fake = { host: { cpu: 5, mem: 40 }, failures: 0, probe: { ok: true, ms: 20 }, lag: 5, headroom: { enabled: false, running: false, latched: false }, ...over };
  const alerts: Alert[] = [];
  const deps: MonitorDeps = {
    config: cfg, now, host: () => fake.host, agentFailures: () => fake.failures, probe: async () => fake.probe, lag: () => fake.lag,
    headroom: () => fake.headroom, onAlert: a => alerts.push(a),
  };
  return { fake, alerts, monitor: createMonitor(deps) };
}
const ticks = async (m: { tick(): Promise<void> }, n: number) => { for (let i = 0; i < n; i++) { advance(15_000); await m.tick(); } };

{ // quiet host: nothing fires
  const r = rig();
  await ticks(r.monitor, 30);
  assert.equal(r.alerts.length, 0);
}
{ // CPU needs a sustained breach, fires once, resolves after the clear streak
  const r = rig();
  r.fake.host = { cpu: 97, mem: 40 };
  await ticks(r.monitor, DEFAULTS.cpu.breaches - 1);
  assert.equal(r.alerts.length, 0, "a short spike does not alert");
  await ticks(r.monitor, 1);
  assert.equal(r.alerts.length, 1);
  assert.deepEqual([r.alerts[0].signal, r.alerts[0].state, r.alerts[0].severity, r.alerts[0].threshold], ["cpu", "firing", "critical", DEFAULTS.cpu.pct]);
  assert.equal(r.alerts[0].value, 97);
  await ticks(r.monitor, 20);
  assert.equal(r.alerts.length, 1, "one alert per incident, no repeats while it persists");
  r.fake.host = { cpu: 10, mem: 40 };
  await ticks(r.monitor, DEFAULTS.clearAfter - 1);
  assert.equal(r.alerts.length, 1, "hysteresis: not resolved after one good sample");
  await ticks(r.monitor, 1);
  assert.deepEqual(r.alerts.map(a => a.state), ["firing", "resolved"]);
  assert.equal(r.alerts[1].id, r.alerts[0].id);
}
{ // RAM
  const r = rig({ host: { cpu: 5, mem: 95 } });
  await ticks(r.monitor, DEFAULTS.ram.breaches);
  assert.deepEqual(r.alerts.map(a => a.signal), ["ram"]);
}
{ // agent failures: a window of failure events, independent of Headroom (disabled and healthy)
  const r = rig({ failures: DEFAULTS.agents.failures - 1 });
  await ticks(r.monitor, 5);
  assert.equal(r.alerts.length, 0);
  r.fake.failures = DEFAULTS.agents.failures;
  await ticks(r.monitor, 1);
  assert.deepEqual(r.alerts.map(a => a.signal), ["agents"]);
  assert.match(r.alerts[0].message, /failed/);
}
{ // console health: probe failure, slow probe, and event-loop lag each fire "console"; Headroom stays out of it
  for (const [name, over] of [
    ["probe failure", { probe: { ok: false, ms: 3000 } }],
    ["slow probe", { probe: { ok: true, ms: DEFAULTS.console.slowMs + 1 } }],
    ["event-loop lag", { lag: DEFAULTS.console.lagMs + 1 }],
  ] as const) {
    const r = rig(over);
    await ticks(r.monitor, DEFAULTS.console.breaches);
    assert.deepEqual(r.alerts.map(a => a.signal), ["console"], name);
  }
  const ok = rig({ headroom: { enabled: true, running: false, latched: false, error: "down" } });
  await ticks(ok.monitor, 10);
  assert.ok(!ok.alerts.some(a => a.signal === "console" || a.signal === "agents"), "proxy state never feeds the agent or console signals");
}
{ // Headroom: its own non-escalating signal, and none at all when it is disabled
  const off = rig({ headroom: { enabled: false, running: false, latched: false } });
  await ticks(off.monitor, 10);
  assert.equal(off.alerts.length, 0, "disabling Headroom is not a failure");
  const down = rig({ headroom: { enabled: true, running: false, latched: false, error: "refused" } });
  await ticks(down.monitor, DEFAULTS.headroom.breaches);
  assert.equal(down.alerts.length, 1);
  assert.equal(down.alerts[0].signal, "headroom");
  assert.equal(down.alerts[0].escalate, false);
}
{ // a failing reader must not stop the others or throw out of the tick
  const r = rig({ host: undefined, failures: 9 });
  await assert.doesNotReject(ticks(r.monitor, 1));
  assert.deepEqual(r.alerts.map(a => a.signal), ["agents"], "no host sample yet is skipped, not a breach");
  const broken = createMonitor({ ...({} as MonitorDeps), config: DEFAULTS, now, host: () => { throw new Error("boom"); }, agentFailures: () => 0, probe: async () => ({ ok: true, ms: 1 }), lag: () => 0, headroom: () => ({ enabled: false, running: false, latched: false }), onAlert() {} });
  await assert.doesNotReject(broken.tick());
}

// ---- escalation
type Call = { provider: string; model: string; cwd: string; mode?: string; title: string };
function chain(mode: "off" | "dry-run" | "live", extra: Partial<typeof DEFAULTS.escalation> = {}) {
  const created: Call[] = [], sent: { id: string; text: string }[] = [], owner: { title: string; thread: string }[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-monitor-log-"));
  const log = createEventLog({ file: path.join(dir, "events.jsonl"), now });
  let fail: (o: Call) => boolean = () => false;
  const esc = createEscalation({
    config: { ...DEFAULTS.escalation, mode, ...extra }, now, cwd: "/repo", log: e => log.record(e),
    threads: {
      create: o => { const c = o as Call; if (fail(c)) throw new Error(`${c.provider} is not ready`); created.push(c); return { id: `th${created.length}` }; },
      send: (id, text) => { sent.push({ id, text }); },
    },
    notify: n => { owner.push(n); },
  });
  return { esc, created, sent, owner, log, failWhen: (f: (o: Call) => boolean) => { fail = f; } };
}
let n = 0;
const alert = (over: Partial<Alert> = {}, state: Alert["state"] = "firing"): Alert => ({
  id: `cpu-${over.id ?? 1}`, signal: "cpu", state, severity: "critical", value: 97, threshold: 90, message: "CPU 97% for 2 min", since: t, escalate: true, ...over,
});
const steps = (c: ReturnType<typeof chain>) => c.log.all().filter(e => e.step === "escalate").map(e => e.msg);

{ // off: only the owner, at once
  const c = chain("off");
  c.esc.handle(alert());
  assert.equal(c.created.length, 0);
  assert.equal(c.owner.length, 1);
}
{ // dry-run: logs every handoff it would make, starts nothing, then tells the owner
  const c = chain("dry-run");
  c.esc.handle(alert());
  assert.equal(c.created.length, 0);
  const log = steps(c).join("\n");
  assert.match(log, /dry run.*L3.*pi/s); assert.match(log, /dry run.*L2/s); assert.match(log, /dry run.*L1.*opus/s);
  assert.equal(c.owner.length, 1);
}
{ // live: L3 Pi first, then L2, L1, owner, each only after its wait and only while unresolved
  const c = chain("live");
  c.esc.handle(alert());
  assert.deepEqual(c.created.map(x => x.provider), ["pi"]);
  assert.equal(c.created[0].mode, "plan", "monitor threads investigate, they do not change anything");
  assert.equal(c.created[0].cwd, "/repo");
  assert.match(c.sent[0].text, /CPU 97%/);
  advance(DEFAULTS.escalation.waitMs[0] - 1); c.esc.advance();
  assert.equal(c.created.length, 1, "L2 waits for L3's time");
  advance(2); c.esc.advance();
  assert.deepEqual(c.created.map(x => x.provider), ["pi", "claude"]);
  assert.match(c.sent[1].text, /th1/, "the next level is told who already tried");
  advance(DEFAULTS.escalation.waitMs[1] + 1); c.esc.advance();
  assert.deepEqual(c.created.map(x => `${x.provider}:${x.model}`), ["pi:default", "claude:sonnet", "claude:opus"]);
  assert.equal(c.owner.length, 0);
  advance(DEFAULTS.escalation.waitMs[2] + 1); c.esc.advance();
  assert.equal(c.owner.length, 1, "the owner is last");
  assert.ok(c.log.all().some(e => e.step === "escalate" && e.kind === "fail"), "an unresolved incident shows as a failure on the dashboard");
  advance(10 * 60 * min); c.esc.advance();
  assert.equal(c.created.length, 3); assert.equal(c.owner.length, 1, "the chain ends; nothing repeats");
}
{ // resolution stops the chain at every level
  for (const stopAt of [0, 1, 2, 3]) {
    const c = chain("live");
    c.esc.handle(alert({ id: stopAt }));
    for (let i = 0; i < stopAt; i++) { advance(DEFAULTS.escalation.waitMs[i] + 1); c.esc.advance(); }
    const before = c.created.length, ownerBefore = c.owner.length;
    c.esc.handle(alert({ id: stopAt }, "resolved"));
    advance(24 * 60 * min); c.esc.advance();
    assert.equal(c.created.length, before, `no thread after resolution at level ${stopAt}`);
    assert.equal(c.owner.length, ownerBefore);
    assert.match(steps(c).at(-1) ?? "", /resolved/);
  }
}
{ // L2 falls back to Codex when Claude is not ready; the handoff is not lost
  const c = chain("live");
  c.failWhen(o => o.provider === "claude" && o.model === "sonnet");
  c.esc.handle(alert());
  advance(DEFAULTS.escalation.waitMs[0] + 1); c.esc.advance();
  assert.deepEqual(c.created.map(x => x.provider), ["pi", "codex"]);
}
{ // a level that cannot start anywhere is logged and the chain still reaches the next level
  const c = chain("live");
  c.failWhen(() => true);
  c.esc.handle(alert());
  assert.equal(c.created.length, 0);
  assert.match(steps(c).join("\n"), /could not start/);
  advance(DEFAULTS.escalation.waitMs[0] + 1); c.esc.advance();
  advance(DEFAULTS.escalation.waitMs[1] + 1); c.esc.advance();
  advance(DEFAULTS.escalation.waitMs[2] + 1); c.esc.advance();
  assert.equal(c.owner.length, 1);
}
{ // a flapping check reopens the same incident: no second L3 thread, no restarted chain
  const c = chain("live");
  for (let i = 0; i < 6; i++) {
    c.esc.handle(alert({ id: 1 + i }));
    advance(30_000);
    c.esc.handle(alert({ id: 1 + i }, "resolved"));
    advance(30_000);
  }
  assert.equal(c.created.length, 1, "six flaps within the cooldown start one thread");
}
{ // a different signal is its own incident, but the global gates still hold
  const c = chain("live", { maxThreadsPerDay: 2, minGapMs: 5 * min });
  c.esc.handle(alert({ id: "a", signal: "cpu" }));
  c.esc.handle(alert({ id: "b", signal: "ram" }));
  assert.equal(c.created.length, 1, "minimum gap between thread starts");
  advance(6 * min);
  c.esc.advance();
  assert.equal(c.created.length, 1, "a gated start is skipped, not queued forever");
  c.esc.handle(alert({ id: "c", signal: "agents" }));
  c.esc.handle(alert({ id: "d", signal: "console" }));
  advance(6 * min); c.esc.advance();
  assert.ok(c.created.length <= 2, "daily cap");
  assert.match(steps(c).join("\n"), /gated/);
  advance(25 * 60 * min);
  c.esc.handle(alert({ id: "e", signal: "cpu" }, "resolved")); // old incident closes
  advance(DEFAULTS.escalation.cooldownMs + min);
  c.esc.handle(alert({ id: "f", signal: "cpu" }));
  assert.equal(c.created.length, 3, "the day window rolls");
}
{ // non-escalating signals go straight to the owner and never start a thread
  const c = chain("live");
  c.esc.handle(alert({ signal: "headroom", escalate: false, severity: "warning" }));
  assert.equal(c.created.length, 0);
  assert.equal(c.owner.length, 1);
}
{ // a resolved alert for an unknown incident is ignored
  const c = chain("live");
  assert.doesNotThrow(() => c.esc.handle(alert({}, "resolved")));
}

console.log("monitor ok");
