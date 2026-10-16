import { spawnLines, parseJson } from "./proc.ts";
import { childEnv } from "./env.ts";
import { brainContext } from "./brain.ts";
import { IMAGE_ONLY_PROMPT, type Agent, type AgentCtx, type Attachment, type ThreadSpec } from "./types.ts";

// Keep the owning app-server alive: turn/steer must reach the process running the turn.
export function startCodexApp(t: ThreadSpec, ctx: AgentCtx, translate: (row: any) => void): Agent {
  let session = t.sessionId, active: string | undefined, alive = true, serial = 0;
  let operation: "turn" | "compact" | undefined, compactConfirmed = false;
  let compactTimer: NodeJS.Timeout | undefined;
  let total: any, baseline: any;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const request = (method: string, params: object): Promise<any> => new Promise((resolve, reject) => {
    if (!alive) return reject(new Error("Codex connection closed."));
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    p.write(JSON.stringify({ id, method, params }));
  });
  const finish = (error?: string) => {
    if (!operation) return;
    const wasCompact = operation === "compact";
    operation = undefined; active = undefined; clearTimeout(compactTimer);
    if (wasCompact && !compactConfirmed && !error) error = "Codex did not confirm context compaction.";
    translate(error ? { type: "turn.failed", error: { message: error } } : { type: "turn.completed" });
  };
  const failed = (error: any) => { finish(String(error?.message || error)); p.kill(); };
  const p = spawnLines("codex", "codex", ["app-server", "-c", "analytics.enabled=false", "-c", "feedback.enabled=false"], { cwd: t.cwd, env: childEnv() }, {
    ...ctx,
    exited(info) {
      alive = false;
      for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error(`Codex connection closed (${info.code ?? info.signal}).`)); }
      pending.clear(); clearTimeout(compactTimer);
      ctx.exited(info);
    },
  }, line => {
    const r = parseJson(line);
    if (!r) return;
    if (r.id != null && !r.method) {
      const wait = pending.get(r.id);
      if (wait) { pending.delete(r.id); clearTimeout(wait.timer); r.error ? wait.reject(new Error(r.error.message || "Codex request rejected.")) : wait.resolve(r.result); }
      return;
    }
    // This adapter never grants an approval or fabricates a user answer.
    if (r.id != null && r.method) {
      p.write(JSON.stringify({ id: r.id, error: { code: -32601, message: "This Console cannot answer interactive requests. Use a message to provide guidance." } }));
      ctx.event({ type: "console_error", text: `Codex requested ${r.method}; interactive response is unavailable.` });
      return;
    }
    const v = r.params || {};
    if (v.threadId && v.threadId !== session) return;
    if (r.method === "turn/started") {
      active = v.turn?.id;
      baseline = total;
      translate({ type: "turn.started" });
    } else if (r.method === "turn/completed") {
      if (active && v.turn?.id && active !== v.turn.id) return;
      finish(v.turn?.status === "completed" ? undefined : v.turn?.error?.message || `Codex turn ${v.turn?.status || "failed"}.`);
    } else if (r.method === "item/started" || r.method === "item/completed") {
      const it = v.item || {}, done = r.method === "item/completed";
      const types: Record<string, string> = { agentMessage: "agent_message", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search" };
      if (it.type === "contextCompaction" && done) {
        compactConfirmed = true; ctx.event({ type: "system", subtype: "compact_boundary" });
      } else if (it.type === "reasoning") {
        if (done) translate({ type: "item.completed", item: { ...it, text: [...(it.summary || []), ...(it.content || [])].join("\n") } });
      } else if (types[it.type]) {
        translate({ type: done ? "item.completed" : "item.started", item: {
          ...it, type: types[it.type], aggregated_output: it.aggregatedOutput, exit_code: it.exitCode,
          ...(it.changes ? { changes: it.changes.map((c: any) => ({ ...c, kind: c.kind?.type || c.kind })) } : {}),
        } });
      } else if (done && it.type === "plan") {
        ctx.event({ type: "assistant", message: { content: [{ type: "text", text: it.text }] } });
      }
    } else if (r.method === "thread/tokenUsage/updated") {
      const u = v.tokenUsage?.last;
      if (u) ctx.event({ type: "context_usage", used: u.totalTokens, max: v.tokenUsage.modelContextWindow, source: "codex/last_request" });
      total = v.tokenUsage?.total;
      if (operation === "turn" && active && (!v.turnId || v.turnId === active) && total && u) {
        baseline ||= Object.fromEntries(Object.keys(total).map(k => [k, Math.max(0, total[k] - (u[k] || 0))]));
        ctx.event({ type: "token_usage", input_tokens: Math.max(0, total.inputTokens - baseline.inputTokens), cached_input_tokens: Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens), output_tokens: Math.max(0, total.outputTokens - baseline.outputTokens) });
      }
    } else if (r.method === "account/rateLimits/updated") {
      const norm = (w: any) => w && ({ used_percent: w.usedPercent, window_minutes: w.windowDurationMins, resets_at: w.resetsAt });
      ctx.event({ type: "provider_usage", rateLimits: { primary: norm(v.rateLimits?.primary), secondary: norm(v.rateLimits?.secondary) } });
    } else if (r.method === "error" && !v.willRetry) {
      ctx.event({ type: "console_error", text: v.error?.message || "Codex error." });
    }
  });
  const ready = (async () => {
    await request("initialize", { clientInfo: { name: "agent_console", title: "Agent Console", version: "1.0.0" } });
    p.write(JSON.stringify({ method: "initialized", params: {} }));
    const brain = brainContext();
    const result = await request(session ? "thread/resume" : "thread/start", {
      ...(session ? { threadId: session, excludeTurns: true } : {}), cwd: t.cwd, approvalPolicy: "never",
      sandbox: t.mode === "bypassPermissions" ? "danger-full-access" : t.mode === "plan" ? "read-only" : "workspace-write",
      ...(t.model !== "default" ? { model: t.model } : {}),
      ...(t.effort && t.effort !== "default" ? { config: { model_reasoning_effort: t.effort } } : {}),
      ...(brain ? { developerInstructions: brain } : {}),
    });
    session = result.thread.id;
    translate({ type: "thread.started", thread_id: session });
  })();
  void ready.catch(failed);
  const input = (text: string, images: Attachment[] = []) => [
    { type: "text", text: text.trim() ? text : IMAGE_ONLY_PROMPT },
    ...images.map(i => ({ type: "localImage", path: i.path })),
  ];
  let starting: Promise<any> | undefined;
  return {
    get alive() { return alive && !p.aborted; },
    send(text, images = []) {
      operation = "turn";
      baseline = total;
      ctx.event({ type: "run_settings", model: t.model, effort: t.effort || "default", source: t.model === "default" ? "Codex CLI configuration" : "Thread override" });
      starting = ready.then(() => request("turn/start", { threadId: session, input: input(text, images), ...(t.effort && t.effort !== "default" ? { effort: t.effort } : {}) })).then(r => {
        if (operation === "turn") active = r.turn.id;
      });
      void starting.catch(failed);
    },
    async steer(text, images = []) {
      await ready; await starting;
      if (!active || operation !== "turn") throw new Error("Codex turn finished before steering was accepted.");
      const expected = active;
      const result = await request("turn/steer", { threadId: session, expectedTurnId: expected, input: input(text, images) });
      if (result.turnId !== expected) throw new Error("Codex did not confirm steering the active turn.");
    },
    compact(instructions = "") {
      if (instructions) throw new Error("Codex /compact does not accept extra instructions.");
      if (!t.sessionId) throw new Error("Send a message before compacting this thread.");
      operation = "compact"; compactConfirmed = false;
      compactTimer = setTimeout(() => failed(new Error("Context compaction timed out.")), 180_000);
      void ready.then(() => request("thread/compact/start", { threadId: session })).catch(failed);
    },
    abort() { operation = undefined; clearTimeout(compactTimer); p.abort(); },
    kill() { operation = undefined; clearTimeout(compactTimer); p.kill(); },
  };
}
