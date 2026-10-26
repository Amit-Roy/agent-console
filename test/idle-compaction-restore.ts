// Boot defers idle-compaction deadlines past listen (#348): the constructor schedules nothing, restoreIdleCompaction
// restores future deadlines, drops overdue ones, and announces only the threads whose deadline changed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-idle-restore-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: dir,
  AGENT_CONSOLE_BRAIN: path.join(dir, "missing"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_IDLE_COMPACT_CLAUDE_TTL_MS: "100000",
});
const { Threads } = await import("../server/threads.ts");
const now = Date.now();
const saved = (id: string, activityAt: number, extra: object = {}) => ({
  id,
  title: id,
  provider: "claude",
  cwd: dir,
  status: "idle",
  createdAt: 1,
  updatedAt: now,
  sessionId: `session-${id}`,
  context: { used: 60000 },
  lastUserActivityAt: activityAt,
  lastProviderActivityAt: activityAt,
  ...extra,
});
const future = now - 10_000; // deadline = activity + ttl - lead = now + 60 s
fs.writeFileSync(
  path.join(dir, "threads.json"),
  JSON.stringify([
    saved("fresh", future),
    saved("overdue", now - 200_000, { idleCompactionDueAt: now + 5_000 }),
    saved("same", future, { idleCompactionDueAt: future + 70_000 }),
  ]),
);
fs.writeFileSync(path.join(dir, "turns.backfilled"), "fixture");
const events: any[] = [];
const threads = new Threads((event) => events.push(event));
try {
  assert.equal(threads.get("fresh")!.idleCompactionDueAt, undefined, "constructor defers deadlines");
  assert.deepEqual(events, [], "constructor emits nothing");
  threads.restoreIdleCompaction();
  assert.equal(threads.get("fresh")!.idleCompactionDueAt, future + 70_000);
  assert.equal(threads.get("overdue")!.idleCompactionDueAt, undefined, "overdue work is not caught up");
  assert.equal(threads.get("same")!.idleCompactionDueAt, future + 70_000);
  assert.deepEqual(
    events.map((event) => event.thread.id).sort(),
    ["fresh", "overdue"],
    "only changed deadlines are announced",
  );
  events.length = 0;
  threads.restoreIdleCompaction();
  assert.deepEqual(events, [], "a second restore changes nothing");
  console.log("idle-compaction-restore ok");
} finally {
  threads.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
}
