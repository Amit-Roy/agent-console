import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-projection-contract-"));
process.env.AGENT_CONSOLE_DATA = dir;
const { HISTORY_PROJECTION, HISTORY_PROJECTION_VERSION } = await import("../server/threads.ts");

// Persisted views are keyed on HISTORY_PROJECTION_VERSION. If this output hash changes, bump the version
// (which invalidates every persisted sidecar) and update both pinned values below.
const PINNED_VERSION = 1;
const PINNED_OUTPUT_SHA256 = "0ec09ac2eb140c3526f60ba2072184dc7164def62b8e97d018eb0a3947b491e1";

const toolResult = (content: unknown, extra = {}) => ({
  type: "user",
  ts: 1,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content, ...extra }] },
});
const corpus: any[] = [
  toolResult("short result"),
  toolResult("r".repeat(5000)),
  toolResult([
    { type: "text", text: "array text", cache_control: { type: "ephemeral" } },
    { type: "image", source: { type: "base64", data: "AAAA" } },
  ]),
  toolResult("failed", { is_error: true }),
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" }, caller: "x" },
        { type: "future_block", payload: { keep: true } },
      ],
    },
  },
  { type: "result", subtype: "error", is_error: true, result: "e".repeat(800), duration_ms: 5 },
  { type: "checkpoint", ts: 2, seq: 1, kind: "turn", commit: "abc", files: ["a", "b"] },
  { type: "system", subtype: "init", model: "m" },
  { type: "user_input", text: "hello" },
  ...[
    "system/thinking_tokens",
    "system/status",
    "system/hook_started",
    "system/hook_response",
    "system/task_updated",
    "system/background_tasks_changed",
    "tool_progress",
  ].map((kind) => {
    const [type, subtype] = kind.split("/");
    return { type, ...(subtype ? { subtype } : {}), payload: "x" };
  }),
];

try {
  const output = corpus.map((entry, line) => HISTORY_PROJECTION.project(line, entry));
  assert.equal(output.filter((value) => value === null).length, 7, "every NOISE kind is dropped");
  const digest = createHash("sha256").update(JSON.stringify(output)).digest("hex");
  assert.equal(HISTORY_PROJECTION_VERSION, PINNED_VERSION, "version changed: update pins");
  assert.equal(digest, PINNED_OUTPUT_SHA256, "projection output changed: bump HISTORY_PROJECTION_VERSION");
  assert.match(HISTORY_PROJECTION.key, /^[0-9a-f]{64}$/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
