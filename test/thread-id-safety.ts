import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-id-safety-"));
const dir = path.join(root, "data");
fs.mkdirSync(dir);
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: dir,
  AGENT_CONSOLE_BRAIN: path.join(dir, "missing"),
  AGENT_CONSOLE_LABELS: "0",
});
const { Threads } = await import("../server/threads.ts");
const removed: string[] = [];
const threads = new Threads((event: any) => {
  if (event?.t === "removed") removed.push(event.thread);
});

const victim = path.join(root, "victim");
fs.mkdirSync(victim);
fs.writeFileSync(path.join(victim, "keep.txt"), "keep");

for (const badId of ["../../victim", "../victim", "/tmp", "", randomUUID()])
  assert.doesNotThrow(() => threads.remove(badId), badId);
assert.ok(fs.existsSync(path.join(victim, "keep.txt")), "sentinel survived");
assert.deepEqual(removed, [], "no removed event");
assert.throws(() => threads.page("../x"), /Invalid thread id/);
console.log("thread-id-safety ok");
process.exit(0);
