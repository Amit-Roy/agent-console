import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeAccountReady,
  claudeConfigDir,
  claudeUsageKey,
  normalizeClaudeAccount,
} from "../server/providers/claude-accounts.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-claude-accounts-"));
try {
  const config = path.join(home, ".claude-nefro");
  assert.equal(normalizeClaudeAccount(), "sunny");
  assert.throws(() => normalizeClaudeAccount("../other"), /Unknown Claude account/);
  assert.equal(claudeConfigDir("sunny", { CLAUDE_CONFIG_DIR: "/custom" }, home), "/custom");
  assert.equal(claudeConfigDir("nefro", { CLAUDE_CONFIG_DIR: "/custom" }, home), config);
  assert.equal(claudeUsageKey(), "claude");
  assert.equal(claudeUsageKey("nefro"), "claude:nefro");
  assert.equal(claudeAccountReady("nefro", {}, home), false);
  fs.mkdirSync(config);
  fs.writeFileSync(
    path.join(config, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-fixture" } }),
  );
  assert.equal(
    claudeAccountReady("nefro", {}, home),
    false,
    "Nefro requires explicit matching account identity.",
  );
  const metadata = path.join(config, ".claude.json");
  fs.writeFileSync(
    metadata,
    JSON.stringify({ oauthAccount: { emailAddress: "sunny.amit.roy@gmail.com" } }),
  );
  assert.equal(
    claudeAccountReady("nefro", {}, home),
    false,
    "Credentials belonging to the other account are rejected.",
  );
  fs.writeFileSync(
    metadata,
    JSON.stringify({ oauthAccount: { emailAddress: "nefro.amit.roy@gmail.com" } }),
  );
  assert.equal(claudeAccountReady("nefro", {}, home), true);
  fs.writeFileSync(path.join(config, ".credentials.json"), "{}");
  assert.equal(claudeAccountReady("nefro", {}, home), false);
  console.log("PASS Claude account isolation, readiness, identity validation, and quota keys");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
