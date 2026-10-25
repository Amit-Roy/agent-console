// Read-only issue diagnostics. Each request owns its view so late responses cannot replace another job's evidence.
import { el } from "/render.js";

let current;
const when = (ts) => (Number.isFinite(ts) ? new Date(ts).toLocaleString() : "Time unavailable");
const button = (text, action) => {
  const b = el("button", "btn", text);
  b.type = "button";
  b.onclick = action;
  return b;
};

function handleJobDialogClose(view) {
  view.request?.abort();
  view.dialog.remove();
  if (current !== view) return;
  current = null;
  if (view.trigger?.isConnected) view.trigger.focus();
  else
    [...document.querySelectorAll(".auto-group-more")]
      .find(
        (b) =>
          b.closest(".auto-group")?.dataset.issue === `${view.repo.toLowerCase()}#${view.number}`,
      )
      ?.focus();
}

function buildWorkflowList(data) {
  const workflow = el("ol", "job-debug-workflow");
  workflow.setAttribute("aria-label", "Issue workflow");
  for (const step of data.workflow) {
    const stepItem = el("li");
    stepItem.dataset.state = step.state;
    stepItem.append(
      el("strong", "", step.label),
      el("span", "tag", step.state),
      el("p", "sub", step.detail),
    );
    workflow.append(stepItem);
  }
  return workflow;
}

function appendThreadRecords(detail, thread) {
  if (thread.lastError)
    detail.append(
      el(
        "p",
        "job-debug-record",
        `Recorded error (${when(thread.lastError.ts)}): ${thread.lastError.message}`,
      ),
    );
  if (thread.lastRun)
    detail.append(el("pre", "job-debug-record", JSON.stringify(thread.lastRun, null, 2)));
  if (thread.quotaPaused)
    detail.append(el("p", "sub", `Quota pause: ${JSON.stringify(thread.quotaPaused)}`));
}

function appendIssueRunInfo(detail, run, data, repo) {
  if (run)
    detail.append(
      el(
        "p",
        "sub",
        `Review attempts ${run.reviews || 0}/${data.limits.reviews} · PR reminders ${run.nudges || 0}/${data.limits.nudges} · Worker recoveries ${run.recoveries || 0}/${data.limits.recoveries}`,
      ),
    );
  if (Number.isSafeInteger(run?.pr) && run.pr > 0) {
    const link = el("a", "code-link", `PR #${run.pr}`);
    link.href = `https://github.com/${repo}/pull/${run.pr}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    detail.append(link);
  }
}

function buildThreadDetail(view, data, thread) {
  const detail = el("details");
  const heading = el(
    "summary",
    "",
    `${thread.issueRun?.premiumAssignment ? "premium" : thread.issueRun?.role || "run"} · ${thread.title}`,
  );
  const meta = [
    thread.id,
    thread.provider,
    thread.model,
    thread.status,
    thread.background ? "background work" : "",
    thread.archived ? "archived" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  detail.append(
    heading,
    el("p", "job-debug-meta", meta),
    el("p", "", thread.reason || "No failure reason recorded."),
    el("p", "sub", `Updated ${when(thread.updatedAt)}`),
  );
  appendThreadRecords(detail, thread);
  appendIssueRunInfo(detail, thread.issueRun, data, view.repo);
  detail.append(
    button("Open thread", () => {
      view.dialog.close();
      view.openThread(thread.id);
    }),
  );
  return detail;
}

function buildEventList(data) {
  const events = el("ol", "job-debug-events");
  for (const event of data.events) {
    const eventItem = el("li");
    eventItem.append(
      el("p", "sub", `${when(event.ts)} · ${event.step} · ${event.kind}`),
      el("p", "", event.msg || "No message recorded."),
    );
    if (event.run || event.ref)
      eventItem.append(
        el("p", "job-debug-meta", [event.run, event.ref].filter(Boolean).join(" · ")),
      );
    events.append(eventItem);
  }
  return events;
}

function appendHistoryNotes(body, data) {
  if (data.historyNote) body.append(el("p", "sub", data.historyNote));
  if (!data.events.length)
    body.append(
      el(
        "p",
        "sub",
        "No matching events retained. Missing evidence does not prove a stage never ran.",
      ),
    );
  if (data.historyTruncated)
    body.append(
      el(
        "p",
        "sub",
        "History is limited to retained recent evidence; older events may be missing.",
      ),
    );
}

function renderJobDebug(view, data) {
  const summary = el("p", "job-debug-summary", `${data.state}: ${data.summary}`);
  const workflow = buildWorkflowList(data);
  const runs = el("div", "job-debug-runs");
  for (const thread of data.threads) runs.append(buildThreadDetail(view, data, thread));
  const events = buildEventList(data);
  view.body.replaceChildren(
    summary,
    el("p", "sub", `Snapshot ${when(data.generatedAt)}. Refresh to update.`),
    el("h3", "", "Workflow"),
    workflow,
    el("h3", "", "Related runs"),
    runs,
    el("h3", "", "Recorded events"),
    events,
  );
  appendHistoryNotes(view.body, data);
}

function showJobDebugError(view, error) {
  const message = el("p", "job-debug-error", error.message || "Diagnostics could not be loaded.");
  message.setAttribute("role", "alert");
  view.body.replaceChildren(
    message,
    button("Retry", () => loadJobDebug(view)),
  );
}

async function loadJobDebug(view) {
  view.request?.abort();
  const request = (view.request = new AbortController());
  view.refresh.disabled = true;
  const loading = el("p", "sub", "Loading job diagnostics…");
  loading.setAttribute("role", "status");
  view.body.replaceChildren(loading);
  try {
    const query = new URLSearchParams({ v: "1", repo: view.repo, number: String(view.number) });
    const response = await fetch(`/api/automation/job?${query}`, {
      cache: "no-store",
      signal: request.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (current !== view || request !== view.request || !view.dialog.open) return;
    renderJobDebug(view, data);
  } catch (error) {
    if (request.signal.aborted || current !== view || request !== view.request) return;
    showJobDebugError(view, error);
  } finally {
    if (current === view && request === view.request) view.refresh.disabled = false;
  }
}

export function openJobDebug({ repo, number, openThread }) {
  current?.dialog.close();
  const dialog = el("dialog", "job-debug");
  dialog.id = "auto-job-debug";
  dialog.setAttribute("aria-labelledby", "job-debug-title");
  const title = el("h2", "", `Debug · ${repo}#${number}`);
  title.id = "job-debug-title";
  const body = el("div", "job-debug-body");
  const actions = el("div", "row job-debug-actions");
  const refresh = button("Refresh", () => loadJobDebug(view));
  const close = button("Close", () => dialog.close());
  close.autofocus = true;
  actions.append(refresh, close);
  dialog.append(
    title,
    el("p", "sub", "Workflow and recorded evidence for this issue."),
    actions,
    body,
  );
  const view = {
    dialog,
    body,
    refresh,
    repo,
    number,
    openThread,
    request: null,
    trigger: document.activeElement,
  };
  current = view;
  dialog.addEventListener("close", () => handleJobDialogClose(view));
  document.body.append(dialog);
  dialog.showModal();
  loadJobDebug(view);
}
