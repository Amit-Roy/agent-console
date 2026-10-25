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
  escalation: {
    mode: EscalationMode;
    waitMs: [number, number, number];
    maxThreadsPerDay: number;
    minGapMs: number;
    cooldownMs: number;
  };
}

export const DEFAULTS: MonitorConfig = {
  enabled: true,
  intervalMs: 15_000,
  clearAfter: 3,
  cpu: { pct: 90, breaches: 8 }, // 8 samples x 15 s = 2 minutes at or above 90%
  ram: { pct: 90, breaches: 4 }, // 1 minute at or above 90% used
  agents: { failures: 3, windowMs: 15 * MIN }, // 3 failed agent runs in 15 minutes
  console: { slowMs: 2000, lagMs: 1000, breaches: 2 }, // probe failing/slow, or event-loop p99 lag, twice in a row
  headroom: { breaches: 4 },
  escalation: {
    mode: "dry-run",
    waitMs: [10 * MIN, 15 * MIN, 20 * MIN],
    maxThreadsPerDay: 3,
    minGapMs: 5 * MIN,
    cooldownMs: 30 * MIN,
  },
};

const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const int = (v: unknown, lo: number, hi: number, fallback: number) =>
  Math.round(num(v, lo, hi, fallback));

/** Defaults, then the optional JSON file, then env. Every number is clamped so a typo cannot turn the monitor into a busy loop. */
export function loadMonitorConfig(
  file: string,
  env: Record<string, string | undefined> = process.env,
): MonitorConfig {
  let f: any = {};
  try {
    f = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {
    /* missing or broken: defaults */
  }
  const d = DEFAULTS,
    e = f.escalation ?? {};
  const mode = (env.AGENT_CONSOLE_MONITOR_ESCALATION ?? e.mode) as EscalationMode;
  const w = Array.isArray(e.waitMs) ? e.waitMs : [];
  return {
    enabled: env.AGENT_CONSOLE_MONITOR === "off" ? false : f.enabled !== false,
    intervalMs: int(f.intervalMs, 1000, 10 * MIN, d.intervalMs),
    clearAfter: int(f.clearAfter, 1, 20, d.clearAfter),
    cpu: {
      pct: num(f.cpu?.pct, 0, 100, d.cpu.pct),
      breaches: int(f.cpu?.breaches, 1, 240, d.cpu.breaches),
    },
    ram: {
      pct: num(f.ram?.pct, 0, 100, d.ram.pct),
      breaches: int(f.ram?.breaches, 1, 240, d.ram.breaches),
    },
    agents: {
      failures: int(f.agents?.failures, 1, 100, d.agents.failures),
      windowMs: int(f.agents?.windowMs, MIN, 24 * 60 * MIN, d.agents.windowMs),
    },
    console: {
      slowMs: int(f.console?.slowMs, 100, 60_000, d.console.slowMs),
      lagMs: int(f.console?.lagMs, 50, 60_000, d.console.lagMs),
      breaches: int(f.console?.breaches, 1, 240, d.console.breaches),
    },
    headroom: { breaches: int(f.headroom?.breaches, 1, 240, d.headroom.breaches) },
    escalation: {
      mode: mode === "off" || mode === "live" || mode === "dry-run" ? mode : d.escalation.mode,
      waitMs: [0, 1, 2].map((i) => int(w[i], MIN, 24 * 60 * MIN, d.escalation.waitMs[i])) as [
        number,
        number,
        number,
      ],
      maxThreadsPerDay: int(e.maxThreadsPerDay, 0, 20, d.escalation.maxThreadsPerDay),
      minGapMs: int(e.minGapMs, 0, 24 * 60 * MIN, d.escalation.minGapMs),
      cooldownMs: int(e.cooldownMs, 0, 24 * 60 * MIN, d.escalation.cooldownMs),
    },
  };
}

export interface Alert {
  id: string;
  signal: SignalId;
  state: "firing" | "resolved";
  severity: "critical" | "warning";
  value: number;
  threshold: number;
  message: string;
  since: number;
  escalate: boolean; // false: owner only (Headroom); agents are never started for it
}

export interface MonitorDeps {
  config: MonitorConfig;
  now: () => number;
  host: () => { cpu: number; mem: number } | undefined; // latest host sample (server/host-history.ts)
  agentFailures: (windowMs: number) => number; // failed agent runs in the window
  probe: () => Promise<{ ok: boolean; ms: number }>; // loopback request to this console
  lag: () => number; // event-loop delay p99 in ms since the last call
  headroom: () => { enabled: boolean; running: boolean; latched: boolean; error?: string };
  onAlert: (a: Alert) => void;
}

type Reading = { breach: boolean; value: number; threshold: number; message: string };
type Tracker = { breaches: number; clears: number; firing?: { id: string; since: number } };

type MonitorContext = {
  deps: MonitorDeps;
  config: MonitorConfig;
  trackers: Map<SignalId, Tracker>;
  seq: number;
  busy: boolean;
};

function emitAlert(ctx: MonitorContext, alert: Alert) {
  try {
    ctx.deps.onAlert(alert);
  } catch (error) {
    console.warn("Monitor alert delivery failed:", (error as Error)?.message);
  }
}

function feedSignal(
  ctx: MonitorContext,
  signal: SignalId,
  need: number,
  reading: Reading,
  severity: Alert["severity"],
  escalate: boolean,
) {
  const tracker = ctx.trackers.get(signal) ?? { breaches: 0, clears: 0 };
  ctx.trackers.set(signal, tracker);
  if (reading.breach) {
    tracker.clears = 0;
    if (!tracker.firing && ++tracker.breaches >= need) {
      tracker.firing = { id: `${signal}-${ctx.deps.now()}-${++ctx.seq}`, since: ctx.deps.now() };
      emitAlert(ctx, {
        id: tracker.firing.id,
        signal,
        state: "firing",
        severity,
        value: reading.value,
        threshold: reading.threshold,
        message: reading.message,
        since: tracker.firing.since,
        escalate,
      });
    }
    return;
  }
  tracker.breaches = 0;
  if (tracker.firing && ++tracker.clears >= ctx.config.clearAfter) {
    emitAlert(ctx, {
      id: tracker.firing.id,
      signal,
      state: "resolved",
      severity,
      value: reading.value,
      threshold: reading.threshold,
      message: `${signal} back to normal: ${reading.message}`,
      since: tracker.firing.since,
      escalate,
    });
    tracker.firing = undefined;
    tracker.clears = 0;
  }
}

const safeRead = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

function sampleHost(ctx: MonitorContext) {
  const host = safeRead(ctx.deps.host);
  if (!host) return;
  const config = ctx.config;
  feedSignal(
    ctx,
    "cpu",
    config.cpu.breaches,
    {
      breach: host.cpu >= config.cpu.pct,
      value: host.cpu,
      threshold: config.cpu.pct,
      message: `CPU ${host.cpu.toFixed(1)}% (limit ${config.cpu.pct}%)`,
    },
    "critical",
    true,
  );
  feedSignal(
    ctx,
    "ram",
    config.ram.breaches,
    {
      breach: host.mem >= config.ram.pct,
      value: host.mem,
      threshold: config.ram.pct,
      message: `RAM ${host.mem.toFixed(1)}% used (limit ${config.ram.pct}%)`,
    },
    "critical",
    true,
  );
}

function sampleAgents(ctx: MonitorContext) {
  const config = ctx.config;
  const failed = safeRead(() => ctx.deps.agentFailures(config.agents.windowMs));
  if (failed === undefined) return;
  feedSignal(
    ctx,
    "agents",
    1,
    {
      breach: failed >= config.agents.failures,
      value: failed,
      threshold: config.agents.failures,
      message: `${failed} agent runs failed in the last ${Math.round(config.agents.windowMs / MIN)} min (limit ${config.agents.failures})`,
    },
    "critical",
    true,
  );
}

function consoleProblem(
  config: MonitorConfig,
  probe: { ok: boolean; ms: number },
  lag: number,
): string {
  if (!probe.ok) return "loopback request failed";
  if (probe.ms > config.console.slowMs)
    return `loopback request took ${probe.ms} ms (limit ${config.console.slowMs})`;
  if (lag > config.console.lagMs)
    return `event-loop lag ${Math.round(lag)} ms (limit ${config.console.lagMs})`;
  return "";
}

async function sampleConsole(ctx: MonitorContext) {
  const config = ctx.config;
  const lag = safeRead(ctx.deps.lag) ?? 0;
  const probe = await ctx.deps.probe().catch(() => ({ ok: false, ms: 0 }));
  const why = consoleProblem(config, probe, lag);
  feedSignal(
    ctx,
    "console",
    config.console.breaches,
    {
      breach: !!why,
      value: !probe.ok ? 0 : Math.max(probe.ms, lag),
      threshold:
        !probe.ok || probe.ms > config.console.slowMs
          ? config.console.slowMs
          : config.console.lagMs,
      message: why ? `Console unhealthy: ${why}` : "Console responding",
    },
    "critical",
    true,
  );
}

function sampleHeadroom(ctx: MonitorContext) {
  const headroom = safeRead(ctx.deps.headroom);
  if (!headroom) return;
  const bad = headroom.enabled && !headroom.running; // disabled is a choice, not a failure
  feedSignal(
    ctx,
    "headroom",
    ctx.config.headroom.breaches,
    {
      breach: bad,
      value: bad ? 1 : 0,
      threshold: 1,
      message: bad
        ? `Headroom proxy not running${headroom.latched ? " (circuit breaker latched)" : ""}${headroom.error ? `: ${headroom.error}` : ""}`
        : "Headroom proxy running or disabled",
    },
    "warning",
    false,
  );
}

async function monitorTick(ctx: MonitorContext) {
  if (ctx.busy) return; // a slow probe must not stack ticks
  ctx.busy = true;
  try {
    sampleHost(ctx);
    sampleAgents(ctx);
    await sampleConsole(ctx);
    sampleHeadroom(ctx);
  } finally {
    ctx.busy = false;
  }
}

export function createMonitor(deps: MonitorDeps) {
  const ctx: MonitorContext = {
    deps,
    config: deps.config,
    trackers: new Map<SignalId, Tracker>(),
    seq: 0,
    busy: false,
  };
  return {
    tick: () => monitorTick(ctx),
    status: () =>
      [...ctx.trackers].map(([signal, tracker]) => ({
        signal,
        firing: !!tracker.firing,
        breaches: tracker.breaches,
      })),
  };
}

// ---------------------------------------------------------------- escalation

export type Route = { provider: string; model: string; effort: string };
/** L3 Pi, then L2 Claude or Codex, then L1 Opus, then the owner. Within a level the first provider that is ready wins. */
export const LEVELS: { name: string; routes: Route[] }[] = [
  { name: "L3", routes: [{ provider: "pi", model: "default", effort: "default" }] },
  {
    name: "L2",
    routes: [
      { provider: "claude", model: "sonnet", effort: "medium" },
      { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
    ],
  },
  { name: "L1", routes: [{ provider: "claude", model: "opus", effort: "medium" }] },
];

type Incident = {
  signal: SignalId;
  id: string;
  message: string;
  openedAt: number;
  resolvedAt?: number;
  level: number; // next level to start: 0..2 are agents, 3 the owner, 4 finished
  nextAt: number;
  threads: string[];
  ownerNotified: boolean;
};

export interface EscalationDeps {
  config: MonitorConfig["escalation"];
  now: () => number;
  cwd: string;
  log: (e: NewEvent) => void;
  threads: {
    create(o: {
      provider: string;
      model: string;
      effort: string;
      cwd: string;
      mode: "plan";
      title: string;
    }): { id: string };
    send(id: string, text: string): void;
  };
  notify: (n: { title: string; thread: string }) => void | Promise<void>;
}

const DAY = 24 * 60 * MIN;

type EscalationContext = {
  deps: EscalationDeps;
  config: MonitorConfig["escalation"];
  incidents: Map<SignalId, Incident>;
  starts: number[]; // times of live thread starts, for the gap and daily cap
};

function sayEscalation(
  ctx: EscalationContext,
  msg: string,
  ref: string,
  kind: NewEvent["kind"] = "info",
) {
  ctx.deps.log({ step: "escalate", kind, ref, msg });
}

function incidentPrompt(incident: Incident, level: string) {
  return [
    `Workspace monitor alert (${level}): ${incident.message}`,
    `Signal: ${incident.signal}. Incident ${incident.id}, open since ${new Date(incident.openedAt).toISOString()}.`,
    incident.threads.length
      ? `Earlier responders did not resolve it: threads ${incident.threads.join(", ")}.`
      : "You are the first responder.",
    `Investigate read-only on this host: find the cause (top processes, recent failures, logs). Do not restart, kill or change anything.`,
    `End with the cause and the exact fix you recommend. This is an unattended run: do not ask questions.`,
  ].join("\n");
}

function escalationGate(ctx: EscalationContext): string | undefined {
  const config = ctx.config;
  const nowMs = ctx.deps.now();
  ctx.starts = ctx.starts.filter((startedAt) => nowMs - startedAt < DAY);
  if (ctx.starts.length >= config.maxThreadsPerDay)
    return `daily cap of ${config.maxThreadsPerDay} threads reached`;
  if (ctx.starts.length && nowMs - ctx.starts[ctx.starts.length - 1] < config.minGapMs)
    return `another thread started less than ${Math.round(config.minGapMs / MIN)} min ago`;
}

function startRoute(
  ctx: EscalationContext,
  incident: Incident,
  level: { name: string },
  route: Route,
) {
  const thread = ctx.deps.threads.create({
    ...route,
    cwd: ctx.deps.cwd,
    mode: "plan",
    title: `monitor ${incident.signal}: ${level.name} ${route.provider}`,
  });
  ctx.deps.threads.send(thread.id, incidentPrompt(incident, level.name));
  incident.threads.push(thread.id);
  ctx.starts.push(ctx.deps.now());
  sayEscalation(
    ctx,
    `${level.name} ${route.provider} ${route.model} started thread ${thread.id}`,
    incident.signal,
  );
}

function startLevel(ctx: EscalationContext, incident: Incident) {
  const level = LEVELS[incident.level],
    ref = incident.signal;
  if (ctx.config.mode !== "live") {
    sayEscalation(
      ctx,
      `dry run: would start ${level.name} (${level.routes.map((route) => `${route.provider} ${route.model}`).join(", else ")}) for ${incident.message}`,
      ref,
    );
    return;
  }
  const blocked = escalationGate(ctx);
  if (blocked) {
    sayEscalation(ctx, `gated: ${level.name} not started, ${blocked}`, ref);
    return;
  }
  for (const route of level.routes) {
    try {
      startRoute(ctx, incident, level, route);
      return;
    } catch (error) {
      sayEscalation(
        ctx,
        `${level.name} ${route.provider} could not start: ${(error as Error)?.message ?? error}`,
        ref,
      );
    }
  }
  sayEscalation(ctx, `${level.name} could not start on any provider`, ref);
}

function tellOwner(ctx: EscalationContext, incident: Incident) {
  incident.ownerNotified = true;
  incident.level = 4;
  sayEscalation(ctx, `owner notified: ${incident.message}`, incident.signal, "fail");
  try {
    void Promise.resolve(
      ctx.deps.notify({
        title: `Monitor ${incident.signal}: ${incident.message}`,
        thread: incident.threads.at(-1) ?? "monitor",
      }),
    ).catch(() => console.warn("Monitor owner notification failed."));
  } catch {
    console.warn("Monitor owner notification failed.");
  }
}

function stepIncident(ctx: EscalationContext, incident: Incident) {
  if (incident.level < 3) {
    startLevel(ctx, incident);
    incident.level++;
    incident.nextAt = ctx.deps.now() + ctx.config.waitMs[Math.min(incident.level - 1, 2)];
  } else if (incident.level === 3) tellOwner(ctx, incident);
}

function handleResolved(ctx: EscalationContext, alert: Alert, nowMs: number) {
  const open = ctx.incidents.get(alert.signal);
  if (!open || open.resolvedAt) return;
  open.resolvedAt = nowMs;
  sayEscalation(
    ctx,
    `${alert.signal} resolved; escalation stopped${open.level < 4 ? ` before ${open.level < 3 ? LEVELS[open.level].name : "the owner"}` : " after the owner was told"}`,
    alert.signal,
  );
}

// Same incident: a flapping check never restarts the chain.
function reopenIncident(ctx: EscalationContext, alert: Alert, open: Incident, nowMs: number) {
  if (!open.resolvedAt) return;
  open.resolvedAt = undefined;
  open.nextAt = nowMs + ctx.config.waitMs[Math.min(Math.max(open.level - 1, 0), 2)];
  sayEscalation(
    ctx,
    `${alert.signal} fired again within the cooldown; incident reopened, chain continues`,
    alert.signal,
  );
}

function openIncident(ctx: EscalationContext, alert: Alert, nowMs: number) {
  const incident: Incident = {
    signal: alert.signal,
    id: alert.id,
    message: alert.message,
    openedAt: nowMs,
    level: 0,
    nextAt: nowMs,
    threads: [],
    ownerNotified: false,
  };
  ctx.incidents.set(alert.signal, incident);
  sayEscalation(ctx, `${alert.signal} firing: ${alert.message}`, alert.signal);
  if (!alert.escalate || ctx.config.mode === "off") {
    tellOwner(ctx, incident);
    return;
  }
  if (ctx.config.mode === "dry-run") {
    while (incident.level < 3) {
      startLevel(ctx, incident);
      incident.level++;
    }
    tellOwner(ctx, incident);
    return;
  }
  stepIncident(ctx, incident);
}

function handleAlert(ctx: EscalationContext, alert: Alert) {
  const nowMs = ctx.deps.now(),
    open = ctx.incidents.get(alert.signal);
  if (alert.state === "resolved") return handleResolved(ctx, alert, nowMs);
  if (open && (!open.resolvedAt || nowMs - open.resolvedAt < ctx.config.cooldownMs))
    return reopenIncident(ctx, alert, open, nowMs);
  openIncident(ctx, alert, nowMs);
}

export function createEscalation(deps: EscalationDeps) {
  const ctx: EscalationContext = {
    deps,
    config: deps.config,
    incidents: new Map<SignalId, Incident>(),
    starts: [],
  };
  const handle = (alert: Alert) => handleAlert(ctx, alert);

  /** Run on every monitor tick: starts the next level of any incident that is still unresolved and due. */
  function advance() {
    const nowMs = deps.now();
    for (const incident of ctx.incidents.values())
      if (!incident.resolvedAt && incident.level < 4 && nowMs >= incident.nextAt)
        stepIncident(ctx, incident);
  }

  return { handle, advance, incidents: () => [...ctx.incidents.values()] };
}
