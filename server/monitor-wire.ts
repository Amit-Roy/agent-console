import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  createMonitor,
  createEscalation,
  loadMonitorConfig,
  type Alert,
  type MonitorConfig,
  type EscalationDeps,
} from "./monitor.ts";
import type { EventLog } from "./automation/events.ts";

// Connects the monitor to this server: the automation event log, push notifications, the threads API and the host sampler.
// Everything runs on the monitor's one timer; there is no other loop, subprocess or listener.

export interface WorkspaceMonitorDeps {
  dataDir: string;
  port: number;
  cwd: string;
  events: EventLog;
  host: () => { cpu: number; mem: number } | undefined;
  headroom: () => { enabled: boolean; running: boolean; latched: boolean; error?: string };
  threads: EscalationDeps["threads"];
  notify: EscalationDeps["notify"];
  now?: () => number;
  config?: MonitorConfig;
}

const FAIL_KEEP = 200;

export function createWorkspaceMonitor(deps: WorkspaceMonitorDeps) {
  const now = deps.now ?? Date.now;
  const config = deps.config ?? loadMonitorConfig(path.join(deps.dataDir, "monitor.json"));
  const failedTurns: number[] = []; // failed agent turns, newest last
  const loop = monitorEventLoopDelay({ resolution: 250 }); // 4 timer wakeups a second; resolution 20 cost 4x more CPU (docs/monitoring.md)

  /** Failed turns come from the threads notifications; failed automation stages from the event log. The larger of the two counts, not the sum: one failure often shows up in both. */
  const agentFailures = (windowMs: number) => {
    const since = now() - windowMs;
    const turns = failedTurns.filter((t) => t >= since).length;
    const stages = deps.events
      .all()
      .filter(
        (e) => e.kind === "fail" && e.ts >= since && e.step !== "monitor" && e.step !== "escalate",
      ).length;
    return Math.max(turns, stages);
  };
  const probe = async () => {
    const t0 = performance.now();
    try {
      const r = await fetch(`http://127.0.0.1:${deps.port}/login`, {
        signal: AbortSignal.timeout(5000),
      }); // the one unauthenticated page
      await r.arrayBuffer();
      return { ok: r.ok, ms: Math.round(performance.now() - t0) };
    } catch {
      return { ok: false, ms: Math.round(performance.now() - t0) };
    }
  };
  const lag = () => {
    const p = loop.percentile(99) / 1e6;
    loop.reset();
    return Number.isFinite(p) ? p : 0;
  };

  const escalation = createEscalation({
    config: config.escalation,
    now,
    cwd: deps.cwd,
    log: (e) => deps.events.record(e),
    threads: deps.threads,
    notify: deps.notify,
  });
  const monitor = createMonitor({
    config,
    now,
    host: deps.host,
    agentFailures,
    probe,
    lag,
    headroom: deps.headroom,
    onAlert: (a: Alert) => {
      deps.events.record({
        step: "monitor",
        kind: "info",
        ref: a.signal,
        msg: a.message,
        data: {
          state: a.state,
          severity: a.severity,
          value: a.value,
          threshold: a.threshold,
          incident: a.id,
        },
      });
      escalation.handle(a);
    },
  });
  const tick = async () => {
    await monitor.tick();
    escalation.advance();
  };
  let timer: NodeJS.Timeout | undefined;
  return {
    config,
    tick,
    /** A failed agent turn (threads notification). */
    noteFailure() {
      failedTurns.push(now());
      if (failedTurns.length > FAIL_KEEP) failedTurns.shift();
    },
    start() {
      if (!config.enabled || timer) return;
      loop.enable();
      deps.events.record({
        step: "monitor",
        kind: "info",
        msg: `monitor started: every ${config.intervalMs / 1000} s, escalation ${config.escalation.mode}`,
      });
      timer = setInterval(() => {
        void tick().catch(() => console.warn("Monitor tick failed."));
      }, config.intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      loop.disable();
    },
    incidents: () => escalation.incidents(),
  };
}
