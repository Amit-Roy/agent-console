import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeAccount = "primary" | "secondary";

export function normalizeClaudeAccount(value?: string): ClaudeAccount {
  if (value === undefined || value === "primary") return "primary";
  if (value === "secondary") return "secondary";
  throw new Error("Unknown Claude account.");
}

export function claudeConfigDir(account?: string, env = process.env, home = os.homedir()): string {
  return normalizeClaudeAccount(account) === "secondary"
    ? path.join(home, ".claude-secondary")
    : env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

function claudeAccountEmail(
  account: ClaudeAccount,
  env = process.env,
  home = os.homedir(),
): string {
  try {
    const metadata = path.join(claudeConfigDir(account, env, home), ".claude.json");
    const legacy =
      account === "primary" && !env.CLAUDE_CONFIG_DIR ? path.join(home, ".claude.json") : undefined;
    const file = fs.existsSync(metadata) ? metadata : legacy;
    if (!file) return "";
    const email = JSON.parse(fs.readFileSync(file, "utf8")).oauthAccount?.emailAddress;
    return typeof email === "string" ? email.trim() : "";
  } catch {
    return "";
  }
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
    return selected === "primary" || claudeAccountEmail(selected, env, home).length > 0;
  } catch {
    return false;
  }
}

export function requireClaudeAccount(account?: string): ClaudeAccount {
  const selected = normalizeClaudeAccount(account);
  if (selected === "secondary" && !claudeAccountReady(selected))
    throw new Error(
      "Secondary Claude account is not signed in. Complete its separate Claude login first.",
    );
  return selected;
}

export const claudeUsageKey = (account?: string) =>
  normalizeClaudeAccount(account) === "secondary" ? "claude:secondary" : "claude";

export function claudeAccounts(env = process.env, home = os.homedir()) {
  return (["primary", "secondary"] as const).map((account) => ({
    id: account,
    label: account === "primary" ? "Primary" : "Secondary",
    email: claudeAccountEmail(account, env, home),
    ready: claudeAccountReady(account, env, home),
  }));
}
