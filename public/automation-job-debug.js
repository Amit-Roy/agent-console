// Read-only issue diagnostics. Each request owns its view so late responses cannot replace another job's evidence.
import { el } from "/render.js";

let current;
const when = (ts) => Number.isFinite(ts) ? new Date(ts).toLocaleString() : "Time unavailable";
const button = (text, action) => {
  const b = el("button", "btn", text);
  b.type = "button";
  b.onclick = action;
  return b;
};

export function openJobDebug({ repo, number, openThread }) {
  current?.dialog.close();
  const dialog = el("dialog", "job-debug");
  dialog.id = "auto-job-debug";
  dialog.setAttribute("aria-labelledby", "job-debug-title");
  const title = el("h2", "", `Debug · ${repo}#${number}`);
  title.id = "job-debug-title";
  const body = el("div", "job-debug-body");
  const actions = el("div", "row job-debug-actions");
  const refresh = button("Refresh", () => load());
  const close = button("Close", () => dialog.close());
  close.autofocus = true;
  actions.append(refresh, close);
  dialog.append(title, el("p", "sub", "Workflow and recorded evidence for this issue."), actions, body);
  const view = { dialog, request: null, trigger: document.activeElement };
  current = view;
  dialog.addEventListener("close", () => {
    view.request?.abort();
    dialog.remove();
    if (current === view) {
      current = null;
      if (view.trigger?.isConnected) view.trigger.focus();
      else [...document.querySelectorAll(".auto-group-more")].find(b => b.closest(".auto-group")?.dataset.issue === `${repo.toLowerCase()}#${number}`)?.focus();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  load();

  async function load() {
    view.request?.abort();
    const request = view.request = new AbortController();
    refresh.disabled = true;
    const loading = el("p", "sub", "Loading job diagnostics…");
    loading.setAttribute("role", "status");
    body.replaceChildren(loading);
    try {
      const query = new URLSearchParams({ v: "1", repo, number: String(number) });
      const response = await fetch(`/api/automation/job?${query}`, { cache: "no-store", signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      if (current !== view || request !== view.request || !dialog.open) return;
      render(data);
    } catch (error) {
      if (request.signal.aborted || current !== view || request !== view.request) return;
      const message = el("p", "job-debug-error", error.message || "Diagnostics could not be loaded.");
      message.setAttribute("role", "alert");
      body.replaceChildren(message, button("Retry", () => load()));
    } finally {
      if (current === view && request === view.request) refresh.disabled = false;
    }
  }

  function render(data) {
    const summary = el("p", "job-debug-summary", `${data.state}: ${data.summary}`);
    const workflow = el("ol", "job-debug-workflow");
    workflow.setAttribute("aria-label", "Issue workflow");
    for (const step of data.workflow) {
      const li = el("li");
      li.dataset.state = step.state;
      li.append(el("strong", "", step.label), el("span", "tag", step.state), el("p", "sub", step.detail));
      workflow.append(li);
    }
    const runs = el("div", "job-debug-runs");
    for (const thread of data.threads) {
      const detail = el("details");
      const heading = el("summary", "", `${thread.issueRun?.premiumAssignment ? "premium" : thread.issueRun?.role || "run"} · ${thread.title}`);
      const meta = [thread.id, thread.provider, thread.model, thread.status, thread.background ? "background work" : "", thread.archived ? "archived" : ""].filter(Boolean).join(" · ");
      detail.append(heading, el("p", "job-debug-meta", meta), el("p", "", thread.reason || "No failure reason recorded."), el("p", "sub", `Updated ${when(thread.updatedAt)}`));
      if (thread.lastError) detail.append(el("p", "job-debug-record", `Recorded error (${when(thread.lastError.ts)}): ${thread.lastError.message}`));
      if (thread.lastRun) detail.append(el("pre", "job-debug-record", JSON.stringify(thread.lastRun, null, 2)));
      if (thread.quotaPaused) detail.append(el("p", "sub", `Quota pause: ${JSON.stringify(thread.quotaPaused)}`));
      const run = thread.issueRun;
      if (run) detail.append(el("p", "sub", `Review attempts ${run.reviews || 0}/${data.limits.reviews} · PR reminders ${run.nudges || 0}/${data.limits.nudges} · Worker recoveries ${run.recoveries || 0}/${data.limits.recoveries}`));
      if (Number.isSafeInteger(run?.pr) && run.pr > 0) {
        const link = el("a", "code-link", `PR #${run.pr}`);
        link.href = `https://github.com/${repo}/pull/${run.pr}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        detail.append(link);
      }
      detail.append(button("Open thread", () => { dialog.close(); openThread(thread.id); }));
      runs.append(detail);
    }
    const events = el("ol", "job-debug-events");
    for (const event of data.events) {
      const li = el("li");
      li.append(el("p", "sub", `${when(event.ts)} · ${event.step} · ${event.kind}`), el("p", "", event.msg || "No message recorded."));
      if (event.run || event.ref) li.append(el("p", "job-debug-meta", [event.run, event.ref].filter(Boolean).join(" · ")));
      events.append(li);
    }
    body.replaceChildren(summary, el("p", "sub", `Snapshot ${when(data.generatedAt)}. Refresh to update.`), el("h3", "", "Workflow"), workflow, el("h3", "", "Related runs"), runs, el("h3", "", "Recorded events"), events);
    if (data.historyNote) body.append(el("p", "sub", data.historyNote));
    if (!data.events.length) body.append(el("p", "sub", "No matching events retained. Missing evidence does not prove a stage never ran."));
    if (data.historyTruncated) body.append(el("p", "sub", "History is limited to retained recent evidence; older events may be missing."));
  }
}
