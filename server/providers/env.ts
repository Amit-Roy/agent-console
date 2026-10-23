import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privacyEnv } from "../privacy.ts";

// Credentials for non-Claude providers come from env files, never from the Claude child's environment, so the
// subscription login can't be swapped for metered billing by accident. Later files win; the process env wins over files.
const FILES = (
  process.env.AGENT_CONSOLE_ENV_FILES ||
  [
    path.join(os.homedir(), ".config", "agent-console", "env"),
    path.join(os.homedir(), "openrouter", ".env"),
  ].join(":")
)
  .split(":")
  .filter(Boolean);

// vendor-neutral names people actually use -> the names each harness reads
const ALIASES: Record<string, string> = {
  OPEN_ROUTER_TOKEN: "OPENROUTER_API_KEY",
  OPENROUTER_TOKEN: "OPENROUTER_API_KEY",
};

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    out[ALIASES[m[1]] ?? m[1]] = v;
  }
  return out;
}

export function fileEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FILES) {
    try {
      Object.assign(out, parseEnv(fs.readFileSync(f, "utf8")));
    } catch {}
  }
  return out;
}

export function hasKey(name: string): boolean {
  return !!(process.env[name] || fileEnv()[name]);
}

// Environment for a non-Claude child: our env, plus credential files. Anthropic variables never pass through.
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...fileEnv(), ...privacyEnv };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"]) delete env[k];
  return env;
}
