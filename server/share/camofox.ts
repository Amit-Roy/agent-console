import { ensureCamofoxStarted } from "./camofox-start.ts";
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

function isRefused(error: unknown): boolean {
  return (error as any)?.cause?.code === "ECONNREFUSED";
}

function wrapFetchError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return error;
  return new CamofoxUnavailableError(String((error as Error)?.message ?? error).slice(0, 100));
}

function fetchOnce(
  base: string,
  pathname: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(new URL(pathname, base), {
    ...init,
    headers: { "content-type": "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

export async function camofoxCall(
  pathname: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs: number = CAMOFOX_DEFAULT_TIMEOUT_MS,
): Promise<any> {
  const base = camofoxBase();
  if (!base) throw new CamofoxUnavailableError("disabled");
  let response: Response;
  try {
    response = await fetchOnce(base, pathname, init, signal, timeoutMs);
  } catch (error) {
    // Refused means the request never reached a server, so one retry after autostart is safe for any method.
    if (signal?.aborted || !isRefused(error) || !(await ensureCamofoxStarted(base)))
      throw wrapFetchError(error, signal);
    try {
      response = await fetchOnce(base, pathname, init, signal, timeoutMs);
    } catch (retryError) {
      throw wrapFetchError(retryError, signal);
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new CamofoxUnavailableError(`${pathname.split("?")[0]} ${response.status}`);
  }
  return readCapped(response);
}
