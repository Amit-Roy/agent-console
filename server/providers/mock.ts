import type { Agent, AgentCtx, Provider, ThreadSpec } from "./types.ts";
import crypto from "node:crypto";

// Deterministic fake agent for tests and UI work: no network, no quota. Enabled with AGENT_CONSOLE_MOCK=1.
//   "slow ..."   streams for ~10s (to test Stop)      "fail ..."  ends the turn with an error
//   "tool ..."   runs a fake Bash tool call            "agent ..." runs a background subagent with nested activity (~1.6s)
//   "ctx N ..."  reports the context N% full           anything else is echoed back
export const mock: Provider = {
  id: "mock",
  label: "Mock",
  modes: ["plan", "acceptEdits", "bypassPermissions"],
  defaultMode: "acceptEdits",
  steer: true,
  models: () => ["echo"],
  defaultModel: () => "echo",
  status: () => ({ ok: true }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    let timers: NodeJS.Timeout[] = [];
    let dead = false;
    // AGENT_CONSOLE_MOCK_START_MS simulates a harness cold start: nothing streams before the "process" is ready
    const readyAt = Date.now() + (Number(process.env.AGENT_CONSOLE_MOCK_START_MS) || 0);
    const at = (ms: number, fn: () => void) => void timers.push(setTimeout(fn, ms + Math.max(0, readyAt - Date.now())));
    const stop = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const delta = (text: string) => ctx.event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    const done = (extra: object = {}) => ctx.event({ type: "result", subtype: "success", is_error: false, duration_ms: 50, ...extra });
    let turns = 0;
    let questionId: string | undefined;
    return {
      get alive() {
        return !dead;
      },
      compact() {
        stop();
        at(Number(process.env.AGENT_CONSOLE_MOCK_COMPACT_MS) || 200, () => { ctx.event({ type: "system", subtype: "compact_boundary" }); ctx.event({ type: "context_usage", used: 6000, max: 200000 }); done(); });
      },
      // a steer arrives mid-turn: the mock folds it into the stream, like a real agent picking it up after its current tool call
      steer(text) {
        delta(` [steered: ${text}]`);
      },
      answer(id, reply) {
        if (dead || id !== questionId) throw new Error("This question is no longer waiting for an answer.");
        questionId = undefined;
        at(20, () => {
          const text = reply.note !== undefined ? `Continuing with your message: ${reply.note}` : reply.skip ? "Question skipped; continuing." : `Continuing with ${JSON.stringify(reply.answers)}.`;
          ctx.event({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
          done();
        });
        return true;
      },
      send(text, images = []) {
        stop();
        questionId = undefined;
        turns++;
        ctx.event({ type: "system", subtype: "status", status: "requesting" }); // chatter the manager must drop
        const forced = /^ctx (\d+)/.exec(text);
        ctx.event({ type: "context_usage", used: forced ? Number(forced[1]) * 2000 : turns * 12_000, max: 200_000 });
        ctx.event({ type: "system", subtype: "init", session_id: t.sessionId ?? `mock-${t.id}` });
        ctx.event({ type: "stream_event", event: { type: "message_start" } });
        const reply = `mock reply (${t.mode}, ${t.model}): ${text}${images.length ? ` [${images.length} image(s): ${images.map((i) => i.media_type).join(", ")}]` : ""}`;
        if (text.startsWith("question")) {
          questionId = `fixture-question-${crypto.randomUUID()}`;
          const id = questionId;
          at(10, () => ctx.event({ type: "question", id, questions: [
            { id: "scope", header: "Scope", question: "How much should I review?", options: [{ label: "Quick pass", description: "Focus on the changed code." }, { label: "Full review", description: "Review the complete implementation." }], allowOther: true },
            { id: "checks", header: "Checks", question: "Which checks should I run?", options: [{ label: "Tests", description: "Run the relevant automated checks." }, { label: "Screenshots", description: "Inspect desktop and mobile layouts." }], multiSelect: true, allowOther: true },
          ] }));
        } else if (text.startsWith("slow")) {
          for (let i = 0; i < 50; i++) at(200 * i, () => delta(`tick ${i} `));
          at(10_500, () => done());
        } else if (text.startsWith("fail")) {
          at(20, () => {
            ctx.event({ type: "console_error", text: "mock failure" });
            ctx.event({ type: "result", subtype: "error", is_error: true, duration_ms: 20 });
          });
        } else if (text.startsWith("agent")) {
          // what Claude emits for a backgrounded subagent: the Agent call, task_started, the instant "launched" result, the subagent's own
          // messages tagged with the parent id, progress, and a completion notice that arrives while the main turn is still going
          const sub = (type: string, content: any[]) => ctx.event({ type, parent_tool_use_id: "a1", message: { role: type === "user" ? "user" : "assistant", content } });
          at(10, () => ctx.event({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Survey the repo", subagent_type: "explore", prompt: "List the top-level files and say what they are." } }] } }));
          at(20, () => ctx.event({ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "a1", task_type: "local_agent", is_backgrounded: true, description: "Survey the repo", subagent_type: "explore" }));
          at(40, () => ctx.event({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully.", is_error: false }] } }));
          at(60, () => sub("assistant", [{ type: "text", text: "Looking at the repo structure first." }]));
          at(70, () => sub("assistant", [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "ls -la" } }]));
          at(90, () => sub("user", [{ type: "tool_result", tool_use_id: "s1", content: "total 8", is_error: false }]));
          at(100, () => ctx.event({ type: "system", subtype: "task_progress", task_id: "k1", tool_use_id: "a1", description: "Running ls", subagent_type: "explore", usage: { total_tokens: 4200, tool_uses: 1, duration_ms: 3000 } }));
          at(120, () => ctx.event({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Subagent launched; waiting for it." }] } }));
          at(1500, () => ctx.event({ type: "system", subtype: "task_notification", task_id: "k1", tool_use_id: "a1", status: "completed", summary: "Survey the repo" }));
          at(1600, () => done());
        } else if (text.startsWith("tool")) {
          at(10, () => ctx.event({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hello" } }] } }));
          at(40, () => ctx.event({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hello", is_error: false }] } }));
          at(70, () => {
            ctx.event({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
            done({ total_cost_usd: 0.001 });
          });
        } else {
          at(10, () => delta(reply.slice(0, 12)));
          at(30, () => delta(reply.slice(12)));
          at(60, () => {
            ctx.event({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
            done();
          });
        }
      },
      interrupt() {
        stop();
        questionId = undefined;
        ctx.event({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 0 });
      },
      configure(_from, to) {
        Object.assign(t, to);
        return true;
      },
      abort() {
        stop();
        dead = true;
        ctx.exited({ code: null, signal: "SIGINT", stderr: "", aborted: true });
      },
      kill() {
        stop();
        dead = true;
        ctx.exited({ code: null, signal: "SIGTERM", stderr: "", aborted: true });
      },
    };
  },
};
