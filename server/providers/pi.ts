import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../auth.ts";
import { launch as sandboxLaunch } from "../automation/sandbox.ts";
import { retryEvent } from "../turn-timing.ts";
import { harnessInstructions, personaFor, personaInstructions } from "./brain.ts";
import { childEnv } from "./env.ts";
import { acquireModelRequest } from "./model-rate-client.ts";
import { CODING_ROUTE, DIRECT_CODING_MODELS } from "./pi-coding-route.mjs";
import { defaultPiModel } from "./pi-model.ts";
import { piQuestions } from "./pi-questions.ts";
import { piRateEnv } from "./pi-rate-env.ts";
import { type Proc, parseJson, spawnLines } from "./proc.ts";
import {
  type Agent,
  type AgentCtx,
  type Attachment,
  type Command,
  clip,
  IMAGE_ONLY_PROMPT,
  type Provider,
  type ThreadSpec,
} from "./types.ts";

// pi (github.com/earendil-works/pi) in RPC mode: one long-lived process per thread, any model pi knows about
// (OpenRouter, OpenAI, Google, local, ...). Pi has no per-action approvals, so only Plan (read-only tools) and Bypass exist.

const SESSIONS = path.join(DATA_DIR, "pi-sessions");
const READ_ONLY_TOOLS = "read,grep,find,ls,ask_user,schedule_list,save_output,subagent";
const QUESTIONS_EXTENSION = fileURLToPath(new URL("./pi-questions-extension.mjs", import.meta.url));
const SUBAGENT_EXTENSION = fileURLToPath(new URL("./pi-subagent-extension.mjs", import.meta.url));
const TOOLS_EXTENSION = fileURLToPath(new URL("./console-tools.mjs", import.meta.url)); // scheduled tasks + save_output
const CODING_ROUTE_EXTENSION = fileURLToPath(new URL("./pi-coding-route.mjs", import.meta.url));

let cached: string[] = [];
const thinking = new Set<string>();
const contexts = new Map<string, number>(); // "provider/model" -> context window in tokens, from the --list-models table
const NVIDIA_FREE_MODELS = new Set([
  "meta/llama-3.2-11b-vision-instruct",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "openai/gpt-oss-20b",
  "stepfun-ai/step-5-preview",
]);
function configured(): boolean {
  try {
    if (
      Object.keys(
        JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8")),
      ).length
    )
      return true;
  } catch {}
  const env = childEnv();
  return !!(env.NVIDIA_API_KEY || env.OPENROUTER_API_KEY);
}

// `pi --list-models` only lists what the current credentials unlock. With an OpenRouter key we offer its free models
// by default (AGENT_CONSOLE_PI_ALL=1 offers everything) so the picker stays short and a typo can't spend money.
// "262.1K" -> 262100, "1M" -> 1000000
export function parseTokens(s: string | undefined): number | undefined {
  const m = s?.match(/^([\d.]+)([KM])?$/i);
  return m
    ? Math.round(Number(m[1]) * (m[2]?.toUpperCase() === "M" ? 1_000_000 : m[2] ? 1000 : 1))
    : undefined;
}

export function parsePiModels(table: string, all = false): string[] {
  const out: string[] = [];
  for (const line of table.split("\n").slice(1)) {
    const [provider, model, context, , thinks] = line.trim().split(/\s+/);
    if (thinks === "yes") thinking.add(`${provider}/${model}`);
    if (provider && model && !provider.startsWith("/") && parseTokens(context))
      contexts.set(`${provider}/${model}`, parseTokens(context)!);
    if (!provider || !model || provider.startsWith("/")) continue;
    if (
      !all &&
      ((provider === "openrouter" && !model.endsWith(":free")) ||
        (provider === "nvidia" && !NVIDIA_FREE_MODELS.has(model)))
    )
      continue;
    out.push(`${provider}/${model}`);
  }
  return out.slice(0, 200);
}

export function refreshPiModels(): Promise<string[]> {
  return new Promise((resolve) => {
    const env = childEnv(); // so the toggles work from ~/.config/agent-console/env too, not only the server's env
    if (env.AGENT_CONSOLE_PI_MODELS) {
      cached = env.AGENT_CONSOLE_PI_MODELS.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return resolve(cached);
    }
    execFile(
      "pi",
      ["--list-models"],
      { env, timeout: 20_000, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        if (!err) {
          cached = parsePiModels(stdout + stderr, env.AGENT_CONSOLE_PI_ALL === "1");
          try {
            fs.writeFileSync(MODELS_FILE, stdout + stderr, { mode: 0o600 });
          } catch {}
        }
        resolve(cached);
      },
    );
  });
}
// `pi --list-models` takes seconds and the server runs it only after it listens. Until it answers, use the list the previous
// process saw, so Pi is ready the moment the server is.
const MODELS_FILE = path.join(DATA_DIR, "pi-models.txt");
try {
  const env = childEnv();
  if (!env.AGENT_CONSOLE_PI_MODELS)
    cached = parsePiModels(fs.readFileSync(MODELS_FILE, "utf8"), env.AGENT_CONSOLE_PI_ALL === "1");
} catch {}

const CAP: Record<string, string> = {
  subagent: "Agent",
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

// Make pi's tool calls look like Claude's so the UI's cards (diff view, shell highlighting, icons) apply.
export function normTool(
  name: string,
  a: Record<string, any> = {},
): { name: string; input: Record<string, any> } {
  const n = CAP[name] ?? name;
  const input: Record<string, any> = { ...a };
  const p = a.path ?? a.file_path ?? a.filePath;
  if (p !== undefined && n !== "Glob" && n !== "Grep") input.file_path = p;
  const edit = Array.isArray(a.edits) ? a.edits[0] : a;
  if (n === "Edit" && edit) {
    const o = edit.oldText ?? edit.old_string ?? edit.oldString,
      nw = edit.newText ?? edit.new_string ?? edit.newString;
    if (typeof o === "string" && typeof nw === "string")
      Object.assign(input, { old_string: o, new_string: nw });
  }
  if (n === "Agent") input.description ??= clip(String(a.prompt ?? "Subagent"), 80);
  return { name: n, input };
}

const textOf = (content: any): string =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
        .join("\n");

function friendlyError(msg: string): string {
  const m = msg.match(/"message"\s*:\s*"([^"]+)"/);
  return clip(m ? m[1] : msg, 500);
}

type PiTranslatorState = {
  emit: (event: any) => void;
  onCommands?: (list: Command[]) => void;
  contextWindow?: () => number | undefined;
  started: number;
  cost: number;
  usageModels: any[];
  failure: string | undefined;
  subagents: Map<string, string>; // toolCallId -> description, while a subagent tool call runs
};

function piSettle(state: PiTranslatorState, aborted = false) {
  if (state.failure) state.emit({ type: "console_error", text: state.failure });
  state.emit({
    type: "result",
    subtype: aborted ? "error_during_execution" : state.failure ? "error" : "success",
    is_error: !!state.failure,
    duration_ms: state.started ? Date.now() - state.started : 0,
    ...(state.cost > 0 ? { total_cost_usd: state.cost } : {}),
    usageModels: state.usageModels,
  });
  state.started = 0;
  state.cost = 0;
  state.usageModels = [];
  state.failure = undefined;
}

function piContentBlocks(message: any) {
  return (message.content ?? [])
    .map((block: any) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "thinking") return { type: "thinking", thinking: block.thinking ?? "" };
      if (block.type === "toolCall")
        return { type: "tool_use", id: block.id, ...normTool(block.name, block.arguments) };
      return undefined;
    })
    .filter(Boolean);
}

function piToolResult(toolId: string, content: any, isError: boolean) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolId,
          content: clip(textOf(content)),
          is_error: isError,
        },
      ],
    },
  };
}

function piRecordUsage(state: PiTranslatorState, message: any, role: string) {
  const usage = message.usage;
  if (!usage) return;
  state.cost += Number(usage.cost?.total) || 0;
  state.usageModels.push({
    model: message.model || "unknown",
    role,
    fresh: usage.input,
    cacheWrite: usage.cacheWrite,
    cacheRead: usage.cacheRead,
    output: usage.output,
    reasoning: usage.reasoning,
    cost: usage.cost?.total,
  });
}

// The subagent extension forwards each child pi event in the tool update's details; show it tagged with the parent call.
function piChildEvent(state: PiTranslatorState, parent: string, child: any) {
  if (child?.type === "message_end" && child.message?.role === "assistant") {
    piRecordUsage(state, child.message, "subagent");
    const content = piContentBlocks(child.message);
    if (content.length)
      state.emit({
        type: "assistant",
        parent_tool_use_id: parent,
        message: { role: "assistant", content },
      });
  } else if (child?.type === "tool_execution_end")
    state.emit({
      ...piToolResult(child.toolCallId, child.result?.content, !!child.isError),
      parent_tool_use_id: parent,
    });
}

function piUsedTokens(usage: any): number {
  return (
    Number(usage?.totalTokens) ||
    (Number(usage?.input) || 0) +
      (Number(usage?.cacheRead) || 0) +
      (Number(usage?.cacheWrite) || 0) +
      (Number(usage?.output) || 0)
  );
}

function piAgentStart(state: PiTranslatorState) {
  state.started ||= Date.now();
}

function piMessageStart(state: PiTranslatorState, rec: any) {
  if (rec.message?.role === "assistant")
    state.emit({ type: "stream_event", event: { type: "message_start" } });
}

function piMessageUpdate(state: PiTranslatorState, rec: any) {
  const delta = rec.assistantMessageEvent;
  if (delta?.type === "text_delta")
    state.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: delta.delta } },
    });
  else if (delta?.type === "thinking_delta")
    state.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: delta.delta },
      },
    });
}

function piMessageEnd(state: PiTranslatorState, rec: any) {
  const message = rec.message;
  if (message?.role !== "assistant") return;
  piRecordUsage(state, message, "agent");
  const used = piUsedTokens(message.usage);
  if (used > 0)
    state.emit({
      type: "context_usage",
      used,
      ...(state.contextWindow?.() ? { max: state.contextWindow() } : {}),
    });
  // a provider error that pi retried successfully must not fail the whole turn: only the last reply counts
  if (message.stopReason === "error" && message.errorMessage)
    state.failure = friendlyError(message.errorMessage);
  else if (message.stopReason !== "aborted") state.failure = undefined;
  const content = piContentBlocks(message);
  if (content.length)
    state.emit({
      type: "assistant",
      message: { role: "assistant", content, model: message.model, usage: message.usage },
    });
}

function piToolStart(state: PiTranslatorState, rec: any) {
  if (rec.toolName !== "subagent") return;
  const description = normTool("subagent", rec.args).input.description;
  state.subagents.set(rec.toolCallId, description);
  state.emit({
    type: "system",
    subtype: "task_started",
    task_id: rec.toolCallId,
    tool_use_id: rec.toolCallId,
    task_type: "local_agent",
    description,
  });
}

function piToolUpdate(state: PiTranslatorState, rec: any) {
  if (state.subagents.has(rec.toolCallId))
    piChildEvent(state, rec.toolCallId, rec.partialResult?.details?.event);
}

function piToolEnd(state: PiTranslatorState, rec: any) {
  if (state.subagents.has(rec.toolCallId)) {
    const summary = clip(textOf(rec.result?.content), 300);
    state.emit({
      type: "system",
      subtype: "task_notification",
      task_id: rec.toolCallId,
      tool_use_id: rec.toolCallId,
      status: rec.isError ? "failed" : "completed",
      summary: summary || state.subagents.get(rec.toolCallId),
    });
    state.subagents.delete(rec.toolCallId);
  }
  state.emit(piToolResult(rec.toolCallId, rec.result?.content, !!rec.isError));
}

// turn timing only: status + error class, never the message
function piRetryStart(state: PiTranslatorState, rec: any) {
  state.emit(
    retryEvent({
      attempt: rec.attempt,
      message: String(rec.errorMessage ?? ""),
      delay: rec.delayMs,
    }),
  );
}

function piRetryEnd(state: PiTranslatorState, rec: any) {
  if (rec.success === false)
    state.failure = friendlyError(String(rec.finalError ?? "request failed"));
}

function piSettled(state: PiTranslatorState, rec: any) {
  piSettle(state, !!rec.aborted);
}

function piCompactResponse(state: PiTranslatorState, rec: any) {
  if (rec.success) {
    state.emit({ type: "system", subtype: "compact_boundary" });
    if (Number.isFinite(rec.data?.estimatedTokensAfter))
      state.emit({
        type: "context_usage",
        used: rec.data.estimatedTokensAfter,
        ...(state.contextWindow?.() ? { max: state.contextWindow() } : {}),
      });
  } else state.emit({ type: "console_error", text: String(rec.error || "Pi compaction failed.") });
  state.emit({
    type: "result",
    subtype: rec.success ? "success" : "error",
    is_error: !rec.success,
  });
}

function piCommandList(rec: any): Command[] {
  return (rec.data?.commands ?? [])
    .filter((entry: any) => typeof entry?.name === "string")
    .map((entry: any) => ({
      name: entry.name,
      description: String(entry.description ?? "").slice(0, 200),
    }))
    .sort((left: Command, right: Command) => left.name.localeCompare(right.name));
}

function piResponse(state: PiTranslatorState, rec: any) {
  if (rec.command === "compact") {
    piCompactResponse(state, rec);
    return;
  }
  if (rec.command === "get_commands" && rec.success) {
    state.onCommands?.(piCommandList(rec));
  } else if (rec.command === "prompt" && rec.success === false) {
    state.failure = friendlyError(String(rec.error ?? "prompt rejected"));
    piSettle(state);
  }
}

const PI_HANDLERS: Record<string, (state: PiTranslatorState, rec: any) => void> = Object.assign(
  Object.create(null),
  {
    agent_start: piAgentStart,
    message_start: piMessageStart,
    message_update: piMessageUpdate,
    message_end: piMessageEnd,
    tool_execution_start: piToolStart,
    tool_execution_update: piToolUpdate,
    tool_execution_end: piToolEnd,
    auto_retry_start: piRetryStart,
    auto_retry_end: piRetryEnd,
    agent_settled: piSettled,
    response: piResponse,
  },
);

// Pure translator: pi session event -> canonical (Claude-shaped) events. Exported so it can be tested without a model.
export function piTranslator(
  emit: (event: any) => void,
  onCommands?: (list: Command[]) => void,
  contextWindow?: () => number | undefined,
) {
  const state: PiTranslatorState = {
    emit,
    onCommands,
    contextWindow,
    started: 0,
    cost: 0,
    usageModels: [],
    failure: undefined,
    subagents: new Map<string, string>(),
  };
  return (rec: any) => {
    PI_HANDLERS[rec?.type]?.(state, rec);
  };
}

type PiRun = {
  spec: ThreadSpec;
  ctx: AgentCtx;
  args: string[];
  proc: Proc | undefined;
  dead: boolean;
  queued: string[]; // writes made before pi is spawned wait here
  counter: number;
  translate: (rec: any) => void;
  questions: ReturnType<typeof piQuestions>;
  // A 429 that outlives pi's own 3 retries: wait out the shared cooldown, re-send the prompt once per user turn.
  // Only when the failed reply made no tool call, so no side effect can run twice.
  last: { text: string; images: Attachment[] } | undefined;
  retried: boolean;
  hadTools: boolean;
  resending: AbortController | undefined;
};

function piArgs(spec: ThreadSpec, dir: string, routed: boolean): string[] {
  const args = [
    "--mode",
    "rpc",
    "--model",
    routed ? CODING_ROUTE : spec.model,
    "--session-dir",
    dir,
    "--extension",
    QUESTIONS_EXTENSION,
    "--extension",
    TOOLS_EXTENSION,
    "--extension",
    SUBAGENT_EXTENSION,
  ];
  if (routed) args.push("--extension", CODING_ROUTE_EXTENSION);
  if (fs.readdirSync(dir).length) args.push("--continue");
  if (spec.mode === "plan") args.push("--tools", READ_ONLY_TOOLS);
  return args;
}

function piWrite(run: PiRun, line: string) {
  return run.proc ? run.proc.write(line) : void run.queued.push(line);
}

function piPromptBody(text: string, images: Attachment[]) {
  return {
    message: text.trim() ? text : IMAGE_ONLY_PROMPT,
    ...(images.length
      ? {
          images: images.map((image) => ({
            type: "image",
            data: fs.readFileSync(image.path).toString("base64"),
            mimeType: image.media_type,
          })),
        }
      : {}),
  };
}

function piRatePool(model: string): "nvidia" | "openrouter" | "other" {
  if (model.startsWith("nvidia/")) return "nvidia";
  if (model.startsWith("openrouter/")) return "openrouter";
  return "other";
}

function piRateLimitGaveUp(run: PiRun, rec: any): boolean {
  return (
    rec.type === "auto_retry_end" &&
    rec.success === false &&
    !run.retried &&
    !run.hadTools &&
    /\b429\b/.test(String(rec.finalError ?? ""))
  );
}

function piResend(run: PiRun, rec: any, again: { text: string; images: Attachment[] }) {
  run.retried = true;
  run.resending = new AbortController();
  const { signal } = run.resending;
  run.ctx.event(retryEvent({ attempt: 4, status: 429, message: String(rec.finalError), delay: 0 }));
  acquireModelRequest({
    signal,
    provider: piRatePool(run.spec.model),
    priority: run.spec.issueRun ? "automation" : "interactive",
  }).then(
    () => {
      if (!signal.aborted)
        piWrite(
          run,
          JSON.stringify({
            id: `p${++run.counter}`,
            type: "prompt",
            ...piPromptBody(again.text, again.images),
          }),
        );
    },
    () => {},
  );
}

function piHandleLine(run: PiRun, line: string) {
  const rec = parseJson(line);
  if (!rec || run.questions.handle(rec)) return;
  if (rec.type === "message_end" && rec.message?.role === "assistant")
    run.hadTools ||= (rec.message.content ?? []).some((block: any) => block?.type === "toolCall");
  if (run.last && piRateLimitGaveUp(run, rec)) {
    piResend(run, rec, run.last);
    return; // swallow the failure and the settle that follows it; the re-send continues the same turn
  }
  if (rec.type === "agent_settled" && run.resending) {
    const aborted = run.resending.signal.aborted;
    run.resending = undefined;
    if (!aborted && !rec.aborted) return;
    run.translate({ ...rec, aborted: true });
    return;
  }
  run.translate(rec);
}

/** Main-thread system prompt: the role persona first. Children get only `brain` through the forwarded env, never the persona. */
export const piMainPrompt = (spec: ThreadSpec, brain: string | undefined) =>
  [personaInstructions(personaFor(spec)), brain].filter(Boolean).join("\n\n");

function piLaunch(run: PiRun, brain: string | undefined) {
  if (run.dead) return;
  const { spec, ctx } = run;
  const main = piMainPrompt(spec, brain);
  if (main) run.args.push("--append-system-prompt", main); // persona + style preamble + shared memory index
  const launch = sandboxLaunch(
    spec,
    "pi",
    run.args,
    piRateEnv(
      {
        ...childEnv(),
        AGENT_CONSOLE_THREAD: spec.id,
        AGENT_CONSOLE_PI_MODE: spec.mode,
        AGENT_CONSOLE_PI_INSTRUCTIONS: brain,
      },
      spec.issueRun ? "automation" : "interactive",
    ),
  );
  const proc = spawnLines(
    "pi",
    launch.command,
    launch.args,
    { cwd: spec.cwd, env: launch.env },
    {
      ...ctx,
      exited(info) {
        run.questions.cancelAll();
        ctx.exited(info);
      },
    },
    (line) => piHandleLine(run, line),
  );
  run.proc = proc;
  for (const line of run.queued.splice(0)) proc.write(line);
}

function piBootFailed(run: PiRun, error: any) {
  run.dead = true;
  run.ctx.event({ type: "console_error", text: String(error?.message || error) });
  run.ctx.exited({
    code: 78,
    signal: null,
    stderr: String(error?.message || error),
    aborted: false,
  });
}

function piStop(run: PiRun, how: "abort" | "kill") {
  run.resending?.abort();
  run.questions.cancelAll();
  if (run.proc) return run.proc[how]();
  if (run.dead) return;
  run.dead = true;
  run.ctx.exited({
    code: null,
    signal: how === "abort" ? "SIGINT" : "SIGTERM",
    stderr: "",
    aborted: true,
  });
}

function piAgent(run: PiRun): Agent {
  const send = (kind: string, text: string, images: Attachment[]) =>
    piWrite(
      run,
      JSON.stringify({ id: `p${++run.counter}`, type: kind, ...piPromptBody(text, images) }),
    );
  return {
    get alive() {
      return !run.dead && (!run.proc || run.proc.alive());
    },
    compact: (instructions = "") =>
      piWrite(
        run,
        JSON.stringify({
          id: `compact${++run.counter}`,
          type: "compact",
          ...(instructions ? { customInstructions: instructions } : {}),
        }),
      ),
    send: (text, images = []) => {
      run.last = { text, images };
      run.retried = false;
      run.hadTools = false;
      run.resending = undefined;
      send("prompt", text, images);
    },
    // Pi's `steer` is delivered after the current assistant turn finishes its tool calls, before the next model call
    steer: (text, images = []) => send("steer", text, images),
    answer: (questionId, reply) => run.questions.answer(questionId, reply),
    abort: () => piStop(run, "abort"),
    kill: () => piStop(run, "kill"),
  };
}

function piStart(spec: ThreadSpec, ctx: AgentCtx): Agent {
  const dir = path.join(SESSIONS, spec.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Only unattended NVIDIA coding runs use the host router. Manual model
  // choices and explicit OpenRouter selections retain their exact provider.
  const routed =
    !!spec.issueRun && DIRECT_CODING_MODELS.some((modelId) => spec.model === `nvidia/${modelId}`);
  const run: PiRun = {
    spec,
    ctx,
    args: piArgs(spec, dir, routed),
    proc: undefined,
    dead: false,
    queued: [],
    counter: 0,
    translate: piTranslator(
      (event) => ctx.event(event),
      (list) => ctx.commands(list),
      () => contexts.get(spec.model),
    ),
    questions: piQuestions((msg) => piWrite(run, JSON.stringify(msg)), ctx.event),
    last: undefined,
    retried: false,
    hadTools: false,
    resending: undefined,
  };
  // The instructions (brain index) resolve asynchronously; writes made before pi is spawned wait in `queued`.
  void harnessInstructions()
    .then((brain) => piLaunch(run, brain))
    .catch((error) => piBootFailed(run, error));
  if (spec.effort && spec.effort !== "default")
    piWrite(run, JSON.stringify({ id: "effort", type: "set_thinking_level", level: spec.effort }));
  piWrite(run, JSON.stringify({ id: "cmds", type: "get_commands" }));
  return piAgent(run);
}

export const pi: Provider = {
  id: "pi",
  label: "Pi",
  modes: ["plan", "bypassPermissions"],
  defaultMode: "bypassPermissions",
  steer: true,
  note: "Plan limits Pi to read-only tools. Bypass gives it everything. Both support user questions.",
  models: () => cached,
  // Prefer a known coding model; manual sessions still allow every listed model.
  defaultModel: () => defaultPiModel(cached),
  modelDetails: () =>
    Object.fromEntries(
      cached.map((id) => [
        id,
        {
          label: id
            .split("/")
            .at(-1)!
            .replace(/:free$/, ""),
          efforts: thinking.has(id) ? ["off", "minimal", "low", "medium", "high"] : [],
        },
      ]),
    ),
  status() {
    if (!configured())
      return {
        ok: false,
        hint: "Add NVIDIA_API_KEY or OPENROUTER_API_KEY to ~/.config/agent-console/env, or run `pi` and /login.",
      };
    if (!cached.length) return { ok: false, hint: "Pi lists no models for these credentials." };
    return { ok: true };
  },
  start: piStart,
};
