import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch as sandboxLaunch } from "../automation/sandbox.ts";
import { headroom } from "../headroom.ts";
import { toolEnvFile } from "../tool-priority.ts";
import { threadDir } from "../uploads.ts";
import { personaFor, personaPath, stylePreamble } from "./brain.ts";
import { claudeConfigDir, requireClaudeAccount } from "./claude-accounts.ts";
import { consoleMcpServer } from "./console-mcp.mjs";
import { parseJson, spawnLines } from "./proc.ts";
import {
  type Agent,
  type AgentCtx,
  type Attachment,
  type Command,
  cleanQuestions,
  clip,
  type Provider,
  type QuestionReply,
  type Settings,
  type ThreadSpec,
} from "./types.ts";

// never let the subscription login be silently replaced by metered API billing
const SCRUBBED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDECODE",
];

// Lean context: every connected MCP server adds its tool names and usage instructions to every turn (about 4k tokens for the claude.ai
// connectors plus project servers). Threads load only the servers named in AGENT_CONSOLE_MCP (comma list from ~/.claude.json, default none:
// agents use the codegraph CLI, so no per-thread MCP server stays alive); AGENT_CONSOLE_MCP=all restores everything.
export function leanMcpArgs(): string[] {
  const keep = (process.env.AGENT_CONSOLE_MCP ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const consoleServer = consoleMcpServer();
  let servers: Record<string, unknown> = {};
  try {
    const all =
      JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")).mcpServers ?? {};
    servers = keep.includes("all")
      ? { ...all }
      : Object.fromEntries(keep.filter((k) => all[k]).map((k) => [k, all[k]]));
  } catch {}
  if (consoleServer) servers.agent_console = consoleServer;
  // always strict: a thread's tools array must not depend on account-level or project-level MCP config
  return ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: servers })];
}

export function normalizeCommands(raw: any[]): Command[] {
  return (raw ?? [])
    .map((c) => (typeof c === "string" ? { name: c } : c))
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({
      name: c.name.replace(/^\/+/, ""),
      description: String(c.description ?? "").slice(0, 200),
      argumentHint: c.argumentHint || undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The SDK control protocol (`--permission-prompt-tool stdio`): the CLI asks its host before any tool that needs the user, as
//   {"type":"control_request","request_id":R,"request":{"subtype":"can_use_tool","tool_name":T,"input":{...},"tool_use_id":U}}
// and blocks until {"type":"control_response","response":{"subtype":"success","request_id":R,"response":{"behavior":"allow"|"deny",...}}}.
// Without a host, headless Claude drops AskUserQuestion from its tools altogether. AskUserQuestion becomes a question card; its
// answer goes back as updatedInput.answers {question text: "label, label"} (verified on CLI 2.1.301: the tool result reads
// `"Which color?"="Green"`). Every other prompt is denied, exactly as without a host, so the permission mode still decides.
interface PendingControl {
  input: any;
  questions: ReturnType<typeof cleanQuestions>;
}

interface ControlContext {
  pending: Map<string, PendingControl>;
  write: (msg: object) => void;
  emit: (event: any) => void;
  mode: string;
}

const AUTO_ALLOWED_TOOLS = [
  "mcp__agent_console__session_search",
  "mcp__agent_console__session_read",
  "mcp__agent_console__pi_research",
  "mcp__agent_console__cli_search",
  "mcp__agent_console__thread_list",
  "mcp__agent_console__thread_send",
];

function respondControl(ctx: ControlContext, requestId: string, response: object) {
  ctx.write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

function askControlQuestions(ctx: ControlContext, event: any, req: any) {
  const questions = cleanQuestions(
    req.input.questions.map((question: any, idx: number) => ({
      ...question,
      id: String(idx),
      allowOther: true,
    })),
  );
  if (!questions.length) {
    respondControl(ctx, event.request_id, {
      behavior: "deny",
      message: "No questions were provided. Continue with your best judgment.",
    });
    return;
  }
  ctx.pending.set(event.request_id, { input: req.input, questions });
  ctx.emit({
    type: "question",
    id: event.request_id,
    tool_use_id: req.tool_use_id,
    questions,
    ts: Date.now(),
  });
}

function handleControlRequest(ctx: ControlContext, event: any) {
  const req = event.request ?? {};
  if (req.subtype !== "can_use_tool") {
    ctx.write({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: event.request_id,
        error: `Unsupported control request: ${req.subtype}`,
      },
    });
    return;
  }
  // Console tools are authenticated by the bridge; thread sends also require a live root tool call.
  // Allow only these exact names in Plan/acceptEdits; all other permission prompts retain their policy.
  const redactionAction = req.input?.action ?? "scan";
  const redactionAllowed =
    req.tool_name === "mcp__agent_console__session_redact" &&
    (["scan", "verify", "status"].includes(redactionAction) ||
      (redactionAction === "apply" && ctx.mode === "bypassPermissions"));
  if (AUTO_ALLOWED_TOOLS.includes(req.tool_name) || redactionAllowed) {
    respondControl(ctx, event.request_id, { behavior: "allow", updatedInput: req.input ?? {} });
    return;
  }
  if (req.tool_name === "AskUserQuestion" && Array.isArray(req.input?.questions)) {
    askControlQuestions(ctx, event, req);
    return;
  }
  respondControl(ctx, event.request_id, {
    behavior: "deny",
    message: `Permission for ${req.tool_name} was not granted: this console does not approve tool prompts in ${ctx.mode} mode. Continue without it or ask the user to switch the thread to Bypass.`,
  });
}

function handleControlMessage(ctx: ControlContext, event: any): boolean {
  if (event?.type === "control_cancel_request") {
    if (ctx.pending.delete(event.request_id))
      ctx.emit({ type: "question_answer", id: event.request_id, cancelled: true });
    return true;
  }
  if (event?.type === "control_response") return true; // replies to host requests; we send none
  if (event?.type !== "control_request") return false;
  handleControlRequest(ctx, event);
  return true;
}

function answerControl(ctx: ControlContext, questionId: string, reply: QuestionReply): boolean {
  const entry = ctx.pending.get(questionId);
  if (!entry) throw new Error("This question is no longer waiting for an answer.");
  if (reply.skip || reply.note !== undefined) {
    const message =
      reply.note !== undefined
        ? `The user did not pick an option and replied in chat instead: ${reply.note}`
        : "The user skipped these questions without answering. Continue with your best judgment and do not ask the same questions again.";
    respondControl(ctx, questionId, { behavior: "deny", message });
    ctx.pending.delete(questionId);
    return reply.note !== undefined;
  }
  const answers: Record<string, string> = {};
  entry.questions.forEach((question, idx) => {
    const picked = (reply.answers[question.id] ?? [])
      .map((part) => String(part).trim())
      .filter(Boolean);
    if (picked.length)
      answers[String(entry.input.questions[idx]?.question ?? question.question)] =
        picked.join(", ");
  });
  respondControl(ctx, questionId, { behavior: "allow", updatedInput: { ...entry.input, answers } });
  ctx.pending.delete(questionId);
  return false;
}

// The SDK control protocol (`--permission-prompt-tool stdio`): the CLI asks its host before any tool that needs the user, as
//   {"type":"control_request","request_id":R,"request":{"subtype":"can_use_tool","tool_name":T,"input":{...},"tool_use_id":U}}
// and blocks until {"type":"control_response","response":{"subtype":"success","request_id":R,"response":{"behavior":"allow"|"deny",...}}}.
// Without a host, headless Claude drops AskUserQuestion from its tools altogether. AskUserQuestion becomes a question card; its
// answer goes back as updatedInput.answers {question text: "label, label"} (verified on CLI 2.1.301: the tool result reads
// `"Which color?"="Green"`). Every other prompt is denied, exactly as without a host, so the permission mode still decides.
export function claudeControl(
  write: (msg: object) => void,
  emit: (event: any) => void,
  mode: string,
) {
  const ctx: ControlContext = { pending: new Map(), write, emit, mode };
  return {
    pending: ctx.pending,
    cancelAll() {
      for (const questionId of ctx.pending.keys())
        emit({ type: "question_answer", id: questionId, cancelled: true });
      ctx.pending.clear();
    },
    // true when the line was a control message (never shown or logged)
    handle(event: any): boolean {
      return handleControlMessage(ctx, event);
    },
    answer(questionId: string, reply: QuestionReply): boolean {
      return answerControl(ctx, questionId, reply);
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
  if (routed.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") === headroom.state().url)
    delete routed.ANTHROPIC_BASE_URL;
  const proxy = headroom.url();
  if (proxy && !routed.ANTHROPIC_BASE_URL) routed.ANTHROPIC_BASE_URL = proxy;
  return routed;
}

interface ClaudeRun {
  proc: ReturnType<typeof spawnLines> | undefined;
  requests: number;
}

export function claudeStartArgs(thread: ThreadSpec): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    thread.mode,
    "--permission-prompt-tool",
    "stdio", // host answers prompts over stdin/stdout: enables AskUserQuestion (see claudeControl)
    "--add-dir",
    threadDir(thread.id), // attachments live outside the project; without this plan/accept-edits could not read them
    "--model",
    thread.model,
  ];
  if (thread.effort && thread.effort !== "default") args.push("--effort", thread.effort);
  args.push(...claudeConsoleSettingsArgs(thread.advisor));
  args.push(...leanMcpArgs());
  const persona = personaFor(thread);
  if (fs.existsSync(personaPath(persona))) args.push("--agent", persona); // replaces the default system prompt; the persona carries the role rules
  const style = stylePreamble();
  if (style) args.push("--append-system-prompt", style); // brain index arrives via the user hook
  fs.mkdirSync(threadDir(thread.id), { recursive: true, mode: 0o700 });
  if (thread.sessionId) args.push("--resume", thread.sessionId);
  else if (thread.forkFrom) args.push("--resume", thread.forkFrom, "--fork-session"); // a forked thread: continue a copy of the parent session
  return args;
}

function claudeStartEnv(thread: ThreadSpec, account: ReturnType<typeof requireClaudeAccount>) {
  const env = claudeRoutingEnv(process.env);
  env.AGENT_CONSOLE_THREAD = thread.id;
  env.ENABLE_TOOL_SEARCH = "false"; // deferred tool loading changes the tools array mid-thread and busts the prompt cache
  const toolEnv = toolEnvFile();
  if (toolEnv && !env.CLAUDE_ENV_FILE) env.CLAUDE_ENV_FILE = toolEnv; // Bash commands start at the lower tool priority
  if (account === "nefro") env.CLAUDE_CONFIG_DIR = claudeConfigDir(account);
  for (const name of SCRUBBED_ENV) delete env[name];
  return env;
}

function clipToolResults(event: any) {
  delete event.tool_use_result; // duplicate of message.content, can be huge
  for (const block of event.message?.content ?? []) {
    if (block?.type === "tool_result" && typeof block.content === "string")
      block.content = clip(block.content);
  }
}

// How full the context is: the last main-thread request's whole input (cached + new) plus what it produced. Subagents have their own.
function emitContextUsage(ctx: AgentCtx, event: any) {
  const usage = event.message?.usage;
  const used =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.output_tokens ?? 0);
  if (used > 0) ctx.event({ type: "context_usage", used });
}

function emitContextWindow(ctx: AgentCtx, event: any, model: string) {
  const wins = Object.entries<any>(event.modelUsage);
  const mine = wins.find(([name]) => name.includes(model)) ?? wins[0];
  if (mine?.[1]?.contextWindow) ctx.event({ type: "context_usage", max: mine[1].contextWindow });
}

function handleClaudeLine(
  thread: ThreadSpec,
  ctx: AgentCtx,
  control: ReturnType<typeof claudeControl>,
  line: string,
) {
  const event = parseJson(line);
  if (!event) return;
  if (control.handle(event)) return;
  if (event.type === "result") control.cancelAll();
  if (event.type === "user") clipToolResults(event);
  if (event.type === "system" && event.subtype === "init" && Array.isArray(event.slash_commands))
    ctx.commands(normalizeCommands(event.slash_commands));
  if (event.type === "system" && event.subtype === "commands_changed")
    return ctx.commands(normalizeCommands(event.commands));
  if (event.type === "assistant" && !event.parent_tool_use_id) emitContextUsage(ctx, event);
  if (event.type === "result" && event.modelUsage) emitContextWindow(ctx, event, thread.model);
  ctx.event(event);
}

// plain string when there is nothing to attach; otherwise the Messages API block form
function writeClaudeUser(proc: NonNullable<ClaudeRun["proc"]>, text: string, images: Attachment[]) {
  const content = images.length
    ? [
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.media_type,
            data: fs.readFileSync(image.path).toString("base64"),
          },
        })),
        ...(text.trim() ? [{ type: "text", text }] : []),
      ]
    : text;
  proc.write(JSON.stringify({ type: "user", message: { role: "user", content } }));
}

function claudeEffortLevel(effort?: string) {
  return !!effort && effort !== "default" && effort !== "ultracode"; // default/ultracode change flags, not a level
}

function configureClaude(run: ClaudeRun, from: Settings, target: Settings): boolean {
  // the CLI refuses to enter bypassPermissions unless launched in it ("bypass_not_launched"): restart for that
  if (target.mode === "bypassPermissions" && from.mode !== target.mode) return false;
  if (
    from.advisor !== target.advisor ||
    (from.effort !== target.effort &&
      !(claudeEffortLevel(from.effort) && claudeEffortLevel(target.effort)))
  )
    return false;
  const ask = (request: object) =>
    run.proc!.write(
      JSON.stringify({
        type: "control_request",
        request_id: `cfg-${++run.requests}`,
        request,
      }),
    );
  if (from.model !== target.model) ask({ subtype: "set_model", model: target.model });
  if (from.mode !== target.mode) ask({ subtype: "set_permission_mode", mode: target.mode });
  if (from.effort !== target.effort)
    ask({ subtype: "apply_flag_settings", settings: { effortLevel: target.effort } });
  return true;
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
  modelDetails: () =>
    Object.fromEntries(
      ["sonnet", "opus", "haiku"].map((id) => [
        id,
        {
          label: id[0].toUpperCase() + id.slice(1),
          efforts: id === "haiku" ? [] : ["low", "medium", "high", "xhigh", "max", "ultracode"],
        },
      ]),
    ),
  status: () => ({ ok: true }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    const account = requireClaudeAccount(t.claudeAccount);
    const args = claudeStartArgs(t);
    const env = claudeStartEnv(t, account);
    const run: ClaudeRun = { proc: undefined, requests: 0 };
    const control = claudeControl((msg) => run.proc!.write(JSON.stringify(msg)), ctx.event, t.mode);
    const launch = sandboxLaunch(t, "claude", args, env);
    const proc = spawnLines(
      "claude",
      launch.command,
      launch.args,
      { cwd: t.cwd, env: launch.env },
      {
        ...ctx,
        exited(info) {
          control.cancelAll();
          ctx.exited(info);
        },
      },
      (line) => handleClaudeLine(t, ctx, control, line),
    );
    run.proc = proc;
    return {
      get alive() {
        return proc.alive();
      },
      send: (text, images = []) => writeClaudeUser(proc, text, images),
      compact: (instructions = "") =>
        writeClaudeUser(proc, `/compact${instructions ? " " + instructions : ""}`, []),
      // Claude takes a user message mid-turn on stdin and folds it in after the running tool call (verified: it dropped the
      // remaining commands and answered the new message within the same turn).
      steer: (text, images = []) => writeClaudeUser(proc, text, images),
      answer: (id, reply) => control.answer(id, reply),
      // Verified on CLI 2.1.302: `interrupt` ends the turn with a zero-usage error result and the process stays up;
      // set_model, set_permission_mode (except into bypass) and apply_flag_settings {effortLevel} change the next request, no model call.
      interrupt: () => {
        control.cancelAll();
        proc.write(
          JSON.stringify({
            type: "control_request",
            request_id: `int-${++run.requests}`,
            request: { subtype: "interrupt" },
          }),
        );
      },
      configure: (from, target) => configureClaude(run, from, target),
      abort: () => {
        control.cancelAll();
        proc.abort();
      },
      kill: () => {
        control.cancelAll();
        proc.kill();
      },
    };
  },
};
