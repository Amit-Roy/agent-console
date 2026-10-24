import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-usage-stop-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_MOCK = "1";
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "no-brain");
process.env.AGENT_CONSOLE_LABELS = "0";
fs.mkdirSync(path.join(data, "logs"), { recursive: true });
fs.mkdirSync(path.join(data, "pi-sessions"), { recursive: true });

const { detectUsageStop } = await import("../server/usage-stop.ts");
const { Threads } = await import("../server/threads.ts");

const claude = detectUsageStop("claude", {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 429,
  api_error: "usage_limit_reached",
  result: "You've hit your session limit · resets 8:20pm (UTC)",
});
assert.ok(claude?.text.includes("session limit"));
const codexText =
  "You’ve hit your usage limit. Upgrade to Pro or try again at Oct 27th, 2026 6:36 AM.";
assert.ok(detectUsageStop("codex", { is_error: true }, codexText));
assert.ok(
  detectUsageStop(
    "codex",
    { is_error: true },
    "You’ve hit your usage limit. try again at 5:55 PM.",
  ),
);
assert.ok(detectUsageStop("codex", { is_error: true }, "boom", "usageLimitExceeded"));
assert.equal(
  detectUsageStop("claude", { is_error: true, result: "Claude AI usage limit reached|1790000000" })
    ?.resetsAt,
  1790000000_000,
);
assert.equal(
  detectUsageStop("claude", { is_error: true, error: { message: "429 rate limit, retry" } }),
  undefined,
);
assert.equal(detectUsageStop("codex", { is_error: true }, "Network error", "other"), undefined);

const threads = new Threads(() => {});
const t = threads.create({ provider: "mock", cwd: data, title: "x" });
assert.ok(t.readAt);
const turn = (failure: string, code?: string) => {
  (threads as any).turns.set(t.id, {
    start: Date.now() - 10,
    tools: {},
    failure,
    failureCode: code,
  });
  (threads as any).onEvent(threads.get(t.id), {
    type: "result",
    is_error: true,
    subtype: "error",
    duration_ms: 10,
  });
};
turn(codexText, "usageLimitExceeded");
const got = threads.get(t.id)!;
assert.equal(got.usageStop?.provider, "mock");
assert.ok(got.replyAt);
const before = got.updatedAt;
await new Promise((r) => setTimeout(r, 5));
threads.markRead(t.id);
assert.equal(threads.get(t.id)!.updatedAt, before);
assert.ok(threads.get(t.id)!.readAt! > t.createdAt - 1);
await threads.send(t.id, "again");
assert.equal(threads.get(t.id)!.usageStop, undefined);

// migration default
const file = path.join(data, "threads.json");
const saved = JSON.parse(fs.readFileSync(file, "utf8"));
for (const s of saved) {
  delete s.readAt;
  s.replyAt = 1234;
}
fs.writeFileSync(file, JSON.stringify(saved));
const reloaded = new Threads(() => {});
assert.equal(reloaded.get(t.id)!.readAt, 1234);
console.log("usage-stop ok");
process.exit(0);
