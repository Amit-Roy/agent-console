import { spawn, type ChildProcess } from "node:child_process";
import { privacyEnv } from "./privacy.ts";

// Headroom (github.com/headroom-sdk/headroom's optimization proxy) compresses the context Claude Code sends to the API and keeps a local
// savings ledger. We run it as a loopback-only child of this server and point Claude at it with ANTHROPIC_BASE_URL. Codex (ChatGPT login,
// chatgpt.com backend) and Pi (OpenRouter) do not talk to a host the proxy can serve, so they rely on RTK alone.
// Claude only gets the proxy while it answers health checks: a dead proxy must never take the agent down with it.
const PORT = Number(process.env.AGENT_CONSOLE_HEADROOM_PORT) || 8790;
const URL_ = `http://127.0.0.1:${PORT}`;
const enabled = () => process.env.AGENT_CONSOLE_HEADROOM !== "0" && (process.env.AGENT_CONSOLE_MOCK !== "1" || process.env.AGENT_CONSOLE_HEADROOM === "1");

let child: ChildProcess | undefined;
let healthy = false;
let owned = false;
let failures = 0;
let timer: NodeJS.Timeout | undefined;
let lastError: string | undefined;
let starting: Promise<void> | undefined;

async function live(): Promise<boolean> {
  try {
    return (await fetch(`${URL_}/livez`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

function spawnProxy() {
  const p = spawn("headroom", ["proxy", "--host", "127.0.0.1", "--port", String(PORT), "--no-rate-limit"], { env: { ...process.env, ...privacyEnv }, stdio: "ignore" });
  child = p;
  owned = true;
  p.on("error", (e) => { lastError = `headroom: ${e.message}`; if (child === p) child = undefined; });
  p.on("exit", (code, signal) => { if (child === p) { child = undefined; lastError = `headroom proxy exited (${signal ?? code})`; } });
}

async function check() {
  healthy = await live();
  if (healthy) { failures = 0; lastError = undefined; return; }
  if (child || !enabled() || failures >= 3) return; // starting up, disabled, or given up (the next server start tries again)
  failures++;
  spawnProxy();
}

export const headroom = {
  async start() {
    if (!enabled()) return;
    if (starting) return starting;
    if (timer) return;
    // Resolve routing before accepting sessions: a Claude process keeps its startup environment for its whole lifetime.
    starting = (async () => {
      await check();
      const deadline = Date.now() + 10_000;
      while (!healthy && child && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        healthy = await live();
      }
      timer = setInterval(() => void check(), 5000);
      timer.unref();
    })();
    try { await starting; } finally { starting = undefined; }
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (owned) child?.kill("SIGTERM"); // a proxy we did not start is not ours to stop
    healthy = false;
  },
  /** Base URL for ANTHROPIC_BASE_URL, only while the proxy is answering. */
  url: () => (healthy ? URL_ : undefined),
  state: () => ({ enabled: enabled(), running: healthy, url: URL_, owned, error: healthy ? undefined : lastError }),
  async stats(): Promise<any | null> {
    if (!healthy) return null;
    try {
      const r = await fetch(`${URL_}/stats-history`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
};
