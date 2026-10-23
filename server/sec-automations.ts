import os from "node:os";
import path from "node:path";

// Security automations for the automation dashboard. The VPS runs them (systemd timers, services, OpenCVE); a read-only
// forced-command key (`sec-status-api status`) reports their state as JSON. This module turns that into rows with a colour.
// Green = last run succeeded and the next one is scheduled. Amber = overdue (more than 1.5 periods since the last run).
// Red = the last run failed or the unit is inactive.
export const CACHE_MS = 60_000;
/** On an SSH failure the last good answer is shown (marked stale) for this long, then the status host counts as down. */
export const STALE_MS = 10 * 60_000;
const OVERDUE = 1.5;
const HOUR = 3_600_000;
const BRIDGE_POLL_MS = HOUR;

export const statusKeyFile = () =>
  process.env.SECSTATUS_SSH_KEY || path.join(os.homedir(), ".ssh", "id_secstatus");

export type Tone = "ok" | "warn" | "bad" | "idle";
export type RemoteUnit = {
  id: string;
  name: string;
  link: string;
  schedule: string;
  periodSec: number;
  runnable?: string | null;
  continuous?: boolean;
  active?: string;
  running?: boolean;
  ok: boolean;
  detail?: string | null;
  lastRun: number | null;
  next: number | null;
};
export type BridgeView = {
  enabled: boolean;
  lastTick: { at: number; error?: string } | null;
  open: number;
  merged: number;
  rejected: number;
  failed: number;
};
export type Row = {
  id: string;
  name: string;
  schedule: string;
  tone: Tone;
  label: string;
  detail: string | null;
  lastRun: number | null;
  next: number | null;
  link: string;
  continuous: boolean;
  runnable: "quick-scan" | "tool-watch" | null;
};
export type View = {
  rows: Row[];
  summary: { tone: Tone; bad: number; warn: number };
  reachable: boolean;
  stale: boolean;
  generatedAt: number;
};

const RUNNABLE = new Set(["quick-scan", "tool-watch"]);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const text = (v: unknown, n: number) =>
  typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "?").slice(0, n) : "";
/** Links go to the console's own pages or an https address; nothing else reaches an href. */
const safeLink = (v: unknown) =>
  typeof v === "string" &&
  (/^\/[a-z0-9/_-]{0,60}$/.test(v) || /^https:\/\/[\w.:/-]{1,200}$/.test(v))
    ? v
    : "/security";

/** Re-validate what the VPS says; bad entries are dropped, never repaired. */
export function parseStatus(raw: any): RemoteUnit[] {
  if (!raw || !Array.isArray(raw.units))
    throw new Error("The status host sent an unreadable answer.");
  const out: RemoteUnit[] = [];
  for (const u of raw.units.slice(0, 40)) {
    if (!u || typeof u.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(u.id)) continue;
    out.push({
      id: u.id,
      name: text(u.name, 80) || u.id,
      link: safeLink(u.link),
      schedule: text(u.schedule, 80),
      periodSec: num(u.periodSec) ?? 86400,
      runnable: RUNNABLE.has(u.runnable) ? u.runnable : null,
      continuous: u.continuous === true,
      active: text(u.active, 20),
      running: u.running === true,
      ok: u.ok === true,
      detail: u.detail ? text(u.detail, 300) : null,
      lastRun: num(u.lastRun),
      next: num(u.next),
    });
  }
  return out;
}

const age = (ms: number) =>
  ms < 2 * HOUR
    ? `${Math.floor(ms / 60_000)} min`
    : ms < 48 * HOUR
      ? `${Math.floor(ms / HOUR)} h`
      : `${Math.floor(ms / 86_400_000)} days`;

export function evaluate(u: RemoteUnit, now: number): Row {
  const base = {
    id: u.id,
    name: u.name,
    schedule: u.schedule,
    detail: u.detail ?? null,
    lastRun: u.lastRun,
    next: u.next,
    link: u.link,
    continuous: u.continuous === true,
    runnable: (u.runnable as Row["runnable"]) ?? null,
  };
  const row = (tone: Tone, label: string, detail: string | null = base.detail): Row => ({
    ...base,
    tone,
    label,
    detail,
  });
  if (!u.ok)
    return row(
      "bad",
      u.active && u.active !== "active" && u.active !== "unknown" ? "Inactive" : "Failed",
    );
  if (u.running) return row("ok", "Running");
  if (u.lastRun && now - u.lastRun > OVERDUE * u.periodSec * 1000)
    return row("warn", "Overdue", `No run for ${age(now - u.lastRun)}.`);
  if (!u.lastRun && !u.continuous) return row("idle", "No run yet");
  if (!u.continuous && !u.next) return row("warn", "Not scheduled", "No next run is scheduled.");
  return row("ok", "OK");
}

export function bridgeRow(b: BridgeView, now: number): Row {
  const base = {
    id: "tool-patch",
    name: "Tool patch bridge",
    schedule: "Hourly poll",
    lastRun: b.lastTick?.at ?? null,
    next: b.enabled && b.lastTick ? b.lastTick.at + BRIDGE_POLL_MS : null,
    link: "/security",
    continuous: false,
    runnable: null,
  };
  const counts = `${b.open} open, ${b.merged} merged, ${b.rejected} rejected, ${b.failed} failed`;
  const row = (tone: Tone, label: string, detail: string): Row => ({
    ...base,
    tone,
    label,
    detail,
  });
  if (!b.enabled) return row("idle", "Off", "Disabled in tool-watch.json.");
  if (b.lastTick?.error) return row("bad", "Failed", b.lastTick.error);
  if (b.failed) return row("bad", "Failed", counts);
  if (!b.lastTick) return row("idle", "No run yet", counts);
  if (now - b.lastTick.at > OVERDUE * BRIDGE_POLL_MS) return row("warn", "Overdue", counts);
  return row("ok", "OK", counts);
}

export function summarize(rows: Row[]) {
  const bad = rows.filter((r) => r.tone === "bad").length;
  const warn = rows.filter((r) => r.tone === "warn").length;
  return { tone: (bad ? "bad" : warn ? "warn" : "ok") as Tone, bad, warn };
}

export interface SecAutomationsDeps {
  /** One `status` call to the VPS forced command. */
  fetchStatus: () => Promise<any>;
  bridge: () => BridgeView;
  now?: () => number;
}

export function createSecAutomations(deps: SecAutomationsDeps) {
  const clock = deps.now ?? Date.now;
  let cache: { at: number; units: RemoteUnit[] } | null = null;
  let pending: Promise<RemoteUnit[]> | null = null;

  async function units() {
    if (cache && clock() - cache.at < CACHE_MS) return cache.units;
    pending ||= deps
      .fetchStatus()
      .then((raw) => {
        const parsed = parseStatus(raw);
        cache = { at: clock(), units: parsed };
        return parsed;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return {
    invalidate() {
      cache = null;
    },
    async view(): Promise<View> {
      const now = clock();
      let remote: RemoteUnit[] = [];
      let reachable = true;
      let stale = false;
      let why = "";
      try {
        remote = await units();
      } catch (e: any) {
        why = String(e?.message || "The status host did not answer.");
        if (cache && now - cache.at < STALE_MS) {
          remote = cache.units;
          stale = true;
        } else reachable = false;
      }
      const rows = remote.map((u) => evaluate(u, now));
      if (!reachable)
        rows.unshift({
          id: "status-host",
          name: "VPS status",
          schedule: "On every page load, cached 60 s",
          tone: "bad",
          label: "Unreachable",
          detail: why,
          lastRun: null,
          next: null,
          link: "/security",
          continuous: false,
          runnable: null,
        });
      const after = rows.findIndex((r) => r.id === "tool-watch");
      rows.splice(after < 0 ? rows.length : after + 1, 0, bridgeRow(deps.bridge(), now));
      return { rows, summary: summarize(rows), reachable, stale, generatedAt: now };
    },
  };
}
export type SecAutomations = ReturnType<typeof createSecAutomations>;
