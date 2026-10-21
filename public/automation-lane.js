// The Auto lane: threads the automation started (issue work, PR reviews, debugging), grouped by the issue they serve.
// They are ordinary threads, so opening, replying and forking work as usual; they just do not crowd the Threads lane.
import { $, el, icon } from "/render.js";

const ROLE = { work: "work", review: "review", debug: "debug" };

export function createAutoLane({ state, openThread, setNav, provLabel, ago }) {
  const expanded = new Set();
  let lastCurrent;
  const issueKey = (run) => run.repo && Number.isSafeInteger(run.number) && run.number > 0
    ? `${run.repo.toLowerCase()}#${run.number}` : run.key;
  function render() {
    const ul = $("autos");
    const focusedIssue = ul.contains(document.activeElement) && document.activeElement.classList.contains("auto-group-toggle")
      ? document.activeElement.closest(".auto-group")?.dataset.issue : undefined;
    const runs = [...state.threads.values()].filter((t) => t.issueRun && !t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    if (state.current !== lastCurrent) {
      const current = runs.find((t) => t.id === state.current);
      if (current) expanded.add(issueKey(current.issueRun));
      lastCurrent = state.current;
    }
    $("lane-auto-dot").hidden = !runs.some((t) => t.status === "running");
    ul.replaceChildren();
    if (!runs.length) {
      ul.append(el("li", "empty-list", "Nothing started automatically yet."));
      return;
    }
    const groups = new Map();
    for (const t of runs) {
      const key = issueKey(t.issueRun);
      const g = groups.get(key) || [];
      g.push(t);
      groups.set(key, g);
    }
    for (const [key, list] of groups) {
      const head = el("li", "auto-group");
      head.dataset.issue = key;
      const run = list[0].issueRun;
      const label = run.repo && Number.isSafeInteger(run.number) && run.number > 0 ? `${run.repo}#${run.number}` : key;
      const toggle = el("button", "auto-group-toggle");
      toggle.type = "button";
      toggle.title = key;
      const running = list.filter((t) => t.status === "running").length;
      toggle.setAttribute("aria-label", `${key}, ${list.length} run${list.length === 1 ? "" : "s"}${running ? `, ${running} running` : ""}`);
      const children = el("ul", "auto-runs");
      children.id = `auto-runs-${list[0].id}`;
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
      toggle.append(icon("chev-right"), el("span", "k", label), el("span", "n", `${list.length} run${list.length === 1 ? "" : "s"}`));
      if (running) {
        const dot = el("span", "dot running");
        dot.setAttribute("aria-hidden", "true");
        toggle.append(dot);
      }
      sync();
      head.append(toggle, children);
      ul.append(head);
      if (focusedIssue === key) toggle.focus();
      for (const t of list) {
        const li = el("li", t.id === state.current ? "sel" : "");
        li.dataset.thread = t.id;
        li.tabIndex = 0;
        li.title = `${t.title}\n${provLabel(t.provider)} · ${t.model}`;
        if (t.id === state.current) li.setAttribute("aria-current", "true");
        const dot = el("span", `dot ${t.status}`);
        dot.setAttribute("aria-hidden", "true");
        const meta = el("div", "meta");
        meta.append(el("span", `tag role role-${t.issueRun.role}`, ROLE[t.issueRun.role] || t.issueRun.role), el("span", "tag", t.issueRun.effort), el("span", "tag", provLabel(t.provider)));
        const time = el("time", "", ago(t.updatedAt));
        time.dateTime = new Date(t.updatedAt).toISOString();
        meta.append(time);
        li.append(dot, el("div", "t", t.title), meta);
        if (t.status === "running") li.append(el("span", "sr-only", "Running"));
        const pick = () => { setNav(false); openThread(t.id); };
        li.onclick = pick;
        li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
        children.append(li);
      }
    }
  }
  return { render };
}
