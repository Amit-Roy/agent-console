import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { checkCamofox } from "./camofox.ts";
import { type HealthCheck, type HealthStatus, runReportChecks } from "./checks.ts";

export type HealthTrigger = "nightly" | "hourly" | "boot" | "manual";

export interface HealthRun {
  at: string;
  trigger: HealthTrigger;
  durationMs: number;
  checks: HealthCheck[];
}

export interface HealthSummary {
  at: string;
  trigger: HealthTrigger;
  worst: HealthStatus;
}

export interface HealthRunnerDeps {
  camofox: () => Promise<HealthCheck>;
  report: (threads: unknown) => Promise<HealthCheck[]>;
  now: () => number;
}

export const MAX_RUNS = 60;
export const STALE_FULL_MS = 26 * 3_600_000;
export const BOOT_DELAY_MS = 5 * 60_000;
const SEVERITY: HealthStatus[] = ["info", "ok", "warning", "error"];

const defaultDeps: HealthRunnerDeps = {
  camofox: async () => (await checkCamofox()) as HealthCheck,
  report: (threads) => runReportChecks({ threads: threads as never }),
  now: () => Date.now(),
};

export function worstStatus(checks: HealthCheck[]): HealthStatus {
  return checks.reduce<HealthStatus>(
    (worst, item) => (SEVERITY.indexOf(item.status) > SEVERITY.indexOf(worst) ? item.status : worst),
    "info",
  );
}

// Boot catch-up: a full run is due when none exists or the last one is older than 26 h.
export function needsBootRun(lastFullAt: string | undefined, nowMs: number): boolean {
  if (!lastFullAt) return true;
  const last = Date.parse(lastFullAt);
  return !Number.isFinite(last) || nowMs - last > STALE_FULL_MS;
}

export function createHealthRunner(opts: {
  threads: unknown;
  dataDir: string;
  deps?: Partial<HealthRunnerDeps>;
}) {
  const deps = { ...defaultDeps, ...opts.deps };
  const file = path.join(opts.dataDir, "health", "runs.jsonl");
  let inflight: Promise<HealthRun> | undefined;

  function readRuns(): HealthRun[] {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const runs: HealthRun[] = [];
    for (const line of text.split("\n")) {
      try {
        if (line.trim()) runs.push(JSON.parse(line) as HealthRun);
      } catch {}
    }
    return runs;
  }

  function record(run: HealthRun): void {
    const kept = [...readRuns(), run].slice(-MAX_RUNS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${kept.map((item) => JSON.stringify(item)).join("\n")}\n`);
  }

  async function collect(trigger: HealthTrigger): Promise<HealthCheck[]> {
    if (trigger === "hourly") return [await deps.camofox()];
    const [cam, rest] = await Promise.all([deps.camofox(), deps.report(opts.threads)]);
    return [cam, ...rest];
  }

  async function execute(trigger: HealthTrigger): Promise<HealthRun> {
    const started = deps.now();
    const checks = await collect(trigger);
    const run: HealthRun = {
      at: new Date(started).toISOString(),
      trigger,
      durationMs: deps.now() - started,
      checks,
    };
    record(run);
    return run;
  }

  function run(trigger: HealthTrigger): Promise<HealthRun> {
    if (inflight) return inflight;
    inflight = execute(trigger).finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  function latest(): HealthRun | undefined {
    return readRuns().at(-1);
  }

  function history(count = 14): HealthSummary[] {
    return readRuns()
      .slice(-count)
      .reverse()
      .map((item) => ({ at: item.at, trigger: item.trigger, worst: worstStatus(item.checks) }));
  }

  function lastFullAt(): string | undefined {
    return readRuns()
      .reverse()
      .find((item) => item.trigger !== "hourly")?.at;
  }

  function schedule(): () => void {
    const log = (err: unknown) => console.error("[health] run failed", err);
    const nightly = new Cron("15 4 * * *", { timezone: "Asia/Kolkata" }, () => {
      run("nightly").catch(log);
    });
    const hourly = new Cron("37 * * * *", () => {
      run("hourly").catch(log);
    });
    let timer: NodeJS.Timeout | undefined;
    if (needsBootRun(lastFullAt(), deps.now())) {
      timer = setTimeout(() => run("boot").catch(log), BOOT_DELAY_MS);
      timer.unref();
    }
    return () => {
      nightly.stop();
      hourly.stop();
      if (timer) clearTimeout(timer);
    };
  }

  return { run, latest, history, running: () => Boolean(inflight), lastFullAt, schedule };
}

export function healthScheduleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_CONSOLE_HEALTH !== "0" && env.NODE_ENV !== "test";
}
