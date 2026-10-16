import { headroom } from "../headroom.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { threadDir } from "../uploads.ts";
import { clip, type Agent, type AgentCtx, type Attachment, type Command, type Provider, type ThreadSpec } from "./types.ts";
import { parseJson, spawnLines } from "./proc.ts";

// never let the subscription login be silently replaced by metered API billing
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"];

// Lean context: every connected MCP server adds its tool names and usage instructions to every turn (about 4k tokens for the claude.ai
// connectors plus project servers). Threads load only the servers named in AGENT_CONSOLE_MCP (default "codegraph", from ~/.claude.json);
// AGENT_CONSOLE_MCP=all restores everything.
export function leanMcpArgs(): string[] {
  const keep = (process.env.AGENT_CONSOLE_MCP ?? "codegraph").split(",").map((x) => x.trim()).filter(Boolean);
  if (keep.includes("all")) return [];
  let servers: Record<string, unknown> = {};
  try {
    const all = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")).mcpServers ?? {};
    servers = Object.fromEntries(keep.filter((k) => all[k]).map((k) => [k, all[k]]));
  } catch {}
  return ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: servers })];
}

export function normalizeCommands(raw: any[]): Command[] {
  return (raw ?? []).map(c => typeof c === "string" ? { name: c } : c)
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({ name: c.name.replace(/^\/+/, ""), description: String(c.description ?? "").slice(0, 200), argumentHint: c.argumentHint || undefined }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const claude: Provider = {
  id: "claude",
  label: "Claude Code",
  modes: ["plan", "acceptEdits", "bypassPermissions"],
  defaultMode: "acceptEdits",
  advisors: ["opus", "fable"],
  steer: true,
  models: () => ["sonnet", "opus", "haiku"],
  defaultModel: () => "sonnet",
  modelDetails: () => Object.fromEntries(["sonnet", "opus", "haiku"].map(id => [id, { label: id[0].toUpperCase() + id.slice(1), efforts: id === "haiku" ? [] : ["low", "medium", "high", "xhigh", "max", "ultracode"] }])),
  status: () => ({ ok: true }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", t.mode,
      "--add-dir", threadDir(t.id), // attachments live outside the project; without this plan/accept-edits could not read them
      "--model", t.model,
    ];
    if (t.effort && t.effort !== "default") args.push("--effort", t.effort);
    if (t.advisor && t.advisor !== "default") args.push("--advisor", t.advisor); // otherwise the advisorModel in settings.json applies
    args.push(...leanMcpArgs());
    fs.mkdirSync(threadDir(t.id), { recursive: true, mode: 0o700 });
    if (t.sessionId) args.push("--resume", t.sessionId);
    else if (t.forkFrom) args.push("--resume", t.forkFrom, "--fork-session"); // a forked thread: continue a copy of the parent session
    const env = { ...process.env };
    for (const k of SCRUBBED_ENV) delete env[k];
    const proxy = headroom.url();
    if (proxy && !env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = proxy; // compress context via Headroom while it is up
    const p = spawnLines("claude", "claude", args, { cwd: t.cwd, env }, ctx, (line) => {
      const ev = parseJson(line);
      if (!ev) return;
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
    return {
      get alive() {
        return p.alive();
      },
      send: (text, images = []) => write(text, images),
      compact: (instructions = "") => write(`/compact${instructions ? " " + instructions : ""}`, []),
      // Claude takes a user message mid-turn on stdin and folds it in after the running tool call (verified: it dropped the
      // remaining commands and answered the new message within the same turn).
      steer: (text, images = []) => write(text, images),
      abort: () => p.abort(),
      kill: () => p.kill(),
    };
  },
};
