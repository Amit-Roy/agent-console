import type { Agent, AgentCtx, Provider, ThreadSpec } from "./types.ts";

// Deterministic fake agent for tests and UI work: no network, no quota. Enabled with AGENT_CONSOLE_MOCK=1.
//   "slow ..."   streams for ~10s (to test Stop)      "fail ..."  ends the turn with an error
//   "tool ..."   runs a fake Bash tool call            anything else is echoed back
export const mock: Provider = {
  id: "mock",
  label: "Mock",
  modes: ["plan", "acceptEdits", "bypassPermissions"],
  defaultMode: "acceptEdits",
  models: () => ["echo"],
  defaultModel: () => "echo",
  status: () => ({ ok: true }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    let timers: NodeJS.Timeout[] = [];
    let dead = false;
    const at = (ms: number, fn: () => void) => void timers.push(setTimeout(fn, ms));
    const stop = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const delta = (text: string) => ctx.event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    const done = (extra: object = {}) => ctx.event({ type: "result", subtype: "success", is_error: false, duration_ms: 50, ...extra });
    return {
      get alive() {
        return !dead;
      },
      send(text) {
        stop();
        ctx.event({ type: "system", subtype: "init", session_id: t.sessionId ?? `mock-${t.id}` });
        ctx.event({ type: "stream_event", event: { type: "message_start" } });
        const reply = `mock reply (${t.mode}, ${t.model}): ${text}`;
        if (text.startsWith("slow")) {
          for (let i = 0; i < 50; i++) at(200 * i, () => delta(`tick ${i} `));
          at(10_500, () => done());
        } else if (text.startsWith("fail")) {
          at(20, () => {
            ctx.event({ type: "console_error", text: "mock failure" });
            ctx.event({ type: "result", subtype: "error", is_error: true, duration_ms: 20 });
          });
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
