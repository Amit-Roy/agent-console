// Request and response models for everything the automation dashboard asks for. Callers build a request, get a response.
// Every envelope carries `v`; a reader ignores fields it does not know, so adding a property never breaks a caller.

export const VERSION = 1 as const;

export type StepId = "triage" | "opener" | "usage" | "dispatcher" | "router" | "worktree" | "worker" | "self_review" | "pr" | "review" | "merge" | "apply";
export type StepState = "idle" | "active" | "ok" | "failed" | "abandoned" | "disabled";
export type EventKind = "start" | "ok" | "fail" | "info" | "abandoned";

export interface FlowNode { id: StepId; label: string; icon: string; kind: "trigger" | "source" | "decision" | "action" | "agent" | "gate"; hint: string }
export interface FlowEdge { from: StepId; to: StepId }

/** The workflow, entrypoint first. The UI draws exactly this; adding a stage is adding a node here. */
export const FLOW: { nodes: FlowNode[]; edges: FlowEdge[] } = {
  nodes: [
    { id: "triage", label: "Triage", icon: "tag", kind: "trigger", hint: "GitHub webhook labels each issue with effort and priority" },
    { id: "opener", label: "Window opener", icon: "clock", kind: "trigger", hint: "Starts a 5-hour quota window overnight" },
    { id: "usage", label: "Usage windows", icon: "gauge", kind: "source", hint: "Claude and Codex quota readings" },
    { id: "dispatcher", label: "Dispatcher", icon: "play", kind: "decision", hint: "Picks issues in the last 90 minutes of a window" },
    { id: "router", label: "Router", icon: "route", kind: "decision", hint: "Chooses provider and model from usage and load" },
    { id: "worktree", label: "Worktree + hook", icon: "branch", kind: "action", hint: "Own worktree; pre-push hook blocks the default branch" },
    { id: "worker", label: "Worker", icon: "bot", kind: "agent", hint: "Implements the issue" },
    { id: "self_review", label: "Self-review", icon: "check", kind: "gate", hint: "Worker checks its diff with the coding-standards skill" },
    { id: "pr", label: "Pull request", icon: "pr", kind: "action", hint: "Branch pushed, PR opened" },
    { id: "review", label: "PR review", icon: "eye", kind: "agent", hint: "Claude or Codex reviews Trivial and BAU PRs" },
    { id: "merge", label: "Merge", icon: "merge", kind: "action", hint: "Squash merge when approved" },
    { id: "apply", label: "Apply", icon: "rocket", kind: "action", hint: "agent-console, dotfiles, brain: pull and restart" },
  ],
  edges: [
    { from: "triage", to: "dispatcher" }, { from: "opener", to: "usage" }, { from: "usage", to: "dispatcher" },
    { from: "dispatcher", to: "router" }, { from: "router", to: "worktree" }, { from: "worktree", to: "worker" },
    { from: "worker", to: "self_review" }, { from: "self_review", to: "pr" }, { from: "pr", to: "review" },
    { from: "review", to: "merge" }, { from: "merge", to: "apply" },
  ],
};
export const STEP_IDS = FLOW.nodes.map(n => n.id);

export interface AutomationEvent { seq: number; ts: number; step: StepId; kind: EventKind; run?: string; ref?: string; msg?: string; data?: Record<string, unknown> }

export interface SnapshotRequest { v?: number; limit?: number }
export interface StepView { id: StepId; state: StepState; lastAt?: number; lastMsg?: string; open: number; failures: number }
export interface Trigger { id: string; kind: "webhook" | "timer" | "hook" | "cron" | "manual"; label: string; detail: string; enabled: boolean; lastAt?: number }
export interface HookInfo { worktree: string; path: string; hook: string; protects: string }
export interface RunView { thread: string; key: string; role: string; effort: string; state: string; title: string }
export interface FailureView { ts: number; step: StepId; ref?: string; msg: string }
export interface Snapshot {
  v: typeof VERSION; now: number; flow: typeof FLOW; steps: StepView[]; triggers: Trigger[]; runs: RunView[]; failures: FailureView[]; hooks: HookInfo[];
  config: { dispatch: Record<string, unknown> & { enabled: boolean; dryRun: boolean }; opener: Record<string, unknown> & { enabled: boolean; dryRun: boolean } };
}

export interface StepLogRequest { v?: number; step: StepId; limit?: number; before?: number }
export interface StepLogResponse { v: typeof VERSION; step: StepId; entries: AutomationEvent[]; next?: number }
