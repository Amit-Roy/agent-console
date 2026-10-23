import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-provider-isolation-"));
const data = path.join(root, "data");
const cwd = path.join(root, "private-checkout");
const bin = path.join(root, "bin");
const sentinel = path.join(root, "shared-skill");
const coding = "nvidia/nvidia/nemotron-3-ultra-550b-a55b";
const retired = "nvidia/nvidia/nemotron-3-super-120b-a12b"; // NVIDIA 404s it; no longer approved
const vision = "nvidia/meta/llama-3.2-11b-vision-instruct";
fs.mkdirSync(cwd);
fs.mkdirSync(bin);
fs.writeFileSync(sentinel, "original");
execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
fs.writeFileSync(path.join(cwd, ".git", "agent-console-auto"), "private-checkout-v1\n");
fs.writeFileSync(
  path.join(bin, "pi"),
  `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
fs.writeFileSync('worker-started', 'yes');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'get_commands') return emit({type:'response',command:'get_commands',success:true,commands:[]});
  if (request.type !== 'prompt') return;
  let denied = false, error;
  try { fs.writeFileSync(${JSON.stringify(sentinel)}, 'overwritten'); }
  catch (e) { denied = e.code === 'EACCES' || e.code === 'EPERM'; error = e.code; }
  const outcome = {denied,error,tmp:process.env.TMPDIR};
  fs.writeFileSync(path.join(process.cwd(), process.env.AGENT_CONSOLE_THREAD + '.json'), JSON.stringify(outcome));
  emit({type:'agent_start'});
  emit({type:'message_end',message:{role:'assistant',model:'fixture',content:[{type:'text',text:JSON.stringify(outcome)}],stopReason:'stop'}});
  emit({type:'agent_settled'});
});
`,
  { mode: 0o700 },
);

process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_ENV_FILES = path.join(root, "no-env-file");
process.env.AGENT_CONSOLE_BRAIN = path.join(root, "no-brain");
process.env.AGENT_CONSOLE_LABELS = "0";
process.env.AGENT_CONSOLE_HEADROOM = "0";
process.env.AGENT_CONSOLE_PI_MODELS = `${vision},${retired},${coding}`;
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const { Threads } = await import("../server/threads.ts");
const { pi, refreshPiModels } = await import("../server/providers/pi.ts");
const { startModelRateBroker } = await import("../server/providers/model-rate-client.ts");
startModelRateBroker(1, data); // Pi children receive the loopback admission broker; the fake Pi never calls it
await refreshPiModels();
// Exercise the real Pi adapter without credentials or any model API request.
pi.status = () => ({ ok: true });
const callbacks = new Map<string, () => void>();
const threads = new Threads((event: any) => {
  if (event.t === "thread" && event.thread.status === "idle") callbacks.get(event.thread.id)?.();
});
const issueRun = {
  key: "fixture/repo#1",
  repo: "fixture/repo",
  number: 1,
  effort: "bau" as const,
  role: "work" as const,
  branch: "issue-1",
  base: "main",
};
async function run(id: string) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error("fake Pi worker did not finish within 8 seconds"));
    }, 8000);
    callbacks.set(id, () => {
      clearTimeout(timer);
      callbacks.delete(id);
      resolve();
    });
    try {
      threads.send(id, "attempt fixture writes");
    } catch (error) {
      clearTimeout(timer);
      callbacks.delete(id);
      reject(error);
    }
  });
  return JSON.parse(fs.readFileSync(path.join(cwd, `${id}.json`), "utf8"));
}

try {
  assert.throws(
    () => threads.create({ provider: "pi", cwd, model: vision, issueRun }),
    /not approved/,
  );
  process.env.AGENT_CONSOLE_PI_MODELS = vision;
  await refreshPiModels();
  assert.throws(
    () => threads.create({ provider: "pi", cwd, issueRun }),
    /no approved coding model/,
  );
  assert.equal(
    fs.existsSync(path.join(cwd, "worker-started")),
    false,
    "rejected models never launch a provider",
  );
  process.env.AGENT_CONSOLE_PI_MODELS = `${vision},${retired},${coding}`;
  await refreshPiModels();

  const auto = threads.create({ provider: "pi", cwd, title: "Auto isolation fixture", issueRun });
  assert.equal(auto.model, coding);
  const outcome = await run(auto.id);
  assert.equal(
    outcome.denied,
    true,
    "Threads must pass issueRun into the real Pi launcher so the kernel denies shared writes",
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "original");
  assert.equal(outcome.tmp, path.join(data, "auto-runtime", auto.id, "tmp"));
  assert.equal(
    threads.history(auto.id).some((event: any) => event.type === "result" && !event.is_error),
    true,
  );

  // A run saved on a model that was later retired restarts on an approved one instead of failing closed forever.
  threads.shutdown(); // drop the live process so the next send starts a new one
  threads.get(auto.id)!.model = retired;
  await run(auto.id);
  assert.equal(
    threads.get(auto.id)!.model,
    coding,
    "a retired stored model is re-selected on restart",
  );

  // The same real adapter permits an explicit manual model and normal writes.
  // This control proves the prior EACCES came from Auto confinement.
  const manual = threads.create({
    provider: "pi",
    cwd,
    title: "Manual isolation control",
    model: vision,
  });
  assert.equal(manual.model, vision);
  assert.equal((await run(manual.id)).denied, false);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "overwritten");
  console.log(
    "automation-provider-isolation: Threads -> Pi -> kernel denies shared writes; manual control and model rejection passed",
  );
} finally {
  threads.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}
