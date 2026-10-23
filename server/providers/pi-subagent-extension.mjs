// Loaded explicitly by the console. Gives Pi a `subagent` tool: it runs a task in a child `pi --mode rpc` session and
// forwards the child's events as tool updates, which the console adapter shows under the parent's Agent call.
import { spawn } from "node:child_process";

export default function subagent(pi) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a self-contained task to a child Pi session with a fresh context. Give it a short description and a complete prompt; it returns the child's final answer.",
    parameters: {
      type: "object",
      required: ["description", "prompt"],
      properties: {
        description: { type: "string", description: "Short label for the task" },
        prompt: { type: "string", description: "Complete instructions for the child" },
      },
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const child = spawn("pi", ["--mode", "rpc", "--no-session", ...(model ? ["--model", model] : [])], { cwd: ctx?.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let answer = "", buf = "", stderr = "", failed = "";
      const finished = new Promise((resolve) => {
        child.on("error", (e) => { failed = String(e.message); resolve(); });
        child.on("close", () => resolve());
        child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-500); });
        child.stdout.on("data", (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === "message_end" && ev.message?.role === "assistant") {
              if (ev.message.stopReason === "error") failed = String(ev.message.errorMessage || "child failed");
              const text = (ev.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
              if (text) answer = text;
            }
            if (ev.type === "message_end" || ev.type === "tool_execution_end") onUpdate?.({ content: [{ type: "text", text: "" }], details: { event: ev } });
            if (ev.type === "agent_settled") { child.stdin.end(); child.kill(); }
          }
        });
      });
      signal?.addEventListener("abort", () => child.kill(), { once: true });
      child.stdin.write(JSON.stringify({ id: "sub", type: "prompt", message: params.prompt }) + "\n");
      await finished;
      if (signal?.aborted) throw new Error("Subagent aborted.");
      if (failed || !answer) throw new Error(failed || stderr || "Subagent returned no answer.");
      return { content: [{ type: "text", text: answer }] };
    },
  });
}
