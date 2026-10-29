import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeAccountReady,
  claudeAccounts,
  claudeConfigDir,
  claudeUsageKey,
  normalizeClaudeAccount,
} from "../server/providers/claude-accounts.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-claude-accounts-"));
try {
  const config = path.join(home, ".claude-secondary");
  assert.equal(normalizeClaudeAccount(), "primary");
  assert.throws(() => normalizeClaudeAccount("../other"), /Unknown Claude account/);
  assert.equal(claudeConfigDir("primary", { CLAUDE_CONFIG_DIR: "/custom" }, home), "/custom");
  assert.equal(claudeConfigDir("secondary", { CLAUDE_CONFIG_DIR: "/custom" }, home), config);
  assert.equal(claudeUsageKey(), "claude");
  assert.equal(claudeUsageKey("secondary"), "claude:secondary");
  assert.equal(claudeAccountReady("secondary", {}, home), false);
  fs.mkdirSync(config);
  fs.writeFileSync(
    path.join(config, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-fixture" } }),
  );
  assert.equal(
    claudeAccountReady("secondary", {}, home),
    false,
    "Secondary requires explicit account identity.",
  );
  const metadata = path.join(config, ".claude.json");
  fs.writeFileSync(metadata, JSON.stringify({ oauthAccount: { emailAddress: "  " } }));
  assert.equal(
    claudeAccountReady("secondary", {}, home),
    false,
    "Blank account metadata does not establish readiness.",
  );
  fs.writeFileSync(
    metadata,
    JSON.stringify({ oauthAccount: { emailAddress: "arbitrary-user@example.com" } }),
  );
  assert.equal(claudeAccountReady("secondary", {}, home), true);
  assert.equal(claudeAccounts({}, home)[1].email, "arbitrary-user@example.com");
  assert.equal(claudeAccounts({}, home)[0].email, "");
  const primary = path.join(home, ".claude");
  fs.mkdirSync(primary);
  fs.writeFileSync(
    path.join(primary, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-fixture" } }),
  );
  assert.equal(claudeAccountReady("primary", {}, home), true);
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "legacy@example.com" } }),
  );
  assert.equal(claudeAccounts({}, home)[0].email, "legacy@example.com");
  fs.writeFileSync(metadata, "invalid JSON");
  assert.equal(claudeAccountReady("secondary", {}, home), false);
  assert.equal(claudeAccounts({}, home)[1].email, "");
  fs.writeFileSync(path.join(config, ".credentials.json"), "{}");
  assert.equal(claudeAccountReady("secondary", {}, home), false);
  console.log("PASS Claude account isolation, readiness, identity validation, and quota keys");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
