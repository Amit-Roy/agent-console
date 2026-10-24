// Request and response models for everything the automation dashboard asks for. Callers build a request, get a response.
// Every envelope carries `v`; a reader ignores fields it does not know, so adding a property never breaks a caller.

export const VERSION = 1 as const;

export type StepId =
  | "triage"
  | "opener"
  | "usage"
  | "dispatcher"
  | "router"
  | "worktree"
  | "worker"
  | "self_review"
  | "pr"
  | "review"
  | "redo"
  | "merge"
  | "apply"
  | "monitor"
  | "escalate"
  | "opencve"
  | "receiver"
  | "tool_watch"
  | "tool_patch"
  | "digest"
  | "push"
  | "falco"
  | "falco_queue"
  | "transport"
  | "scan"
  | "osv_check"
  | "report"
  | "heartbeat"
  | "status_check"
  | "dream_gather"
  | "dream_run"
  | "dream_verify";
export type StepState = "idle" | "active" | "ok" | "failed" | "abandoned" | "disabled";
export type EventKind = "start" | "ok" | "fail" | "info" | "abandoned";

export interface FlowNode {
  id: StepId;
  label: string;
  icon: string;
  kind: "trigger" | "source" | "decision" | "action" | "agent" | "gate";
  hint: string;
}
export interface FlowEdge {
  from: StepId;
  to: StepId;
  label?: string;
} // label: the condition for taking this edge
/** A workflow the dashboard draws on its own: its phases run left to right, each phase's steps in order.
 *  A phase's loop is a run of its steps that repeats; the dashboard boxes them with the loop's label. */
export interface Pipeline {
  id: string;
  label: string;
  hint: string;
  /** Sidebar group: the work loop, or the VPS security automations. */
  group: "workflow" | "security";
  icon: string;
  phases: { label: string; steps: StepId[]; loop?: { steps: StepId[]; label: string } }[];
}

/** The workflows, entrypoint first. The UI draws exactly this; adding a stage is adding a node here and placing it in a pipeline. */
export const FLOW: { nodes: FlowNode[]; edges: FlowEdge[]; pipelines: Pipeline[] } = {
  nodes: [
    {
      id: "triage",
      label: "Triage",
      icon: "tag",
      kind: "trigger",
      hint: "GitHub webhook labels each issue with effort and priority",
    },
    {
      id: "opener",
      label: "Window opener",
      icon: "clock",
      kind: "trigger",
      hint: "Starts a 5-hour quota window overnight",
    },
    {
      id: "usage",
      label: "Usage windows",
      icon: "gauge",
      kind: "source",
      hint: "Claude and Codex quota readings",
    },
    {
      id: "dispatcher",
      label: "Dispatcher",
      icon: "play",
      kind: "decision",
      hint: "Picks issues in the last 90 minutes of a window",
    },
    {
      id: "router",
      label: "Router",
      icon: "route",
      kind: "decision",
      hint: "Chooses provider and model from usage and load",
    },
    {
      id: "worktree",
      label: "Worktree + hook",
      icon: "branch",
      kind: "action",
      hint: "Own worktree; pre-push hook blocks the default branch",
    },
    { id: "worker", label: "Worker", icon: "bot", kind: "agent", hint: "Implements the issue" },
    {
      id: "self_review",
      label: "Self-review",
      icon: "check",
      kind: "gate",
      hint: "Worker checks its diff with the coding-standards skill",
    },
    {
      id: "pr",
      label: "Pull request",
      icon: "pr",
      kind: "action",
      hint: "Branch pushed, PR opened",
    },
    {
      id: "review",
      label: "Premium review",
      icon: "eye",
      kind: "agent",
      hint: "Claude or Codex reviews Trivial and BAU PRs and posts a verdict",
    },
    {
      id: "redo",
      label: "Worker redo",
      icon: "redo",
      kind: "agent",
      hint: "Changes requested: the worker fixes and pushes the same branch, then the PR is reviewed again (3 reviews at most). No new commit: the worker is asked to push, twice at most",
    },
    {
      id: "merge",
      label: "Merge",
      icon: "merge",
      kind: "action",
      hint: "Squash merge when approved",
    },
    {
      id: "apply",
      label: "Apply",
      icon: "rocket",
      kind: "action",
      hint: "agent-console, dotfiles, brain: pull and restart",
    },
    {
      id: "monitor",
      label: "Workspace monitor",
      icon: "gauge",
      kind: "source",
      hint: "Every 15 s: host CPU and RAM, agent failures, console health. An alert needs a sustained breach",
    },
    {
      id: "escalate",
      label: "Escalation",
      icon: "bot",
      kind: "agent",
      hint: "Unresolved alert: L3 Pi, then L2 Claude or Codex, then L1 Opus, then the owner. Dry run unless monitor.json says live",
    },
    {
      id: "opencve",
      label: "OpenCVE sync",
      icon: "database",
      kind: "source",
      hint: "Hourly CVE knowledge-base sync; Airflow diffs new commits and matches subscriptions",
    },
    {
      id: "receiver",
      label: "Webhook receiver",
      icon: "shield",
      kind: "gate",
      hint: "Bearer token, deduplicated for 7 days; writes a marker and never forwards advisory text",
    },
    {
      id: "tool_watch",
      label: "Tool watch",
      icon: "scan",
      kind: "action",
      hint: "The marker starts one fixed tool-watch run; pinned versions are compared with upstream",
    },
    {
      id: "tool_patch",
      label: "Patch bridge",
      icon: "pr",
      kind: "action",
      hint: "Tool changes become branches and pull requests for review and merge",
    },
    {
      id: "digest",
      label: "Daily digest",
      icon: "mail",
      kind: "action",
      hint: "One AgentMail message at 22:15 UTC with the day's event and CVE change counts",
    },
    {
      id: "push",
      label: "Phone alert",
      icon: "bell",
      kind: "action",
      hint: "Web push to the owner's devices; the console bell is the only path for non-security alerts",
    },
    {
      id: "falco",
      label: "Falco runtime",
      icon: "eye",
      kind: "source",
      hint: "Kernel-level runtime detection; Warning and above are queued",
    },
    {
      id: "falco_queue",
      label: "Alert queue",
      icon: "layers",
      kind: "action",
      hint: "Falco events append to a local queue; the flusher sends them every 5 minutes",
    },
    {
      id: "transport",
      label: "Alert transport",
      icon: "mail",
      kind: "gate",
      hint: "vps-harden-notify: ALERT_TRANSPORT is AgentMail, ntfy, webhook or SMTP",
    },
    {
      id: "scan",
      label: "Security scan",
      icon: "scan",
      kind: "action",
      hint: "ClamAV, Falco, Trivy and nmap; full scan Saturday 23:15 UTC, quick scan on demand",
    },
    {
      id: "osv_check",
      label: "OSV malware check",
      icon: "shield",
      kind: "action",
      hint: "Daily 22:30 UTC check of installed packages against OSV advisories",
    },
    {
      id: "report",
      label: "Security page",
      icon: "chart",
      kind: "action",
      hint: "Results reach /security over the forced-command scan key",
    },
    {
      id: "heartbeat",
      label: "Dead-man switch",
      icon: "activity",
      kind: "source",
      hint: "Every 5 minutes the VPS reports unit, OpenCVE stack and backup health",
    },
    {
      id: "status_check",
      label: "VPS status",
      icon: "gauge",
      kind: "decision",
      hint: "One failed or overdue unit turns the check red and raises the owner alert",
    },
    {
      id: "dream_gather",
      label: "Gather signal",
      icon: "database",
      kind: "action",
      hint: "Server writes one signal file: sessions, brain log entries, commits and brain lint since the last good dream",
    },
    {
      id: "dream_run",
      label: "Dream agent",
      icon: "bot",
      kind: "agent",
      hint: "Claude Sonnet consolidates the brain from the signal file. Up to 90 minutes, nobody watching",
    },
    {
      id: "dream_verify",
      label: "Verify changes",
      icon: "check",
      kind: "gate",
      hint: "brain lint must pass and only wiki/, ops/ and tags/ may change; the cost, tokens and pages changed are recorded",
    },
  ],
  edges: [
    { from: "triage", to: "dispatcher" },
    { from: "opener", to: "usage" },
    { from: "usage", to: "dispatcher" },
    { from: "dispatcher", to: "router" },
    { from: "router", to: "worktree" },
    { from: "worktree", to: "worker" },
    { from: "worker", to: "self_review" },
    { from: "self_review", to: "pr" },
    { from: "pr", to: "review" },
    { from: "review", to: "redo", label: "changes requested" },
    { from: "redo", to: "review", label: "new commits pushed" },
    { from: "review", to: "merge", label: "approved" },
    { from: "merge", to: "apply" },
    { from: "monitor", to: "escalate", label: "alert unresolved" },
    { from: "opencve", to: "receiver", label: "subscription match" },
    { from: "receiver", to: "tool_watch", label: "deduplicated" },
    { from: "tool_watch", to: "tool_patch", label: "release changed" },
    { from: "opencve", to: "digest", label: "daily counts" },
    { from: "digest", to: "push", label: "AgentMail digest" },
    { from: "tool_patch", to: "push", label: "PR opened" },
    { from: "falco", to: "falco_queue", label: "Warning or above" },
    { from: "falco_queue", to: "transport", label: "flushed every 5 min" },
    { from: "transport", to: "push", label: "owner" },
    { from: "scan", to: "report", label: "findings" },
    { from: "osv_check", to: "report", label: "malware match" },
    { from: "report", to: "transport", label: "needs attention" },
    { from: "heartbeat", to: "status_check", label: "unit missed" },
    { from: "status_check", to: "transport", label: "failed or overdue" },
    { from: "dream_gather", to: "dream_run", label: "signal file written" },
    { from: "dream_run", to: "dream_verify", label: "run ended" },
  ],
  pipelines: [
    {
      id: "pr",
      label: "Window dispatch",
      group: "workflow",
      icon: "pr",
      hint: "Dispatches issues through a quota window to a merged pull request",
      phases: [
        { label: "Issue to labels", steps: ["triage"] },
        {
          label: "Labels to pull request",
          steps: ["dispatcher", "router", "worktree", "worker", "self_review", "pr"],
        },
        {
          label: "Premium review and merge",
          steps: ["review", "redo", "merge", "apply"],
          loop: {
            steps: ["review", "redo"],
            label: "Review loop · 3 reviews at most, then a person decides",
          },
        },
      ],
    },
    {
      id: "windows",
      label: "Window opener",
      group: "workflow",
      icon: "clock",
      hint: "Starts Claude and Codex 5-hour windows overnight and reads their usage; the dispatcher plans from these readings",
      phases: [{ label: "Quota windows", steps: ["opener", "usage"] }],
    },
    {
      id: "monitor",
      label: "Workspace monitor",
      group: "workflow",
      icon: "gauge",
      hint: "Watches CPU, RAM, agent failures and console health; escalates alerts that nobody resolves",
      phases: [
        { label: "Signals to alerts", steps: ["monitor"] },
        { label: "Escalation chain", steps: ["escalate"] },
      ],
    },
    {
      id: "dream",
      label: "Dream",
      group: "workflow",
      icon: "database",
      hint: "Nightly 04:30: an agent consolidates the shared brain, and the server checks what it changed",
      phases: [
        { label: "Signal", steps: ["dream_gather"] },
        { label: "Consolidate", steps: ["dream_run"] },
        { label: "Check", steps: ["dream_verify"] },
      ],
    },
    {
      id: "cve",
      label: "CVE alerts",
      group: "security",
      icon: "shield",
      hint: "OpenCVE match to a patch PR and the owner's daily digest",
      phases: [
        { label: "Detect", steps: ["opencve", "receiver"] },
        { label: "Patch path", steps: ["tool_watch", "tool_patch"] },
        { label: "Owner alerting", steps: ["digest", "push"] },
      ],
    },
    {
      id: "runtime",
      label: "Runtime guard",
      group: "security",
      icon: "eye",
      hint: "Falco runtime events to the owner's alert channel",
      phases: [
        { label: "Detect", steps: ["falco", "falco_queue"] },
        { label: "Notify", steps: ["transport", "push"] },
      ],
    },
    {
      id: "scans",
      label: "Scheduled scans",
      group: "security",
      icon: "scan",
      hint: "ClamAV, Falco, Trivy, nmap and OSV results to the security page and the owner",
      phases: [
        { label: "Scan", steps: ["scan", "osv_check"] },
        { label: "Report and alert", steps: ["report", "transport", "push"] },
      ],
    },
    {
      id: "deadman",
      label: "Dead-man switch",
      group: "security",
      icon: "activity",
      hint: "The VPS checks its own units, OpenCVE stack and backups every 5 minutes",
      phases: [
        { label: "Watch", steps: ["heartbeat", "status_check"] },
        { label: "Alert", steps: ["transport", "push"] },
      ],
    },
  ],
};
export const STEP_IDS = FLOW.nodes.map((n) => n.id);

export interface AutomationEvent {
  seq: number;
  ts: number;
  step: StepId;
  kind: EventKind;
  run?: string;
  ref?: string;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface SnapshotRequest {
  v?: number;
  limit?: number;
}
export interface StepView {
  id: StepId;
  state: StepState;
  lastAt?: number;
  lastMsg?: string;
  open: number;
  failures: number;
}
export interface Trigger {
  id: string;
  kind: "webhook" | "timer" | "hook" | "cron" | "manual";
  label: string;
  detail: string;
  enabled: boolean;
  lastAt?: number;
  pipeline?: string;
}
export interface HookInfo {
  worktree: string;
  path: string;
  hook: string;
  protects: string;
}
export interface RunView {
  thread: string;
  key: string;
  role: string;
  effort: string;
  state: string;
  title: string;
  retryAttempts?: number;
  recoveries?: number;
  retriesRemaining?: number;
  premiumStatus?: "eligible" | "assigned";
}
export interface FailureView {
  ts: number;
  resolvedAt?: number;
  step: StepId;
  ref?: string;
  msg: string;
}
export interface Snapshot {
  v: typeof VERSION;
  now: number;
  flow: typeof FLOW;
  steps: StepView[];
  triggers: Trigger[];
  runs: RunView[];
  failures: FailureView[];
  hooks: HookInfo[];
  config: {
    dispatch: Record<string, unknown> & { enabled: boolean; dryRun: boolean };
    opener: Record<string, unknown> & { enabled: boolean; dryRun: boolean };
  };
}

export interface StepLogRequest {
  v?: number;
  step: StepId;
  limit?: number;
  before?: number;
}
export interface StepLogResponse {
  v: typeof VERSION;
  step: StepId;
  entries: AutomationEvent[];
  next?: number;
}

export interface DebugRequest {
  v?: number;
  focus?: StepId;
  note?: string;
}
export interface DebugResponse {
  v: typeof VERSION;
  thread: string;
  cwd: string;
  branch: string;
  route: { provider: string; model: string; effort: string };
  why: string;
}
