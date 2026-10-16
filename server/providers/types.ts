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
  effort?: string;
  advisor?: string;
  sessionId?: string;
  forkFrom?: string; // a forked thread's first run continues a copy of this session instead of starting fresh (adapters that can)
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

// A file the user attached to a message, already validated and stored by uploads.ts. Adapters only ever see the images
// (kind "image", for vision input); other files reach the agent as absolute paths listed in the prompt text.
export interface Attachment {
  id: string;
  name: string;
  path: string;
  kind: "image" | "file";
  media_type: string;
  size: number;
  n?: number; // images only: the "[Image #n]" label the user can refer to in the message
}

export const IMAGE_ONLY_PROMPT = "See the attached image(s).";

export interface Agent {
  readonly alive: boolean;
  send(text: string, images?: Attachment[]): void;
  // Deliver a message to a turn that is already running; the agent picks it up at its next opportunity (after the current tool call).
  // Absent when the harness cannot take input mid-turn: the manager then queues the message until the turn ends.
  steer?(text: string, images?: Attachment[]): void | Promise<void>;
  compact?(instructions?: string): void;
  abort(): void; // stop the current turn; the manager discards this agent and starts a fresh one on the next send
  kill(): void;
}

export interface Provider {
  id: string;
  label: string;
  modes: Mode[];
  defaultMode: Mode;
  note?: string; // shown under the agent picker
  advisors?: string[]; // second-opinion models the harness can consult (Claude's advisor tool)
  steer?: boolean; // the harness accepts messages mid-turn (Agent.steer)
  models(): string[];
  modelDetails?(): Record<string, { label: string; description?: string; efforts: string[]; defaultEffort?: string }>;
  defaultModel(): string;
  // Cheap, synchronous readiness check shown in the UI. Never touches the network.
  status(): { ok: boolean; hint?: string };
  start(t: ThreadSpec, ctx: AgentCtx): Agent;
}

export const MAX_RESULT_CHARS = 20_000;
export const clip = (s: string, n = MAX_RESULT_CHARS) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters truncated)` : s);
