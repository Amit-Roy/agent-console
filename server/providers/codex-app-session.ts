import { randomUUID } from "node:crypto";
import { launch as sandboxLaunch } from "../automation/sandbox.ts";
import { retryEvent } from "../turn-timing.ts";
import { harnessInstructions } from "./brain.ts";
import { adaptItem } from "./codex-app-items.ts";
import { codexQuestion } from "./codex-app-questions.ts";
import { CodexRpc } from "./codex-app-rpc.ts";
import { SubagentTracker } from "./codex-app-subagents.ts";
import { codexRouting } from "./codex-routing.ts";
import { consoleCodexMcpArgs } from "./console-mcp.mjs";
import { childEnv } from "./env.ts";
import { type Proc, parseJson, spawnLines } from "./proc.ts";
import {
  type AgentCtx,
  type Attachment,
  type ExitInfo,
  IMAGE_ONLY_PROMPT,
  type QuestionReply,
  type ThreadSpec,
} from "./types.ts";

interface PendingAsk {
  rpcId: any;
  consumesNote: boolean;
  reply: (answer: QuestionReply) => any;
}

type NotificationHandler = (session: CodexAppSession, params: any) => void;

// Parent-thread notifications by method; methods without an entry are ignored.
const NOTIFICATION_HANDLERS = new Map<string, NotificationHandler>([
  ["serverRequest/resolved", (session, params) => session.requestResolved(params)],
  ["turn/started", (session, params) => session.turnStarted(params)],
  ["turn/completed", (session, params) => session.turnCompleted(params)],
  ["item/started", (session, params) => session.itemEvent(params, false)],
  ["item/completed", (session, params) => session.itemEvent(params, true)],
  ["thread/tokenUsage/updated", (session, params) => session.tokenUsageUpdated(params)],
  ["account/rateLimits/updated", (session, params) => session.rateLimitsUpdated(params)],
  ["error", (session, params) => session.errorNotified(params)],
]);

function hasEffort(spec: ThreadSpec): boolean {
  return Boolean(spec.effort && spec.effort !== "default");
}

function sandboxMode(mode: ThreadSpec["mode"]): string {
  if (mode === "bypassPermissions") return "danger-full-access";
  if (mode === "plan") return "read-only";
  return "workspace-write";
}

function threadParams(spec: ThreadSpec, threadId: string | undefined, brain: string | undefined) {
  return {
    ...(threadId ? { threadId, excludeTurns: true } : {}),
    cwd: spec.cwd,
    approvalPolicy: "never",
    sandbox: sandboxMode(spec.mode),
    ...(spec.model !== "default" ? { model: spec.model } : {}),
    ...(hasEffort(spec) ? { config: { model_reasoning_effort: spec.effort } } : {}),
    ...(brain ? { developerInstructions: brain } : {}),
  };
}

function turnInput(text: string, images: Attachment[]) {
  return [
    { type: "text", text: text.trim() ? text : IMAGE_ONLY_PROMPT },
    ...images.map((image) => ({ type: "localImage", path: image.path })),
  ];
}

function rateWindow(window: any) {
  return (
    window && {
      used_percent: window.usedPercent,
      window_minutes: window.windowDurationMins,
      resets_at: window.resetsAt,
    }
  );
}

function errorKind(info: any) {
  return info && typeof info === "object" ? Object.keys(info)[0] : info;
}

function usageDelta(total: any, baseline: any) {
  return {
    type: "token_usage",
    input_tokens: Math.max(0, total.inputTokens - baseline.inputTokens),
    cached_input_tokens: Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens),
    output_tokens: Math.max(0, total.outputTokens - baseline.outputTokens),
    ...(typeof total.reasoningOutputTokens === "number"
      ? {
          reasoning_output_tokens: Math.max(
            0,
            total.reasoningOutputTokens - (baseline.reasoningOutputTokens || 0),
          ),
        }
      : {}),
  };
}

// Shared state of one app-server process: the parent thread, the running operation, questions, RPC and subagents.
export class CodexAppSession {
  readonly spec: ThreadSpec;
  readonly ctx: AgentCtx;
  readonly translate: (row: any) => void;
  readonly rpc: CodexRpc;
  readonly subagents: SubagentTracker;
  threadId: string | undefined;
  active: string | undefined;
  operation: "turn" | "compact" | undefined;
  compactConfirmed = false;
  compactTimer: NodeJS.Timeout | undefined;
  total: any;
  baseline: any;
  readonly asks = new Map<string, PendingAsk>(); // pending questions by canonical id
  // App-server request ids restart with each child process. History persists
  // across those restarts, so canonical ids also need a process-specific prefix.
  readonly questionPrefix = `codex-${randomUUID()}-`;
  proc!: Proc;
  ready!: Promise<void>;
  starting: Promise<any> | undefined;

  constructor(spec: ThreadSpec, ctx: AgentCtx, translate: (row: any) => void) {
    this.spec = spec;
    this.ctx = ctx;
    this.translate = translate;
    this.threadId = spec.sessionId;
    this.rpc = new CodexRpc((line) => this.proc.write(line));
    this.subagents = new SubagentTracker(ctx);
  }

  start(): void {
    const askArgs =
      process.env.AGENT_CONSOLE_CODEX_ASK === "0"
        ? []
        : ["--enable", "default_mode_request_user_input"];
    const routing = codexRouting({ ...childEnv(), AGENT_CONSOLE_THREAD: this.spec.id });
    const launch = sandboxLaunch(
      this.spec,
      "codex",
      [
        "app-server",
        "-c",
        "analytics.enabled=false",
        "-c",
        "feedback.enabled=false",
        ...askArgs,
        ...routing.args,
        ...consoleCodexMcpArgs(),
      ],
      routing.env,
    );
    this.proc = spawnLines(
      "codex",
      launch.command,
      launch.args,
      { cwd: this.spec.cwd, env: launch.env },
      { ...this.ctx, exited: (info) => this.exited(info) },
      (line) => this.handleLine(line),
    );
    this.ready = this.connect(askArgs.length > 0);
    void this.ready.catch((error) => this.failed(error));
  }

  get alive(): boolean {
    return this.rpc.open && !this.proc.aborted;
  }

  finish(error?: string): void {
    if (!this.operation) return;
    const wasCompact = this.operation === "compact";
    this.operation = undefined;
    this.active = undefined;
    clearTimeout(this.compactTimer);
    let message = error;
    if (wasCompact && !this.compactConfirmed && !message)
      message = "Codex did not confirm context compaction.";
    this.translate(
      message ? { type: "turn.failed", error: { message } } : { type: "turn.completed" },
    );
  }

  failed(error: any): void {
    this.finish(String(error?.message || error));
    this.proc.kill();
  }

  cancelQuestions(): void {
    for (const askId of this.asks.keys())
      this.ctx.event({ type: "question_answer", id: askId, cancelled: true });
    this.asks.clear();
  }

  private exited(info: ExitInfo): void {
    this.rpc.open = false;
    this.cancelQuestions();
    this.rpc.rejectAll(info);
    clearTimeout(this.compactTimer);
    this.ctx.exited(info);
  }

  private async connect(experimentalApi: boolean): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "agent_console", title: "Agent Console", version: "1.0.0" },
      capabilities: { experimentalApi },
    });
    this.proc.write(JSON.stringify({ method: "initialized", params: {} }));
    const brain = await harnessInstructions();
    const result = await this.rpc.request(
      this.threadId ? "thread/resume" : "thread/start",
      threadParams(this.spec, this.threadId, brain),
    );
    this.threadId = result.thread.id;
    this.translate({
      type: "thread.started",
      thread_id: this.threadId,
      ...(typeof result.model === "string" ? { model: result.model } : {}),
    });
  }

  handleLine(line: string): void {
    const message = parseJson(line);
    if (!message) return;
    if (message.id != null && !message.method) {
      this.rpc.settle(message);
      return;
    }
    if (message.id != null && message.method) {
      this.serverRequest(message);
      return;
    }
    const params = message.params || {};
    if (params.threadId && params.threadId !== this.threadId) {
      this.subagents.onChildNotification(message.method, params, Boolean(this.operation));
      return;
    }
    NOTIFICATION_HANDLERS.get(message.method)?.(this, params);
  }

  // Questions become cards; the answer is whatever the user picks. This adapter never grants an approval.
  private serverRequest(message: any): void {
    const card = codexQuestion(message.method, message.params);
    if (card?.questions.length) {
      const askId = `${this.questionPrefix}${message.id}`;
      this.asks.set(askId, {
        rpcId: message.id,
        consumesNote: card.consumesNote,
        reply: card.reply,
      });
      this.ctx.event({ type: "question", id: askId, questions: card.questions, ts: Date.now() });
      return;
    }
    this.proc.write(
      JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message:
            "This Console cannot answer interactive requests. Use a message to provide guidance.",
        },
      }),
    );
    this.ctx.event({
      type: "console_error",
      text: `Codex requested ${message.method}; interactive response is unavailable.`,
    });
  }

  requestResolved(params: any): void {
    const askId = `${this.questionPrefix}${params.requestId}`;
    if (this.asks.delete(askId))
      this.ctx.event({ type: "question_answer", id: askId, cancelled: true });
  }

  turnStarted(params: any): void {
    this.active = params.turn?.id;
    this.baseline = this.total;
    this.translate({ type: "turn.started" });
  }

  turnCompleted(params: any): void {
    if (this.active && params.turn?.id && this.active !== params.turn.id) return;
    this.cancelQuestions();
    this.finish(
      params.turn?.status === "completed"
        ? undefined
        : params.turn?.error?.message || `Codex turn ${params.turn?.status || "failed"}.`,
    );
    this.subagents.wakeUnseen();
  }

  itemEvent(params: any, done: boolean): void {
    const item = params.item || {};
    this.subagents.noteParentActivity(item.type);
    if (item.type === "subAgentActivity") {
      this.subagents.onActivity(item, done, Boolean(this.operation));
      return;
    }
    if (item.type === "contextCompaction" && done) {
      this.compactConfirmed = true;
      this.ctx.event({ type: "system", subtype: "compact_boundary" });
      return;
    }
    const row = adaptItem(item, done);
    if (row) this.translate(row);
    else if (done && item.type === "plan")
      this.ctx.event({
        type: "assistant",
        message: { content: [{ type: "text", text: item.text }] },
      });
  }

  tokenUsageUpdated(params: any): void {
    const last = params.tokenUsage?.last;
    if (last)
      this.ctx.event({
        type: "context_usage",
        used: last.totalTokens,
        max: params.tokenUsage.modelContextWindow,
        source: "codex/last_request",
      });
    this.total = params.tokenUsage?.total;
    if (!this.countsTowardTurn(params.turnId) || !this.total || !last) return;
    const total = this.total;
    this.baseline ||= Object.fromEntries(
      Object.keys(total).map((key) => [key, Math.max(0, total[key] - (last[key] || 0))]),
    );
    this.ctx.event(usageDelta(total, this.baseline));
  }

  private countsTowardTurn(turnId: string | undefined): boolean {
    return Boolean(this.operation === "turn" && this.active && (!turnId || turnId === this.active));
  }

  rateLimitsUpdated(params: any): void {
    this.ctx.event({
      type: "provider_usage",
      rateLimits: {
        primary: rateWindow(params.rateLimits?.primary),
        secondary: rateWindow(params.rateLimits?.secondary),
      },
    });
  }

  errorNotified(params: any): void {
    const info = params.error?.codexErrorInfo;
    const kind = errorKind(info);
    if (params.willRetry) {
      this.ctx.event(
        retryEvent({
          status: kind && info?.[kind]?.httpStatusCode,
          error: typeof kind === "string" ? kind : undefined,
          message: String(params.error?.message ?? ""),
        }),
      );
      return;
    }
    this.ctx.event({
      type: "console_error",
      text: params.error?.message || "Codex error.",
      ...(typeof kind === "string" ? { code: kind } : {}),
    });
  }

  send(text: string, images: Attachment[]): void {
    this.operation = "turn";
    this.baseline = this.total;
    this.ctx.event({
      type: "run_settings",
      model: this.spec.model,
      effort: this.spec.effort || "default",
      source: this.spec.model === "default" ? "Codex CLI configuration" : "Thread override",
    });
    this.starting = this.ready
      .then(() =>
        this.rpc.request("turn/start", {
          threadId: this.threadId,
          input: turnInput(text, images),
          ...(hasEffort(this.spec) ? { effort: this.spec.effort } : {}),
        }),
      )
      .then((result) => {
        if (this.operation === "turn") this.active = result.turn.id;
      });
    void this.starting.catch((error) => this.failed(error));
  }

  async steer(text: string, images: Attachment[]): Promise<void> {
    await this.ready;
    await this.starting;
    if (!this.active || this.operation !== "turn")
      throw new Error("Codex turn finished before steering was accepted.");
    const expected = this.active;
    const result = await this.rpc.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: expected,
      input: turnInput(text, images),
    });
    if (result.turnId !== expected)
      throw new Error("Codex did not confirm steering the active turn.");
  }

  compact(instructions: string): void {
    if (instructions) throw new Error("Codex /compact does not accept extra instructions.");
    if (!this.spec.sessionId) throw new Error("Send a message before compacting this thread.");
    this.operation = "compact";
    this.compactConfirmed = false;
    this.compactTimer = setTimeout(
      () => this.failed(new Error("Context compaction timed out.")),
      180_000,
    );
    void this.ready
      .then(() => this.rpc.request("thread/compact/start", { threadId: this.threadId }))
      .catch((error) => this.failed(error));
  }

  answer(askId: string, reply: QuestionReply): boolean {
    const pendingAsk = this.asks.get(askId);
    if (!pendingAsk || !this.rpc.open)
      throw new Error("This question is no longer waiting for an answer.");
    const result = pendingAsk.reply(reply);
    this.proc.write(JSON.stringify({ id: pendingAsk.rpcId, result }));
    this.asks.delete(askId);
    return reply.note !== undefined && pendingAsk.consumesNote;
  }

  stop(hard: boolean): void {
    this.operation = undefined;
    clearTimeout(this.compactTimer);
    this.cancelQuestions();
    if (hard) this.proc.kill();
    else this.proc.abort();
  }
}
