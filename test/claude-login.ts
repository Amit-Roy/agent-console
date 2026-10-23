// In-app Claude sign-in against a fake `claude auth login`. No network, no real credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finishClaudeLogin, startClaudeLogin } from "../server/claude-login.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-claude-login-"));
const fake = path.join(home, "claude");
// Prints the authorize link, then signs in as FAKE_EMAIL when given the code "good#state".
fs.writeFileSync(
  fake,
  `#!${process.execPath}
import fs from 'node:fs';
const dir = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(dir + '/args.json', JSON.stringify({ args: process.argv.slice(2), leaked: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].filter(k => process.env[k]) }));
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\\nPaste code here if prompted > ");
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  if (input.trim() !== 'good#state') { console.log('Login failed: Request failed with status code 400'); process.exit(1); }
  fs.writeFileSync(dir + '/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-' + process.env.FAKE_EMAIL } }));
  fs.writeFileSync(dir + '/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: process.env.FAKE_EMAIL } }));
});
`,
  { mode: 0o700 },
);
const env = (email: string) => {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_EMAIL: email,
    ANTHROPIC_API_KEY: "fixture",
    CLAUDE_CODE_OAUTH_TOKEN: "fixture",
  };
  delete e.CLAUDE_CONFIG_DIR;
  return e;
};
const base = { ...process.env };
delete base.CLAUDE_CONFIG_DIR;
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

try {
  // Sunny keeps legacy ~/.claude.json: the identity merges into it and other settings survive.
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { keep: 1 } }));
  const { url } = await startClaudeLogin("sunny", {
    command: fake,
    env: env("sunny.amit.roy@gmail.com"),
  });
  assert.match(url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  await finishClaudeLogin("sunny", "good#state", home, base);
  assert.equal(
    read(path.join(home, ".claude", ".credentials.json")).claudeAiOauth.accessToken,
    "fresh-sunny.amit.roy@gmail.com",
  );
  assert.equal(fs.statSync(path.join(home, ".claude", ".credentials.json")).mode & 0o777, 0o600);
  assert.deepEqual(read(path.join(home, ".claude.json")), {
    mcpServers: { keep: 1 },
    oauthAccount: { emailAddress: "sunny.amit.roy@gmail.com" },
  });

  // A login as the wrong person never replaces the working one.
  await startClaudeLogin("sunny", { command: fake, env: env("someone@example.com") });
  await assert.rejects(
    finishClaudeLogin("sunny", "good#state", home, base),
    /signed in as someone@example\.com/,
  );
  assert.equal(
    read(path.join(home, ".claude", ".credentials.json")).claudeAiOauth.accessToken,
    "fresh-sunny.amit.roy@gmail.com",
  );

  // A rejected code reports the CLI error; the session is then gone.
  await startClaudeLogin("nefro", { command: fake, env: env("nefro.amit.roy@gmail.com") });
  await assert.rejects(finishClaudeLogin("nefro", "bad#state", home, base), /Login failed/);
  await assert.rejects(finishClaudeLogin("nefro", "good#state", home, base), /expired/);

  // Nefro installs into its own profile, with the email hint and without metered-billing overrides.
  await startClaudeLogin("nefro", { command: fake, env: env("nefro.amit.roy@gmail.com") });
  const tmp = fs
    .readdirSync(os.tmpdir())
    .filter((d) => d.startsWith("claude-login-"))
    .map((d) => path.join(os.tmpdir(), d))
    .find(
      (d) =>
        fs.existsSync(path.join(d, "args.json")) &&
        read(path.join(d, "args.json")).args.includes("nefro.amit.roy@gmail.com"),
    )!;
  assert.deepEqual(read(path.join(tmp, "args.json")), {
    args: ["auth", "login", "--claudeai", "--email", "nefro.amit.roy@gmail.com"],
    leaked: [],
  });
  await finishClaudeLogin("nefro", "good#state", home, base);
  assert.equal(
    read(path.join(home, ".claude-nefro", ".claude.json")).oauthAccount.emailAddress,
    "nefro.amit.roy@gmail.com",
  );
  assert.equal(fs.existsSync(tmp), false, "the throwaway profile is removed");
  console.log("claude login: ok");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
