// A provider is a coding-agent harness (claude, pi, codex, ...) that we drive as a child process and translate into one
// canonical event stream. The canonical shape is Claude Code's stream-json (system/init, stream_event, assistant, user
// tool_result, result), because that is what the UI renders. Adapters for other harnesses emit that shape.

export type Mode = "plan" | "acceptEdits" | "bypassPermissions";
export const ALL_MODES: Mode[] = ["plan", "acceptEdits", "bypassPermissions"];

export interface Command {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface ThreadSpec {
  id: string;
  cwd: string;
  mode: Mode;
  model: string;
  sessionId?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  stderr: string;
  aborted: boolean;
}

// What the thread manager gives an adapter. Everything an adapter reports goes through here.
export interface AgentCtx {
  event(ev: any): void; // canonical event; `result` ends the turn, `system/init` carries session_id
  commands(list: Command[]): void;
  exited(info: ExitInfo): void;
}

export interface Agent {
  readonly alive: boolean;
  send(text: string): void;
  abort(): void; // stop the current turn; the manager discards this agent and starts a fresh one on the next send
  kill(): void;
}

export interface Provider {
  id: string;
  label: string;
  modes: Mode[];
  defaultMode: Mode;
  models(): string[];
  defaultModel(): string;
  // Cheap, synchronous readiness check shown in the UI. Never touches the network.
  status(): { ok: boolean; hint?: string };
  start(t: ThreadSpec, ctx: AgentCtx): Agent;
}

export const MAX_RESULT_CHARS = 20_000;
export const clip = (s: string, n = MAX_RESULT_CHARS) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters truncated)` : s);
