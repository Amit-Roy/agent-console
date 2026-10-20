import { launch as sandboxLaunch } from "../automation/sandbox.ts";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../auth.ts";
import { harnessInstructions } from "./brain.ts";
import { childEnv } from "./env.ts";
import { parseJson, spawnLines, type Proc } from "./proc.ts";
import { piQuestions } from "./pi-questions.ts";
import { piRateEnv } from "./pi-rate-env.ts";
import { CODING_ROUTE, DIRECT_CODING_MODELS } from "./pi-coding-route.mjs";
import { defaultPiModel } from "./pi-model.ts";
import { retryEvent } from "../turn-timing.ts";
import { acquireModelRequest } from "./model-rate-client.ts";
import { clip, IMAGE_ONLY_PROMPT, type Agent, type AgentCtx, type Attachment, type Command, type Provider, type ThreadSpec } from "./types.ts";

// pi (github.com/earendil-works/pi) in RPC mode: one long-lived process per thread, any model pi knows about
// (OpenRouter, OpenAI, Google, local, ...). Pi has no per-action approvals, so only Plan (read-only tools) and Bypass exist.

const SESSIONS = path.join(DATA_DIR, "pi-sessions");
const READ_ONLY_TOOLS = "read,grep,find,ls,ask_user,schedule_list,save_output";
const QUESTIONS_EXTENSION = fileURLToPath(new URL("./pi-questions-extension.mjs", import.meta.url));
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
    if (Object.keys(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"))).length) return true;
  } catch {}
  const env = childEnv();
  return !!(env.NVIDIA_API_KEY || env.OPENROUTER_API_KEY);
}

// `pi --list-models` only lists what the current credentials unlock. With an OpenRouter key we offer its free models
// by default (AGENT_CONSOLE_PI_ALL=1 offers everything) so the picker stays short and a typo can't spend money.
// "262.1K" -> 262100, "1M" -> 1000000
export function parseTokens(s: string | undefined): number | undefined {
  const m = s?.match(/^([\d.]+)([KM])?$/i);
  return m ? Math.round(Number(m[1]) * (m[2]?.toUpperCase() === "M" ? 1_000_000 : m[2] ? 1000 : 1)) : undefined;
}

export function parsePiModels(table: string, all = false): string[] {
  const out: string[] = [];
  for (const line of table.split("\n").slice(1)) {
    const [provider, model, context, , thinks] = line.trim().split(/\s+/);
    if (thinks === "yes") thinking.add(`${provider}/${model}`);
    if (provider && model && !provider.startsWith("/") && parseTokens(context)) contexts.set(`${provider}/${model}`, parseTokens(context)!);
    if (!provider || !model || provider.startsWith("/")) continue;
    if (!all && ((provider === "openrouter" && !model.endsWith(":free")) || (provider === "nvidia" && !NVIDIA_FREE_MODELS.has(model)))) continue;
    out.push(`${provider}/${model}`);
  }
  return out.slice(0, 200);
}

export function refreshPiModels(): Promise<string[]> {
  return new Promise((resolve) => {
    const env = childEnv(); // so the toggles work from ~/.config/agent-console/env too, not only the server's env
    if (env.AGENT_CONSOLE_PI_MODELS) {
      cached = env.AGENT_CONSOLE_PI_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
      return resolve(cached);
    }
    execFile("pi", ["--list-models"], { env, timeout: 20_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (!err) cached = parsePiModels(stdout + stderr, env.AGENT_CONSOLE_PI_ALL === "1");
      resolve(cached);
    });
  });
}

const CAP: Record<string, string> = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Glob", ls: "Glob" };

// Make pi's tool calls look like Claude's so the UI's cards (diff view, shell highlighting, icons) apply.
export function normTool(name: string, a: Record<string, any> = {}): { name: string; input: Record<string, any> } {
  const n = CAP[name] ?? name;
  const input: Record<string, any> = { ...a };
  const p = a.path ?? a.file_path ?? a.filePath;
  if (p !== undefined && n !== "Glob" && n !== "Grep") input.file_path = p;
  const edit = Array.isArray(a.edits) ? a.edits[0] : a;
  if (n === "Edit" && edit) {
    const o = edit.oldText ?? edit.old_string ?? edit.oldString, nw = edit.newText ?? edit.new_string ?? edit.newString;
    if (typeof o === "string" && typeof nw === "string") Object.assign(input, { old_string: o, new_string: nw });
  }
  return { name: n, input };
}

const textOf = (content: any): string =>
  typeof content === "string" ? content : (content ?? []).map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");

function friendlyError(msg: string): string {
  const m = msg.match(/"message"\s*:\s*"([^"]+)"/);
  return clip(m ? m[1] : msg, 500);
}

// Pure translator: pi session event -> canonical (Claude-shaped) events. Exported so it can be tested without a model.
export function piTranslator(emit: (ev: any) => void, onCommands?: (list: Command[]) => void, contextWindow?: () => number | undefined) {
  let started = 0;
  let cost = 0;
  let usageModels: any[] = [];
  let failure: string | undefined;
  const settle = (aborted = false) => {
    if (failure) emit({ type: "console_error", text: failure });
    emit({
      type: "result",
      subtype: aborted ? "error_during_execution" : failure ? "error" : "success",
      is_error: !!failure,
      duration_ms: started ? Date.now() - started : 0,
      ...(cost > 0 ? { total_cost_usd: cost } : {}),
      usageModels,
    });
    started = 0;
    cost = 0;
    usageModels = [];
    failure = undefined;
  };
  return (r: any) => {
    switch (r?.type) {
      case "agent_start":
        started ||= Date.now();
        break;
      case "message_start":
        if (r.message?.role === "assistant") emit({ type: "stream_event", event: { type: "message_start" } });
        break;
      case "message_update": {
        const e = r.assistantMessageEvent;
        if (e?.type === "text_delta") emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: e.delta } } });
        else if (e?.type === "thinking_delta") emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: e.delta } } });
        break;
      }
      case "message_end": {
        const m = r.message;
        if (m?.role !== "assistant") break;
        cost += Number(m.usage?.cost?.total) || 0;
        const u = m.usage;
        if (u) usageModels.push({ model: m.model || "unknown", role: "agent", fresh: u.input, cacheWrite: u.cacheWrite, cacheRead: u.cacheRead, output: u.output, reasoning: u.reasoning, cost: u.cost?.total });
        const used = Number(u?.totalTokens) || (Number(u?.input) || 0) + (Number(u?.cacheRead) || 0) + (Number(u?.cacheWrite) || 0) + (Number(u?.output) || 0);
        if (used > 0) emit({ type: "context_usage", used, ...(contextWindow?.() ? { max: contextWindow() } : {}) });
        // a provider error that pi retried successfully must not fail the whole turn: only the last reply counts
        if (m.stopReason === "error" && m.errorMessage) failure = friendlyError(m.errorMessage);
        else if (m.stopReason !== "aborted") failure = undefined;
        const content = (m.content ?? [])
          .map((b: any) => {
            if (b.type === "text") return { type: "text", text: b.text };
            if (b.type === "thinking") return { type: "thinking", thinking: b.thinking ?? "" };
            if (b.type === "toolCall") return { type: "tool_use", id: b.id, ...normTool(b.name, b.arguments) };
          })
          .filter(Boolean);
        if (content.length) emit({ type: "assistant", message: { role: "assistant", content, model: m.model, usage: m.usage } });
        break;
      }
      case "tool_execution_end":
        emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: r.toolCallId, content: clip(textOf(r.result?.content)), is_error: !!r.isError }] } });
        break;
      case "auto_retry_start": // turn timing only: status + error class, never the message
        emit(retryEvent({ attempt: r.attempt, message: String(r.errorMessage ?? ""), delay: r.delayMs }));
        break;
      case "auto_retry_end":
        if (r.success === false) failure = friendlyError(String(r.finalError ?? "request failed"));
        break;
      case "agent_settled":
        settle(!!r.aborted);
        break;
      case "response":
        if (r.command === "compact") {
          if (r.success) {
            emit({ type: "system", subtype: "compact_boundary" });
            if (Number.isFinite(r.data?.estimatedTokensAfter)) emit({ type: "context_usage", used: r.data.estimatedTokensAfter, ...(contextWindow?.() ? { max: contextWindow() } : {}) });
          } else emit({ type: "console_error", text: String(r.error || "Pi compaction failed.") });
          emit({ type: "result", subtype: r.success ? "success" : "error", is_error: !r.success });
          break;
        }
        if (r.command === "get_commands" && r.success) {
          onCommands?.(
            (r.data?.commands ?? [])
              .filter((c: any) => typeof c?.name === "string")
              .map((c: any) => ({ name: c.name, description: String(c.description ?? "").slice(0, 200) }))
              .sort((a: Command, b: Command) => a.name.localeCompare(b.name)),
          );
        } else if (r.command === "prompt" && r.success === false) {
          failure = friendlyError(String(r.error ?? "prompt rejected"));
          settle();
        }
        break;
    }
  };
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
  modelDetails: () => Object.fromEntries(cached.map(id => [id, { label: id.split("/").at(-1)!.replace(/:free$/, ""), efforts: thinking.has(id) ? ["off", "minimal", "low", "medium", "high"] : [] }])),
  status() {
    if (!configured()) return { ok: false, hint: "Add NVIDIA_API_KEY or OPENROUTER_API_KEY to ~/.config/agent-console/env, or run `pi` and /login." };
    if (!cached.length) return { ok: false, hint: "Pi lists no models for these credentials." };
    return { ok: true };
  },
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    const dir = path.join(SESSIONS, t.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Only unattended NVIDIA coding runs use the host router. Manual model
    // choices and explicit OpenRouter selections retain their exact provider.
    const routed = !!t.issueRun && DIRECT_CODING_MODELS.some(id => t.model === `nvidia/${id}`);
    const args = ["--mode", "rpc", "--model", routed ? CODING_ROUTE : t.model, "--session-dir", dir, "--extension", QUESTIONS_EXTENSION, "--extension", TOOLS_EXTENSION];
    if (routed) args.push("--extension", CODING_ROUTE_EXTENSION);
    if (fs.readdirSync(dir).length) args.push("--continue");
    if (t.mode === "plan") args.push("--tools", READ_ONLY_TOOLS);
    const translate = piTranslator((ev) => ctx.event(ev), (list) => ctx.commands(list), () => contexts.get(t.model));
    // The instructions (brain index) resolve asynchronously; writes made before pi is spawned wait in `queued`.
    let p: Proc | undefined, dead = false;
    const queued: string[] = [];
    const write = (line: string) => (p ? p.write(line) : void queued.push(line));
    // A 429 that outlives pi's own 3 retries: wait out the shared cooldown, re-send the prompt once per user turn.
    // Only when the failed reply made no tool call, so no side effect can run twice.
    let last: { text: string; images: Attachment[] } | undefined, retried = false, hadTools = false, resending: AbortController | undefined;
    const questions = piQuestions(msg => write(JSON.stringify(msg)), ctx.event);
    void harnessInstructions().then((brain) => {
      if (dead) return;
      if (brain) args.push("--append-system-prompt", brain); // style preamble + shared memory index
      const launch = sandboxLaunch(t, "pi", args, piRateEnv({ ...childEnv(), AGENT_CONSOLE_THREAD: t.id }, t.issueRun ? "automation" : "interactive"));
      p = spawnLines("pi", launch.command, launch.args, { cwd: t.cwd, env: launch.env }, {
        ...ctx,
        exited(info) { questions.cancelAll(); ctx.exited(info); },
      }, (line) => {
        const r = parseJson(line);
        if (!r || questions.handle(r)) return;
        if (r.type === "message_end" && r.message?.role === "assistant") hadTools ||= (r.message.content ?? []).some((b: any) => b?.type === "toolCall");
        if (r.type === "auto_retry_end" && r.success === false && !retried && !hadTools && last && /\b429\b/.test(String(r.finalError ?? ""))) {
          retried = true;
          resending = new AbortController();
          const { signal } = resending, again = last;
          ctx.event(retryEvent({ attempt: 4, status: 429, message: String(r.finalError), delay: 0 }));
          acquireModelRequest({ signal, provider: t.model.startsWith("nvidia/") ? "nvidia" : t.model.startsWith("openrouter/") ? "openrouter" : "other", priority: t.issueRun ? "automation" : "interactive" }).then(() => { if (!signal.aborted) write(JSON.stringify({ id: `p${++n}`, type: "prompt", ...body(again.text, again.images) })); }, () => {});
          return; // swallow the failure and the settle that follows it; the re-send continues the same turn
        }
        if (r.type === "agent_settled" && resending) {
          const aborted = resending.signal.aborted;
          resending = undefined;
          if (!aborted && !r.aborted) return;
          return translate({ ...r, aborted: true });
        }
        translate(r);
      });
      for (const line of queued.splice(0)) p.write(line);
    }).catch(error => {
      dead = true;
      ctx.event({ type: "console_error", text: String(error?.message || error) });
      ctx.exited({ code: 78, signal: null, stderr: String(error?.message || error), aborted: false });
    });
    const stop = (how: "abort" | "kill") => {
      resending?.abort();
      questions.cancelAll();
      if (p) return p[how]();
      if (dead) return;
      dead = true;
      ctx.exited({ code: null, signal: how === "abort" ? "SIGINT" : "SIGTERM", stderr: "", aborted: true });
    };
    if (t.effort && t.effort !== "default") write(JSON.stringify({ id: "effort", type: "set_thinking_level", level: t.effort }));
    write(JSON.stringify({ id: "cmds", type: "get_commands" }));
    let n = 0;
    const body = (text: string, images: Attachment[]) => ({
      message: text.trim() ? text : IMAGE_ONLY_PROMPT,
      ...(images.length ? { images: images.map((i) => ({ type: "image", data: fs.readFileSync(i.path).toString("base64"), mimeType: i.media_type })) } : {}),
    });
    return {
      get alive() {
        return !dead && (!p || p.alive());
      },
      compact: (instructions = "") => write(JSON.stringify({ id: `compact${++n}`, type: "compact", ...(instructions ? { customInstructions: instructions } : {}) })),
      send: (text, images = []) => (last = { text, images }, retried = false, hadTools = false, resending = undefined, write(JSON.stringify({ id: `p${++n}`, type: "prompt", ...body(text, images) }))),
      // Pi's `steer` is delivered after the current assistant turn finishes its tool calls, before the next model call
      steer: (text, images = []) => write(JSON.stringify({ id: `p${++n}`, type: "steer", ...body(text, images) })),
      answer: (id, reply) => questions.answer(id, reply),
      abort: () => stop("abort"),
      kill: () => stop("kill"),
    };
  },
};
