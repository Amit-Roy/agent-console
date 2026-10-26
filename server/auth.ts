import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileEnv } from "./providers/env.ts";

export const DATA_DIR =
  process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function loadOrCreate(file: string, make: () => string): string {
  const p = path.join(DATA_DIR, file);
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    const v = make();
    fs.writeFileSync(p, v + "\n", { mode: 0o600 });
    return v;
  }
}

const rand = (n: number) => crypto.randomBytes(n).toString("base64url");
export const PASSWORD =
  process.env.AGENT_CONSOLE_PASSWORD || loadOrCreate("password", () => rand(15));
const SECRET = loadOrCreate("secret", () => rand(32));

const COOKIE = "__Host-ac_session";
const TTL_MS = 30 * 24 * 3600 * 1000;

const sign = (payload: string) =>
  crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function makeToken(): string {
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${sign(exp)}`;
}

export function tokenValid(tok: string | undefined): boolean {
  if (!tok) return false;
  const [exp, mac] = tok.split(".");
  if (!exp || !mac || !safeEqual(mac, sign(exp))) return false;
  return Number(exp) > Date.now();
}

export function cookieFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

export const setCookie = (tok: string) =>
  `${COOKIE}=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}`;

// crude brute-force limiter: 8 failures per 10 minutes, global (single-user tool)
const fails: number[] = [];
export function limited(): boolean {
  const now = Date.now();
  while (fails.length && now - fails[0] > 600_000) fails.shift();
  return fails.length >= 8;
}
export function recordFail() {
  fails.push(Date.now());
}

export function passwordOk(candidate: unknown): boolean {
  return typeof candidate === "string" && safeEqual(candidate, PASSWORD);
}

// --- Coder SSO -------------------------------------------------------------
// Behind Coder's authenticated port proxy the user has already signed in to Coder, so we trust a request
// iff its Host header is exactly this workspace app's Coder hostname. Direct hits on 127.0.0.1 (other local
// processes, DNS-rebinding pages) carry a different Host and still need the password cookie.
// Set AGENT_CONSOLE_AUTH=password to turn this off. Requires the port's Coder share level to stay "owner".
// AGENT_CONSOLE_PUBLIC_HOST (server env or ~/.config/agent-console/env) adds comma-separated hosts, e.g. a direct
// wildcard app host next to the tunnel one. Only list hosts that Coder itself authenticates.
function coderHostsFromEnv(): string[] {
  if (process.env.AGENT_CONSOLE_AUTH === "password") return [];
  const hosts = String(
    process.env.AGENT_CONSOLE_PUBLIC_HOST || fileEnv().AGENT_CONSOLE_PUBLIC_HOST || "",
  )
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const tpl = process.env.VSCODE_PROXY_URI; // e.g. https://{{port}}--main--ws--owner--host.coder.app/
  const port = process.env.PORT || "7070";
  if (tpl && tpl.includes("{{port}}")) {
    try {
      hosts.push(new URL(tpl.replace("{{port}}", port)).host.toLowerCase());
    } catch {}
  }
  return [...new Set(hosts)];
}
export const CODER_HOSTS = coderHostsFromEnv();
export const CODER_HOST = CODER_HOSTS[0];

const PROXY_HEADER = "x-agent-console-proxy";
const PROXY_HASH_HEX = String(
  process.env.AGENT_CONSOLE_PROXY_SECRET_SHA256 ||
    fileEnv().AGENT_CONSOLE_PROXY_SECRET_SHA256 ||
    "",
)
  .trim()
  .toLowerCase();
const PROXY_HASH = /^[0-9a-f]{64}$/.test(PROXY_HASH_HEX)
  ? Buffer.from(PROXY_HASH_HEX, "hex")
  : null;
export const PROXY_PROOF_ON = PROXY_HASH !== null;
if (CODER_HOSTS.length && !PROXY_PROOF_ON) {
  console.warn(
    "auth: AGENT_CONSOLE_PROXY_SECRET_SHA256 unset or invalid; Coder SSO disabled (fail closed); password cookie only",
  );
}

function proxyProofValid(header: string | string[] | undefined): boolean {
  if (!PROXY_HASH) return false; // not configured: fail closed
  if (typeof header !== "string") return false;
  const digest = crypto.createHash("sha256").update(header).digest();
  return crypto.timingSafeEqual(digest, PROXY_HASH);
}

export function viaCoder(req: {
  headers: { host?: string; [PROXY_HEADER]?: string | string[] };
}): boolean {
  const hostOk = CODER_HOSTS.includes(String(req.headers.host || "").toLowerCase());
  return hostOk && proxyProofValid(req.headers[PROXY_HEADER]);
}

export function authed(req: {
  headers: { cookie?: string; host?: string; [PROXY_HEADER]?: string | string[] };
}): boolean {
  return viaCoder(req) || tokenValid(cookieFrom(req.headers.cookie));
}
