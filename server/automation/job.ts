import fs from "node:fs";
import path from "node:path";
import { MAX_NUDGES, MAX_RECOVERIES, MAX_REVIEWS } from "../issue-review.ts";
import type { IssueRun } from "../window-dispatch.ts";
import { type AutomationEvent, FLOW } from "./contracts.ts";
import { redact } from "./events.ts";

interface JobThread {
  id: string;
  title?: string;
  provider?: string;
  model?: string;
  status?: string;
  background?: number;
  archived?: number;
  updatedAt?: number;
  issueRun?: IssueRun;
  lastRun?: unknown;
  quotaPaused?: unknown;
}
export interface RecordedJobError {
  type: string;
  message: string;
  ts?: number;
}
interface JobDeps {
  threads(): JobThread[];
  events(): AutomationEvent[];
  lastError?: (id: string) => RecordedJobError | undefined;
  now?: () => number;
}
interface JobRequest {
  v?: number;
  repo: string;
  number: number;
}
type State = "active" | "paused" | "blocked" | "completed" | "idle";
const clean = (value: unknown, depth = 0): any =>
  typeof value === "string"
    ? redact(value).slice(0, 1000)
    : Array.isArray(value)
      ? depth < 4
        ? value.slice(0, 30).map((v) => clean(v, depth + 1))
        : []
      : value && typeof value === "object"
        ? depth < 4
          ? Object.fromEntries(
              Object.entries(value)
                .slice(0, 40)
                .map(([k, v]) => [k, clean(v, depth + 1)]),
            )
          : {}
        : value;
/** Only explicit provider errors are exposed, never user, assistant, or tool content. */
export function readJobError(dataDir: string, id: string): RecordedJobError | undefined {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      path.join(dataDir, "logs", `${id}.jsonl`),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return;
    const start = Math.max(0, stat.size - 64 * 1024),
      bytes = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const length = fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, length).toString("utf8").split("\n");
    if (start) lines.shift(); // An incomplete leading event cannot provide reliable evidence.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        const message =
          e.type === "console_error"
            ? e.text
            : e.type === "result" && e.is_error
              ? typeof e.error === "string"
                ? e.error
                : e.error?.message
              : undefined;
        if (typeof message === "string" && message.trim())
          return {
            type: e.type,
            message: redact(message).slice(0, 1000),
            ...(Number.isFinite(e.ts) ? { ts: e.ts } : {}),
          };
      } catch {
        /* Partial writes and malformed lines do not hide other retained errors. */
      }
    }
  } catch {
    /* Missing, unreadable, and non-regular logs have no diagnostic excerpt. */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const active = (t: JobThread) => t.status === "running" || !!t.background;
function threadReason(t: JobThread): string {
  const r = t.issueRun!;
  if (active(t)) return t.background ? "Background work is still running." : "Thread is running.";
  if (t.quotaPaused) return "Thread is paused by the recorded provider quota window.";
  if (r.outcome === "merged") return "Reviewer recorded that the PR merged.";
  if (r.premiumThread) return "Worker was handed to a premium owner.";
  if (r.premiumPending) return "Worker is queued for premium re-dispatch.";
  if (r.stalled)
    return `Worker recovery limit reached (${r.recoveries ?? 0}/${MAX_RECOVERIES}); automatic recovery stopped.`;
  if (r.outcome === "approved")
    return "Reviewer approved, but the PR was not merged at its last check.";
  if (r.outcome === "changes") return "Reviewer requested changes.";
  if (r.outcome === "error") return "Reviewer turn ended with an error.";
  if (r.outcome === "no-verdict") return "Reviewer posted no verdict.";
  if (r.outcome === "closed") return "PR was closed without merging at the last check.";
  if (r.missingPr) return "No open PR was found at the last recorded branch check.";
  if (r.redoing) return "Worker is waiting to continue review fixes.";
  return "Thread is idle; its cause is not recorded in thread metadata.";
}

function assertValidJobRequest(req: JobRequest) {
  if (req.v !== undefined && req.v !== 1) throw new Error("Unsupported request version.");
  if (
    typeof req.repo !== "string" ||
    !/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(req.repo) ||
    !Number.isSafeInteger(req.number) ||
    req.number <= 0
  )
    throw new Error("Invalid issue repository or number.");
}

// A matching explicit ref is authoritative. Never borrow a different issue's event through a thread field.
function matchEvents(
  deps: JobDeps,
  key: string,
  related: JobThread[],
): ReturnType<JobDeps["events"]> {
  const ids = new Set(related.map((thread) => thread.id));
  const runIds = new Set(
    related.flatMap((thread) => [`work:${thread.id}`, `review:${thread.id}`, `redo:${thread.id}`]),
  );
  return deps
    .events()
    .filter((event) =>
      event.ref
        ? event.ref.toLowerCase() === key
        : (typeof event.data?.thread === "string" && ids.has(event.data.thread)) ||
          (!!event.run && runIds.has(event.run)),
    );
}

type JobVerdict = { state: State; summary: string };

function isMergedEvidence(related: JobThread[], latest: AutomationEvent | undefined): boolean {
  return (
    ((latest?.step === "merge" || latest?.step === "apply") && latest.kind === "ok") ||
    (related[0]?.issueRun?.outcome === "merged" &&
      !(latest?.kind === "fail" || latest?.kind === "abandoned"))
  );
}

function recoveryVerdict(related: JobThread[], latest: AutomationEvent | undefined): JobVerdict {
  if (related.some((thread) => thread.issueRun?.premiumPending && !thread.issueRun.premiumThread))
    return {
      state: "paused",
      summary:
        "Worker recovery is queued for premium re-dispatch when an approved provider is available.",
    };
  if (related.some((thread) => thread.issueRun?.stalled && !thread.issueRun.premiumThread))
    return {
      state: "blocked",
      summary:
        "Worker recovery limit reached; automatic recovery stopped. Inspect the recorded failure and thread before assigning a new owner.",
    };
  if (
    latest?.kind === "fail" ||
    latest?.kind === "abandoned" ||
    latest?.msg?.endsWith(": a person decides")
  )
    return {
      state: "blocked",
      summary: latest.msg || `Latest recorded ${latest.step} event: ${latest.kind}.`,
    };
  return {
    state: "idle",
    summary: latest?.msg
      ? `No thread is running. Latest recorded event: ${latest.msg}`
      : "No thread is running. The current blocker is not known from retained local evidence.",
  };
}

function jobVerdict(related: JobThread[], latest: AutomationEvent | undefined): JobVerdict {
  if (related.some(active))
    return {
      state: "active",
      summary:
        "Automation has a running thread or background work. Earlier failures may already be under repair.",
    };
  if (related.some((thread) => thread.quotaPaused))
    return {
      state: "paused",
      summary: "Automation is paused by a recorded provider quota window.",
    };
  if (isMergedEvidence(related, latest))
    return {
      state: "completed",
      summary:
        "Retained evidence records a merged PR. Current GitHub state has not been refreshed.",
    };
  return recoveryVerdict(related, latest);
}

function workflowStepState(running: boolean, last: AutomationEvent | undefined): string {
  if (running) return "active";
  if (!last) return "unobserved";
  if (last.kind === "fail" || last.msg?.endsWith(": a person decides")) return "failed";
  if (last.kind === "abandoned") return "abandoned";
  return last.kind === "ok" ? "ok" : "recorded";
}

function stepDetail(running: boolean, last: AutomationEvent | undefined): string {
  if (running) return "A related thread is running.";
  return (
    last?.msg ??
    (last
      ? `Recorded ${last.kind} event.`
      : "No retained event for this step; completion is not known.")
  );
}

function threadRunsStep(thread: JobThread, stepId: string): boolean {
  if (!active(thread)) return false;
  if (thread.issueRun?.role === "review") return stepId === "review";
  return thread.issueRun?.redoing ? stepId === "redo" : stepId === "worker";
}

function workflowViews(related: JobThread[], events: AutomationEvent[]) {
  const steps = FLOW.pipelines
    .find((pipeline) => pipeline.id === "pr")!
    .phases.flatMap((phase) => phase.steps);
  return steps.map((stepId) => {
    const node = FLOW.nodes.find((candidate) => candidate.id === stepId)!;
    const last = events.find((event) => event.step === stepId);
    const running = related.some((thread) => threadRunsStep(thread, stepId));
    return {
      id: stepId,
      label: node.label,
      state: workflowStepState(running, last),
      detail: stepDetail(running, last),
      ...(last ? { lastAt: last.ts } : {}),
    };
  });
}

function threadView(thread: JobThread, deps: JobDeps) {
  return {
    id: thread.id,
    title: clean(thread.title),
    provider: thread.provider,
    model: thread.model,
    status: thread.status,
    background: thread.background,
    archived: thread.archived,
    updatedAt: thread.updatedAt,
    issueRun: clean(thread.issueRun),
    lastRun: clean(thread.lastRun),
    quotaPaused: clean(thread.quotaPaused),
    reason: threadReason(thread),
    ...(deps.lastError ? { lastError: clean(deps.lastError(thread.id)) } : {}),
  };
}

/** Read-only local evidence. This function never invokes an agent or contacts GitHub; optional log excerpts contain explicit errors only. */
export function diagnoseJob(req: JobRequest, deps: JobDeps) {
  assertValidJobRequest(req);
  const repo = req.repo.toLowerCase(),
    key = `${repo}#${req.number}`;
  const related = deps
    .threads()
    .filter(
      (thread) =>
        thread.issueRun?.repo?.toLowerCase() === repo && thread.issueRun.number === req.number,
    )
    .sort((first, second) => (second.updatedAt ?? 0) - (first.updatedAt ?? 0));
  const matched = matchEvents(deps, key, related);
  if (!related.length && !matched.length)
    throw new Error("No automation evidence exists for this issue.");
  const events = matched
    .slice(-200)
    .reverse()
    .map((event) => clean(event) as AutomationEvent);
  const { state, summary } = jobVerdict(related, events[0]);
  return {
    v: 1,
    repo,
    number: req.number,
    generatedAt: (deps.now ?? Date.now)(),
    state,
    summary,
    limits: { reviews: MAX_REVIEWS, nudges: MAX_NUDGES, recoveries: MAX_RECOVERIES },
    workflow: workflowViews(related, events),
    threads: related.slice(0, 50).map((thread) => threadView(thread, deps)),
    threadsTruncated: related.length > 50,
    events,
    historyTruncated: matched.length > events.length,
    historyNote:
      "Events are newest first, limited to 200 retained issue events. Logs rotate; absent events are not proof a step never occurred. Up to 50 newest threads are shown. Recorded errors come only from the last 64 KiB of each thread log and may predate recovery. GitHub state is not refreshed.",
  };
}
