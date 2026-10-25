import fs from "node:fs";
import path from "node:path";
import {
  type AutomationEvent,
  type FailureView,
  FLOW,
  type HookInfo,
  type RunView,
  type Snapshot,
  type SnapshotRequest,
  STEP_IDS,
  type StepId,
  type StepLogRequest,
  type StepLogResponse,
  type StepState,
  type StepView,
  type Trigger,
  VERSION,
} from "./contracts.ts";
import { DREAM_TASK_ID } from "./dream.ts";
import { type EventLog, STALE_RUN_MS } from "./events.ts";

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

/** The Effort model switches: `effort_schedule` is the weekly auto-start, the rest map to the steps of the same name. */
function effortStepOn(cfg: Snapshot["config"], id: StepId): boolean {
  if (!id.startsWith("effort_") || !cfg.effort) return true;
  return id === "effort_schedule"
    ? cfg.effort.enabled
    : cfg.effort.steps[id.slice("effort_".length)] !== false;
}

function stepState(
  disabled: boolean,
  live: number,
  stale: number,
  last: AutomationEvent | undefined,
  nowMs: number,
): StepState {
  if (disabled) return "disabled";
  if (live) return "active";
  if (stale) return "abandoned";
  if (!last) return "idle";
  if (last.kind === "fail" && nowMs - last.ts < DAY) return "failed";
  return last.kind === "abandoned" ? "abandoned" : "ok";
}

function stepViews(deps: ApiDeps, nowMs: number, cfg: Snapshot["config"]): StepView[] {
  const events = deps.log.all(),
    open = deps.log.openRuns();
  return STEP_IDS.map((stepId): StepView => {
    const mine = events.filter((event) => event.step === stepId);
    const live = open.filter((run) => run.step === stepId && nowMs - run.ts < STALE_RUN_MS).length;
    const stale = open.filter(
      (run) => run.step === stepId && nowMs - run.ts >= STALE_RUN_MS,
    ).length;
    const last = [...mine].reverse().find((event) => event.kind !== "start");
    const failures = mine.filter((event) => event.kind === "fail" && nowMs - event.ts < DAY).length;
    const disabled =
      (stepId === "dispatcher" && !cfg.dispatch.enabled) ||
      (stepId === "opener" && !cfg.opener.enabled) ||
      !effortStepOn(cfg, stepId);
    const state = stepState(disabled, live, stale, last, nowMs);
    const lastAny = mine.at(-1);
    return {
      id: stepId,
      state,
      ...(lastAny ? { lastAt: lastAny.ts } : {}),
      ...(last?.msg ? { lastMsg: last.msg } : {}),
      open: live,
      failures,
    };
  });
}

function fixedTriggers(cfg: Snapshot["config"], lastOf: (step: StepId) => number | undefined) {
  const dispatch = cfg.dispatch as any,
    opener = cfg.opener as any;
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
      detail: `Every 5 min; last ${dispatch.leadMinutes} min of a window; ${dispatch.dryRun ? "dry run" : "live"}`,
      enabled: dispatch.enabled,
      lastAt: lastOf("dispatcher"),
      pipeline: "pr",
    },
    {
      id: "opener-tick",
      kind: "timer",
      label: "Window opener tick",
      detail: `Every 5 min; ${opener.from}–${opener.to} ${opener.tz}; ${opener.dryRun ? "dry run" : "live"}`,
      enabled: opener.enabled,
      lastAt: lastOf("opener"),
      pipeline: "windows",
    },
    {
      id: "effort-weekly",
      kind: "timer",
      label: "Effort model weekly retrain",
      detail:
        "Every 7 days the triage worker retrains the effort model; Run now starts a retrain at once",
      enabled: effortStepOn(cfg, "effort_schedule"),
      lastAt: lastOf("effort_schedule"),
      pipeline: "effort",
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
  ];
}

function triggerViews(deps: ApiDeps, cfg: Snapshot["config"]): Trigger[] {
  const lastOf = (step: StepId) => deps.log.all().findLast((event) => event.step === step)?.ts;
  return [
    ...fixedTriggers(cfg, lastOf),
    ...deps.schedules().map(
      (schedule): Trigger => ({
        id: `cron-${schedule.id}`,
        kind: "cron",
        label: schedule.title,
        detail: schedule.schedule,
        enabled: schedule.enabled,
        ...(schedule.id === DREAM_TASK_ID
          ? { pipeline: "dream", lastAt: lastOf("dream_run") }
          : {}),
      }),
    ),
    {
      id: "debug",
      kind: "manual",
      label: "Debug button",
      detail: "Starts a debugging thread with the automation skill",
      enabled: true,
    },
  ].map(
    (trigger: any) =>
      (trigger.lastAt === undefined
        ? (({ lastAt, ...rest }) => rest)(trigger)
        : trigger) as Trigger,
  );
}

function findRecovery(events: AutomationEvent[], failure: AutomationEvent) {
  return events.find((later) => {
    if (later.seq <= failure.seq) return false;
    if (failure.step === "escalate" || failure.step === "monitor") {
      return (
        !!failure.ref &&
        later.ref === failure.ref &&
        later.step === "monitor" &&
        later.data?.state === "resolved" &&
        (!failure.data?.incident || later.data?.incident === failure.data.incident)
      );
    }
    return (
      later.kind === "ok" &&
      later.step === failure.step &&
      (failure.ref ? later.ref === failure.ref : !!failure.run && later.run === failure.run)
    );
  });
}

function failureViews(events: AutomationEvent[], limit: number): FailureView[] {
  return events
    .filter((event) => event.kind === "fail")
    .slice(-limit)
    .reverse()
    .map((failure) => {
      const recovery = findRecovery(events, failure);
      return {
        ts: failure.ts,
        step: failure.step,
        ...(failure.ref ? { ref: failure.ref } : {}),
        msg: failure.msg ?? "",
        ...(recovery ? { resolvedAt: recovery.ts } : {}),
      };
    });
}

export function automationApi(deps: ApiDeps) {
  const now = deps.now ?? Date.now;

  function snapshot(req: SnapshotRequest = {}): Snapshot {
    checkVersion(req.v);
    const limit = Math.min(100, Math.max(1, Math.floor(req.limit ?? 20)));
    const cfg = deps.config();
    const events = deps.log.all();
    const failures = failureViews(events, limit);
    return {
      v: VERSION,
      now: now(),
      flow: FLOW,
      steps: stepViews(deps, now(), cfg),
      triggers: triggerViews(deps, cfg),
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
