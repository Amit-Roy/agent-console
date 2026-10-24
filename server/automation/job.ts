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

/** Read-only local evidence. This function never invokes an agent or contacts GitHub; optional log excerpts contain explicit errors only. */
export function diagnoseJob(req: JobRequest, deps: JobDeps) {
  if (req.v !== undefined && req.v !== 1) throw new Error("Unsupported request version.");
  if (
    typeof req.repo !== "string" ||
    !/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(req.repo) ||
    !Number.isSafeInteger(req.number) ||
    req.number <= 0
  )
    throw new Error("Invalid issue repository or number.");
  const repo = req.repo.toLowerCase(),
    key = `${repo}#${req.number}`;
  const related = deps
    .threads()
    .filter((t) => t.issueRun?.repo?.toLowerCase() === repo && t.issueRun.number === req.number)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const ids = new Set(related.map((t) => t.id));
  const runIds = new Set(
    related.flatMap((t) => [`work:${t.id}`, `review:${t.id}`, `redo:${t.id}`]),
  );
  // A matching explicit ref is authoritative. Never borrow a different issue's event through a thread field.
  const matched = deps
    .events()
    .filter((e) =>
      e.ref
        ? e.ref.toLowerCase() === key
        : (typeof e.data?.thread === "string" && ids.has(e.data.thread)) ||
          (!!e.run && runIds.has(e.run)),
    );
  if (!related.length && !matched.length)
    throw new Error("No automation evidence exists for this issue.");
  const events = matched
    .slice(-200)
    .reverse()
    .map((e) => clean(e) as AutomationEvent);
  const latest = events[0];
  let state: State = "idle",
    summary =
      "No thread is running. The current blocker is not known from retained local evidence.";
  if (related.some(active)) {
    state = "active";
    summary =
      "Automation has a running thread or background work. Earlier failures may already be under repair.";
  } else if (related.some((t) => t.quotaPaused)) {
    state = "paused";
    summary = "Automation is paused by a recorded provider quota window.";
  } else if (
    ((latest?.step === "merge" || latest?.step === "apply") && latest.kind === "ok") ||
    (related[0]?.issueRun?.outcome === "merged" &&
      !(latest?.kind === "fail" || latest?.kind === "abandoned"))
  ) {
    state = "completed";
    summary = "Retained evidence records a merged PR. Current GitHub state has not been refreshed.";
  } else if (related.some((t) => t.issueRun?.premiumPending && !t.issueRun.premiumThread)) {
    state = "paused";
    summary =
      "Worker recovery is queued for premium re-dispatch when an approved provider is available.";
  } else if (related.some((t) => t.issueRun?.stalled && !t.issueRun.premiumThread)) {
    state = "blocked";
    summary =
      "Worker recovery limit reached; automatic recovery stopped. Inspect the recorded failure and thread before assigning a new owner.";
  } else if (
    latest?.kind === "fail" ||
    latest?.kind === "abandoned" ||
    latest?.msg?.endsWith(": a person decides")
  ) {
    state = "blocked";
    summary = latest.msg || `Latest recorded ${latest.step} event: ${latest.kind}.`;
  } else if (latest?.msg) summary = `No thread is running. Latest recorded event: ${latest.msg}`;
  const steps = FLOW.pipelines.find((p) => p.id === "pr")!.phases.flatMap((p) => p.steps);
  const workflow = steps.map((id) => {
    const node = FLOW.nodes.find((n) => n.id === id)!;
    const last = events.find((e) => e.step === id);
    const running = related.some(
      (t) =>
        active(t) &&
        (t.issueRun?.role === "review"
          ? id === "review"
          : t.issueRun?.redoing
            ? id === "redo"
            : id === "worker"),
    );
    return {
      id,
      label: node.label,
      state: running
        ? "active"
        : !last
          ? "unobserved"
          : last.kind === "fail" || last.msg?.endsWith(": a person decides")
            ? "failed"
            : last.kind === "abandoned"
              ? "abandoned"
              : last.kind === "ok"
                ? "ok"
                : "recorded",
      detail: running
        ? "A related thread is running."
        : (last?.msg ??
          (last
            ? `Recorded ${last.kind} event.`
            : "No retained event for this step; completion is not known.")),
      ...(last ? { lastAt: last.ts } : {}),
    };
  });
  return {
    v: 1,
    repo,
    number: req.number,
    generatedAt: (deps.now ?? Date.now)(),
    state,
    summary,
    limits: { reviews: MAX_REVIEWS, nudges: MAX_NUDGES, recoveries: MAX_RECOVERIES },
    workflow,
    threads: related.slice(0, 50).map((t) => ({
      id: t.id,
      title: clean(t.title),
      provider: t.provider,
      model: t.model,
      status: t.status,
      background: t.background,
      archived: t.archived,
      updatedAt: t.updatedAt,
      issueRun: clean(t.issueRun),
      lastRun: clean(t.lastRun),
      quotaPaused: clean(t.quotaPaused),
      reason: threadReason(t),
      ...(deps.lastError ? { lastError: clean(deps.lastError(t.id)) } : {}),
    })),
    threadsTruncated: related.length > 50,
    events,
    historyTruncated: matched.length > events.length,
    historyNote:
      "Events are newest first, limited to 200 retained issue events. Logs rotate; absent events are not proof a step never occurred. Up to 50 newest threads are shown. Recorded errors come only from the last 64 KiB of each thread log and may predate recovery. GitHub state is not refreshed.",
  };
}
