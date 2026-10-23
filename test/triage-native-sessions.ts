import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNativeSessions, genuineNativeRequest } from "../scripts/triage-native-sessions.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "triage-native-sessions-"));
const timestamp = "2026-01-01T00:00:00.000Z";
function write(file: string, rows: any[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    rows.map((row) => JSON.stringify({ timestamp, ...row })).join("\n") + "\n",
  );
}
const claudeUser = (sessionId: string, text: string) => ({
  type: "user",
  sessionId,
  message: { role: "user", content: text },
});
const claudeAssistant = (sessionId: string, id: string, output = 5) => ({
  type: "assistant",
  sessionId,
  message: {
    id,
    role: "assistant",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: output,
    },
    content: [{ type: "tool_use", id: `call-${id}` }],
  },
});
const codexMeta = (id: string, parent?: string) => ({
  type: "session_meta",
  payload: {
    id,
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "exec",
  },
});
const codexUser = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const codexUsage = (thread: string, response: string, input = 100, output = 10) => ({
  type: "token_usage_record",
  payload: {
    thread_id: thread,
    response_id: response,
    usage: { input_tokens: input, output_tokens: output, cached_input_tokens: input / 2 },
    thread_token_usage: { input_tokens: 999_999_999, output_tokens: 999_999_999 },
    turn_token_usage: { input_tokens: 888_888_888, output_tokens: 888_888_888 },
  },
});
try {
  assert.equal(buildNativeSessions({ detectRunningProcesses: false }).audit.files, 0);
  assert.equal(
    genuineNativeRequest("<environment_context>Injected environment</environment_context>"),
    undefined,
  );
  assert.equal(
    genuineNativeRequest("x".repeat(13_000))?.length,
    13_000,
    "Original length must survive until truncation provenance is recorded",
  );
  assert.equal(
    genuineNativeRequest([
      { type: "tool_result", content: "Never a request" },
      { type: "text", text: "Build the app." },
    ]),
    "Build the app.",
  );
  const claudeDir = path.join(temporary, "claude");
  write(path.join(claudeDir, "root.jsonl"), [
    claudeUser("root", "# AGENTS.md instructions for somewhere"),
    claudeUser("root", "Build a preview."),
    claudeAssistant("root", "root-message", 4),
    claudeAssistant("root", "root-message", 5),
    claudeUser("root", "Later scope must not become a predictor."),
  ]);
  write(path.join(claudeDir, "root", "subagents", "agent-child.jsonl"), [
    claudeUser("root", "Delegate a check."),
    claudeAssistant("root", "child-message", 7),
  ]);
  write(path.join(claudeDir, "fork.jsonl"), [
    claudeUser("root", "Copied ancestor prompt."),
    claudeAssistant("root", "root-message", 5),
    claudeUser("fork", "Own fork request."),
    claudeAssistant("fork", "fork-message", 3),
  ]);
  const claude = buildNativeSessions({ claudeDir, detectRunningProcesses: false });
  assert.equal(claude.tasks.length, 2);
  const root = claude.tasks.find((task) => task.provenance.rootNativeSessionId === "root")!;
  assert.equal(root.request, "Build a preview.");
  assert.equal(root.inputTokens, 120);
  assert.equal(root.outputTokens, 12);
  assert.equal(root.cacheReadTokens, 60);
  assert.equal(root.nonCachedInputTokens, 60);
  assert.equal(root.toolCalls, 2);
  assert.equal(root.provenance.childCount, 1);
  assert.deepEqual(root.provenance.nativeSessionIds, ["root", "agent-child"]);
  const fork = claude.tasks.find((task) => task.provenance.rootNativeSessionId === "fork")!;
  assert.equal(fork.inputTokens, 60);
  assert.equal(fork.request, "Own fork request.");
  assert.equal(fork.group, root.group);
  assert.equal(
    root.provenance.terminalStatus,
    "inactive-after-user",
    "Inactive unfinished snapshots retain observed usage.",
  );
  const active = buildNativeSessions({
    claudeDir,
    activeNativeSessionIds: ["agent-child"],
    detectRunningProcesses: false,
  });
  assert.equal(active.tasks.length, 1);
  assert.equal(active.audit.excluded["active-session"], 1);

  const codexDir = path.join(temporary, "codex");
  write(path.join(codexDir, "rollout-native-root.jsonl"), [
    codexMeta("native-root"),
    codexUser("<environment_context>System context</environment_context>"),
    codexUser("Ship the console."),
    codexUsage("other-thread", "cloned-parent", 9999),
    codexUsage("native-root", "own-response"),
    codexUsage("native-root", "own-response"),
    { type: "response_item", payload: { type: "function_call", call_id: "shared-call" } },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 9999, output_tokens: 9999, cached_input_tokens: 0 },
        },
      },
    },
    { type: "event_msg", payload: { type: "turn_aborted" } },
  ]);
  write(path.join(codexDir, "rollout-native-child.jsonl"), [
    codexMeta("native-child", "native-root"),
    codexUser("Child brief."),
    codexUsage("native-root", "cloned-parent", 5000),
    codexUsage("native-child", "child-response", 50, 7),
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "shared-call" } },
  ]);
  write(path.join(codexDir, "rollout-native-orphan.jsonl"), [
    codexMeta("native-orphan", "missing-parent"),
    codexUser("Orphan brief."),
    codexUsage("native-orphan", "orphan-response"),
  ]);
  const codex = buildNativeSessions({ codexDir, detectRunningProcesses: false });
  assert.equal(codex.tasks.length, 1);
  assert.equal(codex.tasks[0].inputTokens, 150);
  assert.equal(codex.tasks[0].outputTokens, 17);
  assert.equal(codex.tasks[0].toolCalls, 1);
  assert.equal(codex.tasks[0].toolRounds, null);
  assert.equal(codex.tasks[0].request, "Ship the console.");
  assert.equal(codex.tasks[0].provenance.terminalStatus, "observed-interruption");
  assert.equal(codex.audit.orphanChildren, 1);
  const fallbackDir = path.join(temporary, "fallback");
  write(path.join(fallbackDir, "old.jsonl"), [
    codexMeta("old"),
    codexUser("An old session."),
    ...[
      [100, 10],
      [100, 10],
      [150, 20],
      [20, 3],
      [30, 4],
    ].map(([input, output]) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: output } },
      },
    })),
  ]);
  const fallback = buildNativeSessions({ codexDir: fallbackDir, detectRunningProcesses: false });
  assert.equal(fallback.tasks[0].inputTokens, 180);
  assert.equal(fallback.tasks[0].outputTokens, 24);
  assert.equal(fallback.tasks[0].cacheReadTokens, null);

  const piDir = path.join(temporary, "pi");
  const piAssistant = {
    type: "message",
    id: "pi-assistant",
    message: {
      role: "assistant",
      stopReason: "error",
      usage: { input: 10, output: 4, cacheRead: 20, cacheWrite: 30 },
      content: [{ type: "toolCall", id: "pi-tool" }],
    },
  };
  write(path.join(piDir, "pi.jsonl"), [
    { type: "session", id: "pi-root" },
    {
      type: "message",
      id: "system",
      message: { role: "system", content: "Private system prompt." },
    },
    { type: "message", id: "user", message: { role: "user", content: "Implement a form." } },
    piAssistant,
    piAssistant,
  ]);
  const pi = buildNativeSessions({ piDir, detectRunningProcesses: false });
  assert.equal(pi.tasks[0].inputTokens, 60);
  assert.equal(pi.tasks[0].outputTokens, 4);
  assert.equal(pi.tasks[0].toolCalls, 1);
  assert.equal(pi.tasks[0].provenance.terminalStatus, "observed-error");
  write(path.join(piDir, "missing.jsonl"), [
    { type: "session", id: "pi-missing" },
    { type: "message", id: "user", message: { role: "user", content: "No telemetry." } },
  ]);
  fs.writeFileSync(path.join(piDir, "broken.jsonl"), "{PRIVATE_INVALID_DATA\n");
  const incomplete = buildNativeSessions({ piDir, detectRunningProcesses: false });
  assert.equal(incomplete.tasks.length, 1);
  assert.equal(incomplete.audit.excluded["missing-usage-telemetry"], 1);
  assert.equal(incomplete.audit.excluded["malformed-jsonl"], 1);
  assert.ok(!JSON.stringify(incomplete.audit).includes("PRIVATE_INVALID_DATA"));
  assert.equal(
    buildNativeSessions({ piDir, maxFileBytes: 1, detectRunningProcesses: false }).tasks.length,
    0,
  );
  console.log(
    "Native session parsing passed: ownership, dedupe, child rollup, cache accounting, inactive failures, missing telemetry, and bounded reads.",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
