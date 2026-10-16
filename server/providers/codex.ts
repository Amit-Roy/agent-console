import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCodexApp } from "./codex-app.ts";
import { codexWebTool } from "./codex-web.ts";
import { clip, type Agent, type AgentCtx, type Mode, type Provider, type ThreadSpec } from "./types.ts";

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
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: clip(text), is_error: isError }] },
});

// codex reports harmless ~/.codex/config.toml warnings as "error" items before every turn; the user can't act on them from here
const CONFIG_WARNING = /^Codex is ignoring \d+ unrecognized configuration setting/;

export function codexTranslator(emit: (ev: any) => void) {
  let started = 0;
  const begun = new Set<string>();
  const web = new Map<string, string>();
  const finish = (failure?: string) => {
    if (failure) emit({ type: "console_error", text: failure });
    emit({ type: "result", subtype: failure ? "error" : "success", is_error: !!failure, duration_ms: started ? Date.now() - started : 0 });
    started = 0;
    begun.clear();
    web.clear();
  };
  const tool = (id: string, name: string, input: Record<string, any>) => {
    if (begun.has(id)) return;
    begun.add(id);
    emit(asst({ type: "tool_use", id, name, input }));
  };
  return (r: any) => {
    switch (r?.type) {
      case "thread.started":
        emit({ type: "system", subtype: "init", session_id: r.thread_id });
        break;
      case "turn.started":
        started ||= Date.now();
        emit({ type: "stream_event", event: { type: "message_start" } });
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const it = r.item ?? {};
        const done = r.type === "item.completed";
        if (it.type === "agent_message" && done) emit(asst({ type: "text", text: String(it.text ?? "") }));
        else if (it.type === "reasoning" && done && it.text) emit(asst({ type: "thinking", thinking: String(it.text) }));
        else if (it.type === "command_execution") {
          tool(it.id, "Bash", { command: unwrapShell(it.command) });
          if (done) emit(result(it.id, String(it.aggregated_output ?? ""), it.status === "failed" || (it.exit_code ?? 0) !== 0));
        } else if (it.type === "file_change") {
          const changes = it.changes ?? [];
          tool(it.id, "Edit", { file_path: changes[0]?.path, changes });
          if (done) emit(result(it.id, changes.map((c: any) => `${c.kind} ${c.path}`).join("\n") || "no changes", it.status === "failed"));
        } else if (it.type === "mcp_tool_call") {
          tool(it.id, `${it.server}:${it.tool}`, it.arguments ?? {});
          if (done) emit(result(it.id, JSON.stringify(it.result ?? it.error ?? "", null, 1), it.status === "failed"));
        } else if (it.type === "web_search") {
          const details = codexWebTool(it);
          const signature = JSON.stringify(details);
          if (!begun.has(it.id)) tool(it.id, details.name, details.input);
          else if (web.get(it.id) !== signature) emit({ type: "tool_update", tool_use_id: it.id, ...details });
          web.set(it.id, signature);
          if (done) {
            const failed = ["failed", "incomplete", "cancelled"].includes(it.status) || !!it.error;
            const output = it.error?.message ?? it.error ?? (failed ? `Web action ${it.status}` : it.results ? JSON.stringify(it.results, null, 2) : "");
            emit(result(it.id, String(output), failed));
          }
        } else if (it.type === "error" && done && !CONFIG_WARNING.test(String(it.message))) emit({ type: "console_error", text: String(it.message ?? "error") });
        break;
      }
      case "turn.completed": {
        // exec usage is cumulative across tool-loop requests, never current context.
        if (r.usage) emit({ type: "token_usage", ...r.usage });
        finish();
        break;
      }
      case "turn.failed":
        finish(String(r.error?.message ?? "turn failed"));
        break;
      case "error":
        if (!started) emit({ type: "console_error", text: String(r.message ?? "error") });
        break;
    }
  };
}

const loggedIn = () => fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"));

// Codex's Plan and Accept-edits modes rely on its bubblewrap sandbox, which needs unprivileged user namespaces. Many containers
// (this one included) forbid them, and every command then fails with "bwrap: No permissions to create a new namespace".
let sandbox: boolean | undefined;
const sandboxWorks = () => (sandbox ??= spawnSync("unshare", ["--user", "true"], { stdio: "ignore" }).status === 0);

// Read only the public model metadata from the CLI's account-specific cache. Never expose prompts or auth data.
export function codexModels() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let models: any[] = [];
  try { models = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")).models || []; } catch {}
  const details: Record<string, { label: string; description?: string; efforts: string[]; defaultEffort?: string }> = {};
  details.default = { label: "CLI default", description: "Inherits Codex configuration, project overrides and CLI defaults. Select a model to pin it for this thread.", efforts: [] };
  for (const m of models) {
    if (m.visibility !== "list" || typeof m.slug !== "string") continue;
    details[m.slug] = { label: m.display_name || m.slug, description: m.description, efforts: (m.supported_reasoning_levels || []).map((e: any) => e.effort).filter((e: any) => typeof e === "string"), defaultEffort: m.default_reasoning_level };
  }
  for (const id of (process.env.AGENT_CONSOLE_CODEX_MODELS || "").split(",").map(s => s.trim()).filter(Boolean)) {
    details[id] ||= { label: id, description: "Configured model; supported effort levels are unknown.", efforts: [] };
  }
  const known = Object.entries(details).filter(([id, m]) => id !== "default" && m.efforts.length).map(([,m]) => m.efforts);
  details.default.efforts = known.length ? known[0].filter(e => known.every(levels => levels.includes(e))) : [];
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
  status: () => (loggedIn() ? { ok: true } : { ok: false, hint: "Run `codex login --device-auth` in a terminal." }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    return startCodexApp(t, ctx, codexTranslator(ctx.event));
  },
};
