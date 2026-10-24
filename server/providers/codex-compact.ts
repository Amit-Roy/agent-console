import { codexRouting } from "./codex-routing.ts";
import { childEnv } from "./env.ts";
import { parseJson, spawnLines } from "./proc.ts";
import type { AgentCtx, ThreadSpec } from "./types.ts";

interface CompactState {
  thread: ThreadSpec;
  ctx: AgentCtx;
  started: number;
  finished: boolean;
  confirmed: boolean;
  requested: boolean;
  timer: NodeJS.Timeout | undefined;
  proc: ReturnType<typeof spawnLines> | undefined;
}

function finishCompaction(state: CompactState, error?: string) {
  if (state.finished) return;
  state.finished = true;
  clearTimeout(state.timer);
  if (error) state.ctx.event({ type: "console_error", text: error });
  state.ctx.event({
    type: "result",
    subtype: error ? "error" : "success",
    is_error: !!error,
    duration_ms: Date.now() - state.started,
  });
  state.proc!.kill();
}

function compactRpc(
  state: CompactState,
  requestId: number | undefined,
  method: string,
  params: object,
) {
  state.proc!.write(
    JSON.stringify({ ...(requestId != null ? { id: requestId } : {}), method, params }),
  );
}

function compactSandbox(mode: ThreadSpec["mode"]) {
  if (mode === "bypassPermissions") return "danger-full-access";
  return mode === "plan" ? "read-only" : "workspace-write";
}

function resumeCompactThread(state: CompactState) {
  const { thread } = state;
  compactRpc(state, undefined, "initialized", {});
  compactRpc(state, 2, "thread/resume", {
    threadId: thread.sessionId,
    excludeTurns: true,
    cwd: thread.cwd,
    approvalPolicy: "never",
    sandbox: compactSandbox(thread.mode),
    ...(thread.model !== "default" ? { model: thread.model } : {}),
    ...(thread.effort && thread.effort !== "default"
      ? { config: { model_reasoning_effort: thread.effort } }
      : {}),
  });
}

function handleCompactProgress(state: CompactState, reply: any) {
  if (reply.method === "item/completed" && reply.params.item?.type === "contextCompaction") {
    state.confirmed = true;
    state.ctx.event({ type: "system", subtype: "compact_boundary" });
  } else if (reply.method === "turn/completed") {
    const turn = reply.params.turn;
    finishCompaction(
      state,
      turn?.status === "completed" && state.confirmed
        ? undefined
        : turn?.error?.message || "Codex did not confirm context compaction.",
    );
  } else if (reply.method === "error" && !reply.params.willRetry)
    finishCompaction(state, reply.params.error?.message || "Codex compaction failed.");
}

/** Returns true when the reply ended the compaction with an error. */
function failedCompaction(state: CompactState, reply: any): boolean {
  const sessionId = state.thread.sessionId;
  if (reply.error && reply.id != null) {
    finishCompaction(state, String(reply.error.message || "Codex rejected compaction."));
    return true;
  }
  const foreign = reply.params?.threadId && reply.params.threadId !== sessionId;
  if (reply.method === "error" && !reply.params?.willRetry && !foreign) {
    finishCompaction(state, reply.params?.error?.message || "Codex compaction failed.");
    return true;
  }
  return false;
}

function handleCompactLine(state: CompactState, line: string) {
  const reply = parseJson(line);
  if (!reply || state.finished || failedCompaction(state, reply)) return;
  const sessionId = state.thread.sessionId;
  if (reply.id === 1 && !reply.method) resumeCompactThread(state);
  else if (reply.id === 2 && !reply.method) {
    state.requested = true;
    compactRpc(state, 3, "thread/compact/start", { threadId: sessionId });
  } else if (state.requested && reply.params?.threadId === sessionId)
    handleCompactProgress(state, reply);
}

// exec treats /compact as a prompt. Use the native app-server operation against the same persisted thread instead.
export function compactCodex(t: ThreadSpec, ctx: AgentCtx) {
  if (!t.sessionId) throw new Error("Send a message before compacting this thread.");
  const state: CompactState = {
    thread: t,
    ctx,
    started: Date.now(),
    finished: false,
    confirmed: false,
    requested: false,
    timer: undefined,
    proc: undefined,
  };
  const routing = codexRouting(childEnv());
  state.proc = spawnLines(
    "codex compaction",
    "codex",
    ["app-server", ...routing.args],
    { cwd: t.cwd, env: routing.env },
    {
      ...ctx,
      event: (ev) => {
        if (ev.type === "console_error") finishCompaction(state, ev.text);
        else ctx.event(ev);
      },
      exited: (info) => {
        if (!state.finished)
          finishCompaction(
            state,
            info.aborted
              ? "Compaction stopped."
              : `Codex compaction exited before completion (${info.code ?? info.signal}). ${info.stderr.trim().slice(-300)}`,
          );
      },
    },
    (line) => handleCompactLine(state, line),
  );
  state.timer = setTimeout(
    () =>
      finishCompaction(
        state,
        "Context compaction timed out. Try again when the provider is available.",
      ),
    180_000,
  );
  compactRpc(state, 1, "initialize", { clientInfo: { name: "agent_console", version: "1.0.0" } });
  return {
    abort: () => finishCompaction(state, "Compaction stopped."),
    kill: () => {
      state.finished = true;
      clearTimeout(state.timer);
      state.proc!.kill();
    },
  };
}
