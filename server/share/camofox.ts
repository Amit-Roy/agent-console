import { ShareError } from "./types.ts";

// Thin client for the local camofox browser. Refused connections, timeouts and non-2xx answers surface as
// CamofoxUnavailableError so callers can treat them as a quiet skip.

export const CAMOFOX_DEFAULT_URL = "http://127.0.0.1:9377";
export const CAMOFOX_DEFAULT_TIMEOUT_MS = 45_000;
const RESPONSE_CAP = 1 << 20;

export class CamofoxUnavailableError extends ShareError {
  constructor(detail: string) {
    super(`camofox unavailable: ${detail}`);
    this.name = "CamofoxUnavailableError";
  }
}

export function camofoxBase(): string | null {
  const configured = process.env.AGENT_CONSOLE_CAMOFOX_URL || CAMOFOX_DEFAULT_URL;
  return configured === "off" ? null : configured;
}

async function readCapped(response: Response): Promise<any> {
  const text = await response.text();
  if (text.length > RESPONSE_CAP) throw new CamofoxUnavailableError("response too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new CamofoxUnavailableError("invalid json");
  }
}

export async function camofoxCall(
  pathname: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs: number = CAMOFOX_DEFAULT_TIMEOUT_MS,
): Promise<any> {
  const base = camofoxBase();
  if (!base) throw new CamofoxUnavailableError("disabled");
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(new URL(pathname, base), {
      ...init,
      headers: { "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CamofoxUnavailableError(String((error as Error)?.message ?? error).slice(0, 100));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new CamofoxUnavailableError(`${pathname.split("?")[0]} ${response.status}`);
  }
  return readCapped(response);
}
