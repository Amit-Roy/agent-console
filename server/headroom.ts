import { type ChildProcess, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagnostic, ResourceGuard, resource } from "./headroom-diagnostics.ts";
import {
  type HeadroomProfileStore,
  ingestOtlp,
  MAX_OTLP_BYTES,
  OtlpDecodeError,
  ProfileTrigger,
  readSmapsRollup,
  type SnapshotTrigger,
} from "./headroom-profile.ts";
import { privacyEnv } from "./privacy.ts";
import { fileEnv } from "./providers/env.ts";

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
const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "headroom-profile");
const SNAPSHOT_CODES: Record<SnapshotTrigger, number> = {
  step: 1,
  periodic: 2,
  breaker: 3,
};
let profileStore: HeadroomProfileStore | undefined;
let profilePort = 0;
const trigger = new ProfileTrigger();
const current = (epoch: number) => active && enabled() && !latched && generation === epoch;

async function live(): Promise<boolean> {
  try {
    return (await fetch(`${URL_}/livez`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

function terminate(p: ChildProcess) {
  const existing = terminations.get(p);
  if (existing) return existing;
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  const pending = new Promise<void>((resolve) => {
    const escalation = setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }, 5000);
    escalation.unref();
    const done = () => {
      clearTimeout(escalation);
      resolve();
    };
    p.once("exit", done);
    p.once("error", done);
    p.kill("SIGTERM");
  });
  terminations.set(p, pending);
  return pending;
}

// Memory profiling is on by default; "0" in agent-console's env disables it. It needs the server port to report back.
function profileEnv(settings: Record<string, string | undefined>): Record<string, string> {
  const pick = (key: string) => process.env[key] ?? settings[key];
  const enabledByEnv = (pick("AGENT_CONSOLE_HEADROOM_PROFILE") ?? "1") !== "0";
  if (!enabledByEnv || !profilePort) return { AGENT_CONSOLE_HEADROOM_PROFILE: "0" };
  const existing = process.env.PYTHONPATH;
  const out: Record<string, string> = {
    AGENT_CONSOLE_HEADROOM_PROFILE: "1",
    PYTHONPATH: existing ? `${PROFILE_DIR}${path.delimiter}${existing}` : PROFILE_DIR,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${profilePort}/v1/metrics`,
    OTEL_METRIC_EXPORT_INTERVAL: "30000",
    OTEL_SERVICE_NAME: "headroom-proxy",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
  };
  if (pick("AGENT_CONSOLE_HEADROOM_TRACEMALLOC") === "1")
    out.AGENT_CONSOLE_HEADROOM_TRACEMALLOC = "1";
  return out;
}

function recordSnapshot(pid: number, reason: SnapshotTrigger, rssBytes: number) {
  try {
    profileStore?.recordSnapshot(pid, reason, rssBytes, Date.now());
    diagnostic("snapshot", { pid, reason: SNAPSHOT_CODES[reason] });
  } catch {
    diagnostic("snapshot", { pid, reason: 0 });
  }
}

// Profile storage must never break the proxy guard.
function recordProfile(pid: number, sample: { rssBytes: number; time: number }) {
  if (!profileStore) return;
  try {
    profileStore.recordSample(pid, sample, readSmapsRollup(pid));
    const due = trigger.tick(pid, sample.rssBytes, Date.now());
    if (due) recordSnapshot(pid, due, sample.rssBytes);
  } catch {
    diagnostic("snapshot", { pid, reason: 0 });
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function readCapped(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OTLP_BYTES)
        resolve(null); // keep draining so the 413 reaches the sender
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** POST /v1/metrics: OTLP/HTTP protobuf from the local Headroom proxy only. Mount before any auth middleware. */
export function metricsIngest(getStore: () => HeadroomProfileStore | undefined) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const finish = (status: number) => void res.writeHead(status, { Connection: "close" }).end();
    const proxied = req.headers["x-forwarded-for"] || req.headers.forwarded;
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "") || proxied) return finish(403);
    if (!String(req.headers["content-type"] || "").startsWith("application/x-protobuf"))
      return finish(415);
    const store = getStore();
    if (!store) return finish(503);
    try {
      const body = await readCapped(req);
      if (!body) return finish(413);
      ingestOtlp(store, body);
      finish(200);
    } catch (error) {
      finish(error instanceof OtlpDecodeError ? 400 : 500);
    }
  };
}

function spawnProxy() {
  attempts++;
  guard = new ResourceGuard();
  stdoutBytes = stderrBytes = 0;
  const settings = fileEnv();
  const env = {
    ...process.env,
    ...privacyEnv,
    HEADROOM_WORKERS: "1",
    HEADROOM_COMPRESS_WORKERS: "1",
    HEADROOM_LOG_MESSAGES: "0",
    OMP_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
  Object.assign(env, profileEnv(settings));
  if (env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") === URL_) delete env.ANTHROPIC_BASE_URL;
  // Provider clients cannot call Headroom's injected retrieval tool. Keep compression,
  // but never replace tool output with CCR markers that the agent cannot resolve.
  const headroomCommand =
    process.env.AGENT_CONSOLE_HEADROOM_COMMAND ??
    settings.AGENT_CONSOLE_HEADROOM_COMMAND ??
    "headroom";
  const args = [
    "-n",
    "15",
    headroomCommand,
    "proxy",
    "--host",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--compression-max-workers",
    "1",
    "--no-code-aware",
    "--no-ccr",
    "--workers",
    "1",
  ];
  if (
    (process.env.AGENT_CONSOLE_HEADROOM_KOMPRESS ?? settings.AGENT_CONSOLE_HEADROOM_KOMPRESS) !==
    "1"
  )
    args.push("--disable-kompress");
  args.push("--disable-kompress-fallback", "--anthropic-pre-upstream-concurrency", "1");
  const p = spawn("nice", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = p;
  // Drain both streams without retaining or serializing any child output.
  p.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
  });
  p.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
  });
  diagnostic("start", { pid: p.pid ?? 0, attempt: attempts });
  p.on("error", () => {
    diagnostic("spawn-error");
    if (child === p) {
      child = undefined;
      healthy = false;
      lastError = "Headroom launch failed";
    }
  });
  p.on("exit", (code, signal) => {
    diagnostic("exit", {
      pid: p.pid ?? 0,
      code: code ?? -1,
      signal: signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 0,
      stdoutBytes,
      stderrBytes,
    });
    if (child === p) {
      child = undefined;
      healthy = false;
      if (!latched) lastError = "Headroom proxy exited";
    }
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
      recordProfile(p.pid, sample);
      if (reason) {
        latched = true;
        healthy = false;
        lastError =
          reason === 1
            ? "Headroom disabled: RSS exceeded 8192 MiB"
            : "Headroom disabled: CPU exceeded 80% for 30 seconds";
        diagnostic("breaker", { reason });
        recordSnapshot(p.pid, "breaker", sample.rssBytes);
        terminate(p);
        return;
      }
    }
  }
  const responding = await live();
  if (!current(epoch)) return;
  healthy = responding;
  if (healthy) {
    lastError = undefined;
    return;
  }
  if (child) return;
  if (attempts >= 3) {
    latched = true;
    lastError = "Headroom disabled: three launch attempts exhausted";
    diagnostic("breaker", { reason: 3 });
    return;
  }
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

async function launchSequence(epoch: number) {
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
}

export const headroom = {
  /** Wires profiling: the store receiving samples and the port the proxy reports metrics to. */
  attachProfile(store: HeadroomProfileStore | undefined, port: number) {
    profileStore = store;
    profilePort = port;
  },
  async start() {
    if (!enabled()) {
      if (process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") === URL_)
        delete process.env.ANTHROPIC_BASE_URL;
      return;
    }
    if (latched) return;
    if (starting) return starting;
    if (active) return;
    active = true;
    const epoch = ++generation;
    const pending = launchSequence(epoch);
    starting = pending;
    try {
      await pending;
    } finally {
      if (starting === pending) starting = undefined;
    }
  },
  stop() {
    active = false;
    generation++;
    starting = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (child) stopping = terminate(child); // Never terminate an external proxy.
    healthy = false;
    diagnostic("stop");
    return stopping;
  },
  url: () => (enabled() && active && !latched && healthy ? URL_ : undefined),
  async probe(refreshRouting = false) {
    const responding = await live();
    // Inspection is observational. Repair can invalidate routing, never clear a breaker or enable it.
    if (refreshRouting && !responding && healthy) {
      healthy = false;
      lastError ??= "Headroom proxy is unreachable";
    }
    return { ...headroom.state(), reachable: responding };
  },
  state: () => ({
    latched,
    enabled: enabled(),
    running: enabled() && active && !latched && healthy,
    url: URL_,
    owned: !!child,
    error: healthy ? undefined : lastError,
  }),
  async stats(): Promise<any | null> {
    if (!headroom.url()) return null;
    try {
      const r = await fetch(`${URL_}/stats-history`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
};
