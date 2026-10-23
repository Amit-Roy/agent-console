// Loaded explicitly by the console. Gives Pi a `subagent` tool: it runs a task in a child `pi --mode rpc` session and
// forwards the child's events as tool updates, which the console adapter shows under the parent's Agent call.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODING_ROUTE } from "./pi-coding-route.mjs";

export default function subagent(pi) {
  const active = new Set();
  pi.on?.("session_shutdown", async () => {
    await Promise.all(
      [...active].map(({ stop, finished }) => {
        stop();
        return finished;
      }),
    );
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a self-contained task to a child Pi session with a fresh context. Give complete instructions and a short description. Independent calls run in parallel; assign separate files to children making edits. Optionally choose an available provider/model; otherwise inherit the parent model. Plan children have read-only tools. The result contains the final answer; child progress appears in the parent conversation.",
    executionMode: "parallel",
    parameters: {
      type: "object",
      required: ["description", "prompt"],
      properties: {
        description: { type: "string", description: "Short label for the task" },
        prompt: { type: "string", description: "Complete instructions for the child" },
        model: { type: "string", description: "Optional available provider/model ID" },
      },
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Subagent aborted.");
      const model = params.model || (ctx?.model && `${ctx.model.provider}/${ctx.model.id}`);
      if (
        params.model &&
        !ctx?.modelRegistry?.getAvailable().some((m) => `${m.provider}/${m.id}` === params.model)
      )
        throw new Error(`Subagent model not available: ${params.model}`);
      const args = ["--mode", "rpc", "--no-session", ...(model ? ["--model", model] : [])];
      const thinking = pi.getThinkingLevel?.();
      if (thinking) args.push("--thinking", thinking);
      if (process.env.AGENT_CONSOLE_PI_MODE === "plan") args.push("--tools", "read,grep,find,ls");
      if (process.env.AGENT_CONSOLE_PI_INSTRUCTIONS)
        args.push("--append-system-prompt", process.env.AGENT_CONSOLE_PI_INSTRUCTIONS);
      if (model === CODING_ROUTE)
        args.push("--extension", fileURLToPath(new URL("./pi-coding-route.mjs", import.meta.url)));
      const child = spawn("pi", args, {
        cwd: ctx?.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let answer = "",
        buf = "",
        stderr = "",
        failed = "",
        settled = false;
      let killTimer;
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.stdin.end();
        child.kill();
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref();
      };
      const finished = new Promise((resolve) => {
        child.on("error", (e) => {
          failed = String(e.message);
          resolve();
        });
        child.on("close", (code) => {
          if (!settled && !failed)
            failed = stderr || `Subagent exited before completion (${code}).`;
          resolve();
        });
        child.stdin.on("error", () => {}); // The exit handler reports closed pipes.
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => {
          stderr = (stderr + d).slice(-500);
        });
        child.stdout.on("data", (d) => {
          buf += d;
          while (buf.includes("\n")) {
            const i = buf.indexOf("\n");
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            let ev;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === "response" && ev.command === "prompt" && ev.success === false) {
              failed = String(ev.error || "Child prompt rejected.");
              stop();
            }
            if (ev.type === "message_end" && ev.message?.role === "assistant") {
              // Only the final reply determines success after Pi's automatic retries.
              failed =
                ev.message.stopReason === "error"
                  ? String(ev.message.errorMessage || "Child failed.")
                  : ev.message.stopReason === "aborted"
                    ? "Subagent aborted."
                    : "";
              answer = (ev.message.content ?? [])
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n");
            }
            if (ev.type === "message_end" || ev.type === "tool_execution_end")
              onUpdate?.({ content: [{ type: "text", text: "" }], details: { event: ev } });
            if (ev.type === "agent_settled") {
              settled = true;
              if (ev.aborted) failed = "Subagent aborted.";
              stop();
            }
          }
        });
      });
      const task = { stop, finished };
      active.add(task);
      signal?.addEventListener("abort", stop, { once: true });
      // Cancellation may arrive between the initial check and listener registration.
      if (signal?.aborted) stop();
      else
        child.stdin.write(
          JSON.stringify({ id: "sub", type: "prompt", message: params.prompt }) + "\n",
        );
      try {
        await finished;
      } finally {
        active.delete(task);
        signal?.removeEventListener("abort", stop);
        clearTimeout(killTimer);
      }
      if (signal?.aborted) throw new Error("Subagent aborted.");
      if (failed || !answer) throw new Error(failed || stderr || "Subagent returned no answer.");
      return { content: [{ type: "text", text: answer }] };
    },
  });
}
