import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { headroom } from "./headroom.ts";
import { claudeAccountReady } from "./providers/claude-accounts.ts";
import type { Threads } from "./threads.ts";

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
  repairable: boolean;
}
export interface DoctorRepair {
  id: string;
  status: "fixed" | "deferred" | "manual";
  detail: string;
}

function executablePath(name: string) {
  return (process.env.PATH || "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, name))
    .find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}
const executable = (name: string) => !!executablePath(name);

function codexHelperReady() {
  const cli = executablePath("codex");
  if (!cli) return false;
  try {
    const helper = path.join(path.dirname(fs.realpathSync(cli)), "codex-code-mode-host");
    fs.accessSync(helper, fs.constants.X_OK);
    return fs.statSync(helper).isFile();
  } catch {
    return false;
  }
}

// An unauthenticated HEAD checks DNS, TLS and reachability without inference or credentials.
export async function probeUpstream(fetcher: typeof fetch = fetch, timeoutMs = 2500) {
  try {
    const response = await fetcher("https://api.anthropic.com/", {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status < 500 && response.status !== 429 ? "reachable" : "unavailable";
  } catch {
    return "unreachable";
  }
}

type Dependencies = {
  proxy?: typeof headroom;
  accountReady?: typeof claudeAccountReady;
  executable?: typeof executable;
  upstream?: typeof probeUpstream;
  codexAuthReady?: () => boolean;
  codexHelperReady?: () => boolean;
};

type DoctorThreads = Pick<Threads, "routingHealth" | "repairRouting" | "repairStaleTurns">;
type DoctorContext = {
  threads: DoctorThreads;
  deps: Dependencies;
  proxy: typeof headroom;
  accountReady: typeof claudeAccountReady;
  hasExecutable: typeof executable;
  upstream: typeof probeUpstream;
  repairing: Promise<any> | undefined;
};
type ProxyState = Awaited<ReturnType<typeof headroom.probe>>;
type RoutingHealth = ReturnType<Threads["routingHealth"]>;

function binaryCheck(
  id: string,
  label: string,
  ready: boolean,
  missingStatus: DoctorCheck["status"],
  readyDetail: string,
  missingDetail: string,
): DoctorCheck {
  return {
    id,
    label,
    status: ready ? "ok" : missingStatus,
    detail: ready ? readyDetail : missingDetail,
    repairable: false,
  };
}

function cliChecks(ctx: DoctorContext): DoctorCheck[] {
  const { deps, hasExecutable } = ctx;
  const cliReady = hasExecutable("claude");
  const codexReady = hasExecutable("codex");
  const codexAuth =
    deps.codexAuthReady?.() ??
    fs.existsSync(
      path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"),
    );
  const piReady = hasExecutable("pi");
  const helperReady = (deps.codexHelperReady ?? codexHelperReady)();
  return [
    binaryCheck(
      "claude-cli",
      "Claude CLI",
      cliReady,
      "error",
      "Claude executable is available.",
      "Install Claude CLI or fix the server PATH.",
    ),
    binaryCheck(
      "codex-cli",
      "Codex CLI",
      codexReady,
      "warning",
      "Codex executable is available.",
      "Install Codex CLI or fix the server PATH.",
    ),
    binaryCheck(
      "codex-helper",
      "Codex tool helper",
      helperReady,
      "warning",
      "Adjacent codex-code-mode-host executable is available. Package compatibility is not verified.",
      "The adjacent codex-code-mode-host helper is missing or not executable. Repair the Codex installation.",
    ),
    binaryCheck(
      "codex-auth",
      "Codex login",
      codexAuth,
      "warning",
      "Local auth file exists. Provider acceptance is not verified.",
      "No local Codex auth file. Run codex login --device-auth.",
    ),
    binaryCheck(
      "pi-cli",
      "Pi CLI",
      piReady,
      "warning",
      "Pi executable is available. Model access is not verified.",
      "Install Pi CLI or fix the server PATH.",
    ),
  ];
}

function accountChecks(ctx: DoctorContext): DoctorCheck[] {
  return (["primary", "secondary"] as const).map((account) =>
    binaryCheck(
      `claude-${account}`,
      `Claude ${account} login`,
      ctx.accountReady(account),
      "warning",
      "Local login credentials are present. Provider acceptance is not verified.",
      "Local login is missing or invalid. Sign in from the account menu.",
    ),
  );
}

function headroomDetail(state: ProxyState): string {
  if (state.running && state.reachable) return "Proxy is reachable.";
  if (!state.enabled) return "Compression is disabled; new sessions connect directly.";
  return `${state.error || "Proxy is unavailable"}. New sessions bypass compression. The resource safety breaker remains enabled.`;
}

function headroomCheck(state: ProxyState): DoctorCheck {
  return {
    id: "headroom",
    label: "Headroom proxy",
    status: (state.running && state.reachable) || !state.enabled ? "ok" : "warning",
    detail: headroomDetail(state),
    repairable: false,
  };
}

function routingChecks(routing: RoutingHealth): DoctorCheck[] {
  return [
    {
      id: "routing",
      label: "Session connections",
      status: routing.idle + routing.active ? "error" : "ok",
      detail:
        routing.idle + routing.active
          ? `${routing.idle} idle and ${routing.active} active sessions retain an unavailable proxy. Idle sessions can be recycled; active sessions wait until completion.`
          : "No sessions retain an unavailable proxy.",
      repairable: routing.idle + routing.active > 0,
    },
    {
      id: "silent-turns",
      label: "Silent turns",
      status: routing.silent ? "warning" : "ok",
      detail: routing.silent
        ? `${routing.silent} turns exceeded the existing inactivity limit. Repair setup can stop these expired turns. Healthy active work and questions waiting on you are preserved.`
        : "No turns exceeded the inactivity limit. Waiting for your answer does not count.",
      repairable: routing.silent > 0,
    },
  ];
}

function networkCheck(network: string): DoctorCheck {
  return {
    id: "anthropic-network",
    label: "Anthropic connection",
    status: network === "reachable" ? "ok" : "error",
    detail:
      network === "reachable"
        ? "Direct DNS, TLS and HTTP reachability checked. No model request made."
        : "Direct Anthropic connection failed or returned a temporary server/rate-limit error. Check network or provider availability.",
    repairable: false,
  };
}

async function inspectDoctor(ctx: DoctorContext) {
  const [state, network] = await Promise.all([ctx.proxy.probe(), ctx.upstream()]);
  const routing = ctx.threads.routingHealth();
  const checks: DoctorCheck[] = [
    ...cliChecks(ctx),
    ...accountChecks(ctx),
    headroomCheck(state),
    ...routingChecks(routing),
    networkCheck(network),
  ];
  return {
    checkedAt: new Date().toISOString(),
    status: checks.every((check) => check.status === "ok")
      ? ("healthy" as const)
      : ("issues" as const),
    checks,
  };
}

function fixedRepairs(
  expired: number,
  result: { fixed: number; deferred: number },
): DoctorRepair[] {
  const repairs: DoctorRepair[] = [];
  if (expired)
    repairs.push({
      id: "silent-turns",
      status: "fixed",
      detail: `Stopped ${expired} turns beyond the inactivity deadline. Saved conversation history remains available.`,
    });
  if (result.fixed)
    repairs.push({
      id: "routing",
      status: "fixed",
      detail: `Recycled ${result.fixed} idle sessions. Their next message resumes saved history with a fresh connection.`,
    });
  if (result.deferred)
    repairs.push({
      id: "routing-active",
      status: "deferred",
      detail: `${result.deferred} active sessions will recycle after completion. Running work was preserved.`,
    });
  return repairs;
}

async function runRepair(ctx: DoctorContext) {
  // Refresh cached reachability before deciding which warm sessions require recycling.
  await ctx.proxy.probe(true);
  const expired = ctx.threads.repairStaleTurns();
  const result = ctx.threads.repairRouting();
  const report = await inspectDoctor(ctx);
  const repairs = fixedRepairs(expired, result);
  for (const check of report.checks)
    if (check.status !== "ok" && !check.repairable)
      repairs.push({ id: check.id, status: "manual", detail: check.detail });
  return { ...report, repairs };
}

async function repairOnce(ctx: DoctorContext) {
  if (ctx.repairing) return ctx.repairing;
  const pending = runRepair(ctx);
  ctx.repairing = pending;
  try {
    return await pending;
  } finally {
    if (ctx.repairing === pending) ctx.repairing = undefined;
  }
}

export function createDoctor(threads: DoctorThreads, deps: Dependencies = {}) {
  const ctx: DoctorContext = {
    threads,
    deps,
    proxy: deps.proxy ?? headroom,
    accountReady: deps.accountReady ?? claudeAccountReady,
    hasExecutable: deps.executable ?? executable,
    upstream: deps.upstream ?? probeUpstream,
    repairing: undefined,
  };
  return { inspect: () => inspectDoctor(ctx), repair: () => repairOnce(ctx) };
}
