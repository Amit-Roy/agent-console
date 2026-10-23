// Warm agents outlive short breaks (idle keepalive, count cap, memory guard), and tool processes run below agent priority.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-priority-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
  AGENT_CONSOLE_IDLE_MAX: "3",
});
const { Threads } = await import(pathToFileURL(path.join(root, "server/threads.ts")).href);
const { PROVIDERS } = await import(
  pathToFileURL(path.join(root, "server/providers/index.ts")).href
);
const { lowerToolPriority, toolEnvFile, TOOL_NICE } = await import(
  pathToFileURL(path.join(root, "server/tool-priority.ts")).href
);

const killed: string[] = [];
const names = new Map<string, string>();
PROVIDERS.set("idle-fixture", {
  id: "idle-fixture",
  label: "Idle fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(t: any, ctx: any) {
    let alive = true;
    return {
      get alive() {
        return alive;
      },
      send() {
        setImmediate(() => ctx.event({ type: "result", subtype: "success" }));
      },
      interrupt() {},
      abort() {
        alive = false;
        ctx.exited({ code: null, signal: "SIGINT", stderr: "", aborted: true });
      },
      kill() {
        alive = false;
        killed.push(names.get(t.id));
        ctx.exited({ code: null, signal: "SIGTERM", stderr: "", aborted: true });
      },
    };
  },
});
mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
const threads = new Threads(() => {});
const settle = () => new Promise((r) => setImmediate(r));
const plenty = 0.8,
  tight = 0.1;

// idle keepalive: 25 idle minutes no longer cost a cold start
const a = threads.create({ provider: "idle-fixture", cwd: data, title: "a" });
names.set(a.id, "a");
threads.send(a.id, "go");
await settle();
mock.timers.tick(25 * 60_000);
threads.sweep(plenty);
assert.deepEqual(killed, [], "an agent idle for 25 minutes stays warm");
mock.timers.tick(6 * 60_000);
threads.sweep(plenty);
assert.deepEqual(killed, ["a"], "past 30 idle minutes it is freed");

// count cap: oldest idle processes go first
killed.length = 0;
for (const title of ["b", "c", "d", "e"]) {
  const t = threads.create({ provider: "idle-fixture", cwd: data, title });
  names.set(t.id, title);
  threads.send(t.id, "go");
  await settle();
  mock.timers.tick(1000);
}
threads.sweep(plenty);
assert.deepEqual(killed, ["b"], "the idle cap (3 here) frees the oldest");

// memory guard: under 20% available, keep only the newest two
threads.sweep(tight);
assert.deepEqual(killed, ["b", "c"], "low memory frees all but the newest two");

// tool priority: grandchildren of the server are lowered, direct children are not
const env = fs.readFileSync(toolEnvFile(), "utf8");
assert.match(
  env,
  new RegExp(`renice -n ${TOOL_NICE} -p \\$\\$`),
  "Claude's Bash env file lowers each command",
);
const harness = spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 300));
const tool = Number(
  fs.readFileSync(`/proc/${harness.pid}/task/${harness.pid}/children`, "utf8").trim().split(" ")[0],
);
const harnessPriority = os.getPriority(harness.pid!);
const toolPriority = os.getPriority(tool);
try {
  lowerToolPriority();
  assert.equal(
    os.getPriority(harness.pid!),
    harnessPriority,
    "the harness keeps its inherited priority",
  );
  assert.equal(
    os.getPriority(tool),
    Math.max(toolPriority, TOOL_NICE),
    "tool priority is lowered without raising already lower-priority work",
  );
} finally {
  harness.kill("SIGKILL");
  try {
    process.kill(tool, "SIGKILL");
  } catch {}
}
console.log(
  "PASS idle agents stay warm for two hours within a count cap and a memory floor; tool processes run below agents",
);
process.exit(0);
