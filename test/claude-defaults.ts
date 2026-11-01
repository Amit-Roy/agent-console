// Claude's new-thread defaults: opus, bypassPermissions, medium effort (issue #409). Offline, mock provider on.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-claude-defaults-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
});
const { Threads } = await import("../server/threads.ts");
const { providerInfo } = await import("../server/providers/index.ts");
const threads = new Threads(() => {});

const fresh = threads.create({ provider: "claude", cwd: data });
assert.deepEqual([fresh.model, fresh.mode, fresh.effort], ["opus", "bypassPermissions", "medium"]);
console.log("PASS  create with no effort: opus/bypassPermissions/medium");

assert.equal(
  threads.create({ provider: "claude", cwd: data, effort: "default" }).effort,
  "default",
);
console.log("PASS  explicit default effort stays default");

assert.equal(threads.create({ provider: "claude", cwd: data, model: "haiku" }).effort, "default");
console.log("PASS  haiku without effort gets default");

assert.equal(providerInfo().find((p) => p.id === "claude")?.defaultEffort, "medium");
console.log("PASS  providerInfo exposes defaultEffort");

const mockThread = threads.create({ provider: "mock", cwd: data });
const forked = threads.fork(mockThread.id, "claude");
assert.deepEqual([forked.model, forked.effort], ["opus", "medium"]);
console.log("PASS  fork from another agent into Claude gets medium");

const same = threads.fork(threads.create({ provider: "claude", cwd: data, effort: "high" }).id);
assert.equal(same.effort, "high");
console.log("PASS  same-agent fork keeps source effort");
process.exit(0);
