// The Auto lane: threads the automation started (issue work, PR reviews, debugging), grouped by the issue they serve.
// They are ordinary threads, so opening, replying and forking work as usual; they just do not crowd the Threads lane.

import { createMenu } from "/menu.js";
import { $, el, icon } from "/render.js";

const ROLE = { work: "work", review: "review", debug: "debug" };

export function createAutoLane({
  state,
  openThread,
  setNav,
  provLabel,
  ago,
  assignPremium,
  debugIssue,
}) {
  const expanded = new Set();
  let menuOpen = false,
    renderPending = false;
  let lastCurrent;
  let archiveOpen = !!localStorage.getItem("ac_auto_archive_open");
  $("auto-archive-toggle").onclick = () => {
    archiveOpen = !archiveOpen;
    localStorage.setItem("ac_auto_archive_open", archiveOpen ? "1" : "");
    render();
  };
  const issueKey = (run) =>
    run.repo && Number.isSafeInteger(run.number) && run.number > 0
      ? `${run.repo.toLowerCase()}#${run.number}`
      : run.key;
  // background tasks keep an idle run's agent alive: show it as busy everywhere the lane-tab dot counts it, like the Threads list
  const busy = (t) => t.status === "running" || !!t.background;
  function render() {
    if (menuOpen) {
      renderPending = true;
      return;
    }
    renderPending = false;
    const runs = [...state.threads.values()]
      .filter((t) => t.issueRun)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const groups = new Map();
    for (const t of runs) {
      const key = issueKey(t.issueRun);
      const list = groups.get(key) || [];
      list.push(t);
      groups.set(key, list);
    }
    const live = new Map(),
      archived = new Map();
    for (const [key, list] of groups) {
      const target = list.some((t) => !t.archived || t.status === "running" || t.background)
        ? live
        : archived;
      target.set(key, list);
    }
    if (state.current !== lastCurrent) {
      const current = runs.find((t) => t.id === state.current);
      if (current) {
        expanded.add(issueKey(current.issueRun));
        if (archived.has(issueKey(current.issueRun))) archiveOpen = true;
      }
      lastCurrent = state.current;
    }
    $("lane-auto-dot").hidden = !runs.some(busy);
    $("auto-archive").hidden = !archived.size;
    $("auto-archive-count").textContent = archived.size || "";
    $("auto-archive-toggle").setAttribute("aria-expanded", String(archiveOpen));
    $("auto-archived").hidden = !archiveOpen;
    renderList(
      $("autos"),
      live,
      archived.size ? "Everything is archived." : "Nothing started automatically yet.",
    );
    renderList($("auto-archived"), archived);
  }
  function renderList(ul, groups, emptyMessage) {
    const focusedClass = document.activeElement?.classList.contains("auto-group-more")
      ? "auto-group-more"
      : "auto-group-toggle";
    const focusedIssue =
      ul.contains(document.activeElement) && document.activeElement.classList.contains(focusedClass)
        ? document.activeElement.closest(".auto-group")?.dataset.issue
        : undefined;
    ul.replaceChildren();
    if (!groups.size && emptyMessage) ul.append(el("li", "empty-list", emptyMessage));
    for (const [key, list] of groups) {
      const head = el("li", "auto-group");
      head.dataset.issue = key;
      const run = list[0].issueRun;
      const label =
        run.repo && Number.isSafeInteger(run.number) && run.number > 0
          ? `${run.repo}#${run.number}`
          : key;
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
      const sync = () => {
        const open = expanded.has(key);
        toggle.setAttribute("aria-expanded", String(open));
        children.hidden = !open;
      };
      toggle.onclick = () => {
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        sync();
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
      sync();
      const header = el("div", "auto-group-header");
      header.append(toggle);
      if (
        /^[\w.-]+\/[\w.-]+$/.test(run.repo) &&
        Number.isSafeInteger(run.number) &&
        run.number > 0
      ) {
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
            menuOpen = true;
          },
          onClose: () => {
            menuOpen = false;
            if (renderPending) queueMicrotask(render);
          },
          onSelect: (value) => {
            if (value === "show")
              window.open(
                `https://github.com/${run.repo}/issues/${run.number}`,
                "_blank",
                "noopener,noreferrer",
              );
            else if (value === "premium") assignPremium?.({ repo: run.repo, number: run.number });
            else debugIssue?.({ repo: run.repo, number: run.number });
          },
        });
        header.append(more);
      }
      head.append(header, children);
      ul.append(head);
      if (focusedIssue === key) header.querySelector(`.${focusedClass}`)?.focus();
      for (const t of list) {
        const li = el("li", t.id === state.current ? "sel" : "");
        li.dataset.thread = t.id;
        li.tabIndex = 0;
        li.title = `${t.title}\n${provLabel(t.provider)} · ${t.model}`;
        if (t.id === state.current) li.setAttribute("aria-current", "true");
        const dot = el("span", `dot ${t.background ? "running" : t.status}`);
        dot.setAttribute("aria-hidden", "true");
        const meta = el("div", "meta");
        meta.append(
          el(
            "span",
            `tag role role-${t.issueRun.role}`,
            t.issueRun.premiumAssignment ? "premium" : ROLE[t.issueRun.role] || t.issueRun.role,
          ),
          el("span", "tag", t.issueRun.effort),
          el("span", "tag", provLabel(t.provider)),
        );
        const time = el("time", "", ago(t.updatedAt));
        time.dateTime = new Date(t.updatedAt).toISOString();
        meta.append(time);
        li.append(dot, el("div", "t", t.title), meta);
        if (t.status === "running") li.append(el("span", "sr-only", "Running"));
        else if (t.background) li.append(el("span", "sr-only", "Background tasks working"));
        const pick = () => {
          setNav(false);
          openThread(t.id);
        };
        li.onclick = pick;
        li.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        };
        children.append(li);
      }
    }
  }
  return { render };
}
