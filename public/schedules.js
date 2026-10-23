// Scheduled tasks in the sidebar: one row per task (schedule, agent, next run, on/off), its latest runs as child rows, and the report
// card a finished run leaves in its thread. Every run is an ordinary thread, so opening, replying and forking work as usual.

import { createMenu } from "/menu.js";
import { $, el, icon, iconButton } from "/render.js";

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

export function createSchedules({
  state,
  send,
  openThread,
  setNav,
  provLabel,
  editTask,
  confirmDelete,
}) {
  const openRuns = new Set(); // tasks showing every run instead of the latest few
  let menuOpen = false,
    pending = false;

  function switchFor(t) {
    const sw = el("button", "switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(t.enabled));
    sw.setAttribute("aria-label", `${t.enabled ? "Pause" : "Resume"} ${t.title}`);
    sw.title =
      t.repeat === "manual"
        ? "Manual tasks run only when you press Run now"
        : t.enabled
          ? "On: runs on schedule"
          : "Paused";
    sw.onclick = (e) => {
      e.stopPropagation();
      send({ t: "task_save", id: t.id, enabled: !t.enabled });
    };
    sw.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && e.stopPropagation();
    return sw;
  }

  function runRow(t, r) {
    const thread = r.thread && state.threads.get(r.thread);
    const li = el("li", `run ${r.status}${r.thread && r.thread === state.current ? " sel" : ""}`);
    const dot = el("span", `dot ${r.status}`);
    dot.setAttribute("aria-hidden", "true");
    const label = el("div", "t", when(r.at));
    if (r.trigger === "catch-up") label.append(el("span", "run-trigger", " · catch-up"));
    li.append(dot, label, el("div", "meta", runSummary(r)));
    if (thread) {
      li.tabIndex = 0;
      li.title = thread.title;
      if (r.thread === state.current) li.setAttribute("aria-current", "true");
      const pick = () => {
        setNav(false);
        openThread(r.thread);
      };
      li.onclick = pick;
      li.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      };
    } else li.classList.add("inert");
    return li;
  }

  function taskRow(t) {
    const li = el("li", "task");
    li.tabIndex = 0;
    const running = t.runs.some((r) => r.status === "running");
    const title = el("div", "t");
    if (running) {
      const d = el("span", "dot running");
      d.setAttribute("aria-hidden", "true");
      title.append(d);
    }
    title.append(el("span", "", t.title));
    const meta = el("div", "meta");
    meta.append(
      icon("clock"),
      el("span", "sched", describe(t)),
      el("span", "tag", provLabel(t.provider)),
    );
    if (!t.enabled && t.repeat !== "manual") meta.append(el("span", "paused", "Paused"));
    else if (t.nextRunAt) {
      const next = el("time", "", until(t.nextRunAt));
      next.dateTime = new Date(t.nextRunAt).toISOString();
      next.title = `Next run ${new Date(t.nextRunAt).toLocaleString()}`;
      meta.append(next);
    }
    const more = iconButton("more", `Actions for ${t.title}`, "btn sm icon ghost row-more");
    more.onclick = (e) => e.stopPropagation();
    more.addEventListener(
      "keydown",
      (e) => (e.key === "Enter" || e.key === " ") && e.stopPropagation(),
    );
    createMenu({
      trigger: more,
      kind: "menu",
      label: `Actions for ${t.title}`,
      header: () => t.title,
      align: "end",
      getItems: () => [
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
      ],
      onOpen: () => {
        menuOpen = true;
        li.classList.add("menu-open");
      },
      onClose: () => {
        menuOpen = false;
        li.classList.remove("menu-open");
        if (pending) render();
      },
      onSelect: (v) => {
        if (v === "run") {
          setNav(false);
          send({ t: "task_run", id: t.id });
        } else if (v === "edit") editTask(t);
        else if (v === "delete" && confirmDelete(t)) send({ t: "task_delete", id: t.id });
      },
    });
    li.append(title, meta, switchFor(t), more);
    li.title = `${t.title}\n${describe(t)} (${t.tz}) · ${provLabel(t.provider)} · ${t.cwd}`;
    li.onclick = () => editTask(t);
    li.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        editTask(t);
      }
    };
    return li;
  }

  function render() {
    if (menuOpen) {
      pending = true;
      return;
    }
    pending = false;
    const ul = $("tasks");
    ul.replaceChildren();
    const tasks = [...state.tasks.values()];
    $("lane-tasks-dot").hidden = !tasks.some((t) => t.runs.some((r) => r.status === "running"));
    if (!tasks.length) {
      const empty = el("li", "empty-list empty-tasks");
      empty.append(
        el(
          "span",
          "",
          "Run a prompt on a timer: a morning research digest, weekly triage, a nightly check. Each run is a thread you can reply to, and its report is committed to git.",
        ),
      );
      ul.append(empty);
      return;
    }
    for (const t of tasks) {
      ul.append(taskRow(t));
      const runs = t.runs.slice().reverse();
      const shown = openRuns.has(t.id) ? runs : runs.slice(0, RECENT);
      if (!runs.length) {
        ul.append(
          el(
            "li",
            "run empty-run",
            t.repeat === "manual"
              ? "No runs yet. Use ⋯ → Run now."
              : t.enabled && t.nextRunAt
                ? `First run ${when(t.nextRunAt)}`
                : "No runs yet.",
          ),
        );
        continue;
      }
      for (const r of shown) ul.append(runRow(t, r));
      if (runs.length > RECENT) {
        const li = el("li", "run all-runs");
        const b = el(
          "button",
          "side-toggle",
          openRuns.has(t.id) ? "Show fewer" : `All ${runs.length} runs`,
        );
        b.type = "button";
        b.setAttribute("aria-expanded", String(openRuns.has(t.id)));
        b.prepend(icon("chev-right"));
        b.onclick = () => {
          openRuns.has(t.id) ? openRuns.delete(t.id) : openRuns.add(t.id);
          render();
        };
        li.append(b);
        ul.append(li);
      }
    }
  }

  // The card a finished run leaves in its thread: status, cost, the committed report, and what to do next
  function reportCard(e) {
    const r = e.run || {};
    const card = el("div", `msg run-report ${r.status}`);
    const head = el("div", "rr-head");
    head.append(
      icon(r.status === "done" ? "check" : r.status === "failed" ? "alert" : "clock"),
      el("span", "rr-status", STATUS[r.status] || r.status),
      el("span", "rr-task", e.title || "Scheduled task"),
    );
    card.append(head);
    const facts = el("div", "rr-facts");
    for (const f of [
      when(r.at),
      duration(r.ms),
      r.cost != null ? `$${r.cost.toFixed(3)}` : "",
      r.trigger === "catch-up"
        ? "Catch-up run"
        : r.trigger === "manual"
          ? "Run now"
          : "On schedule",
    ])
      if (f) facts.append(el("span", "", f));
    card.append(facts);
    if (r.reason) card.append(el("p", "rr-reason", r.reason));
    const actions = el("div", "rr-actions");
    if (r.output?.path) {
      const file = el("a", "rr-file");
      file.href = "#";
      file.dataset.fileRef = r.output.path;
      file.title = r.output.path;
      file.append(
        icon("file"),
        el("span", "rr-path", r.output.path.replace(/^.*\/agent-outputs\//, "agent-outputs/")),
        ...(r.output.commit ? [el("code", "", r.output.commit)] : []),
      );
      card.append(file);
      const open = el("a", "btn sm primary", "Open report");
      open.href = "#";
      open.dataset.fileRef = r.output.path;
      actions.append(open);
    }
    const fork = el("button", "btn sm", "Fork");
    fork.type = "button";
    fork.title = "Continue in a new thread";
    fork.onclick = () => send({ t: "fork", thread: state.current });
    actions.append(fork);
    if (state.tasks.has(e.task)) {
      const again = el("button", "btn sm", "Run again");
      again.type = "button";
      again.onclick = () => send({ t: "task_run", id: e.task });
      actions.append(again);
    }
    card.append(actions, el("p", "rr-hint", "Reply below to ask follow-ups about this run."));
    return card;
  }

  return { render, reportCard };
}
