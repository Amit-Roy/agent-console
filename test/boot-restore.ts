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
const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e) + "\n").join("");
const limits = (utilization: number, observedAt?: number) => ({
  type: "rate_limit_event",
  ...(observedAt == null ? {} : { observedAt, usageProvider: "claude" }),
  rate_limit_info: { unifiedWindows: { five_hour: { utilization } } },
});
try {
  // Matching lines come back whole, once each, in file order; a final line without a newline still counts.
  const buf = Buffer.from(
    '{"a":"café 🧪"}\n{"type":"result","modelUsage":{},"x":"init"}\n{"skip":1}\n{"type":"system","subtype":"init"}',
  );
  assert.deepEqual(linesWith(buf, ['"modelUsage"', '"init"']), [
    '{"type":"result","modelUsage":{},"x":"init"}',
    '{"type":"system","subtype":"init"}',
  ]);
  assert.deepEqual(linesWith(Buffer.from("plain\n"), ['"init"']), []);

  // Boot restores the newest rate-limit event from the log tail, even when megabytes of tool output follow it.
  const filler = { type: "user", text: "x".repeat(200_000) };
  fs.writeFileSync(
    path.join(data, "logs/claude.jsonl"),
    jsonl([limits(0.1, 300), filler, limits(0.4, 400), filler, { type: "result" }]),
  );
  fs.writeFileSync(path.join(data, "logs/legacy.jsonl"), jsonl([limits(0.9)]));
  fs.writeFileSync(
    path.join(data, "threads.json"),
    JSON.stringify([
      {
        id: "claude",
        title: "fixture",
        provider: "claude",
        claudeAccount: "primary",
        cwd: data,
        status: "idle",
        createdAt: 1,
        updatedAt: 999_999,
      },
      {
        id: "legacy",
        title: "legacy",
        provider: "claude",
        claudeAccount: "secondary",
        cwd: data,
        status: "idle",
        createdAt: 1,
        updatedAt: 999_999,
      },
    ]),
  );
  fs.writeFileSync(path.join(data, "turns.backfilled"), "fixture");
  const threads = new Threads(() => {});
  try {
    assert.equal(
      usage.get("claude"),
      undefined,
      "the constructor leaves log reads to restoreTelemetry",
    );
    threads.restoreTelemetry();
    assert.equal(usage.get("claude")?.windows[0].used, 40);
    assert.equal(
      usage.get("claude")?.updatedAt,
      400,
      "thread.updatedAt must not replace provider receipt time",
    );
    assert.equal(
      usage.get("claude:secondary"),
      undefined,
      "unstamped legacy events are skipped during boot restore",
    );
  } finally {
    threads.shutdown();
  }
  console.log("boot restore: ok");
} finally {
  fs.rmSync(data, { recursive: true, force: true });
}
