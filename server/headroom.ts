import { spawn, type ChildProcess } from "node:child_process";
import { privacyEnv } from "./privacy.ts";
import { diagnostic, resource, ResourceGuard } from "./headroom-diagnostics.ts";

// Headroom defaults on: its CPU/RSS guard is a circuit breaker, not an OS quota.
const PORT = Number(process.env.AGENT_CONSOLE_HEADROOM_PORT) || 8790;
const URL_ = `http://127.0.0.1:${PORT}`;
const enabled = () => process.env.AGENT_CONSOLE_HEADROOM !== "0";
let child: ChildProcess | undefined;
let healthy = false;
let attempts = 0;
let generation = 0;
let active = false;
let latched = false;
let timer: NodeJS.Timeout | undefined;
let lastError: string | undefined;
let starting: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
const terminations = new WeakMap<ChildProcess, Promise<void>>();
let guard = new ResourceGuard();
let stdoutBytes = 0;
let stderrBytes = 0;
const current = (epoch: number) => active && enabled() && !latched && generation === epoch;

async function live(): Promise<boolean> {
  try { return (await fetch(`${URL_}/livez`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

function terminate(p: ChildProcess) {
  const existing = terminations.get(p);
  if (existing) return existing;
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  const pending = new Promise<void>((resolve) => {
    const escalation = setTimeout(() => { if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); }, 5000);
    escalation.unref();
    const done = () => { clearTimeout(escalation); resolve(); };
    p.once("exit", done);
    p.once("error", done);
    p.kill("SIGTERM");
  });
  terminations.set(p, pending);
  return pending;
}

function spawnProxy() {
  attempts++;
  guard = new ResourceGuard();
  stdoutBytes = stderrBytes = 0;
  const env = { ...process.env, ...privacyEnv, HEADROOM_WORKERS: "1", HEADROOM_COMPRESS_WORKERS: "1", HEADROOM_LOG_MESSAGES: "0",
    OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", NUMEXPR_NUM_THREADS: "1", TOKENIZERS_PARALLELISM: "false" };
  if (env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") === URL_) delete env.ANTHROPIC_BASE_URL;
  // Provider clients cannot call Headroom's injected retrieval tool. Keep compression,
  // but never replace tool output with CCR markers that the agent cannot resolve.
  const p = spawn("nice", ["-n", "15", "headroom", "proxy", "--host", "127.0.0.1", "--port", String(PORT),
    "--compression-max-workers", "1", "--no-code-aware", "--no-ccr", "--workers", "1",
    "--disable-kompress", "--disable-kompress-fallback", "--anthropic-pre-upstream-concurrency", "1"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = p;
  // Drain both streams without retaining or serializing any child output.
  p.stdout?.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; });
  p.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  diagnostic("start", { pid: p.pid ?? 0, attempt: attempts });
  p.on("error", () => { diagnostic("spawn-error"); if (child === p) { child = undefined; healthy = false; lastError = "Headroom launch failed"; } });
  p.on("exit", (code, signal) => {
    diagnostic("exit", { pid: p.pid ?? 0, code: code ?? -1, signal: signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 0, stdoutBytes, stderrBytes });
    if (child === p) { child = undefined; healthy = false; if (!latched) lastError = "Headroom proxy exited"; }
  });
}

async function check(epoch: number) {
  if (!current(epoch)) return;
  const p = child;
  if (p?.pid) {
    const sample = await resource(p.pid);
    if (!current(epoch)) return;
    if (sample) {
      const { cpuPercent, reason } = guard.sample(sample);
      diagnostic("resource", { pid: p.pid, rssBytes: sample.rssBytes, cpuPercent });
      diagnostic("output", { stdoutBytes, stderrBytes });
      if (reason) {
        latched = true; healthy = false;
        lastError = reason === 1 ? "Headroom disabled: RSS exceeded 1024 MiB" : "Headroom disabled: CPU exceeded 80% for 30 seconds";
        diagnostic("breaker", { reason });
        terminate(p);
        return;
      }
    }
  }
  const responding = await live();
  if (!current(epoch)) return;
  healthy = responding;
  if (healthy) { lastError = undefined; return; }
  if (child) return;
  if (attempts >= 3) { latched = true; lastError = "Headroom disabled: three launch attempts exhausted"; diagnostic("breaker", { reason: 3 }); return; }
  spawnProxy();
}

function schedule(epoch: number) {
  if (!current(epoch)) return;
  timer = setTimeout(async () => {
    timer = undefined;
    await check(epoch);
    schedule(epoch);
  }, 5000);
  timer.unref();
}

export const headroom = {
  async start() {
    if (!enabled()) {
      if (process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") === URL_) delete process.env.ANTHROPIC_BASE_URL;
      return;
    }
    if (latched) return;
    if (starting) return starting;
    if (active) return;
    active = true;
    const epoch = ++generation;
    const pending = (async () => {
      await stopping;
      if (!current(epoch)) return;
      await check(epoch);
      const deadline = Date.now() + 10_000;
      while (current(epoch) && !healthy && child && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (!current(epoch)) break;
        const responding = await live();
        if (current(epoch)) healthy = responding;
      }
      schedule(epoch);
    })();
    starting = pending;
    try { await pending; } finally { if (starting === pending) starting = undefined; }
  },
  stop() {
    active = false; generation++; starting = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (child) stopping = terminate(child); // Never terminate an external proxy.
    healthy = false;
    diagnostic("stop");
    return stopping;
  },
  url: () => (enabled() && active && !latched && healthy ? URL_ : undefined),
  state: () => ({ enabled: enabled(), running: enabled() && active && !latched && healthy, url: URL_, owned: !!child, error: healthy ? undefined : lastError }),
  async stats(): Promise<any | null> {
    if (!headroom.url()) return null;
    try {
      const r = await fetch(`${URL_}/stats-history`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },
};
