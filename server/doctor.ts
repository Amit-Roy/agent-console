import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

export function createDoctor(
  threads: Pick<Threads, "routingHealth" | "repairRouting" | "repairStaleTurns">,
  deps: Dependencies = {},
) {
  const proxy = deps.proxy ?? headroom;
  const accountReady = deps.accountReady ?? claudeAccountReady;
  const hasExecutable = deps.executable ?? executable;
  const upstream = deps.upstream ?? probeUpstream;
  let repairing: Promise<any> | undefined;

  async function inspect() {
    const [state, network] = await Promise.all([proxy.probe(), upstream()]);
    const routing = threads.routingHealth();
    const cliReady = hasExecutable("claude");
    const codexReady = hasExecutable("codex");
    const codexAuth =
      deps.codexAuthReady?.() ??
      fs.existsSync(
        path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"),
      );
    const piReady = hasExecutable("pi");
    const helperReady = (deps.codexHelperReady ?? codexHelperReady)();
    const checks: DoctorCheck[] = [
      {
        id: "claude-cli",
        label: "Claude CLI",
        status: cliReady ? "ok" : "error",
        detail: cliReady
          ? "Claude executable is available."
          : "Install Claude CLI or fix the server PATH.",
        repairable: false,
      },
      {
        id: "codex-cli",
        label: "Codex CLI",
        status: codexReady ? "ok" : "warning",
        detail: codexReady
          ? "Codex executable is available."
          : "Install Codex CLI or fix the server PATH.",
        repairable: false,
      },
      {
        id: "codex-helper",
        label: "Codex tool helper",
        status: helperReady ? "ok" : "warning",
        detail: helperReady
          ? "Adjacent codex-code-mode-host executable is available. Package compatibility is not verified."
          : "The adjacent codex-code-mode-host helper is missing or not executable. Repair the Codex installation.",
        repairable: false,
      },
      {
        id: "codex-auth",
        label: "Codex login",
        status: codexAuth ? "ok" : "warning",
        detail: codexAuth
          ? "Local auth file exists. Provider acceptance is not verified."
          : "No local Codex auth file. Run codex login --device-auth.",
        repairable: false,
      },
      {
        id: "pi-cli",
        label: "Pi CLI",
        status: piReady ? "ok" : "warning",
        detail: piReady
          ? "Pi executable is available. Model access is not verified."
          : "Install Pi CLI or fix the server PATH.",
        repairable: false,
      },
      ...(["sunny", "nefro"] as const).map((account) => {
        const ready = accountReady(account);
        return {
          id: `claude-${account}`,
          label: `Claude ${account} login`,
          status: ready ? ("ok" as const) : ("warning" as const),
          detail: ready
            ? "Local login credentials are present. Provider acceptance is not verified."
            : "Local login is missing or invalid. Sign in from the account menu.",
          repairable: false,
        };
      }),
      {
        id: "headroom",
        label: "Headroom proxy",
        status: (state.running && state.reachable) || !state.enabled ? "ok" : "warning",
        detail:
          state.running && state.reachable
            ? "Proxy is reachable."
            : !state.enabled
              ? "Compression is disabled; new sessions connect directly."
              : `${state.error || "Proxy is unavailable"}. New sessions bypass compression. The resource safety breaker remains enabled.`,
        repairable: false,
      },
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
      {
        id: "anthropic-network",
        label: "Anthropic connection",
        status: network === "reachable" ? "ok" : "error",
        detail:
          network === "reachable"
            ? "Direct DNS, TLS and HTTP reachability checked. No model request made."
            : "Direct Anthropic connection failed or returned a temporary server/rate-limit error. Check network or provider availability.",
        repairable: false,
      },
    ];
    return {
      checkedAt: new Date().toISOString(),
      status: checks.every((check) => check.status === "ok")
        ? ("healthy" as const)
        : ("issues" as const),
      checks,
    };
  }

  async function repair() {
    if (repairing) return repairing;
    const pending = (async () => {
      // Refresh cached reachability before deciding which warm sessions require recycling.
      await proxy.probe(true);
      const expired = threads.repairStaleTurns();
      const result = threads.repairRouting();
      const report = await inspect();
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
      for (const check of report.checks)
        if (check.status !== "ok" && !check.repairable)
          repairs.push({ id: check.id, status: "manual", detail: check.detail });
      return { ...report, repairs };
    })();
    repairing = pending;
    try {
      return await pending;
    } finally {
      if (repairing === pending) repairing = undefined;
    }
  }
  return { inspect, repair };
}
