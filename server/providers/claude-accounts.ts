import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileEnv } from "./env.ts";

export type ClaudeAccount = "sunny" | "nefro";

export function normalizeClaudeAccount(value?: string): ClaudeAccount {
  if (value === undefined || value === "sunny") return "sunny";
  if (value === "nefro") return "nefro";
  throw new Error("Unknown Claude account.");
}

export function claudeConfigDir(account?: string, env = process.env, home = os.homedir()): string {
  return normalizeClaudeAccount(account) === "nefro"
    ? path.join(home, ".claude-nefro")
    : env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

// Expected sign-in emails are deployment config (process env, else the Console env file); unset skips the mismatch check.
function expectedEmail(account: ClaudeAccount): string {
  const name = account === "nefro" ? "CLAUDE_NEFRO_EMAIL" : "CLAUDE_SUNNY_EMAIL";
  return process.env[name] || fileEnv()[name] || "";
}

export function claudeAccountReady(
  account?: string,
  env = process.env,
  home = os.homedir(),
): boolean {
  try {
    const selected = normalizeClaudeAccount(account);
    const config = claudeConfigDir(selected, env, home);
    const oauth = JSON.parse(
      fs.readFileSync(path.join(config, ".credentials.json"), "utf8"),
    ).claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.length) return false;
    const metadata = path.join(config, ".claude.json");
    const legacy =
      selected === "sunny" && !env.CLAUDE_CONFIG_DIR ? path.join(home, ".claude.json") : undefined;
    const file = fs.existsSync(metadata) ? metadata : legacy;
    const email =
      file && fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8")).oauthAccount?.emailAddress
        : undefined;
    const expected = expectedEmail(selected);
    if (selected === "nefro" && typeof email !== "string") return false;
    if (expected && typeof email === "string" && email.toLowerCase() !== expected.toLowerCase())
      return false;
    return true;
  } catch {
    return false;
  }
}

export function requireClaudeAccount(account?: string): ClaudeAccount {
  const selected = normalizeClaudeAccount(account);
  if (selected === "nefro" && !claudeAccountReady(selected))
    throw new Error(
      "Nefro Claude account is not signed in. Complete its separate Claude login first.",
    );
  return selected;
}

export const claudeUsageKey = (account?: string) =>
  normalizeClaudeAccount(account) === "nefro" ? "claude:nefro" : "claude";

export function claudeAccounts() {
  return [
    {
      id: "sunny",
      label: "Sunny",
      email: expectedEmail("sunny"),
      ready: claudeAccountReady("sunny"),
    },
    {
      id: "nefro",
      label: "Nefro",
      email: expectedEmail("nefro"),
      ready: claudeAccountReady("nefro"),
    },
  ];
}
