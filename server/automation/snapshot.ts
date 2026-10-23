import fs from "node:fs";
import path from "node:path";
import {
  FLOW,
  STEP_IDS,
  VERSION,
  type FailureView,
  type HookInfo,
  type RunView,
  type Snapshot,
  type SnapshotRequest,
  type StepId,
  type StepLogRequest,
  type StepLogResponse,
  type StepState,
  type StepView,
  type Trigger,
} from "./contracts.ts";
import { STALE_RUN_MS, type EventLog } from "./events.ts";

const DAY = 86_400_000;

export interface ApiDeps {
  log: EventLog;
  now?: () => number;
  config: () => Snapshot["config"];
  hooks: () => HookInfo[];
  runs: () => RunView[];
  schedules: () => { id: string; title: string; schedule: string; enabled: boolean }[];
}

/** Pre-push hooks in dispatched worktrees: which branch each one protects. */
export function scanHooks(worktrees: string): HookInfo[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(worktrees);
  } catch {
    return [];
  }
  const out: HookInfo[] = [];
  for (const name of names.sort()) {
    const wt = path.join(worktrees, name);
    try {
      const gitdir = /^gitdir:\s*(.+)$/m
        .exec(fs.readFileSync(path.join(wt, ".git"), "utf8"))?.[1]
        ?.trim();
      if (!gitdir) continue;
      const script = fs.readFileSync(path.join(gitdir, "ac-hooks", "pre-push"), "utf8");
      out.push({
        worktree: name,
        path: wt,
        hook: "pre-push",
        protects: /refs\/heads\/([^"\s]+)/.exec(script)?.[1] ?? "?",
      });
    } catch {
      /* not a worktree, or no hook */
    }
  }
  return out;
}

function checkVersion(v: unknown) {
  if (v !== undefined && v !== VERSION) throw new Error(`Unsupported request version ${String(v)}`);
}

export function automationApi(deps: ApiDeps) {
  const now = deps.now ?? Date.now;

  function steps(cfg: Snapshot["config"]): StepView[] {
    const t = now(),
      events = deps.log.all(),
      open = deps.log.openRuns();
    return STEP_IDS.map((id): StepView => {
      const mine = events.filter((e) => e.step === id);
      const live = open.filter((r) => r.step === id && t - r.ts < STALE_RUN_MS).length;
      const stale = open.filter((r) => r.step === id && t - r.ts >= STALE_RUN_MS).length;
      const last = [...mine].reverse().find((e) => e.kind !== "start");
      const failures = mine.filter((e) => e.kind === "fail" && t - e.ts < DAY).length;
      const disabled =
        (id === "dispatcher" && !cfg.dispatch.enabled) || (id === "opener" && !cfg.opener.enabled);
      const state: StepState = disabled
        ? "disabled"
        : live
          ? "active"
          : stale
            ? "abandoned"
            : !last
              ? "idle"
              : last.kind === "fail" && t - last.ts < DAY
                ? "failed"
                : last.kind === "abandoned"
                  ? "abandoned"
                  : "ok";
      const lastAny = mine.at(-1);
      return {
        id,
        state,
        ...(lastAny ? { lastAt: lastAny.ts } : {}),
        ...(last?.msg ? { lastMsg: last.msg } : {}),
        open: live,
        failures,
      };
    });
  }

  function triggers(cfg: Snapshot["config"]): Trigger[] {
    const lastOf = (step: StepId) => deps.log.all().findLast((e) => e.step === step)?.ts;
    const d = cfg.dispatch as any,
      o = cfg.opener as any;
    return [
      {
        id: "webhook",
        kind: "webhook",
        label: "GitHub webhook",
        detail: "Issue events reach the triage worker on :7077, which labels effort and priority",
        enabled: true,
        lastAt: lastOf("triage"),
        pipeline: "pr",
      },
      {
        id: "dispatch-tick",
        kind: "timer",
        label: "Dispatcher tick",
        detail: `Every 5 min; last ${d.leadMinutes} min of a window; ${d.dryRun ? "dry run" : "live"}`,
        enabled: d.enabled,
        lastAt: lastOf("dispatcher"),
        pipeline: "pr",
      },
      {
        id: "opener-tick",
        kind: "timer",
        label: "Window opener tick",
        detail: `Every 5 min; ${o.from}–${o.to} ${o.tz}; ${o.dryRun ? "dry run" : "live"}`,
        enabled: o.enabled,
        lastAt: lastOf("opener"),
        pipeline: "windows",
      },
      {
        id: "monitor-tick",
        kind: "timer",
        label: "Workspace monitor tick",
        detail:
          "Every 15 s: host CPU and RAM, agent failures, console health; unresolved alerts escalate L3 Pi, L2 Claude or Codex, L1 Opus, owner",
        enabled: true,
        lastAt: lastOf("monitor"),
        pipeline: "monitor",
      },
      {
        id: "turn-end",
        kind: "hook",
        label: "Issue turn-end hook",
        detail:
          "When a Trivial or BAU worker ends its turn with a PR, a reviewer thread starts; changes requested go back to the worker",
        enabled: true,
        lastAt: lastOf("review"),
        pipeline: "pr",
      },
      ...deps.schedules().map(
        (s): Trigger => ({
          id: `cron-${s.id}`,
          kind: "cron",
          label: s.title,
          detail: s.schedule,
          enabled: s.enabled,
        }),
      ),
      {
        id: "debug",
        kind: "manual",
        label: "Debug button",
        detail: "Starts a debugging thread with the automation skill",
        enabled: true,
      },
    ].map((t) => (t.lastAt === undefined ? (({ lastAt, ...rest }) => rest)(t) : t) as Trigger);
  }

  function snapshot(req: SnapshotRequest = {}): Snapshot {
    checkVersion(req.v);
    const limit = Math.min(100, Math.max(1, Math.floor(req.limit ?? 20)));
    const cfg = deps.config();
    const failures: FailureView[] = deps.log
      .all()
      .filter((e) => e.kind === "fail")
      .slice(-limit)
      .reverse()
      .map((e) => ({ ts: e.ts, step: e.step, ...(e.ref ? { ref: e.ref } : {}), msg: e.msg ?? "" }));
    return {
      v: VERSION,
      now: now(),
      flow: FLOW,
      steps: steps(cfg),
      triggers: triggers(cfg),
      runs: deps.runs(),
      failures,
      hooks: deps.hooks(),
      config: cfg,
    };
  }

  function log(req: StepLogRequest): StepLogResponse {
    checkVersion(req.v);
    if (!STEP_IDS.includes(req.step)) throw new Error(`Unknown step "${req.step}"`);
    const page = deps.log.read({ step: req.step, limit: req.limit, before: req.before });
    return {
      v: VERSION,
      step: req.step,
      entries: page.events,
      ...(page.next != null ? { next: page.next } : {}),
    };
  }
  return { snapshot, log };
}
