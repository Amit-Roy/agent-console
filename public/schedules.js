// Scheduled tasks in the sidebar: one row per task (schedule, agent, next run, on/off), its latest runs as child rows, and the report
// card a finished run leaves in its thread. Every run is an ordinary thread, so opening, replying and forking work as usual.

import { createMenu } from "./menu.js";
import { $, el, icon, iconButton } from "./render.js";

const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];
export const REPEAT_ITEMS = [
  { value: "manual", label: "Manual", desc: "Only when you press Run now" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays", desc: "Monday to Friday" },
  { value: "weekly", label: "Weekly" },
];
export const DAY_ITEMS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({
  value: String(d),
  label: DAY_NAMES[d],
}));
const RECENT = 3;

// "Daily 09:00", "Mondays 09:00", "Hourly at :15", "Manual" (matches server describe())
export function describe(t) {
  if (t.repeat === "manual") return "Manual";
  if (t.repeat === "hourly") return `Hourly at :${t.time.slice(3)}`;
  if (t.repeat === "weekly") return `${DAY_NAMES[t.day]} ${t.time}`;
  return `${t.repeat === "daily" ? "Daily" : "Weekdays"} ${t.time}`;
}

// "in 6h", "in 12m", "in 2d"
export function until(ts) {
  const s = Math.max(0, (ts - Date.now()) / 1000);
  if (s < 60) return "in <1m";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

// "Today 09:00", "Yesterday 18:30", "Oct 17 09:00"
export function when(ts) {
  const d = new Date(ts),
    now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function duration(ms) {
  if (!(ms >= 0)) return "";
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

const STATUS = { running: "Running", done: "Done", failed: "Failed", skipped: "Skipped" };
function runSummary(r) {
  if (r.status === "running") return "Running";
  if (r.status === "skipped" || r.status === "failed")
    return `${STATUS[r.status]} · ${r.reason || ""}`.replace(/ · $/, "");
  return [
    STATUS[r.status],
    duration(r.ms),
    r.cost != null ? `$${r.cost.toFixed(2)}` : "",
    r.output ? "Report saved" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function isActivationKey(event) {
  return event.key === "Enter" || event.key === " ";
}

function switchTitle(task) {
  if (task.repeat === "manual") return "Manual tasks run only when you press Run now";
  return task.enabled ? "On: runs on schedule" : "Paused";
}

function switchFor(ctx, task) {
  const toggle = el("button", "switch");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(task.enabled));
  toggle.setAttribute("aria-label", `${task.enabled ? "Pause" : "Resume"} ${task.title}`);
  toggle.title = switchTitle(task);
  toggle.onclick = (event) => {
    event.stopPropagation();
    ctx.send({ t: "task_save", id: task.id, enabled: !task.enabled });
  };
  toggle.onkeydown = (event) => isActivationKey(event) && event.stopPropagation();
  return toggle;
}

function runRow(ctx, _task, run) {
  const { state } = ctx;
  const thread = run.thread && state.threads.get(run.thread);
  const row = el(
    "li",
    `run ${run.status}${run.thread && run.thread === state.current ? " sel" : ""}`,
  );
  const dot = el("span", `dot ${run.status}`);
  dot.setAttribute("aria-hidden", "true");
  const label = el("div", "t", when(run.at));
  if (run.trigger === "catch-up") label.append(el("span", "run-trigger", " · catch-up"));
  row.append(dot, label, el("div", "meta", runSummary(run)));
  if (thread) bindRunThread(ctx, row, run, thread);
  else row.classList.add("inert");
  return row;
}

function bindRunThread(ctx, row, run, thread) {
  row.tabIndex = 0;
  row.title = thread.title;
  if (run.thread === ctx.state.current) row.setAttribute("aria-current", "true");
  const pick = () => {
    ctx.setNav(false);
    ctx.openThread(run.thread);
  };
  row.onclick = pick;
  row.onkeydown = (event) => {
    if (isActivationKey(event)) {
      event.preventDefault();
      pick();
    }
  };
}

function buildTaskTitle(task, running) {
  const title = el("div", "t");
  if (running) {
    const dot = el("span", "dot running");
    dot.setAttribute("aria-hidden", "true");
    title.append(dot);
  }
  title.append(el("span", "", task.title));
  return title;
}

function buildTaskMeta(ctx, task) {
  const meta = el("div", "meta");
  meta.append(
    icon("clock"),
    el("span", "sched", describe(task)),
    el("span", "tag", ctx.provLabel(task.provider)),
  );
  if (!task.enabled && task.repeat !== "manual") meta.append(el("span", "paused", "Paused"));
  else if (task.nextRunAt) {
    const next = el("time", "", until(task.nextRunAt));
    next.dateTime = new Date(task.nextRunAt).toISOString();
    next.title = `Next run ${new Date(task.nextRunAt).toLocaleString()}`;
    meta.append(next);
  }
  return meta;
}

function taskMenuItems(running) {
  return [
    {
      value: "run",
      label: "Run now",
      desc: running ? "A run is in progress" : "Start a run in a new thread",
      icon: "play",
      disabled: running,
    },
    { value: "edit", label: "Edit", icon: "pencil" },
    {
      value: "delete",
      label: "Delete task…",
      desc: "Also deletes its run threads; reports stay in git",
      icon: "trash",
      tone: "danger",
    },
  ];
}

function selectTaskAction(ctx, task, action) {
  if (action === "run") {
    ctx.setNav(false);
    ctx.send({ t: "task_run", id: task.id });
  } else if (action === "edit") ctx.editTask(task);
  else if (action === "delete" && ctx.confirmDelete(task))
    ctx.send({ t: "task_delete", id: task.id });
}

function attachTaskMenu(ctx, task, row, more, running) {
  createMenu({
    trigger: more,
    kind: "menu",
    label: `Actions for ${task.title}`,
    header: () => task.title,
    align: "end",
    getItems: () => taskMenuItems(running),
    onOpen: () => {
      ctx.menuOpen = true;
      row.classList.add("menu-open");
    },
    onClose: () => {
      ctx.menuOpen = false;
      row.classList.remove("menu-open");
      if (ctx.pending) renderTasks(ctx);
    },
    onSelect: (action) => selectTaskAction(ctx, task, action),
  });
}

function taskRow(ctx, task) {
  const row = el("li", "task");
  row.tabIndex = 0;
  const running = task.runs.some((run) => run.status === "running");
  const title = buildTaskTitle(task, running);
  const meta = buildTaskMeta(ctx, task);
  const more = iconButton("more", `Actions for ${task.title}`, "btn sm icon ghost row-more");
  more.onclick = (event) => event.stopPropagation();
  more.addEventListener("keydown", (event) => isActivationKey(event) && event.stopPropagation());
  attachTaskMenu(ctx, task, row, more, running);
  row.append(title, meta, switchFor(ctx, task), more);
  row.title = `${task.title}\n${describe(task)} (${task.tz}) · ${ctx.provLabel(task.provider)} · ${task.cwd}`;
  row.onclick = () => ctx.editTask(task);
  row.onkeydown = (event) => {
    if (isActivationKey(event)) {
      event.preventDefault();
      ctx.editTask(task);
    }
  };
  return row;
}

function emptyRunText(task) {
  if (task.repeat === "manual") return "No runs yet. Use ⋯ → Run now.";
  return task.enabled && task.nextRunAt ? `First run ${when(task.nextRunAt)}` : "No runs yet.";
}

function allRunsToggle(ctx, task, runCount) {
  const row = el("li", "run all-runs");
  const button = el(
    "button",
    "side-toggle",
    ctx.openRuns.has(task.id) ? "Show fewer" : `All ${runCount} runs`,
  );
  button.type = "button";
  button.setAttribute("aria-expanded", String(ctx.openRuns.has(task.id)));
  button.prepend(icon("chev-right"));
  button.onclick = () => {
    ctx.openRuns.has(task.id) ? ctx.openRuns.delete(task.id) : ctx.openRuns.add(task.id);
    renderTasks(ctx);
  };
  row.append(button);
  return row;
}

function appendTaskGroup(ctx, list, task) {
  list.append(taskRow(ctx, task));
  const runs = task.runs.slice().reverse();
  const shown = ctx.openRuns.has(task.id) ? runs : runs.slice(0, RECENT);
  if (!runs.length) {
    list.append(el("li", "run empty-run", emptyRunText(task)));
    return;
  }
  for (const run of shown) list.append(runRow(ctx, task, run));
  if (runs.length > RECENT) list.append(allRunsToggle(ctx, task, runs.length));
}

function emptyTasksRow() {
  const empty = el("li", "empty-list empty-tasks");
  empty.append(
    el(
      "span",
      "",
      "Run a prompt on a timer: a morning research digest, weekly triage, a nightly check. Each run is a thread you can reply to, and its report is committed to git.",
    ),
  );
  return empty;
}

function renderTasks(ctx) {
  if (ctx.menuOpen) {
    ctx.pending = true;
    return;
  }
  ctx.pending = false;
  const list = $("tasks");
  list.replaceChildren();
  const tasks = [...ctx.state.tasks.values()];
  $("lane-tasks-dot").hidden = !tasks.some((task) =>
    task.runs.some((run) => run.status === "running"),
  );
  if (!tasks.length) {
    list.append(emptyTasksRow());
    return;
  }
  for (const task of tasks) appendTaskGroup(ctx, list, task);
}

function reportIcon(status) {
  if (status === "done") return "check";
  return status === "failed" ? "alert" : "clock";
}

function triggerLabel(trigger) {
  if (trigger === "catch-up") return "Catch-up run";
  return trigger === "manual" ? "Run now" : "On schedule";
}

function reportFacts(run) {
  const facts = el("div", "rr-facts");
  for (const fact of [
    when(run.at),
    duration(run.ms),
    run.cost != null ? `$${run.cost.toFixed(3)}` : "",
    triggerLabel(run.trigger),
  ])
    if (fact) facts.append(el("span", "", fact));
  return facts;
}

function appendReportFile(card, actions, output) {
  const file = el("a", "rr-file");
  file.href = "#";
  file.dataset.fileRef = output.path;
  file.title = output.path;
  file.append(
    icon("file"),
    el("span", "rr-path", output.path.replace(/^.*\/agent-outputs\//, "agent-outputs/")),
    ...(output.commit ? [el("code", "", output.commit)] : []),
  );
  card.append(file);
  const openLink = el("a", "btn sm primary", "Open report");
  openLink.href = "#";
  openLink.dataset.fileRef = output.path;
  actions.append(openLink);
}

// The card a finished run leaves in its thread: status, cost, the committed report, and what to do next
function reportCard(ctx, event) {
  const run = event.run || {};
  const card = el("div", `msg run-report ${run.status}`);
  const head = el("div", "rr-head");
  head.append(
    icon(reportIcon(run.status)),
    el("span", "rr-status", STATUS[run.status] || run.status),
    el("span", "rr-task", event.title || "Scheduled task"),
  );
  card.append(head, reportFacts(run));
  if (run.reason) card.append(el("p", "rr-reason", run.reason));
  const actions = el("div", "rr-actions");
  if (run.output?.path) appendReportFile(card, actions, run.output);
  const fork = el("button", "btn sm", "Fork");
  fork.type = "button";
  fork.title = "Continue in a new thread";
  fork.onclick = () => ctx.send({ t: "fork", thread: ctx.state.current });
  actions.append(fork);
  if (ctx.state.tasks.has(event.task)) {
    const again = el("button", "btn sm", "Run again");
    again.type = "button";
    again.onclick = () => ctx.send({ t: "task_run", id: event.task });
    actions.append(again);
  }
  card.append(actions, el("p", "rr-hint", "Reply below to ask follow-ups about this run."));
  return card;
}

export function createSchedules({
  state,
  send,
  openThread,
  setNav,
  provLabel,
  editTask,
  confirmDelete,
}) {
  const ctx = {
    state,
    send,
    openThread,
    setNav,
    provLabel,
    editTask,
    confirmDelete,
    openRuns: new Set(), // tasks showing every run instead of the latest few
    menuOpen: false,
    pending: false,
  };
  return { render: () => renderTasks(ctx), reportCard: (event) => reportCard(ctx, event) };
}
