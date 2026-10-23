// Offline account setup/login checks. All account data and CLI calls are fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-account-cli-"));
const sunny = path.join(home, ".claude"),
  nefro = path.join(home, ".claude-nefro");
const bin = path.join(home, "bin"),
  capture = path.join(home, "capture.json");
const script = path.resolve("bin/claude-account");
fs.mkdirSync(sunny);
fs.mkdirSync(bin);
const shared = ["CLAUDE.md", "settings.json", "skills", "agents", "RTK.md"];
for (const name of shared) {
  if (["skills", "agents"].includes(name)) fs.mkdirSync(path.join(sunny, name));
  else
    fs.writeFileSync(
      path.join(sunny, name),
      name === "settings.json" ? "{}" : "Shared brain fixture.",
    );
}
for (const name of [".credentials.json", ".claude.json", "projects", "history.jsonl"])
  fs.writeFileSync(path.join(sunny, name), "private fixture");
fs.writeFileSync(
  path.join(bin, "claude"),
  `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),dir:process.env.CLAUDE_CONFIG_DIR,leaked:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDECODE'].filter(k=>process.env[k])}));\n`,
  { mode: 0o700 },
);
const env = {
  ...process.env,
  HOME: home,
  PATH: bin + path.delimiter + process.env.PATH,
  CAPTURE: capture,
  ANTHROPIC_API_KEY: "fixture",
  ANTHROPIC_AUTH_TOKEN: "fixture",
  CLAUDE_CODE_OAUTH_TOKEN: "fixture",
  CLAUDECODE: "fixture",
};
delete env.CLAUDE_CONFIG_DIR;
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
try {
  assert.equal(run("nefro", "setup").status, 0);
  for (const name of shared)
    assert.equal(fs.readlinkSync(path.join(nefro, name)), path.join(sunny, name));
  for (const name of [".credentials.json", ".claude.json", "projects", "history.jsonl"])
    assert.equal(fs.existsSync(path.join(nefro, name)), false, name + " must remain private");
  assert.equal(fs.statSync(nefro).mode & 0o777, 0o700);
  assert.equal(run("nefro", "setup").status, 0, "Setup is idempotent.");
  assert.equal(run("nefro", "login").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), {
    args: ["auth", "login", "--claudeai", "--email", "nefro.amit.roy@gmail.com"],
    dir: nefro,
    leaked: [],
  });
  assert.equal(run("sunny", "status").status, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(capture, "utf8")),
    { args: ["auth", "status"], leaked: [] },
    "Sunny preserves the legacy config lookup.",
  );
  assert.equal(
    run("nefro", "login", "--resume", "private-session").status,
    2,
    "Arbitrary CLI arguments are rejected.",
  );
  assert.equal(run("../sunny", "setup").status, 2);
  fs.unlinkSync(path.join(nefro, "CLAUDE.md"));
  fs.writeFileSync(path.join(nefro, "CLAUDE.md"), "Existing private instructions.");
  assert.equal(run("nefro", "setup").status, 1, "Existing files are never overwritten.");
  assert.equal(
    fs.readFileSync(path.join(nefro, "CLAUDE.md"), "utf8"),
    "Existing private instructions.",
  );
  console.log(
    "PASS account CLI: shared brain, private state, exact login routing, scrubbed auth, safe setup",
  );
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
