import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TriageDecision, TriageInput } from "./providers/triage-model.ts";
import { EFFORT_LABELS, PRIORITY_LABELS } from "./triage-comment.ts";

export const MANAGED = new Set<string>([
  ...Object.values(EFFORT_LABELS),
  ...Object.values(PRIORITY_LABELS),
]);
export const ACTIONS = {
  issues: new Set(["opened", "edited", "reopened", "unlabeled"]),
  pull_request: new Set([
    "opened",
    "edited",
    "reopened",
    "unlabeled",
    "synchronize",
    "ready_for_review",
  ]),
};
export type Kind = "issue" | "pull_request";
export type Job = {
  delivery: string;
  repo: string;
  number: number;
  kind: Kind;
  attempts: number;
  reason: "webhook" | "repair" | "reconcile";
};
export type GithubRequest = (method: string, endpoint: string, body?: unknown) => Promise<any>;
export type Options = {
  secret: string;
  repos: string[];
  dbPath: string;
  classify?: (input: TriageInput) => Promise<TriageDecision>;
  github?: GithubRequest;
  retryDelaysMs?: number[];
  maxBodyBytes?: number;
  assessmentRevision?: () => string;
  // Called after the named CI workflow passes on a push to main of an allowed repository.
  deploy?: { workflow: string; run: (repo: string, sha: string) => void };
  log?: (metadata: Record<string, unknown>) => void;
  // Called for each accepted webhook, each finished non-webhook job (queued, repair, reconcile) and each reconciled item
  // that looks like it has no telemetry comment. Must be idempotent; failures are logged, never thrown (token telemetry comment).
  // Called for an issue closed or a pull request merged, so the Console can archive the matching automation threads.
  onClosed?: (item: { repo: string; number: number; kind: Kind }) => void;
  onItem?: (item: { repo: string; number: number; kind: Kind }) => Promise<unknown> | void;
};
export type CachedAssessment = {
  body: string;
  effort: keyof typeof EFFORT_LABELS;
  priority: keyof typeof PRIORITY_LABELS;
  model: string;
};
export type ReconcileTotals = { scanned: number; queued: number };

// Shared mutable state of one triage service. Every closure variable of the factory lives here
// so the module-level step functions mutate the same fields.
export type TriageContext = {
  options: Options;
  repos: Set<string>;
  github: GithubRequest;
  classify: (input: TriageInput) => Promise<TriageDecision>;
  revision: () => string;
  retries: number[];
  database: DatabaseSync;
  actor: Promise<string> | undefined;
  closing: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  active: Promise<void> | undefined;
  idleListeners: Set<() => void>;
  // Product description grounds workflow-frequency inference. Last good text survives API failures,
  // so a transient error never changes the source fingerprint and re-triages every item.
  repoContexts: Map<string, { text: string; fetched: number }>;
  reconciling: Map<string, Promise<ReconcileTotals>>;
};

export function logEvent(ctx: TriageContext, event: string, fields: Record<string, unknown> = {}) {
  try {
    ctx.options.log?.({ event, ...fields });
  } catch {}
}

export function assertRepoAllowlist(list: string[]) {
  if (!list.length || list.some((repo) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
    throw new Error("An explicit repository allowlist is required");
  }
}

export function labelNames(issue: any): string[] {
  return (Array.isArray(issue.labels) ? issue.labels : [])
    .map((label: any) => (typeof label === "string" ? label : label?.name))
    .filter((label: unknown): label is string => typeof label === "string");
}

export function triageSourceMarker(issue: any, pull?: any, repoContext = ""): string {
  const source = JSON.stringify([
    issue.title ?? "",
    issue.body ?? "",
    pull?.head?.sha ?? null,
    Boolean(pull?.draft),
    repoContext,
  ]);
  return `<!-- agent-console-triage-source:${createHash("sha256").update(source).digest("hex")} -->`;
}

export function managedLabels(issue: any): string {
  return labelNames(issue)
    .filter((label) => MANAGED.has(label))
    .sort()
    .join("\n");
}
