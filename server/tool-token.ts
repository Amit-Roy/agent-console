import crypto from "node:crypto";

export type ToolTokenCheck = { ok: boolean; threadId?: string; derived: boolean };

/** Per-thread token for Auto children; useless without the matching thread header. */
export function derivedToolToken(master: string, threadId: string): string {
  return crypto.createHmac("sha256", master).update(threadId).digest("hex");
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

/** The master token is valid for any caller; a derived token only for the thread it was derived for. */
export function checkToolToken(
  master: string,
  token: string,
  threadHeader: string | undefined,
): ToolTokenCheck {
  if (sameText(token, master))
    return { ok: true, threadId: threadHeader || undefined, derived: false };
  if (threadHeader && sameText(token, derivedToolToken(master, threadHeader)))
    return { ok: true, threadId: threadHeader, derived: true };
  return { ok: false, derived: false };
}

const READ_ONLY_TOOLS = [
  "session_search",
  "session_read",
  "cli_search",
  "idea_list",
  "idea_read",
  "schedule_config_list",
  "schedule_get",
  "schedule_runs",
  "schedule_report",
  "schedule_transcript",
];

/** Gate for one agent-tool call. Derived tokens always get issue-run limits, whatever the header says. */
export function gateToolCall(
  master: string,
  token: string,
  threadHeader: string | undefined,
  tool: string,
  threadIsIssueRun: (threadId: string) => boolean,
): { status: 200 | 401 | 400; threadId?: string; error?: string } {
  const auth = checkToolToken(master, token, threadHeader);
  if (!auth.ok) return { status: 401, error: "Not an Agent Console tool call." };
  const restricted = auth.derived || (!!auth.threadId && threadIsIssueRun(auth.threadId));
  if (restricted && !READ_ONLY_TOOLS.includes(tool))
    return {
      status: 400,
      threadId: auth.threadId,
      error: "Unattended issue runs may only use read-only session tools.",
    };
  return { status: 200, threadId: auth.threadId };
}

const SCRUBBED_PREFIXES = ["CODER_", "VSCODE_"];
const SCRUBBED_NAMES = [
  "AGENT_CONSOLE_PASSWORD",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "HUGGING_FACE_TOKEN",
];
const CLAUDE_SCRUBBED_NAMES = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPAEEK_API_KEY",
];

/** Env for an Auto child: derived tool token for its own thread, host credentials and IPC handles removed. */
export function autoChildEnv(
  env: NodeJS.ProcessEnv,
  threadId: string,
  provider: string | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const names =
    provider === "claude" ? [...SCRUBBED_NAMES, ...CLAUDE_SCRUBBED_NAMES] : SCRUBBED_NAMES;
  for (const key of Object.keys(out)) {
    if (names.includes(key) || SCRUBBED_PREFIXES.some((prefix) => key.startsWith(prefix)))
      delete out[key];
  }
  if (env.AGENT_CONSOLE_TOOL_TOKEN)
    out.AGENT_CONSOLE_TOOL_TOKEN = derivedToolToken(env.AGENT_CONSOLE_TOOL_TOKEN, threadId);
  return out;
}
