// The Auto lane: threads the automation started (issue work, PR reviews, debugging), grouped by the issue they serve.
// They are ordinary threads, so opening, replying and forking work as usual; they just do not crowd the Threads lane.
import { $, el } from "/render.js";

const ROLE = { work: "work", review: "review", debug: "debug" };

export function createAutoLane({ state, openThread, setNav, provLabel, ago }) {
  function render() {
    const ul = $("autos");
    const runs = [...state.threads.values()].filter((t) => t.issueRun && !t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    $("lane-auto-dot").hidden = !runs.some((t) => t.status === "running");
    ul.replaceChildren();
    if (!runs.length) {
      ul.append(el("li", "empty-list", "Nothing started automatically yet."));
      return;
    }
    const groups = new Map();
    for (const t of runs) {
      const g = groups.get(t.issueRun.key) || [];
      g.push(t);
      groups.set(t.issueRun.key, g);
    }
    for (const [key, list] of groups) {
      const head = el("li", "auto-group");
      head.append(el("span", "k", key), el("span", "n", `${list.length} run${list.length === 1 ? "" : "s"}`));
      ul.append(head);
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
        ul.append(li);
      }
    }
  }
  return { render };
}
