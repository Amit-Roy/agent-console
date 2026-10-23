import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRateLimit } from "./model-rate-limit.ts";

export type ModelProvider = "nvidia" | "openrouter" | "other";
export type ModelPriority = "interactive" | "automation" | "triage" | "label";
export type ModelAdmission = {
  signal?: AbortSignal;
  provider?: ModelProvider;
  priority?: ModelPriority;
};
let local: ModelRateLimit | undefined;
const directory = (env = process.env) =>
  env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");

/** Only the Console server owns a queue. Workers and Pi use its loopback broker. */
export function setLocalModelRateLimit(limiter: ModelRateLimit): void {
  local = limiter;
}

export function startModelRateBroker(port: number, dataDir = directory()) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dataDir, "model-rate-token");
  try {
    fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (token.length < 32) throw new Error("Invalid model admission credential.");
  const config = { url: `http://127.0.0.1:${port}/api/model-request`, token };
  const descriptor = path.join(dataDir, "model-rate-broker.json");
  fs.writeFileSync(descriptor + ".tmp", JSON.stringify(config), { mode: 0o600 });
  fs.renameSync(descriptor + ".tmp", descriptor);
  process.env.AGENT_CONSOLE_RATE_URL = config.url;
  process.env.AGENT_CONSOLE_RATE_TOKEN = config.token;
  setLocalModelRateLimit(
    new ModelRateLimit({ path: path.join(dataDir, "model-rate-limit.sqlite") }),
  );
  return config;
}

/** Stable, admission-only credentials survive Console restarts. */
export function modelRateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let url = env.AGENT_CONSOLE_RATE_URL,
    token = env.AGENT_CONSOLE_RATE_TOKEN;
  if (!url || !token) {
    const config = JSON.parse(
      fs.readFileSync(path.join(directory(env), "model-rate-broker.json"), "utf8"),
    );
    url = config.url;
    token = config.token;
  }
  const parsed = new URL(url!);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !token ||
    token.length < 16
  ) {
    throw new Error("Invalid local model admission broker.");
  }
  return { ...env, AGENT_CONSOLE_RATE_URL: url, AGENT_CONSOLE_RATE_TOKEN: token };
}

async function remote(
  action: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const env = modelRateEnv(process.env);
  const response = await fetch(env.AGENT_CONSOLE_RATE_URL!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-console-tool": env.AGENT_CONSOLE_RATE_TOKEN!,
    },
    body: JSON.stringify({ action, ...input }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as any;
    throw Object.assign(new Error(body.error || "Model admission unavailable."), {
      code: body.code,
      retryAt: body.retryAt,
      provider: body.provider,
    });
  }
  await response.arrayBuffer();
}

export async function acquireModelRequest(options: ModelAdmission = {}): Promise<void> {
  if (local) return local.acquire(options);
  return remote(
    "acquire",
    { provider: options.provider || "other", priority: options.priority || "interactive" },
    options.signal,
  );
}

export async function reportModel429(
  retryAfter?: string | number | null,
  provider: ModelProvider = "other",
): Promise<void> {
  if (local) {
    local.report429(retryAfter, provider);
    return;
  }
  await remote("cooldown", { retryAfter, provider }, AbortSignal.timeout(5000));
}

export function syncModelQuota(quota: { used: number; limit: number; observedAt?: number }): void {
  local?.syncOpenRouterQuota(quota);
}
