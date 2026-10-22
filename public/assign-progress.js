// Premium assignment progress: a timeline of the server's preparation steps, read live from the NDJSON response of
// POST /api/automation/assign (see server/automation/assign.ts ASSIGNMENT_STEPS). Each row expands to its command output.
import { $, el } from "/render.js";

const R = 8, ARC = 2 * Math.PI * R;
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const seconds = (ms) => {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
};

function node() {
  const ring = svg("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" });
  ring.append(svg("circle", { class: "track", cx: 10, cy: 10, r: R }), svg("circle", { class: "arc", cx: 10, cy: 10, r: R, "stroke-dasharray": ARC.toFixed(2) }));
  const check = svg("svg", { viewBox: "0 0 20 20", class: "mark", "aria-hidden": "true" });
  check.append(svg("path", { class: "ok", d: "M6 10.5l2.6 2.6L14 7.5" }), svg("path", { class: "no", d: "M7 7l6 6M13 7l-6 6" }));
  const n = el("span", "ap-node");
  n.append(ring, check);
  return n;
}

/** Reads one assignment stream into the progress dialog. Resolves with the thread id; rejects with the server's error. */
export async function showAssignmentProgress(response, { title, onBack, onOpen }) {
  const dlg = $("ap"), list = $("ap-steps"), open = $("ap-open"), error = $("ap-error");
  const rows = new Map();
  let active = null, tick = 0, thread = null, failed = false;
  $("ap-title").textContent = "Assigning to premium";
  $("ap-sub").textContent = title;
  error.hidden = true;
  list.replaceChildren();
  open.textContent = "See thread";
  open.disabled = true;
  open.onclick = () => { dlg.close(); if (failed) onBack(); else if (thread) onOpen(thread); };
  $("ap-close").onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();

  const plan = (steps) => {
    list.replaceChildren(...steps.map(({ id, label }, i) => {
      const li = el("li", "ap-step");
      li.dataset.state = "pending";
      const row = el("button", "ap-row");
      row.type = "button";
      row.setAttribute("aria-expanded", "false");
      row.setAttribute("aria-controls", `ap-log-${id}`);
      const time = el("span", "ap-time");
      row.append(node(), el("span", "ap-label", label), time);
      const log = el("pre", "ap-log");
      log.id = `ap-log-${id}`;
      log.hidden = true;
      row.onclick = () => { log.hidden = !log.hidden; row.setAttribute("aria-expanded", String(!log.hidden)); };
      li.append(row, log);
      rows.set(id, { li, row, time, log, start: 0, i });
      return li;
    }));
  };
  const live = () => { if (active) active.time.textContent = seconds(performance.now() - active.clientStart); };
  const finish = (r, state, at) => {
    r.li.dataset.state = state;
    r.time.textContent = seconds(Math.max(0, at - r.start));
    if (active === r) active = null;
  };
  const handle = (m) => {
    const r = rows.get(m.id);
    if (m.t === "plan") plan(m.steps);
    else if (m.t === "step" && r) {
      Object.assign(r, { start: m.at, clientStart: performance.now() });
      r.li.dataset.state = "active";
      active = r;
      live();
      // The newest step stays in view on short phone screens.
      r.li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (m.t === "log" && r) {
      r.log.append(`${m.text}\n`);
      if (!r.log.hidden) r.log.scrollTop = r.log.scrollHeight;
    } else if (m.t === "ok" && r) finish(r, "done", m.at);
    else if (m.t === "fail" && r) {
      finish(r, "failed", m.at);
      r.log.append(`${m.error}\n`);
      r.log.hidden = false;
      r.row.setAttribute("aria-expanded", "true");
    } else if (m.t === "done") thread = m.thread;
    else if (m.t === "error") throw new Error(m.error || "Could not start a premium session.");
  };

  tick = setInterval(live, 100);
  try {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) if (line.trim()) handle(JSON.parse(line));
      if (done) break;
    }
    if (buf.trim()) handle(JSON.parse(buf));
    if (!thread) throw new Error("The connection closed before the session started.");
    $("ap-title").textContent = "Premium session started";
    open.disabled = false;
    if (dlg.open) open.focus();
    return thread;
  } catch (e) {
    failed = true;
    if (active) finish(active, "failed", active.start + performance.now() - active.clientStart);
    $("ap-title").textContent = "Assignment stopped";
    error.textContent = e.message;
    error.hidden = false;
    open.textContent = "Back to settings";
    open.disabled = false;
    throw e;
  } finally { clearInterval(tick); }
}
