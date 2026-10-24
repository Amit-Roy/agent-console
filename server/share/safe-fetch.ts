import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import { ShareError } from "./types.ts";

// SSRF guard for fetching user-shared URLs. Every connection resolves DNS exactly once, vets every answer, and dials the
// vetted address (no second lookup, so no DNS rebinding). Only http/https on ports 80/443; redirects are followed by hand
// and every hop is re-validated. Bodies are capped while streaming and never decompressed.

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 << 20;
export const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const USER_AGENT = "Mozilla/5.0 (compatible; agent-console-share/1.0)";

export class BlockedAddressError extends ShareError {
  constructor(detail: string) {
    super("That link points to a private or blocked address.");
    this.name = "BlockedAddressError";
    this.detail = detail;
  }
  detail: string;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Test-only hooks. Production callers never pass these. */
export interface SafeFetchTestHooks {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  isAllowed?: (address: string) => boolean;
  ports?: string[];
}

export interface SafeFetchOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  testHooks?: SafeFetchTestHooks;
}

export interface SafeResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
}

/** True only for globally routable unicast addresses; IPv4-mapped IPv6 is judged by the embedded IPv4 address. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  return parsed.range() === "unicast";
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

function checkAddress(address: string, hooks: SafeFetchTestHooks): void {
  const allowed = hooks.isAllowed ? hooks.isAllowed(address) : isPublicAddress(address);
  if (!allowed) throw new BlockedAddressError(`blocked address ${address}`);
}

/** Validates scheme, credentials, port and IP-literal hosts without resolving DNS. */
export function validateUrl(raw: string | URL, hooks: SafeFetchTestHooks = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new BlockedAddressError("invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new BlockedAddressError(`blocked scheme ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new BlockedAddressError("credentials in url");
  const ports = hooks.ports ? new Set(["", ...hooks.ports]) : ALLOWED_PORTS;
  if (!ports.has(parsed.port)) throw new BlockedAddressError(`blocked port ${parsed.port}`);
  const host = stripBrackets(parsed.hostname);
  if (!host) throw new BlockedAddressError("empty host");
  if (net.isIP(host)) checkAddress(host, hooks);
  return parsed;
}

/** Resolves once and vets every answer; any non-public answer rejects the whole host. */
async function resolveVetted(
  hostname: string,
  hooks: SafeFetchTestHooks,
): Promise<ResolvedAddress[]> {
  const host = stripBrackets(hostname);
  const family = net.isIP(host);
  const answers = family
    ? [{ address: host, family }]
    : await (hooks.resolve ?? defaultResolve)(host);
  if (!answers.length) throw new BlockedAddressError(`no address for ${host}`);
  for (const answer of answers) checkAddress(answer.address, hooks);
  return answers;
}

/**
 * For callers that hand the URL to another tool (yt-dlp, camofox): validates the URL and that the host resolves only to
 * public addresses. The other tool resolves again, so this narrows but cannot fully close the rebinding window.
 */
export async function assertPublicHost(
  raw: string | URL,
  hooks: SafeFetchTestHooks = {},
): Promise<ResolvedAddress[]> {
  const parsed = validateUrl(raw, hooks);
  return resolveVetted(parsed.hostname, hooks);
}

type LookupCallback = (
  error: Error | null,
  address: string | ResolvedAddress[],
  family?: number,
) => void;

function makeLookup(hooks: SafeFetchTestHooks) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    resolveVetted(hostname, hooks).then(
      (answers) => {
        if (options?.all) callback(null, answers);
        else callback(null, answers[0].address, answers[0].family);
      },
      (error) => callback(error, ""),
    );
  };
}

function flattenHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined)
      out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function readCapped(
  body: AsyncIterable<Buffer> & { destroy?: () => void },
  maxBytes: number,
) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy?.();
      throw new ShareError(
        `That response is too large (over ${Math.round(maxBytes / 1048576)} MB).`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchHops(
  start: URL,
  agent: Agent,
  signal: AbortSignal,
  opts: SafeFetchOptions,
): Promise<SafeResponse> {
  const hooks = opts.testHooks ?? {};
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await request(current, {
      dispatcher: agent,
      method: "GET",
      signal,
      headers: {
        accept: opts.accept ?? "*/*",
        "accept-encoding": "identity",
        "user-agent": USER_AGENT,
      },
    });
    const headers = flattenHeaders(response.headers);
    if (isRedirect(response.statusCode) && headers.location) {
      await response.body.dump();
      current = validateUrl(new URL(headers.location, current), hooks);
      continue;
    }
    const declared = Number(headers["content-length"]);
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (declared > maxBytes) {
      response.body.destroy();
      throw new ShareError(
        `That response is too large (over ${Math.round(maxBytes / 1048576)} MB).`,
      );
    }
    const body = await readCapped(response.body, maxBytes);
    return {
      status: response.statusCode,
      url: current.href,
      headers,
      contentType: headers["content-type"] ?? "",
      body,
    };
  }
  throw new ShareError("That link redirects too many times.");
}

/** GET with the SSRF guard, a total timeout, a streaming byte cap and at most five re-validated redirects. */
export async function safeFetch(
  raw: string | URL,
  opts: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const hooks = opts.testHooks ?? {};
  const start = validateUrl(raw, hooks);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const agent = new Agent({
    connect: { lookup: makeLookup(hooks) as any, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    allowH2: false,
  });
  try {
    return await fetchHops(start, agent, signal, opts);
  } catch (error) {
    if (timeout.aborted && !opts.signal?.aborted)
      throw new ShareError("That page took too long to load.");
    throw error;
  } finally {
    agent.close().catch(() => {});
  }
}
