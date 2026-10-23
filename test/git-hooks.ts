// The committed pre-commit hook rejects a commit when the unit suite fails and lets it through when it passes.
// The hook's command is overridable (AGENT_CONSOLE_PRECOMMIT_CMD) so this test does not run the whole suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hooks-"));
const git = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

git(["init", "-q"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
fs.mkdirSync(path.join(repo, ".githooks"));
fs.copyFileSync(path.join(root, ".githooks", "pre-commit"), path.join(repo, ".githooks", "pre-commit"));
fs.chmodSync(path.join(repo, ".githooks", "pre-commit"), 0o755);
git(["config", "core.hooksPath", ".githooks"]);
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
git(["add", "a.txt"]);

const failing = git(["commit", "-q", "-m", "broken"], { AGENT_CONSOLE_PRECOMMIT_CMD: "echo failing-suite >&2; exit 1" });
assert.notEqual(failing.status, 0, "a failing suite must block the commit");
assert.match(failing.stderr, /failing-suite/);
assert.notEqual(git(["rev-parse", "--verify", "HEAD"]).status, 0, "no commit may exist after a rejected commit");

const passing = git(["commit", "-q", "-m", "ok"], { AGENT_CONSOLE_PRECOMMIT_CMD: "true" });
assert.equal(passing.status, 0, passing.stderr);
assert.equal(git(["rev-parse", "--verify", "HEAD"]).status, 0);

fs.rmSync(repo, { recursive: true, force: true });
console.log("git-hooks ok");
