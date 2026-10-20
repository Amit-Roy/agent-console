import { launch as sandboxLaunch } from "../automation/sandbox.ts";
import { claudeConfigDir, requireClaudeAccount } from "./claude-accounts.ts";
import { headroom } from "../headroom.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { threadDir } from "../uploads.ts";
import { cleanQuestions, clip, type Agent, type AgentCtx, type Attachment, type Command, type Provider, type QuestionReply, type ThreadSpec } from "./types.ts";
import { parseJson, spawnLines } from "./proc.ts";
import { stylePreamble } from "./brain.ts";
import { toolEnvFile } from "../tool-priority.ts";
import { consoleMcpServer, SESSION_INSTRUCTIONS } from "./console-mcp.mjs";

// never let the subscription login be silently replaced by metered API billing
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE"];

// Lean context: every connected MCP server adds its tool names and usage instructions to every turn (about 4k tokens for the claude.ai
// connectors plus project servers). Threads load only the servers named in AGENT_CONSOLE_MCP (default "codegraph", from ~/.claude.json);
// AGENT_CONSOLE_MCP=all restores everything.
export function leanMcpArgs(): string[] {
  const keep = (process.env.AGENT_CONSOLE_MCP ?? "codegraph").split(",").map((x) => x.trim()).filter(Boolean);
  const consoleServer = consoleMcpServer();
  if (keep.includes("all")) return consoleServer ? ["--mcp-config", JSON.stringify({ mcpServers: { agent_console: consoleServer } })] : [];
  let servers: Record<string, unknown> = {};
  try {
    const all = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")).mcpServers ?? {};
    servers = Object.fromEntries(keep.filter((k) => all[k]).map((k) => [k, all[k]]));
  } catch {}
  if (consoleServer) servers.agent_console = consoleServer;
  return ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: servers })];
}

export function normalizeCommands(raw: any[]): Command[] {
  return (raw ?? []).map(c => typeof c === "string" ? { name: c } : c)
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({ name: c.name.replace(/^\/+/, ""), description: String(c.description ?? "").slice(0, 200), argumentHint: c.argumentHint || undefined }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The SDK control protocol (`--permission-prompt-tool stdio`): the CLI asks its host before any tool that needs the user, as
//   {"type":"control_request","request_id":R,"request":{"subtype":"can_use_tool","tool_name":T,"input":{...},"tool_use_id":U}}
// and blocks until {"type":"control_response","response":{"subtype":"success","request_id":R,"response":{"behavior":"allow"|"deny",...}}}.
// Without a host, headless Claude drops AskUserQuestion from its tools altogether. AskUserQuestion becomes a question card; its
// answer goes back as updatedInput.answers {question text: "label, label"} (verified on CLI 2.1.301: the tool result reads
// `"Which color?"="Green"`). Every other prompt is denied, exactly as without a host, so the permission mode still decides.
export function claudeControl(write: (msg: object) => void, emit: (ev: any) => void, mode: string) {
  const pending = new Map<string, { input: any; questions: ReturnType<typeof cleanQuestions> }>();
  const respond = (request_id: string, response: object) => write({ type: "control_response", response: { subtype: "success", request_id, response } });
  return {
    pending,
    cancelAll() {
      for (const id of pending.keys()) emit({ type: "question_answer", id, cancelled: true });
      pending.clear();
    },
    // true when the line was a control message (never shown or logged)
    handle(ev: any): boolean {
      if (ev?.type === "control_cancel_request") {
        if (pending.delete(ev.request_id)) emit({ type: "question_answer", id: ev.request_id, cancelled: true });
        return true;
      }
      if (ev?.type === "control_response") return true; // replies to host requests; we send none
      if (ev?.type !== "control_request") return false;
      const r = ev.request ?? {};
      if (r.subtype !== "can_use_tool") {
        write({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: `Unsupported control request: ${r.subtype}` } });
        return true;
      }
      // Session history tools are read-only and authenticated by the Console bridge.
      // Allow only these exact names in Plan/acceptEdits; all other permission prompts retain their policy.
      if (["mcp__agent_console__session_search", "mcp__agent_console__session_read"].includes(r.tool_name)) {
        respond(ev.request_id, { behavior: "allow", updatedInput: r.input ?? {} });
        return true;
      }
      if (r.tool_name === "AskUserQuestion" && Array.isArray(r.input?.questions)) {
        const questions = cleanQuestions(r.input.questions.map((q: any, i: number) => ({ ...q, id: String(i), allowOther: true })));
        if (!questions.length) {
          respond(ev.request_id, { behavior: "deny", message: "No questions were provided. Continue with your best judgment." });
          return true;
        }
        pending.set(ev.request_id, { input: r.input, questions });
        emit({ type: "question", id: ev.request_id, tool_use_id: r.tool_use_id, questions, ts: Date.now() });
        return true;
      }
      respond(ev.request_id, { behavior: "deny", message: `Permission for ${r.tool_name} was not granted: this console does not approve tool prompts in ${mode} mode. Continue without it or ask the user to switch the thread to Bypass.` });
      return true;
    },
    answer(id: string, reply: QuestionReply): boolean {
      const p = pending.get(id);
      if (!p) throw new Error("This question is no longer waiting for an answer.");
      if (reply.skip || reply.note !== undefined) {
        const message = reply.note !== undefined
          ? `The user did not pick an option and replied in chat instead: ${reply.note}`
          : "The user skipped these questions without answering. Continue with your best judgment and do not ask the same questions again.";
        respond(id, { behavior: "deny", message });
        pending.delete(id);
        return reply.note !== undefined;
      }
      const answers: Record<string, string> = {};
      p.questions.forEach((q, i) => {
        const a = (reply.answers[q.id] ?? []).map((x) => String(x).trim()).filter(Boolean);
        if (a.length) answers[String(p.input.questions[i]?.question ?? q.question)] = a.join(", ");
      });
      respond(id, { behavior: "allow", updatedInput: { ...p.input, answers } });
      pending.delete(id);
      return false;
    },
  };
}

// Empty string disables the advisor in the installed CLI settings schema; omitted inherits user/project settings.
export function claudeAdvisorArgs(advisor?: string): string[] {
  if (advisor === "off") return ["--settings", JSON.stringify({ advisorModel: "" })];
  return advisor && advisor !== "default" ? ["--advisor", advisor] : [];
}

// Console schedules idle compaction itself. Keep the CLI's independent idle timer off,
// including when a thread opts out, while preserving native context-limit compaction.
export function claudeConsoleSettingsArgs(advisor?: string): string[] {
  const args = claudeAdvisorArgs(advisor);
  if (args[0] === "--settings") {
    return ["--settings", JSON.stringify({ ...JSON.parse(args[1]), idleCompaction: false })];
  }
  return ["--settings", JSON.stringify({ idleCompaction: false }), ...args];
}

// A nested console can inherit its parent's local proxy URL. Never keep that
// managed URL when this console has disabled the proxy or cannot reach it.
export function claudeRoutingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const routed = { ...env };
  if (routed.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") === headroom.state().url) delete routed.ANTHROPIC_BASE_URL;
  const proxy = headroom.url();
  if (proxy && !routed.ANTHROPIC_BASE_URL) routed.ANTHROPIC_BASE_URL = proxy;
  return routed;
}

export const claude: Provider = {
  id: "claude",
  label: "Claude Code",
  modes: ["plan", "acceptEdits", "bypassPermissions"],
  defaultMode: "acceptEdits",
  advisors: ["off", "opus", "fable"],
  steer: true,
  models: () => ["sonnet", "opus", "haiku"],
  defaultModel: () => "sonnet",
  modelDetails: () => Object.fromEntries(["sonnet", "opus", "haiku"].map(id => [id, { label: id[0].toUpperCase() + id.slice(1), efforts: id === "haiku" ? [] : ["low", "medium", "high", "xhigh", "max", "ultracode"] }])),
  status: () => ({ ok: true }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    const account = requireClaudeAccount(t.claudeAccount);
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", t.mode,
      "--permission-prompt-tool", "stdio", // host answers prompts over stdin/stdout: enables AskUserQuestion (see claudeControl)
      "--add-dir", threadDir(t.id), // attachments live outside the project; without this plan/accept-edits could not read them
      "--model", t.model,
    ];
    if (t.effort && t.effort !== "default") args.push("--effort", t.effort);
    args.push(...claudeConsoleSettingsArgs(t.advisor));
    args.push(...leanMcpArgs());
    const style = [stylePreamble(), SESSION_INSTRUCTIONS].filter(Boolean).join("\n\n");
    if (style) args.push("--append-system-prompt", style); // brain index arrives via the user hook
    fs.mkdirSync(threadDir(t.id), { recursive: true, mode: 0o700 });
    if (t.sessionId) args.push("--resume", t.sessionId);
    else if (t.forkFrom) args.push("--resume", t.forkFrom, "--fork-session"); // a forked thread: continue a copy of the parent session
    const env = claudeRoutingEnv(process.env);
    env.AGENT_CONSOLE_THREAD = t.id;
    const toolEnv = toolEnvFile();
    if (toolEnv && !env.CLAUDE_ENV_FILE) env.CLAUDE_ENV_FILE = toolEnv; // Bash commands start at the lower tool priority
    if (account === "nefro") env.CLAUDE_CONFIG_DIR = claudeConfigDir(account);
    for (const k of SCRUBBED_ENV) delete env[k];
    const control = claudeControl((msg) => p.write(JSON.stringify(msg)), ctx.event, t.mode);
    const launch = sandboxLaunch(t, "claude", args, env);
    const p = spawnLines("claude", launch.command, launch.args, { cwd: t.cwd, env: launch.env }, {
      ...ctx,
      exited(info) { control.cancelAll(); ctx.exited(info); },
    }, (line) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (control.handle(ev)) return;
      if (ev.type === "result") control.cancelAll();
      if (ev.type === "user") {
        delete ev.tool_use_result; // duplicate of message.content, can be huge
        for (const c of ev.message?.content ?? []) {
          if (c?.type === "tool_result" && typeof c.content === "string") c.content = clip(c.content);
        }
      }
      if (ev.type === "system" && ev.subtype === "init" && Array.isArray(ev.slash_commands)) ctx.commands(normalizeCommands(ev.slash_commands));
      if (ev.type === "system" && ev.subtype === "commands_changed") return ctx.commands(normalizeCommands(ev.commands));
      // How full the context is: the last main-thread request's whole input (cached + new) plus what it produced. Subagents have their own.
      if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        const u = ev.message?.usage;
        const used = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.output_tokens ?? 0);
        if (used > 0) ctx.event({ type: "context_usage", used });
      }
      if (ev.type === "result" && ev.modelUsage) {
        const wins = Object.entries<any>(ev.modelUsage);
        const mine = wins.find(([k]) => k.includes(t.model)) ?? wins[0];
        if (mine?.[1]?.contextWindow) ctx.event({ type: "context_usage", max: mine[1].contextWindow });
      }
      ctx.event(ev);
    });
    // plain string when there is nothing to attach; otherwise the Messages API block form
    const write = (text: string, images: Attachment[]) => {
      const content = images.length
        ? [
            ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: fs.readFileSync(i.path).toString("base64") } })),
            ...(text.trim() ? [{ type: "text", text }] : []),
          ]
        : text;
      p.write(JSON.stringify({ type: "user", message: { role: "user", content } }));
    };
    let requests = 0;
    return {
      get alive() {
        return p.alive();
      },
      send: (text, images = []) => write(text, images),
      compact: (instructions = "") => write(`/compact${instructions ? " " + instructions : ""}`, []),
      // Claude takes a user message mid-turn on stdin and folds it in after the running tool call (verified: it dropped the
      // remaining commands and answered the new message within the same turn).
      steer: (text, images = []) => write(text, images),
      answer: (id, reply) => control.answer(id, reply),
      // Verified on CLI 2.1.302: `interrupt` ends the turn with a zero-usage error result and the process stays up;
      // set_model, set_permission_mode (except into bypass) and apply_flag_settings {effortLevel} change the next request, no model call.
      interrupt: () => { control.cancelAll(); p.write(JSON.stringify({ type: "control_request", request_id: `int-${++requests}`, request: { subtype: "interrupt" } })); },
      configure: (from, to) => {
        const level = (e?: string) => !!e && e !== "default" && e !== "ultracode"; // default/ultracode change flags, not a level
        // the CLI refuses to enter bypassPermissions unless launched in it ("bypass_not_launched"): restart for that
        if (to.mode === "bypassPermissions" && from.mode !== to.mode) return false;
        if (from.advisor !== to.advisor || (from.effort !== to.effort && !(level(from.effort) && level(to.effort)))) return false;
        const ask = (request: object) => p.write(JSON.stringify({ type: "control_request", request_id: `cfg-${++requests}`, request }));
        if (from.model !== to.model) ask({ subtype: "set_model", model: to.model });
        if (from.mode !== to.mode) ask({ subtype: "set_permission_mode", mode: to.mode });
        if (from.effort !== to.effort) ask({ subtype: "apply_flag_settings", settings: { effortLevel: to.effort } });
        return true;
      },
      abort: () => { control.cancelAll(); p.abort(); },
      kill: () => { control.cancelAll(); p.kill(); },
    };
  },
};
