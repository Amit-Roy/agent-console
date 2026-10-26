import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Iron bridge: keys that iron-proxy manages are set on the iron host over ssh. The value goes to the
// child on stdin only (never argv, env or logs); ssh stderr is discarded so no remote text is relayed.
export type IronEntry = { name: string; tokenSha: string };
export type IronMap = Map<string, IronEntry>;

const OK_TTL = 60_000;
const FAIL_TTL = 10_000;
const TIMEOUT = { status: 10_000, set: 20_000, token: 10_000 };
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// Used when iron cannot be reached: these never fall back to plaintext.
export const KNOWN_MANAGED = new Set([
  "NVIDIA_API_KEY",
  "DEEPAEEK_API_KEY",
  "DEEPSEEK_API_KEY",
  "HUGGING_FACE_TOKEN",
  "OPEN_ROUTER_TOKEN",
  "OPENROUTER_API_KEY",
]);

type Run = { code: number | null; out: string };

function sshCommand(args: string[]): { bin: string; argv: string[] } {
  const override = process.env.VAULT_IRON_SSH;
  if (override) return { bin: override, argv: args };
  const host = process.env.VAULT_IRON_HOST || "vps";
  const key = path.join(os.homedir(), ".ssh", "id_iron_vault");
  const opts = [
    "-i",
    key,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
  ];
  return { bin: "ssh", argv: [...opts, `root@${host}`, ...args] };
}

function run(args: string[], ms: number, stdin?: string): Promise<Run> {
  return new Promise((resolve) => {
    const cmd = sshCommand(args);
    const child = spawn(cmd.bin, cmd.argv, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.stdout.on("data", (d) => {
      if (out.length < 1_000_000) out += d;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

function parseStatus(out: string): IronMap | null {
  const map: IronMap = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof row?.name !== "string" || typeof row?.tokenSha !== "string") return null;
    const vars: unknown[] = Array.isArray(row.envVars) ? row.envVars : [];
    for (const v of vars) {
      if (typeof v === "string")
        map.set(v, { name: row.name, tokenSha: row.tokenSha.toLowerCase() });
    }
  }
  return map;
}

let cache: { at: number; ttl: number; map: IronMap | null } | null = null;

export async function ironStatus(): Promise<IronMap | null> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.map;
  const r = await run(["status"], TIMEOUT.status);
  const map = r.code === 0 ? parseStatus(r.out) : null;
  cache = { at: Date.now(), ttl: map ? OK_TTL : FAIL_TTL, map };
  return map;
}

/* last status seen, for synchronous checks; never calls out */
export const ironCached = (): IronMap | null => cache?.map ?? null;
export const ironForget = () => {
  cache = null;
};

export async function ironSet(name: string, value: string): Promise<boolean> {
  if (!NAME.test(name)) return false;
  const r = await run(["set", name], TIMEOUT.set, value);
  ironForget();
  return r.code === 0 && r.out.trim() === `ok ${name}`;
}

export async function ironToken(name: string): Promise<string | null> {
  if (!NAME.test(name)) return null;
  const r = await run(["token", name], TIMEOUT.token);
  const token = r.out.replace(/\r?\n$/, "");
  return r.code === 0 && token && !/[\r\n\0]/.test(token) ? token : null;
}
