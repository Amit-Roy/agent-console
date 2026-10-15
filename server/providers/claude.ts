import { clip, type Agent, type AgentCtx, type Command, type Provider, type ThreadSpec } from "./types.ts";
import { parseJson, spawnLines } from "./proc.ts";

// never let the subscription login be silently replaced by metered API billing
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"];

export function normalizeCommands(raw: any[]): Command[] {
  return (raw ?? [])
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({ name: c.name, description: String(c.description ?? "").slice(0, 200), argumentHint: c.argumentHint || undefined }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const claude: Provider = {
  id: "claude",
  label: "Claude Code",
  modes: ["plan", "acceptEdits", "bypassPermissions"],
  defaultMode: "acceptEdits",
  models: () => ["sonnet", "opus", "haiku"],
  defaultModel: () => "sonnet",
  status: () => ({ ok: true }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", t.mode,
      "--model", t.model,
    ];
    if (t.sessionId) args.push("--resume", t.sessionId);
    const env = { ...process.env };
    for (const k of SCRUBBED_ENV) delete env[k];
    const p = spawnLines("claude", "claude", args, { cwd: t.cwd, env }, ctx, (line) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (ev.type === "user") {
        delete ev.tool_use_result; // duplicate of message.content, can be huge
        for (const c of ev.message?.content ?? []) {
          if (c?.type === "tool_result" && typeof c.content === "string") c.content = clip(c.content);
        }
      }
      if (ev.type === "system" && ev.subtype === "commands_changed") return ctx.commands(normalizeCommands(ev.commands));
      ctx.event(ev);
    });
    return {
      get alive() {
        return p.alive();
      },
      send: (text) => p.write(JSON.stringify({ type: "user", message: { role: "user", content: text } })),
      abort: () => p.abort(),
      kill: () => p.kill(),
    };
  },
};
