import { spawnLines, parseJson } from "./proc.ts";
import { childEnv } from "./env.ts";
import { codexRouting } from "./codex-routing.ts";
import type { AgentCtx, ThreadSpec } from "./types.ts";

// exec treats /compact as a prompt. Use the native app-server operation against the same persisted thread instead.
export function compactCodex(t: ThreadSpec, ctx: AgentCtx) {
  if (!t.sessionId) throw new Error("Send a message before compacting this thread.");
  const started = Date.now();
  let finished = false, confirmed = false, requested = false;
  const finish = (error?: string) => {
    if (finished) return;
    finished = true; clearTimeout(timer);
    if (error) ctx.event({ type: "console_error", text: error });
    ctx.event({ type: "result", subtype: error ? "error" : "success", is_error: !!error, duration_ms: Date.now() - started });
    proc.kill();
  };
  const rpc = (id: number | undefined, method: string, params: object) => proc.write(JSON.stringify({ ...(id != null ? { id } : {}), method, params }));
  const routing = codexRouting(childEnv());
  const proc = spawnLines("codex compaction", "codex", ["app-server", ...routing.args], { cwd: t.cwd, env: routing.env }, {
    ...ctx,
    event: ev => { if (ev.type === "console_error") finish(ev.text); else ctx.event(ev); },
    exited: info => { if (!finished) finish(info.aborted ? "Compaction stopped." : `Codex compaction exited before completion (${info.code ?? info.signal}). ${info.stderr.trim().slice(-300)}`); },
  }, line => {
    const r = parseJson(line);
    if (!r || finished) return;
    if (r.error && r.id != null) return finish(String(r.error.message || "Codex rejected compaction."));
    if (r.method === "error" && !r.params?.willRetry && (!r.params?.threadId || r.params.threadId === t.sessionId)) return finish(r.params?.error?.message || "Codex compaction failed.");
    if (r.id === 1 && !r.method) {
      rpc(undefined, "initialized", {});
      rpc(2, "thread/resume", {
        threadId: t.sessionId, excludeTurns: true, cwd: t.cwd, approvalPolicy: "never",
        sandbox: t.mode === "bypassPermissions" ? "danger-full-access" : t.mode === "plan" ? "read-only" : "workspace-write",
        ...(t.model !== "default" ? { model: t.model } : {}),
        ...(t.effort && t.effort !== "default" ? { config: { model_reasoning_effort: t.effort } } : {}),
      });
    } else if (r.id === 2 && !r.method) {
      requested = true;
      rpc(3, "thread/compact/start", { threadId: t.sessionId });
    } else if (requested && r.params?.threadId === t.sessionId) {
      if (r.method === "item/completed" && r.params.item?.type === "contextCompaction") {
        confirmed = true;
        ctx.event({ type: "system", subtype: "compact_boundary" });
      } else if (r.method === "turn/completed") {
        const turn = r.params.turn;
        finish(turn?.status === "completed" && confirmed ? undefined : turn?.error?.message || "Codex did not confirm context compaction.");
      } else if (r.method === "error" && !r.params.willRetry) finish(r.params.error?.message || "Codex compaction failed.");
    }
  });
  const timer = setTimeout(() => finish("Context compaction timed out. Try again when the provider is available."), 180_000);
  rpc(1, "initialize", { clientInfo: { name: "agent_console", version: "1.0.0" } });
  return { abort: () => finish("Compaction stopped."), kill: () => { finished = true; clearTimeout(timer); proc.kill(); } };
}
