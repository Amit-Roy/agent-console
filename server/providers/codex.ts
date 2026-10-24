import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCodexApp } from "./codex-app.ts";
import { codexWebTool } from "./codex-web.ts";
import {
  type Agent,
  type AgentCtx,
  cleanQuestions,
  clip,
  type Mode,
  type Provider,
  type ThreadSpec,
} from "./types.ts";

// Persistent Codex app-server owns each active session and accepts native mid-turn steering.
// The pure exec translator is shared with the app-server item adapter and historical fixtures.

// codex runs everything as `/usr/bin/zsh -lc '<command>'`; show just the command
export const unwrapShell = (cmd: unknown): string => {
  const c = String(cmd ?? "");
  const m = c.match(/^\S*\/(?:ba|z|da)?sh -lc (['"])([\s\S]*)\1$/);
  if (!m) return c;
  return m[1] === "'" ? m[2].replaceAll("'\\''", "'") : m[2].replaceAll('\\"', '"');
};

const asst = (b: any) => ({ type: "assistant", message: { role: "assistant", content: [b] } });
const result = (id: string, text: string, isError: boolean) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: clip(text), is_error: isError }],
  },
});

// codex reports harmless ~/.codex/config.toml warnings as "error" items before every turn; the user can't act on them from here
const CONFIG_WARNING = /^Codex is ignoring \d+ unrecognized configuration setting/;

type CodexState = {
  emit: (event: any) => void;
  started: number;
  begun: Set<string>;
  web: Map<string, string>;
  asked: Set<string>;
};

function codexFinish(state: CodexState, failure?: string) {
  if (failure) state.emit({ type: "console_error", text: failure });
  state.emit({
    type: "result",
    subtype: failure ? "error" : "success",
    is_error: !!failure,
    duration_ms: state.started ? Date.now() - state.started : 0,
  });
  state.started = 0;
  state.begun.clear();
  state.web.clear();
}

function codexTool(state: CodexState, toolId: string, name: string, input: Record<string, any>) {
  if (state.begun.has(toolId)) return;
  state.begun.add(toolId);
  state.emit(asst({ type: "tool_use", id: toolId, name, input }));
}

function asyncQuestions(item: any) {
  const raw = Array.isArray(item.questions) ? item.questions : [];
  return cleanQuestions(
    raw
      .map((entry: any, index: number) => ({
        id: String(index),
        question: entry?.title,
        options: Array.isArray(entry?.options)
          ? entry.options.map((label: string) => ({ label }))
          : [],
        allowOther: true,
      }))
      .filter((entry: any) => typeof entry.question === "string" && entry.question.trim()),
  );
}

function codexAgentMessage(state: CodexState, item: any, done: boolean) {
  if (!done) return;
  // request_user_input_async is an agentMessage with question metadata,
  // not a blocking app-server request. Its text is only a fallback for text clients.
  const questions = asyncQuestions(item);
  if (!questions.length) {
    state.emit(asst({ type: "text", text: String(item.text ?? "") }));
    return;
  }
  const questionId = `codex-async-${item.id || randomUUID()}`;
  if (state.asked.has(questionId)) return;
  state.asked.add(questionId);
  state.emit({ type: "question", id: questionId, async: true, questions, ts: Date.now() });
}

function codexReasoning(state: CodexState, item: any, done: boolean) {
  if (done && item.text) state.emit(asst({ type: "thinking", thinking: String(item.text) }));
}

function codexCommand(state: CodexState, item: any, done: boolean) {
  codexTool(state, item.id, "Bash", {
    command: unwrapShell(item.command),
    ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
  });
  if (!done) return;
  state.emit(
    result(
      item.id,
      String(item.aggregated_output ?? ""),
      item.status === "failed" || (item.exit_code ?? 0) !== 0,
    ),
  );
}

function codexFileChange(state: CodexState, item: any, done: boolean) {
  const changes = item.changes ?? [];
  codexTool(state, item.id, "Edit", { file_path: changes[0]?.path, changes });
  if (!done) return;
  state.emit(
    result(
      item.id,
      changes.map((change: any) => `${change.kind} ${change.path}`).join("\n") || "no changes",
      item.status === "failed",
    ),
  );
}

function codexMcpCall(state: CodexState, item: any, done: boolean) {
  codexTool(state, item.id, `${item.server}:${item.tool}`, item.arguments ?? {});
  if (!done) return;
  state.emit(
    result(
      item.id,
      JSON.stringify(item.result ?? item.error ?? "", null, 1),
      item.status === "failed",
    ),
  );
}

function webOutput(item: any, failed: boolean) {
  const reported = item.error?.message ?? item.error;
  if (reported !== undefined && reported !== null) return reported;
  if (failed) return `Web action ${item.status}`;
  return item.results ? JSON.stringify(item.results, null, 2) : "";
}

function codexWebSearch(state: CodexState, item: any, done: boolean) {
  const details = codexWebTool(item);
  const signature = JSON.stringify(details);
  if (!state.begun.has(item.id)) codexTool(state, item.id, details.name, details.input);
  else if (state.web.get(item.id) !== signature)
    state.emit({ type: "tool_update", tool_use_id: item.id, ...details });
  state.web.set(item.id, signature);
  if (!done) return;
  const failed = ["failed", "incomplete", "cancelled"].includes(item.status) || !!item.error;
  state.emit(result(item.id, String(webOutput(item, failed)), failed));
}

function codexItemError(state: CodexState, item: any, done: boolean) {
  if (done && !CONFIG_WARNING.test(String(item.message)))
    state.emit({ type: "console_error", text: String(item.message ?? "error") });
}

const CODEX_ITEM_HANDLERS: Record<string, (state: CodexState, item: any, done: boolean) => void> =
  Object.assign(Object.create(null), {
    agent_message: codexAgentMessage,
    reasoning: codexReasoning,
    command_execution: codexCommand,
    file_change: codexFileChange,
    mcp_tool_call: codexMcpCall,
    web_search: codexWebSearch,
    error: codexItemError,
  });

function codexItemEvent(state: CodexState, rec: any) {
  const item = rec.item ?? {};
  CODEX_ITEM_HANDLERS[item.type]?.(state, item, rec.type === "item.completed");
}

const CODEX_HANDLERS: Record<string, (state: CodexState, rec: any) => void> = Object.assign(
  Object.create(null),
  {
    "thread.started": (state: CodexState, rec: any) =>
      state.emit({
        type: "system",
        subtype: "init",
        session_id: rec.thread_id,
        ...(rec.model ? { model: rec.model } : {}),
      }), // resolved model id for turn timing
    "turn.started": (state: CodexState) => {
      state.started ||= Date.now();
      state.emit({ type: "stream_event", event: { type: "message_start" } });
    },
    "item.started": codexItemEvent,
    "item.updated": codexItemEvent,
    "item.completed": codexItemEvent,
    "turn.completed": (state: CodexState, rec: any) => {
      // exec usage is cumulative across tool-loop requests, never current context.
      if (rec.usage) state.emit({ type: "token_usage", ...rec.usage });
      codexFinish(state);
    },
    "turn.failed": (state: CodexState, rec: any) =>
      codexFinish(state, String(rec.error?.message ?? "turn failed")),
    error: (state: CodexState, rec: any) => {
      if (!state.started)
        state.emit({ type: "console_error", text: String(rec.message ?? "error") });
    },
  },
);

export function codexTranslator(emit: (event: any) => void) {
  const state: CodexState = {
    emit,
    started: 0,
    begun: new Set<string>(),
    web: new Map<string, string>(),
    asked: new Set<string>(),
  };
  return (rec: any) => {
    CODEX_HANDLERS[rec?.type]?.(state, rec);
  };
}

const loggedIn = () =>
  fs.existsSync(
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"),
  );

// Codex's Plan and Accept-edits modes rely on its bubblewrap sandbox, which needs unprivileged user namespaces. Many containers
// (this one included) forbid them, and every command then fails with "bwrap: No permissions to create a new namespace".
let sandbox: boolean | undefined;
const sandboxWorks = () =>
  (sandbox ??= spawnSync("unshare", ["--user", "true"], { stdio: "ignore" }).status === 0);

// Read only the public model metadata from the CLI's account-specific cache. Never expose prompts or auth data.
export function codexModels() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let models: any[] = [];
  try {
    models = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")).models || [];
  } catch {}
  const details: Record<
    string,
    { label: string; description?: string; efforts: string[]; defaultEffort?: string }
  > = {};
  details.default = {
    label: "CLI default",
    description:
      "Inherits Codex configuration, project overrides and CLI defaults. Select a model to pin it for this thread.",
    efforts: [],
  };
  for (const m of models) {
    if (m.visibility !== "list" || typeof m.slug !== "string") continue;
    details[m.slug] = {
      label: m.display_name || m.slug,
      description: m.description,
      efforts: (m.supported_reasoning_levels || [])
        .map((e: any) => e.effort)
        .filter((e: any) => typeof e === "string"),
      defaultEffort: m.default_reasoning_level,
    };
  }
  for (const id of (process.env.AGENT_CONSOLE_CODEX_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    details[id] ||= {
      label: id,
      description: "Configured model; supported effort levels are unknown.",
      efforts: [],
    };
  }
  const known = Object.entries(details)
    .filter(([id, m]) => id !== "default" && m.efforts.length)
    .map(([, m]) => m.efforts);
  details.default.efforts = known.length
    ? known[0].filter((e) => known.every((levels) => levels.includes(e)))
    : [];
  return details;
}

export const codex: Provider = {
  id: "codex",
  label: "Codex",
  steer: true,
  get modes(): Mode[] {
    return sandboxWorks() ? ["plan", "acceptEdits", "bypassPermissions"] : ["bypassPermissions"];
  },
  get defaultMode(): Mode {
    return sandboxWorks() ? "acceptEdits" : "bypassPermissions";
  },
  get note(): string {
    return sandboxWorks()
      ? "Uses your ChatGPT login. Plan is a read-only sandbox, Accept edits is workspace-write."
      : "Uses your ChatGPT login. This machine cannot run Codex's sandbox (no user namespaces), so only Bypass is available.";
  },
  // "default" = whatever ~/.codex/config.toml selects
  models: () => Object.keys(codexModels()),
  modelDetails: codexModels,
  defaultModel: () => "default",
  status: () =>
    loggedIn()
      ? { ok: true }
      : { ok: false, hint: "Run `codex login --device-auth` in a terminal." },
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    return startCodexApp(t, ctx, codexTranslator(ctx.event));
  },
};
