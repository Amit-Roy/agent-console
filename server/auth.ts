import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");
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
export const PASSWORD = process.env.AGENT_CONSOLE_PASSWORD || loadOrCreate("password", () => rand(15));
const SECRET = loadOrCreate("secret", () => rand(32));

const COOKIE = "ac_session";
const TTL_MS = 30 * 24 * 3600 * 1000;

const sign = (payload: string) => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

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
