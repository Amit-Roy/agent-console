import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-boot-restore-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_MOCK = "1";
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "missing-brain");
const { linesWith } = await import("../server/history.ts");
const { usage } = await import("../server/usage.ts");
const { Threads } = await import("../server/threads.ts");
const jsonl = (events: unknown[]) => events.map(e => JSON.stringify(e) + "\n").join("");
const limits = (utilization: number) => ({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization } } } });
try {
  // Matching lines come back whole, once each, in file order; a final line without a newline still counts.
  const buf = Buffer.from('{"a":"café 🧪"}\n{"type":"result","modelUsage":{},"x":"init"}\n{"skip":1}\n{"type":"system","subtype":"init"}');
  assert.deepEqual(linesWith(buf, ['"modelUsage"', '"init"']), ['{"type":"result","modelUsage":{},"x":"init"}', '{"type":"system","subtype":"init"}']);
  assert.deepEqual(linesWith(Buffer.from("plain\n"), ['"init"']), []);

  // Boot restores the newest rate-limit event from the log tail, even when megabytes of tool output follow it.
  const filler = { type: "user", text: "x".repeat(200_000) };
  fs.writeFileSync(path.join(data, "logs/claude.jsonl"), jsonl([limits(0.1), filler, limits(0.4), filler, { type: "result" }]));
  fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([{ id: "claude", title: "fixture", provider: "claude", cwd: data, status: "idle", createdAt: 1, updatedAt: 2 }]));
  fs.writeFileSync(path.join(data, "turns.backfilled"), "fixture");
  const threads = new Threads(() => {});
  try {
    assert.equal(usage.get("claude"), undefined, "the constructor leaves log reads to restoreTelemetry");
    threads.restoreTelemetry();
    assert.equal(usage.get("claude")?.windows[0].used, 40);
  } finally { threads.shutdown(); }
  console.log("boot restore: ok");
} finally { fs.rmSync(data, { recursive: true, force: true }); }
