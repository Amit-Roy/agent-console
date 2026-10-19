import type { ClaudeAccount } from "./claude-accounts.ts";

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
  claudeAccount?: ClaudeAccount;
  sessionId?: string;
  forkFrom?: string; // a forked thread's first run continues a copy of this session instead of starting fresh (adapters that can)
}

export type Settings = Pick<ThreadSpec, "mode" | "model" | "effort" | "advisor">;

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

// Elicitation: the agent asks the user something mid-turn (Claude's AskUserQuestion, Codex request_user_input / MCP elicitation,
// Pi extension dialogs). Adapters emit the canonical event {type:"question", id, questions} and wait for Agent.answer.
// An adapter that learns the request went away (the harness cancelled it) emits {type:"question_answer", id, cancelled:true}.
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  id: string; // unique within the request; keys the answer map
  header?: string; // short chip text
  question: string;
  options: QuestionOption[]; // may be empty: free text only
  multiSelect?: boolean;
  allowOther?: boolean; // free-text answer allowed besides the options
  secret?: boolean; // mask the free-text field
}
// answers: question id -> chosen labels and/or free text. `skip` declines the whole request. `note` is a chat message the user
// typed instead of using the card; adapters that can hand it to the agent as the answer do so.
export interface QuestionReply {
  answers: Record<string, string[]>;
  skip?: boolean;
  note?: string;
}

export function cleanQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((q: any, i) => ({
    id: String(q?.id ?? i),
    ...(q?.header ? { header: String(q.header).slice(0, 40) } : {}),
    question: String(q?.question ?? "").slice(0, 2000),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 20).map((o: any) => ({ label: String(o?.label ?? o).slice(0, 200), ...(o?.description ? { description: String(o.description).slice(0, 500) } : {}) })),
    ...(q?.multiSelect ? { multiSelect: true } : {}),
    ...(q?.allowOther ? { allowOther: true } : {}),
    ...(q?.secret ? { secret: true } : {}),
  }));
}

export interface Agent {
  readonly alive: boolean;
  send(text: string, images?: Attachment[]): void;
  // Deliver a message to a turn that is already running; the agent picks it up at its next opportunity (after the current tool call).
  // Absent when the harness cannot take input mid-turn: the manager then queues the message until the turn ends.
  steer?(text: string, images?: Attachment[]): void | Promise<void>;
  compact?(instructions?: string): void;
  // Reply to a pending question (id from the "question" event). Returns true when a `note` reached the agent as the answer itself;
  // false means the caller must still deliver the note as an ordinary message. Throws when the question is no longer pending.
  answer?(id: string, reply: QuestionReply): boolean;
  abort(): void; // stop the current turn; the manager discards this agent and starts a fresh one on the next send
  // Stop the current turn but keep the process for the next message. The harness ends the turn with a `result` event.
  interrupt?(): void;
  // Apply new thread settings to the idle process. false: unsupported, so the manager restarts it with new flags.
  configure?(from: Settings, to: Settings): boolean;
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
