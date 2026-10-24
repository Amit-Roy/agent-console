import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-titles-"));
process.env.AGENT_CONSOLE_DATA = dir;
process.env.AGENT_CONSOLE_BRAIN = path.join(dir, "no-brain");
process.env.AGENT_CONSOLE_LABELS = "0";
process.env.AGENT_CONSOLE_MOCK = "1";
const { registerHooks } = await import("node:module");
let fontLoads = 0;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "fontkit") fontLoads++;
    return next(specifier, context);
  },
});
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
PROVIDERS.set("fixture", {
  id: "fixture",
  label: "Fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start() {
    return { alive: true, send() {}, abort() {}, kill() {} };
  },
} as any);
const tick = () => new Promise((r) => setTimeout(r, 50));
const { cleanTitle } = await import("../server/providers/title.ts");
assert.equal(fontLoads, 0, "font parser must stay unloaded until a title needs measuring");
assert.equal(cleanTitle("Auth fix redirect"), "Auth fix redirect", "natural title survives cleanup");
assert.equal(fontLoads, 0, "naming must not require a newly installed runtime font parser");
hooks.deregister();
execFileSync(process.execPath, ["scripts/title-metrics.mjs", "--check"], { stdio: "pipe" });
assert.equal(cleanTitle(""), undefined, "empty replies must be rejected");
assert.equal(
  cleanTitle("Orchestrator GitHub issue triage queue worker"),
  "Orchestrator GitHub issue triage",
  "whole words only, within the 30-char budget",
);
assert.equal(cleanTitle("Social multi-platform"), "Social multi-platform", "no mid-word cut");
const threads = new Threads(() => {});
try {
  // an unnamed thread is named by its prompts
  const t = threads.create({ provider: "fixture", cwd: dir });
  assert.equal(t.autoTitle, true);
  assert.ok(!t.titleLocked);
  threads.send(t.id, "fix the login redirect bug please");
  await tick();
  assert.equal(threads.get(t.id)!.title, "fix:the login");
  assert.equal(threads.get(t.id)!.autoTitle, false);
  // the title helper reads every user message from the log, not a stored copy
  assert.equal(threads.get(t.id)!.recent, undefined);
  // a manual rename locks the title for good
  threads.update(t.id, { title: "My own name" });
  assert.equal(threads.get(t.id)!.titleLocked, true);
  threads.send(t.id, "now rework the billing export totally", { delivery: "queued" } as any);
  await tick();
  assert.equal(threads.get(t.id)!.title, "My own name");
  // a title given at creation is a manual title
  const named = threads.create({
    provider: "fixture",
    cwd: dir,
    title: "agent-console:10 Idle windows",
  });
  assert.equal(named.titleLocked, true);
  threads.send(named.id, "completely different subject entirely");
  await tick();
  assert.equal(threads.get(named.id)!.title, "agent-console:10 Idle windows");
  // A distinct long model reply is shortened on a feature word boundary.
  const capped = threads.create({ provider: "fixture", cwd: path.join(dir, "capped") });
  threads.send(capped.id, "Mobile:keyboard focus overflow");
  await tick();
  assert.ok(threads.get(capped.id)!.title!.length <= 20, "title exceeds Android width");
  assert.equal(threads.get(capped.id)!.title, "Mobile:keyboard");
} finally {
  threads.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  "PASS thread titles: first prompt names, history-based input, manual rename and creation title lock",
);
