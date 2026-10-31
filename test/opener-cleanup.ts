import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-opener-cleanup-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "no-brain");
process.env.AGENT_CONSOLE_LABELS = "0";
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const contexts = new Map<string, any>();
PROVIDERS.set("cleanup-fixture", {
  id: "cleanup-fixture",
  label: "Cleanup fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(t, ctx) {
    contexts.set(t.id, ctx);
    return {
      alive: true,
      send() {},
      steer() {},
      abort() {},
      kill() {},
    };
  },
} as any);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const logPath = (id: string) => path.join(data, "logs", `${id}.jsonl`);

const threads = new Threads(() => {});
const start = (disposable?: 1) => {
  const t = threads.create({
    provider: "cleanup-fixture",
    cwd: data,
    title: "fixture",
    disposable,
  });
  threads.send(t.id, "ok");
  return t;
};

// a disposable thread is removed after its result, log file included; others are untouched
const keep = start();
for (const result of [{ subtype: "success" }, { subtype: "error", is_error: true }]) {
  const gone = start(1);
  contexts.get(gone.id).event({ type: "result", ...result });
  assert.ok(
    threads.list().some((t) => t.id === gone.id),
    "still listed in the finishing tick",
  );
  await tick();
  await tick();
  assert.ok(!threads.list().some((t) => t.id === gone.id), "disposable removed");
  assert.equal(fs.existsSync(logPath(gone.id)), false, "log file is gone");
}
contexts.get(keep.id).event({ type: "result", subtype: "success" });
await tick();
await tick();
assert.ok(
  threads.list().some((t) => t.id === keep.id),
  "non-disposable kept",
);
assert.equal(fs.existsSync(logPath(keep.id)), true);
threads.shutdown();

// boot: idle disposable and legacy archived opener threads go; other archived threads stay
const row = (id: string, extra: any) => ({
  id,
  title: "fixture",
  provider: "cleanup-fixture",
  cwd: data,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  cost: 0,
  ...extra,
});
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    row("disp", { disposable: 1 }),
    row("legacy", { title: "Window opener · codex", archived: 5 }),
    row("filed", { title: "Some work", archived: 5 }),
    row("live-opener-title", { title: "Window opener · codex" }),
    row("plain", {}),
  ]),
);
const booted = new Threads(() => {});
assert.deepEqual(
  booted
    .list()
    .map((t) => t.id)
    .sort(),
  ["filed", "live-opener-title", "plain"],
);
booted.shutdown();
fs.rmSync(data, { recursive: true, force: true });
console.log("opener-cleanup ok");
