// The Auto lane: threads the automation started (issue work, PR reviews, debugging), grouped by the issue they serve.
// They are ordinary threads, so opening, replying and forking work as usual; they just do not crowd the Threads lane.

import { createMenu } from "/menu.js";
import { $, el, icon } from "/render.js";

const ROLE = { work: "work", review: "review", debug: "debug" };

function issueKey(run) {
  return run.repo && Number.isSafeInteger(run.number) && run.number > 0
    ? `${run.repo.toLowerCase()}#${run.number}`
    : run.key;
}

// background tasks keep an idle run's agent alive: show it as busy everywhere the lane-tab dot counts it, like the Threads list
function busy(thread) {
  return thread.status === "running" || !!thread.background;
}

function groupRunsByIssue(runs) {
  const groups = new Map();
  for (const thread of runs) {
    const key = issueKey(thread.issueRun);
    const list = groups.get(key) || [];
    list.push(thread);
    groups.set(key, list);
  }
  return groups;
}

function splitLiveArchived(groups) {
  const live = new Map(),
    archived = new Map();
  for (const [key, list] of groups) {
    const target = list.some((t) => !t.archived || t.status === "running" || t.background)
      ? live
      : archived;
    target.set(key, list);
  }
  return { live, archived };
}

function trackCurrentThread(lane, runs, archived) {
  if (lane.state.current === lane.lastCurrent) return;
  const current = runs.find((t) => t.id === lane.state.current);
  if (current) {
    lane.expanded.add(issueKey(current.issueRun));
    if (archived.has(issueKey(current.issueRun))) lane.archiveOpen = true;
  }
  lane.lastCurrent = lane.state.current;
}

function renderLane(lane) {
  if (lane.menuOpen) {
    lane.renderPending = true;
    return;
  }
  lane.renderPending = false;
  const runs = [...lane.state.threads.values()]
    .filter((t) => t.issueRun)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const { live, archived } = splitLiveArchived(groupRunsByIssue(runs));
  trackCurrentThread(lane, runs, archived);
  $("lane-auto-dot").hidden = !runs.some(busy);
  $("auto-archive").hidden = !archived.size;
  $("auto-archive-count").textContent = archived.size || "";
  $("auto-archive-toggle").setAttribute("aria-expanded", String(lane.archiveOpen));
  $("auto-archived").hidden = !lane.archiveOpen;
  renderGroupList(
    lane,
    $("autos"),
    live,
    archived.size ? "Everything is archived." : "Nothing started automatically yet.",
  );
  renderGroupList(lane, $("auto-archived"), archived);
}

function syncGroupOpen(lane, key, toggle, children) {
  const open = lane.expanded.has(key);
  toggle.setAttribute("aria-expanded", String(open));
  children.hidden = !open;
}

function buildGroupToggle(lane, ul, key, list, label) {
  const run = list[0].issueRun;
  const toggle = el("button", "auto-group-toggle");
  toggle.type = "button";
  toggle.title = key;
  const running = list.filter(busy).length;
  toggle.setAttribute(
    "aria-label",
    `${key}, ${list.length} run${list.length === 1 ? "" : "s"}${running ? `, ${running} running` : ""}`,
  );
  const children = el("ul", "auto-runs");
  children.id = `${ul.id}-runs-${list[0].id}`;
  children.setAttribute("aria-label", key);
  toggle.setAttribute("aria-controls", children.id);
  toggle.onclick = () => {
    if (lane.expanded.has(key)) lane.expanded.delete(key);
    else lane.expanded.add(key);
    syncGroupOpen(lane, key, toggle, children);
  };
  toggle.append(
    icon("chev-right"),
    el("span", "k", label),
    el("span", "n", `${list.length} run${list.length === 1 ? "" : "s"}`),
  );
  if (running) {
    const dot = el("span", "dot running");
    dot.setAttribute("aria-hidden", "true");
    toggle.append(dot);
  }
  syncGroupOpen(lane, key, toggle, children);
  return { toggle, children, run };
}

function selectIssueAction(lane, run, value) {
  if (value === "show")
    window.open(
      `https://github.com/${run.repo}/issues/${run.number}`,
      "_blank",
      "noopener,noreferrer",
    );
  else if (value === "premium") lane.assignPremium?.({ repo: run.repo, number: run.number });
  else lane.debugIssue?.({ repo: run.repo, number: run.number });
}

function buildIssueMenuButton(lane, run, label) {
  const more = el("button", "btn icon ghost auto-group-more");
  more.type = "button";
  more.title = "Issue actions";
  more.setAttribute("aria-label", `Actions for ${label}`);
  more.append(icon("more"));
  createMenu({
    trigger: more,
    kind: "menu",
    label: `Actions for ${label}`,
    align: "end",
    renderTrigger: () => {},
    items: [
      { value: "show", label: "Show issue" },
      { value: "premium", label: "Assign to premium" },
      { value: "debug", label: "Debug" },
    ],
    onOpen: () => {
      lane.menuOpen = true;
    },
    onClose: () => {
      lane.menuOpen = false;
      if (lane.renderPending) queueMicrotask(() => renderLane(lane));
    },
    onSelect: (value) => selectIssueAction(lane, run, value),
  });
  return more;
}

function buildRunItem(lane, thread) {
  const { state, provLabel, ago, setNav, openThread } = lane;
  const runItem = el("li", thread.id === state.current ? "sel" : "");
  runItem.dataset.thread = thread.id;
  runItem.tabIndex = 0;
  runItem.title = `${thread.title}\n${provLabel(thread.provider)} · ${thread.model}`;
  if (thread.id === state.current) runItem.setAttribute("aria-current", "true");
  const dot = el("span", `dot ${thread.background ? "running" : thread.status}`);
  dot.setAttribute("aria-hidden", "true");
  const meta = el("div", "meta");
  meta.append(
    el(
      "span",
      `tag role role-${thread.issueRun.role}`,
      thread.issueRun.premiumAssignment
        ? "premium"
        : ROLE[thread.issueRun.role] || thread.issueRun.role,
    ),
    el("span", "tag", thread.issueRun.effort),
    el("span", "tag", provLabel(thread.provider)),
  );
  const time = el("time", "", ago(thread.updatedAt));
  time.dateTime = new Date(thread.updatedAt).toISOString();
  meta.append(time);
  runItem.append(dot, el("div", "t", thread.title), meta);
  if (thread.status === "running") runItem.append(el("span", "sr-only", "Running"));
  else if (thread.background) runItem.append(el("span", "sr-only", "Background tasks working"));
  const pick = () => {
    setNav(false);
    openThread(thread.id);
  };
  runItem.onclick = pick;
  runItem.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick();
    }
  };
  return runItem;
}

function renderGroup(lane, ul, key, list, focused) {
  const head = el("li", "auto-group");
  head.dataset.issue = key;
  const run = list[0].issueRun;
  const label =
    run.repo && Number.isSafeInteger(run.number) && run.number > 0
      ? `${run.repo}#${run.number}`
      : key;
  const { toggle, children } = buildGroupToggle(lane, ul, key, list, label);
  const header = el("div", "auto-group-header");
  header.append(toggle);
  if (/^[\w.-]+\/[\w.-]+$/.test(run.repo) && Number.isSafeInteger(run.number) && run.number > 0)
    header.append(buildIssueMenuButton(lane, run, label));
  head.append(header, children);
  ul.append(head);
  if (focused.issue === key) header.querySelector(`.${focused.className}`)?.focus();
  for (const thread of list) children.append(buildRunItem(lane, thread));
}

function renderGroupList(lane, ul, groups, emptyMessage) {
  const focusedClass = document.activeElement?.classList.contains("auto-group-more")
    ? "auto-group-more"
    : "auto-group-toggle";
  const focusedIssue =
    ul.contains(document.activeElement) && document.activeElement.classList.contains(focusedClass)
      ? document.activeElement.closest(".auto-group")?.dataset.issue
      : undefined;
  ul.replaceChildren();
  if (!groups.size && emptyMessage) ul.append(el("li", "empty-list", emptyMessage));
  const focused = { className: focusedClass, issue: focusedIssue };
  for (const [key, list] of groups) renderGroup(lane, ul, key, list, focused);
}

export function createAutoLane({
  state,
  openThread,
  setNav,
  provLabel,
  ago,
  assignPremium,
  debugIssue,
}) {
  const lane = {
    state,
    openThread,
    setNav,
    provLabel,
    ago,
    assignPremium,
    debugIssue,
    expanded: new Set(),
    menuOpen: false,
    renderPending: false,
    lastCurrent: undefined,
    archiveOpen: !!localStorage.getItem("ac_auto_archive_open"),
  };
  $("auto-archive-toggle").onclick = () => {
    lane.archiveOpen = !lane.archiveOpen;
    localStorage.setItem("ac_auto_archive_open", lane.archiveOpen ? "1" : "");
    renderLane(lane);
  };
  return { render: () => renderLane(lane) };
}
