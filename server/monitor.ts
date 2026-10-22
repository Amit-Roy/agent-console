import fs from "node:fs";
import type { NewEvent } from "./automation/events.ts";

// Workspace monitor (issue #19). Design, thresholds, payloads and measured overhead: docs/monitoring.md.
// Four signals are read on one timer: host CPU, host RAM, agent failures and console health. Headroom has its own
// signal that never feeds the others. A signal fires after a sustained breach and resolves after a clear streak.
// Alerts go to the escalation chain, which starts nothing unless the configuration says "live".

const MIN = 60_000;
export type SignalId = "cpu" | "ram" | "agents" | "console" | "headroom";
export type EscalationMode = "off" | "dry-run" | "live";

export interface MonitorConfig {
  enabled: boolean;
  intervalMs: number;
  clearAfter: number; // consecutive good samples before an alert resolves
  cpu: { pct: number; breaches: number };
  ram: { pct: number; breaches: number };
  agents: { failures: number; windowMs: number };
  console: { slowMs: number; lagMs: number; breaches: number };
  headroom: { breaches: number };
  escalation: { mode: EscalationMode; waitMs: [number, number, number]; maxThreadsPerDay: number; minGapMs: number; cooldownMs: number };
}

export const DEFAULTS: MonitorConfig = {
  enabled: true, intervalMs: 15_000, clearAfter: 3,
  cpu: { pct: 90, breaches: 8 },                            // 8 samples x 15 s = 2 minutes at or above 90%
  ram: { pct: 90, breaches: 4 },                            // 1 minute at or above 90% used
  agents: { failures: 3, windowMs: 15 * MIN },              // 3 failed agent runs in 15 minutes
  console: { slowMs: 2000, lagMs: 1000, breaches: 2 },      // probe failing/slow, or event-loop p99 lag, twice in a row
  headroom: { breaches: 4 },
  escalation: { mode: "dry-run", waitMs: [10 * MIN, 15 * MIN, 20 * MIN], maxThreadsPerDay: 3, minGapMs: 5 * MIN, cooldownMs: 30 * MIN },
};

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const int = (v: unknown, lo: number, hi: number, fallback: number) => Math.round(num(v, lo, hi, fallback));

/** Defaults, then the optional JSON file, then env. Every number is clamped so a typo cannot turn the monitor into a busy loop. */
export function loadMonitorConfig(file: string, env: Record<string, string | undefined> = process.env): MonitorConfig {
  let f: any = {};
  try { f = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { /* missing or broken: defaults */ }
  const d = DEFAULTS, e = f.escalation ?? {};
  const mode = (env.AGENT_CONSOLE_MONITOR_ESCALATION ?? e.mode) as EscalationMode;
  const w = Array.isArray(e.waitMs) ? e.waitMs : [];
  return {
    enabled: env.AGENT_CONSOLE_MONITOR === "off" ? false : f.enabled !== false,
    intervalMs: int(f.intervalMs, 1000, 10 * MIN, d.intervalMs),
    clearAfter: int(f.clearAfter, 1, 20, d.clearAfter),
    cpu: { pct: num(f.cpu?.pct, 0, 100, d.cpu.pct), breaches: int(f.cpu?.breaches, 1, 240, d.cpu.breaches) },
    ram: { pct: num(f.ram?.pct, 0, 100, d.ram.pct), breaches: int(f.ram?.breaches, 1, 240, d.ram.breaches) },
    agents: { failures: int(f.agents?.failures, 1, 100, d.agents.failures), windowMs: int(f.agents?.windowMs, MIN, 24 * 60 * MIN, d.agents.windowMs) },
    console: { slowMs: int(f.console?.slowMs, 100, 60_000, d.console.slowMs), lagMs: int(f.console?.lagMs, 50, 60_000, d.console.lagMs), breaches: int(f.console?.breaches, 1, 240, d.console.breaches) },
    headroom: { breaches: int(f.headroom?.breaches, 1, 240, d.headroom.breaches) },
    escalation: {
      mode: mode === "off" || mode === "live" || mode === "dry-run" ? mode : d.escalation.mode,
      waitMs: [0, 1, 2].map(i => int(w[i], MIN, 24 * 60 * MIN, d.escalation.waitMs[i])) as [number, number, number],
      maxThreadsPerDay: int(e.maxThreadsPerDay, 0, 20, d.escalation.maxThreadsPerDay),
      minGapMs: int(e.minGapMs, 0, 24 * 60 * MIN, d.escalation.minGapMs),
      cooldownMs: int(e.cooldownMs, 0, 24 * 60 * MIN, d.escalation.cooldownMs),
    },
  };
}

export interface Alert {
  id: string; signal: SignalId; state: "firing" | "resolved"; severity: "critical" | "warning";
  value: number; threshold: number; message: string; since: number;
  escalate: boolean; // false: owner only (Headroom); agents are never started for it
}

export interface MonitorDeps {
  config: MonitorConfig;
  now: () => number;
  host: () => { cpu: number; mem: number } | undefined;      // latest host sample (server/host-history.ts)
  agentFailures: (windowMs: number) => number;                // failed agent runs in the window
  probe: () => Promise<{ ok: boolean; ms: number }>;          // loopback request to this console
  lag: () => number;                                          // event-loop delay p99 in ms since the last call
  headroom: () => { enabled: boolean; running: boolean; latched: boolean; error?: string };
  onAlert: (a: Alert) => void;
}

type Reading = { breach: boolean; value: number; threshold: number; message: string };
type Tracker = { breaches: number; clears: number; firing?: { id: string; since: number } };

export function createMonitor(deps: MonitorDeps) {
  const c = deps.config;
  const trackers = new Map<SignalId, Tracker>();
  let seq = 0, busy = false;

  function feed(signal: SignalId, need: number, r: Reading, severity: Alert["severity"], escalate: boolean) {
    const tr = trackers.get(signal) ?? { breaches: 0, clears: 0 };
    trackers.set(signal, tr);
    if (r.breach) {
      tr.clears = 0;
      if (!tr.firing && ++tr.breaches >= need) {
        tr.firing = { id: `${signal}-${deps.now()}-${++seq}`, since: deps.now() };
        emit({ id: tr.firing.id, signal, state: "firing", severity, value: r.value, threshold: r.threshold, message: r.message, since: tr.firing.since, escalate });
      }
    } else {
      tr.breaches = 0;
      if (tr.firing && ++tr.clears >= c.clearAfter) {
        emit({ id: tr.firing.id, signal, state: "resolved", severity, value: r.value, threshold: r.threshold, message: `${signal} back to normal: ${r.message}`, since: tr.firing.since, escalate });
        tr.firing = undefined; tr.clears = 0;
      }
    }
  }
  function emit(a: Alert) { try { deps.onAlert(a); } catch (error) { console.warn("Monitor alert delivery failed:", (error as Error)?.message); } }
  const safe = <T>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };

  async function tick() {
    if (busy) return; // a slow probe must not stack ticks
    busy = true;
    try {
      const host = safe(deps.host);
      if (host) {
        feed("cpu", c.cpu.breaches, { breach: host.cpu >= c.cpu.pct, value: host.cpu, threshold: c.cpu.pct, message: `CPU ${host.cpu.toFixed(1)}% (limit ${c.cpu.pct}%)` }, "critical", true);
        feed("ram", c.ram.breaches, { breach: host.mem >= c.ram.pct, value: host.mem, threshold: c.ram.pct, message: `RAM ${host.mem.toFixed(1)}% used (limit ${c.ram.pct}%)` }, "critical", true);
      }
      const failed = safe(() => deps.agentFailures(c.agents.windowMs));
      if (failed !== undefined) {
        feed("agents", 1, { breach: failed >= c.agents.failures, value: failed, threshold: c.agents.failures, message: `${failed} agent runs failed in the last ${Math.round(c.agents.windowMs / MIN)} min (limit ${c.agents.failures})` }, "critical", true);
      }
      const lag = safe(deps.lag) ?? 0;
      const probe = await deps.probe().catch(() => ({ ok: false, ms: 0 }));
      const why = !probe.ok ? "loopback request failed" : probe.ms > c.console.slowMs ? `loopback request took ${probe.ms} ms (limit ${c.console.slowMs})` : lag > c.console.lagMs ? `event-loop lag ${Math.round(lag)} ms (limit ${c.console.lagMs})` : "";
      feed("console", c.console.breaches, { breach: !!why, value: !probe.ok ? 0 : Math.max(probe.ms, lag), threshold: !probe.ok || probe.ms > c.console.slowMs ? c.console.slowMs : c.console.lagMs, message: why ? `Console unhealthy: ${why}` : "Console responding" }, "critical", true);
      const h = safe(deps.headroom);
      if (h) {
        const bad = h.enabled && !h.running; // disabled is a choice, not a failure
        feed("headroom", c.headroom.breaches, { breach: bad, value: bad ? 1 : 0, threshold: 1, message: bad ? `Headroom proxy not running${h.latched ? " (circuit breaker latched)" : ""}${h.error ? `: ${h.error}` : ""}` : "Headroom proxy running or disabled" }, "warning", false);
      }
    } finally { busy = false; }
  }

  return {
    tick,
    status: () => [...trackers].map(([signal, t]) => ({ signal, firing: !!t.firing, breaches: t.breaches })),
  };
}

// ---------------------------------------------------------------- escalation

export type Route = { provider: string; model: string; effort: string };
/** L3 Pi, then L2 Claude or Codex, then L1 Opus, then the owner. Within a level the first provider that is ready wins. */
export const LEVELS: { name: string; routes: Route[] }[] = [
  { name: "L3", routes: [{ provider: "pi", model: "default", effort: "default" }] },
  { name: "L2", routes: [{ provider: "claude", model: "sonnet", effort: "medium" }, { provider: "codex", model: "gpt-6.1-sol", effort: "low" }] },
  { name: "L1", routes: [{ provider: "claude", model: "opus", effort: "medium" }] },
];

type Incident = {
  signal: SignalId; id: string; message: string; openedAt: number; resolvedAt?: number;
  level: number;       // next level to start: 0..2 are agents, 3 the owner, 4 finished
  nextAt: number; threads: string[]; ownerNotified: boolean;
};

export interface EscalationDeps {
  config: MonitorConfig["escalation"];
  now: () => number;
  cwd: string;
  log: (e: NewEvent) => void;
  threads: { create(o: { provider: string; model: string; effort: string; cwd: string; mode: "plan"; title: string }): { id: string }; send(id: string, text: string): void };
  notify: (n: { title: string; thread: string }) => void | Promise<void>;
}

const DAY = 24 * 60 * MIN;

export function createEscalation(deps: EscalationDeps) {
  const cfg = deps.config;
  const incidents = new Map<SignalId, Incident>();
  let starts: number[] = []; // times of live thread starts, for the gap and daily cap

  const say = (msg: string, ref: string, kind: NewEvent["kind"] = "info") => deps.log({ step: "escalate", kind, ref, msg });

  function prompt(i: Incident, level: string) {
    return [
      `Workspace monitor alert (${level}): ${i.message}`,
      `Signal: ${i.signal}. Incident ${i.id}, open since ${new Date(i.openedAt).toISOString()}.`,
      i.threads.length ? `Earlier responders did not resolve it: threads ${i.threads.join(", ")}.` : "You are the first responder.",
      `Investigate read-only on this host: find the cause (top processes, recent failures, logs). Do not restart, kill or change anything.`,
      `End with the cause and the exact fix you recommend. This is an unattended run: do not ask questions.`,
    ].join("\n");
  }

  function gate(): string | undefined {
    const t = deps.now();
    starts = starts.filter(s => t - s < DAY);
    if (starts.length >= cfg.maxThreadsPerDay) return `daily cap of ${cfg.maxThreadsPerDay} threads reached`;
    if (starts.length && t - starts[starts.length - 1] < cfg.minGapMs) return `another thread started less than ${Math.round(cfg.minGapMs / MIN)} min ago`;
  }

  function startLevel(i: Incident) {
    const level = LEVELS[i.level], ref = i.signal;
    if (cfg.mode !== "live") { say(`dry run: would start ${level.name} (${level.routes.map(r => `${r.provider} ${r.model}`).join(", else ")}) for ${i.message}`, ref); return; }
    const blocked = gate();
    if (blocked) { say(`gated: ${level.name} not started, ${blocked}`, ref); return; }
    for (const route of level.routes) {
      try {
        const th = deps.threads.create({ ...route, cwd: deps.cwd, mode: "plan", title: `monitor ${i.signal}: ${level.name} ${route.provider}` });
        deps.threads.send(th.id, prompt(i, level.name));
        i.threads.push(th.id);
        starts.push(deps.now());
        say(`${level.name} ${route.provider} ${route.model} started thread ${th.id}`, ref);
        return;
      } catch (error) { say(`${level.name} ${route.provider} could not start: ${(error as Error)?.message ?? error}`, ref); }
    }
    say(`${level.name} could not start on any provider`, ref);
  }

  function tellOwner(i: Incident) {
    i.ownerNotified = true; i.level = 4;
    say(`owner notified: ${i.message}`, i.signal, "fail");
    try { void Promise.resolve(deps.notify({ title: `Monitor ${i.signal}: ${i.message}`, thread: i.threads.at(-1) ?? "monitor" })).catch(() => console.warn("Monitor owner notification failed.")); }
    catch { console.warn("Monitor owner notification failed."); }
  }

  function step(i: Incident) {
    if (i.level < 3) { startLevel(i); i.level++; i.nextAt = deps.now() + cfg.waitMs[Math.min(i.level - 1, 2)]; }
    else if (i.level === 3) tellOwner(i);
  }

  function handle(a: Alert) {
    const now = deps.now(), open = incidents.get(a.signal);
    if (a.state === "resolved") {
      if (!open || open.resolvedAt) return;
      open.resolvedAt = now;
      say(`${a.signal} resolved; escalation stopped${open.level < 4 ? ` before ${open.level < 3 ? LEVELS[open.level].name : "the owner"}` : " after the owner was told"}`, a.signal);
      return;
    }
    if (open && (!open.resolvedAt || now - open.resolvedAt < cfg.cooldownMs)) { // same incident: a flapping check never restarts the chain
      if (open.resolvedAt) {
        open.resolvedAt = undefined; open.nextAt = now + cfg.waitMs[Math.min(Math.max(open.level - 1, 0), 2)];
        say(`${a.signal} fired again within the cooldown; incident reopened, chain continues`, a.signal);
      }
      return;
    }
    const i: Incident = { signal: a.signal, id: a.id, message: a.message, openedAt: now, level: 0, nextAt: now, threads: [], ownerNotified: false };
    incidents.set(a.signal, i);
    say(`${a.signal} firing: ${a.message}`, a.signal);
    if (!a.escalate || cfg.mode === "off") { tellOwner(i); return; }
    if (cfg.mode === "dry-run") { while (i.level < 3) { startLevel(i); i.level++; } tellOwner(i); return; }
    step(i);
  }

  /** Run on every monitor tick: starts the next level of any incident that is still unresolved and due. */
  function advance() {
    const now = deps.now();
    for (const i of incidents.values()) if (!i.resolvedAt && i.level < 4 && now >= i.nextAt) step(i);
  }

  return { handle, advance, incidents: () => [...incidents.values()] };
}
