// Request and response models for everything the automation dashboard asks for. Callers build a request, get a response.
// Every envelope carries `v`; a reader ignores fields it does not know, so adding a property never breaks a caller.

export const VERSION = 1 as const;

export type StepId = "triage" | "opener" | "usage" | "dispatcher" | "router" | "worktree" | "worker" | "self_review" | "pr" | "review" | "redo" | "merge" | "apply";
export type StepState = "idle" | "active" | "ok" | "failed" | "abandoned" | "disabled";
export type EventKind = "start" | "ok" | "fail" | "info" | "abandoned";

export interface FlowNode { id: StepId; label: string; icon: string; kind: "trigger" | "source" | "decision" | "action" | "agent" | "gate"; hint: string }
export interface FlowEdge { from: StepId; to: StepId; label?: string } // label: the condition for taking this edge
/** A workflow the dashboard draws on its own: its phases run left to right, each phase's steps in order.
 *  A phase's loop is a run of its steps that repeats; the dashboard boxes them with the loop's label. */
export interface Pipeline { id: string; label: string; hint: string; phases: { label: string; steps: StepId[]; loop?: { steps: StepId[]; label: string } }[] }

/** The workflows, entrypoint first. The UI draws exactly this; adding a stage is adding a node here and placing it in a pipeline. */
export const FLOW: { nodes: FlowNode[]; edges: FlowEdge[]; pipelines: Pipeline[] } = {
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
    { id: "review", label: "Premium review", icon: "eye", kind: "agent", hint: "Claude or Codex reviews Trivial and BAU PRs and posts a verdict" },
    { id: "redo", label: "Worker redo", icon: "redo", kind: "agent", hint: "Changes requested: the worker fixes and pushes the same branch, then the PR is reviewed again (3 reviews at most). No new commit: the worker is asked to push, twice at most" },
    { id: "merge", label: "Merge", icon: "merge", kind: "action", hint: "Squash merge when approved" },
    { id: "apply", label: "Apply", icon: "rocket", kind: "action", hint: "agent-console, dotfiles, brain: pull and restart" },
  ],
  edges: [
    { from: "triage", to: "dispatcher" }, { from: "opener", to: "usage" }, { from: "usage", to: "dispatcher" },
    { from: "dispatcher", to: "router" }, { from: "router", to: "worktree" }, { from: "worktree", to: "worker" },
    { from: "worker", to: "self_review" }, { from: "self_review", to: "pr" }, { from: "pr", to: "review" },
    { from: "review", to: "redo", label: "changes requested" }, { from: "redo", to: "review", label: "new commits pushed" }, { from: "review", to: "merge", label: "approved" }, { from: "merge", to: "apply" },
  ],
  pipelines: [
    { id: "pr", label: "PR workflow", hint: "From a new issue to a merged pull request", phases: [
      { label: "Issue to labels", steps: ["triage"] },
      { label: "Labels to pull request", steps: ["dispatcher", "router", "worktree", "worker", "self_review", "pr"] },
      { label: "Premium review and merge", steps: ["review", "redo", "merge", "apply"], loop: { steps: ["review", "redo"], label: "Review loop · 3 reviews at most, then a person decides" } },
    ] },
    { id: "windows", label: "Window opener", hint: "Starts Claude and Codex 5-hour windows overnight and reads their usage; the dispatcher plans from these readings", phases: [
      { label: "Quota windows", steps: ["opener", "usage"] },
    ] },
  ],
};
export const STEP_IDS = FLOW.nodes.map(n => n.id);

export interface AutomationEvent { seq: number; ts: number; step: StepId; kind: EventKind; run?: string; ref?: string; msg?: string; data?: Record<string, unknown> }

export interface SnapshotRequest { v?: number; limit?: number }
export interface StepView { id: StepId; state: StepState; lastAt?: number; lastMsg?: string; open: number; failures: number }
export interface Trigger { id: string; kind: "webhook" | "timer" | "hook" | "cron" | "manual"; label: string; detail: string; enabled: boolean; lastAt?: number; pipeline?: string }
export interface HookInfo { worktree: string; path: string; hook: string; protects: string }
export interface RunView { thread: string; key: string; role: string; effort: string; state: string; title: string }
export interface FailureView { ts: number; step: StepId; ref?: string; msg: string }
export interface Snapshot {
  v: typeof VERSION; now: number; flow: typeof FLOW; steps: StepView[]; triggers: Trigger[]; runs: RunView[]; failures: FailureView[]; hooks: HookInfo[];
  config: { dispatch: Record<string, unknown> & { enabled: boolean; dryRun: boolean }; opener: Record<string, unknown> & { enabled: boolean; dryRun: boolean } };
}

export interface StepLogRequest { v?: number; step: StepId; limit?: number; before?: number }
export interface StepLogResponse { v: typeof VERSION; step: StepId; entries: AutomationEvent[]; next?: number }

export interface DebugRequest { v?: number; focus?: StepId; note?: string }
export interface DebugResponse { v: typeof VERSION; thread: string; cwd: string; branch: string; route: { provider: string; model: string; effort: string }; why: string }
