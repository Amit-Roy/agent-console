import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "console-url-"));
const config = path.join(scratch, "env");
const alias = "https://console.nefro-dev-coder.duckdns.org/";
const template = "https://{{port}}--main--workspace--owner.example.test/";
const run = (overrides: NodeJS.ProcessEnv = {}) =>
  spawnSync("bash", ["bin/agent-console", "url"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_CONSOLE_RUN: scratch,
      AGENT_CONSOLE_ENV_FILES: config,
      AGENT_CONSOLE_URL: "",
      VSCODE_PROXY_URI: template,
      PORT: "7070",
      ...overrides,
    },
  });
try {
  fs.writeFileSync(config, `AGENT_CONSOLE_URL=${alias}\nUNRELATED_SECRET=fixture-private\n`);
  assert.equal(run().stdout.trim(), alias, "The URL command must use the configured short URL");
  assert.equal(
    run({ AGENT_CONSOLE_URL: "https://override.example.test" }).stdout.trim(),
    "https://override.example.test/",
  );
  fs.writeFileSync(config, "");
  assert.equal(run({ PORT: "7072" }).stdout.trim(), template.replace("{{port}}", "7072"));
  assert.equal(run({ VSCODE_PROXY_URI: "" }).stdout.trim(), "");
  for (const value of [
    "http://console.example.test",
    "https://user:fixture-private@console.example.test",
    "https://console.example.test/?token=fixture-private",
    "not a URL",
  ]) {
    const result = run({ AGENT_CONSOLE_URL: value });
    assert.notEqual(result.status, 0, "An invalid public URL must fail explicitly");
    assert.equal(result.stdout, "");
    assert.ok(
      !result.stderr.includes("fixture-private"),
      "URL validation must not print credentials",
    );
  }
  console.log(
    "Console URL tests passed: configured alias, environment precedence, proxy fallback, and safe validation.",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
