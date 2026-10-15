import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "./env.ts";
import { parseJson, spawnLines } from "./proc.ts";
import { clip, type Agent, type AgentCtx, type Mode, type Provider, type ThreadSpec } from "./types.ts";

// OpenAI Codex CLI via `codex exec --json`: one process per turn, resumed by thread id. Uses the ChatGPT subscription login
// (`codex login`). Event mapping follows the documented `exec --json` item stream; see test/providers.ts for fixtures.

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
  const finish = (failure?: string) => {
    if (failure) emit({ type: "console_error", text: failure });
    emit({ type: "result", subtype: failure ? "error" : "success", is_error: !!failure, duration_ms: started ? Date.now() - started : 0 });
    started = 0;
    begun.clear();
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
          tool(it.id, "WebSearch", { query: it.query });
          if (done) emit(result(it.id, "", false));
        } else if (it.type === "error" && done && !CONFIG_WARNING.test(String(it.message))) emit({ type: "console_error", text: String(it.message ?? "error") });
        break;
      }
      case "turn.completed":
        finish();
        break;
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

export const codex: Provider = {
  id: "codex",
  label: "Codex",
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
  models: () => ["default", ...(process.env.AGENT_CONSOLE_CODEX_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean)],
  defaultModel: () => "default",
  status: () => (loggedIn() ? { ok: true } : { ok: false, hint: "Run `codex login --device-auth` in a terminal." }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    let session = t.sessionId;
    let p: ReturnType<typeof spawnLines> | undefined;
    let dead = false;
    const translate = codexTranslator((ev) => {
      if (ev.type === "system" && ev.subtype === "init") session = ev.session_id;
      ctx.event(ev);
    });
    return {
      get alive() {
        return !dead;
      },
      send(text) {
        const args = ["exec", "--json", "--skip-git-repo-check", "-C", t.cwd];
        if (t.model !== "default") args.push("-m", t.model);
        if (t.mode === "bypassPermissions") args.push("--dangerously-bypass-approvals-and-sandbox");
        else args.push("-c", `sandbox_mode="${t.mode === "plan" ? "read-only" : "workspace-write"}"`, "-c", 'approval_policy="never"');
        if (session) args.push("resume", session);
        args.push("-"); // prompt from stdin
        // one process per turn: an exit only matters if it is the latest process (a previous turn's exit can land after the next send)
        const proc = spawnLines("codex", "codex", args, { cwd: t.cwd, env: childEnv() }, { ...ctx, exited: (i) => { if (p !== proc) return; dead = true; ctx.exited(i); } }, (line) => {
          const r = parseJson(line);
          if (r) translate(r);
        });
        p = proc;
        proc.proc.stdin!.end(text);
      },
      abort: () => p?.abort(),
      kill: () => p?.kill(),
    };
  },
};
