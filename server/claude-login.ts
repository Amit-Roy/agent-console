import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ClaudeAccount,
  claudeAccounts,
  claudeConfigDir,
  normalizeClaudeAccount,
} from "./providers/claude-accounts.ts";

// In-app Claude sign-in. `claude auth login` prints Anthropic's authorize URL and reads the code the callback page shows from stdin.
// It runs in a throwaway profile. Fresh profiles accept a signed-in identity; existing profiles
// require the same email before replacing their working login.
const SCRUBBED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDECODE",
];
const LIMIT_MS = 10 * 60_000;

type Login = {
  proc: ChildProcessWithoutNullStreams;
  dir: string;
  out: string;
  timer: NodeJS.Timeout;
  exited: Promise<number | null>;
};
const logins = new Map<ClaudeAccount, Login>();

function close(account: ClaudeAccount) {
  const l = logins.get(account);
  if (!l) return;
  logins.delete(account);
  clearTimeout(l.timer);
  if (l.proc.exitCode === null) l.proc.kill();
  fs.rmSync(l.dir, { recursive: true, force: true });
}

export function startClaudeLogin(
  id: string,
  opts: { command?: string; env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<{ url: string }> {
  const account = normalizeClaudeAccount(id);
  close(account);
  const email = claudeAccounts(opts.env ?? process.env, opts.home ?? os.homedir()).find(
    (accountProfile) => accountProfile.id === account,
  )!.email;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-login-"));
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    CLAUDE_CONFIG_DIR: dir,
    BROWSER: "true",
  };
  for (const k of SCRUBBED_ENV) delete env[k];
  const args = ["auth", "login", "--claudeai", ...(email ? ["--email", email] : [])];
  const proc = spawn(opts.command ?? "claude", args, {
    env,
    stdio: "pipe",
  });
  const exited = new Promise<number | null>((resolve) => proc.on("close", resolve));
  const login: Login = {
    proc,
    dir,
    out: "",
    exited,
    timer: setTimeout(() => close(account), LIMIT_MS),
  };
  logins.set(account, login);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      close(account);
      reject(new Error(msg));
    };
    const read = (d: Buffer) => {
      login.out += d;
      const url = login.out.match(/https:\/\/\S+\/oauth\/authorize\?\S+/)?.[0];
      if (url && !settled) {
        settled = true;
        resolve({ url });
      }
    };
    proc.stdout.on("data", read);
    proc.stderr.on("data", (d) => {
      login.out += d;
    });
    proc.on("error", () => fail("Claude Code is not installed on the server."));
    exited.then(() => fail("Claude sign-in stopped before it gave a link."));
    setTimeout(() => fail("Claude sign-in did not give a link."), 20_000).unref();
  });
}

// The pasted code also carries the OAuth state ("code#state"); the CLI checks it.
export async function finishClaudeLogin(
  id: string,
  code: string,
  home = os.homedir(),
  env = process.env,
): Promise<void> {
  const account = normalizeClaudeAccount(id);
  const l = logins.get(account);
  if (!l || l.proc.exitCode !== null) throw new Error("Sign-in expired. Tap Sign in again.");
  const pasted = String(code ?? "").trim();
  if (!pasted || /\s/.test(pasted)) throw new Error("Paste the code from the Claude page.");
  l.proc.stdin.end(pasted + "\n");
  const exit = await l.exited;
  try {
    if (exit !== 0)
      throw new Error(
        l.out.match(/Login failed[^\n]*/)?.[0] ?? "Claude rejected the code. Tap Sign in again.",
      );
    installClaudeLogin(account, l.dir, home, env);
  } finally {
    close(account);
  }
}

export function cancelClaudeLogin(id: string) {
  close(normalizeClaudeAccount(id));
}

// Copy the fresh login into the account's profile: credentials plus the oauthAccount identity, leaving all other settings alone.
export function installClaudeLogin(
  account: ClaudeAccount,
  from: string,
  home = os.homedir(),
  env = process.env,
) {
  const oauthAccount = JSON.parse(
    fs.readFileSync(path.join(from, ".claude.json"), "utf8"),
  ).oauthAccount;
  const expected = claudeAccounts(env, home).find(
    (accountProfile) => accountProfile.id === account,
  )!.email;
  const email =
    typeof oauthAccount?.emailAddress === "string" ? oauthAccount.emailAddress.trim() : "";
  if (!email) throw new Error("Claude sign-in did not provide an account email.");
  if (expected && email.toLowerCase() !== expected.toLowerCase())
    throw new Error(`That signed in as ${email || "an unknown account"}. Sign in as ${expected}.`);
  const config = claudeConfigDir(account, env, home);
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  writePrivate(
    path.join(config, ".credentials.json"),
    fs.readFileSync(path.join(from, ".credentials.json"), "utf8"),
  );
  // Primary keeps its identity in the legacy ~/.claude.json when CLAUDE_CONFIG_DIR is unset (see claudeAccountReady).
  const metadata = path.join(config, ".claude.json");
  const file =
    fs.existsSync(metadata) || account === "secondary" || env.CLAUDE_CONFIG_DIR
      ? metadata
      : path.join(home, ".claude.json");
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  writePrivate(file, JSON.stringify({ ...current, oauthAccount }, null, 2));
}

function writePrivate(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
