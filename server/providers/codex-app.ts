import { randomUUID } from "node:crypto";
import { spawnLines, parseJson } from "./proc.ts";
import { childEnv } from "./env.ts";
import { codexRouting } from "./codex-routing.ts";
import { harnessInstructions } from "./brain.ts";
import { retryEvent } from "../turn-timing.ts";
import { cleanQuestions, IMAGE_ONLY_PROMPT, type Agent, type AgentCtx, type Attachment, type Question, type QuestionReply, type ThreadSpec } from "./types.ts";

// Codex asks the user through app-server server requests (exec mode refuses: "request_user_input not supported in exec mode"):
//   item/tool/requestUserInput   {questions:[{id,header,question,isOther,isSecret,options:[{label,description}]|null}]}
//                                -> {answers:{[id]:{answers:[...]}}}; no answers = "continue with best judgment"
//   mcpServer/elicitation/request (mode "form") an MCP server's JSON-schema form -> {action:"accept"|"decline", content}
// request_user_input is offered to the model in Plan collaboration mode, or in default mode behind the
// default_mode_request_user_input feature, which we enable (AGENT_CONSOLE_CODEX_ASK=0 turns it off). Returns undefined for
// requests that cannot be shown as a question card.
export function codexQuestion(method: string, params: any): { questions: Question[]; consumesNote: boolean; reply(r: QuestionReply): any } | undefined {
  if (method === "item/tool/requestUserInput" && Array.isArray(params?.questions)) {
    const questions = cleanQuestions(params.questions.map((q: any) => ({ ...q, options: q.options ?? [], allowOther: q.isOther || !q.options?.length, secret: q.isSecret })));
    return {
      questions,
      consumesNote: true,
      reply: (r) => {
        if (r.note !== undefined) return { answers: questions[0] ? { [questions[0].id]: { answers: [r.note] } } : {} };
        if (r.skip) return { answers: {} };
        return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: (r.answers[q.id] ?? []).map(String).filter(Boolean) }]).filter(([, a]: any) => a.answers.length)) };
      },
    };
  }
  if (method === "mcpServer/elicitation/request" && ["form", "openai/form"].includes(params?.mode) && params.requestedSchema?.properties) {
    const props = Object.entries<any>(params.requestedSchema.properties);
    const required = new Set<string>(params.requestedSchema.required ?? []);
    const enumOf = (s: any): string[] => s?.enum ?? s?.oneOf?.map((o: any) => o.const) ?? s?.anyOf?.map((o: any) => o.const) ?? [];
    // Nested objects and large forms need a dedicated form renderer. Decline
    // unsupported schemas instead of silently truncating or changing their types.
    if (!props.length || props.length > 10 || props.some(([, s]) => !s || !["string", "boolean", "number", "integer", "array"].includes(s.type)
      || (s.type === "array" && (s.items?.type !== "string" && !Array.isArray(s.items?.enum))) || enumOf(s.type === "array" ? s.items : s).length > 20)) return undefined;
    const questions = cleanQuestions(props.map(([key, s], i) => {
      const multi = s.type === "array";
      const values = s.type === "boolean" ? ["Yes", "No"] : enumOf(multi ? s.items : s);
      return {
        id: key,
        header: i === 0 ? params.serverName : undefined,
        question: [i === 0 ? params.message : "", s.title || s.description || key].filter(Boolean).join("\n\n") + (required.has(key) ? "" : " (optional)"),
        options: values.map((v: string) => ({ label: String(v) })),
        multiSelect: multi,
        allowOther: !values.length,
      };
    }));
    return {
      questions,
      consumesNote: false,
      reply: (r) => {
        if (r.skip || r.note !== undefined) return { action: "decline", content: null, _meta: null };
        const content: Record<string, unknown> = {};
        for (const [key, s] of props) {
          const a = (r.answers[key] ?? []).map(String).filter(Boolean);
          if (!a.length) {
            if (required.has(key)) throw new Error(`Please answer ${s.title || key}.`);
            continue;
          }
          if (["number", "integer"].includes(s.type) && (!Number.isFinite(Number(a[0])) || (s.type === "integer" && !Number.isInteger(Number(a[0]))))) throw new Error(`Enter a valid ${s.type} for ${s.title || key}.`);
          if (s.type === "boolean" && !["Yes", "No"].includes(a[0])) throw new Error(`Choose Yes or No for ${s.title || key}.`);
          content[key] = s.type === "array" ? a : s.type === "boolean" ? a[0] === "Yes" : s.type === "number" || s.type === "integer" ? Number(a[0]) : a[0];
        }
        return { action: "accept", content, _meta: null };
      },
    };
  }
  return undefined;
}

// Keep the owning app-server alive: turn/steer must reach the process running the turn.
export function startCodexApp(t: ThreadSpec, ctx: AgentCtx, translate: (row: any) => void): Agent {
  let session = t.sessionId, active: string | undefined, alive = true, serial = 0;
  let operation: "turn" | "compact" | undefined, compactConfirmed = false;
  let compactTimer: NodeJS.Timeout | undefined;
  let total: any, baseline: any;
  // Subagents by thread id. Codex does not start a parent turn when one finishes after the parent's turn ended, so we do.
  const children = new Map<string, { path: string; call: string; text: string; done?: boolean }>();
  let unseen: string[] = []; // finished while the parent turn ran, before the parent model looked again
  const backgroundChanged = () => ctx.event({ type: "system", subtype: "background_tasks_changed", tasks: [...children].filter(([, c]) => !c.done).map(([id, c]) => ({ task_id: id, description: c.path })) });
  const subagentDone = (id: string) => {
    const c = children.get(id)!;
    return `[Background subagent ${c.path} finished. Its final message:]\n${c.text.trim() || "(no message)"}`;
  };
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
  const asks = new Map<string, { rpcId: any; consumesNote: boolean; reply: (r: QuestionReply) => any }>(); // pending questions by canonical id
  // App-server request ids restart with each child process. History persists
  // across those restarts, so canonical ids also need a process-specific prefix.
  const questionPrefix = `codex-${randomUUID()}-`;
  const cancelQuestions = () => {
    for (const id of asks.keys()) ctx.event({ type: "question_answer", id, cancelled: true });
    asks.clear();
  };
  const ask = process.env.AGENT_CONSOLE_CODEX_ASK === "0" ? [] : ["--enable", "default_mode_request_user_input"];
  const routing = codexRouting(childEnv());
  const p = spawnLines("codex", "codex", ["app-server", "-c", "analytics.enabled=false", "-c", "feedback.enabled=false", ...ask, ...routing.args], { cwd: t.cwd, env: routing.env }, {
    ...ctx,
    exited(info) {
      alive = false;
      cancelQuestions();
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
    // Questions become cards; the answer is whatever the user picks. This adapter never grants an approval.
    if (r.id != null && r.method) {
      const q = codexQuestion(r.method, r.params);
      if (q && q.questions.length) {
        const id = `${questionPrefix}${r.id}`;
        asks.set(id, { rpcId: r.id, consumesNote: q.consumesNote, reply: q.reply });
        ctx.event({ type: "question", id, questions: q.questions, ts: Date.now() });
        return;
      }
      p.write(JSON.stringify({ id: r.id, error: { code: -32601, message: "This Console cannot answer interactive requests. Use a message to provide guidance." } }));
      ctx.event({ type: "console_error", text: `Codex requested ${r.method}; interactive response is unavailable.` });
      return;
    }
    const v = r.params || {};
    if (v.threadId && v.threadId !== session) {
      const child = children.get(v.threadId);
      if (child && r.method === "item/completed" && v.item?.type === "agentMessage" && typeof v.item.text === "string") child.text = v.item.text;
      return;
    }
    if (r.method === "serverRequest/resolved") {
      const id = `${questionPrefix}${v.requestId}`;
      if (asks.delete(id)) ctx.event({ type: "question_answer", id, cancelled: true });
      return;
    }
    if (r.method === "turn/started") {
      active = v.turn?.id;
      baseline = total;
      translate({ type: "turn.started" });
    } else if (r.method === "turn/completed") {
      if (active && v.turn?.id && active !== v.turn.id) return;
      cancelQuestions();
      finish(v.turn?.status === "completed" ? undefined : v.turn?.error?.message || `Codex turn ${v.turn?.status || "failed"}.`);
      for (const id of unseen.splice(0)) ctx.event({ type: "subagent_wake", text: subagentDone(id) });
    } else if (r.method === "item/started" || r.method === "item/completed") {
      const it = v.item || {}, done = r.method === "item/completed";
      const types: Record<string, string> = { agentMessage: "agent_message", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search" };
      if (it.type !== "subAgentActivity" && unseen.length && ["agentMessage", "reasoning", "commandExecution", "mcpToolCall"].includes(it.type)) unseen = []; // the parent model ran after the result arrived
      if (it.type === "subAgentActivity") {
        if (!done || !it.agentThreadId) return;
        if (it.kind === "started" && !children.has(it.agentThreadId)) {
          children.set(it.agentThreadId, { path: it.agentPath || "subagent", call: it.id, text: "" });
          ctx.event({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: it.id, name: "Agent", input: { description: it.agentPath || "Subagent" } }] } });
          ctx.event({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: it.id, content: "Started in the background." }] } });
          ctx.event({ type: "system", subtype: "task_started", task_id: it.agentThreadId, tool_use_id: it.id, task_type: "local_agent", is_backgrounded: true, description: it.agentPath });
          backgroundChanged();
        } else if (it.kind === "completed" && children.get(it.agentThreadId) && !children.get(it.agentThreadId)!.done) {
          const c = children.get(it.agentThreadId)!;
          c.done = true;
          ctx.event({ type: "system", subtype: "task_notification", task_id: it.agentThreadId, tool_use_id: c.call, status: "completed", summary: c.text.slice(0, 300) });
          backgroundChanged();
          if (operation) unseen.push(it.agentThreadId);
          else ctx.event({ type: "subagent_wake", text: subagentDone(it.agentThreadId) });
        }
      } else if (it.type === "contextCompaction" && done) {
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
        ctx.event({ type: "token_usage", input_tokens: Math.max(0, total.inputTokens - baseline.inputTokens), cached_input_tokens: Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens), output_tokens: Math.max(0, total.outputTokens - baseline.outputTokens), ...(typeof total.reasoningOutputTokens === "number" ? { reasoning_output_tokens: Math.max(0, total.reasoningOutputTokens - (baseline.reasoningOutputTokens || 0)) } : {}) });
      }
    } else if (r.method === "account/rateLimits/updated") {
      const norm = (w: any) => w && ({ used_percent: w.usedPercent, window_minutes: w.windowDurationMins, resets_at: w.resetsAt });
      ctx.event({ type: "provider_usage", rateLimits: { primary: norm(v.rateLimits?.primary), secondary: norm(v.rateLimits?.secondary) } });
    } else if (r.method === "error" && v.willRetry) {
      const info = v.error?.codexErrorInfo, kind = info && typeof info === "object" ? Object.keys(info)[0] : info;
      ctx.event(retryEvent({ status: kind && info?.[kind]?.httpStatusCode, error: typeof kind === "string" ? kind : undefined, message: String(v.error?.message ?? "") }));
    } else if (r.method === "error" && !v.willRetry) {
      ctx.event({ type: "console_error", text: v.error?.message || "Codex error." });
    }
  });
  const ready = (async () => {
    await request("initialize", { clientInfo: { name: "agent_console", title: "Agent Console", version: "1.0.0" }, capabilities: { experimentalApi: ask.length > 0 } });
    p.write(JSON.stringify({ method: "initialized", params: {} }));
    const brain = await harnessInstructions();
    const result = await request(session ? "thread/resume" : "thread/start", {
      ...(session ? { threadId: session, excludeTurns: true } : {}), cwd: t.cwd, approvalPolicy: "never",
      sandbox: t.mode === "bypassPermissions" ? "danger-full-access" : t.mode === "plan" ? "read-only" : "workspace-write",
      ...(t.model !== "default" ? { model: t.model } : {}),
      ...(t.effort && t.effort !== "default" ? { config: { model_reasoning_effort: t.effort } } : {}),
      ...(brain ? { developerInstructions: brain } : {}),
    });
    session = result.thread.id;
    translate({ type: "thread.started", thread_id: session, ...(typeof result.model === "string" ? { model: result.model } : {}) });
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
    answer(id, reply) {
      const a = asks.get(id);
      if (!a || !alive) throw new Error("This question is no longer waiting for an answer.");
      const result = a.reply(reply);
      p.write(JSON.stringify({ id: a.rpcId, result }));
      asks.delete(id);
      return reply.note !== undefined && a.consumesNote;
    },
    abort() { operation = undefined; clearTimeout(compactTimer); cancelQuestions(); p.abort(); },
    kill() { operation = undefined; clearTimeout(compactTimer); cancelQuestions(); p.kill(); },
  };
}
