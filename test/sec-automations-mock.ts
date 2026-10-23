// Mock `sec-status-api status` answers for the security-automation tests: green, amber (overdue) and red.
export const NOW = Date.UTC(2026, 9, 23, 15, 30, 0);
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

export const unit = (over: Record<string, unknown>) => ({
  id: "x",
  name: "Unit",
  link: "/security",
  schedule: "Daily",
  periodSec: 86400,
  runnable: null,
  continuous: false,
  active: "active",
  running: false,
  ok: true,
  detail: null,
  lastRun: NOW - 2 * H,
  next: NOW + 20 * H,
  ...over,
});

export const OPENCVE = "https://vps.example.ts.net:8443";
export function status(over: Record<string, Record<string, unknown>> = {}) {
  const units = [
    unit({
      id: "secscan",
      name: "Security scan (ClamAV, Falco, Trivy, nmap)",
      schedule: "Saturday 23:15 UTC full, quick on demand",
      periodSec: 7 * 86400,
      runnable: "quick-scan",
      lastRun: NOW - 22 * H,
      next: NOW + 31 * H,
    }),
    unit({
      id: "tool-watch",
      name: "Tool watch",
      schedule: "Daily 22:45 UTC",
      runnable: "tool-watch",
      lastRun: NOW - 5 * H,
      next: NOW + 7 * H,
    }),
    unit({
      id: "falco-alert",
      name: "Falco alert forwarder",
      schedule: "Continuous, queue flushed every 5 min",
      periodSec: 300,
      continuous: true,
      lastRun: NOW - 3 * MIN,
      next: NOW + 2 * MIN,
    }),
    unit({
      id: "osv",
      name: "OSV malware check",
      schedule: "Daily 22:30 UTC",
      lastRun: NOW - 16 * H,
      next: NOW + 7 * H,
    }),
    unit({
      id: "opencve-sync",
      name: "OpenCVE sync",
      link: OPENCVE,
      schedule: "Hourly",
      periodSec: 3600,
      active: "unknown",
      lastRun: NOW - 40 * MIN,
      next: NOW + 20 * MIN,
    }),
    unit({
      id: "opencve-digest",
      name: "OpenCVE digest",
      link: OPENCVE,
      schedule: "Daily 22:15 UTC",
      lastRun: NOW - 17 * H,
      next: NOW + 6 * H,
    }),
    unit({
      id: "opencve-webhook",
      name: "OpenCVE webhook",
      link: OPENCVE,
      schedule: "Continuous",
      periodSec: 300,
      continuous: true,
      lastRun: null,
      next: null,
    }),
    unit({
      id: "opencve-backup",
      name: "OpenCVE backup",
      link: OPENCVE,
      schedule: "Daily 21:00 UTC",
      lastRun: NOW - 18 * H,
      next: NOW + 5 * H,
    }),
    unit({
      id: "heartbeat",
      name: "Dead-man switch",
      schedule: "Every 5 min",
      periodSec: 300,
      lastRun: NOW - 2 * MIN,
      next: NOW + 3 * MIN,
    }),
  ].map((u) => ({ ...u, ...(over[u.id as string] ?? {}) }));
  return { generatedAt: NOW, units };
}

export const GREEN = status();
export const AMBER = status({ "tool-watch": { lastRun: NOW - 40 * H } });
export const RED = status({
  "opencve-backup": { ok: false, detail: "fresh database backup" },
  heartbeat: { ok: false, detail: "falco-alert inactive; alert queue not flushed for 30 min" },
  "tool-watch": { lastRun: NOW - 40 * H },
});
export const BRIDGE = {
  enabled: true,
  lastTick: { at: NOW - 25 * MIN },
  open: 1,
  merged: 3,
  rejected: 1,
  failed: 0,
};
export { D };
