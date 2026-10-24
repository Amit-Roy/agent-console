// Automation page: a sidebar of workflows, the selected workflow's phases and steps, its triggers and failures, and a
// drawer with one step's log. Everything comes from GET /api/automation (see server/automation/contracts.ts); security
// rows come from GET /api/security/automations. The page holds no state beyond the selected workflow.
import { createMenu } from "/menu.js";
import { openCrashLog } from "/sec-crash-log.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const ICONS = {
  tag: "M2.5 8.2V3a.5.5 0 0 1 .5-.5h5.2l5.3 5.3-5.5 5.5zM5.2 5.2h.01",
  clock: "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5zM8 4.75V8l2.25 1.5",
  gauge: "M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l2.5-3.5",
  play: "M5.25 3.75v8.5L12 8z",
  route:
    "M4 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5.5 4H9a2 2 0 0 1 2 2v1M10.5 12H7a2 2 0 0 1-2-2V9",
  branch:
    "M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 5v6M11.5 8v.5a2 2 0 0 1-2 2H6",
  bot: "M4.5 5h7A1.5 1.5 0 0 1 13 6.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-5A1.5 1.5 0 0 1 4.5 5zM8 5V3M6 8.5v1M10 8.5v1",
  check: "m3.5 8.5 3 3 6-7",
  pr: "M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 5v6M11.5 11V7a2 2 0 0 0-2-2H8M9.5 3.5 8 5l1.5 1.5",
  eye: "M1.75 8s2.25-4.5 6.25-4.5S14.25 8 14.25 8s-2.25 4.5-6.25 4.5S1.75 8 1.75 8zM8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z",
  merge:
    "M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 5v6M4.5 5.5c0 2.2 2.2 3 5.5 3",
  rocket:
    "M9.5 2.5c2.5 0 4 1.5 4 4-1.2 3-3.5 4.5-5.5 5l-3-3c.5-2 2-4.3 4.5-6zM6 10l-2.5 2.5M5 7.5 3 8l1.5-2.5M8.5 11 8 13l2.5-1.5",
  redo: "M3 8a5 5 0 0 1 8.5-3.5L13 6M13 2.5V6H9.5M13 8a5 5 0 0 1-8.5 3.5L3 10M3 13.5V10h3.5",
  next: "M2.5 8h10M9 4.5 12.5 8 9 11.5",
  back: "M13.5 8h-10M7 4.5 3.5 8 7 11.5",
  database:
    "M8 2.5c3 0 5 .7 5 1.5S11 5.5 8 5.5 3 4.8 3 4s2-1.5 5-1.5zM3 4v4c0 .8 2 1.5 5 1.5s5-.7 5-1.5V4M3 8v4c0 .8 2 1.5 5 1.5s5-.7 5-1.5V8",
  shield: "M8 2 3 4v3.5c0 2.8 2 5.1 5 6.5 3-1.4 5-3.7 5-6.5V4z",
  scan: "M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3M2.5 8h11",
  mail: "M2.5 4.5h11v7h-11zM2.5 5 8 9l5.5-4",
  bell: "M8 2.5a3.5 3.5 0 0 1 3.5 3.5c0 2.5.5 3.5 1.5 4.5H3c1-1 1.5-2 1.5-4.5A3.5 3.5 0 0 1 8 2.5zM6.5 12.5a1.5 1.5 0 0 0 3 0",
  activity: "M2.5 8.5h2l1.5-4 2 7 1.5-3h4",
  layers: "M8 2.5 14 6l-6 3.5L2 6zM2 9.5 8 13l6-3.5M2 12l6 3.5 6-3.5",
  chart: "M3 13V8M6.5 13V5M10 13V9M13.5 13V3",
  scale: "M8 2.5v10.5M5 13h6M3 5h10M3 5.5 1.75 9.5h2.5zM13 5.5l-1.25 4h2.5z",
  plus: "M8 3v10M3 8h10",
  chev: "m4.5 6.5 3.5 3.5 3.5-3.5",
};
const icon = (name) => {
  const s = svg("svg", { class: "ico", viewBox: "0 0 16 16", "aria-hidden": "true" });
  s.append(svg("path", { d: ICONS[name] || ICONS.play }));
  return s;
};

const STATE_TEXT = {
  idle: "Idle",
  active: "Working",
  ok: "OK",
  failed: "Failed",
  abandoned: "Overdue",
  disabled: "Off",
};

const time = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
const when = (ts, now) => {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${day(ts)} ${time(ts)}`;
};
const until = (ts, now) => {
  const s = Math.max(0, (ts - now) / 1000);
  if (s < 90) return "in under a min";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `${day(ts)} ${time(ts)}`;
};

let snap = null;
let sec = null;
let secError = null;
let openStep = null;
let selected = null;
let detailFor = null;
const logState = { entries: [], next: undefined };

async function getJson(url, init) {
  const r = await fetch(url, { cache: "no-store", ...init });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

// ---------- workflow data ----------
const pipelineOf = (id) => snap?.flow.pipelines.find((p) => p.id === id) || null;
const stepIdsOf = (p) => p.phases.flatMap((ph) => ph.steps);
const pipelineOfStep = (id) => snap?.flow.pipelines.find((p) => stepIdsOf(p).includes(id)) || null;
const isSecurity = (p) => p?.group === "security";

/** Security rows, and the VPS unit each drawn step stands for. A step with no row keeps its last verdict. */
const SEC_ROWS = {
  cve: [
    "opencve-sync",
    "opencve-webhook",
    "tool-watch",
    "tool-patch",
    "opencve-digest",
    "opencve-backup",
  ],
  runtime: ["falco-alert", "crashes"],
  scans: ["secscan", "osv"],
  deadman: ["heartbeat"],
};
const SEC_ROW_MAP = {
  opencve: ["opencve-sync"],
  receiver: ["opencve-webhook"],
  tool_watch: ["tool-watch"],
  tool_patch: ["tool-patch"],
  digest: ["opencve-digest"],
  falco: ["falco-alert"],
  falco_queue: ["falco-alert"],
  scan: ["secscan"],
  osv_check: ["osv"],
  report: ["secscan", "osv"],
  heartbeat: ["heartbeat"],
  status_check: ["heartbeat"],
};
const TONE_STATE = { ok: "ok", warn: "abandoned", bad: "failed", idle: "idle" };
const TONE_RANK = { bad: 3, warn: 2, idle: 1, ok: 0 };

function secRows(p) {
  const ids = SEC_ROWS[p.id] || [];
  const rows = sec?.rows || [];
  const out = rows
    .filter((r) => ids.includes(r.id))
    .sort((a, b) => {
      const ai = ids.indexOf(a.id),
        bi = ids.indexOf(b.id);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  const down = rows.filter((r) => r.id === "status-host");
  return down.length ? [...down, ...out] : out;
}
function securityView(id, pipeline) {
  const p = pipeline || pipelineOfStep(id);
  if (!isSecurity(p)) return null;
  if (!sec) return { state: "idle", sub: secError ? "Status unavailable" : "Loading…" };
  const all = secRows(p);
  if (id === "push") {
    const bad = all.filter((r) => r.tone === "bad").length;
    const last = all.reduce((a, b) => Math.max(a, b.lastRun || 0), 0) || null;
    return {
      state: bad ? "failed" : "idle",
      ...(last ? { lastAt: last } : {}),
      sub: bad ? "Alert raised" : "Ready",
    };
  }
  const mapped = SEC_ROW_MAP[id] ? all.filter((r) => SEC_ROW_MAP[id].includes(r.id)) : [];
  const rows = mapped.length ? mapped : all;
  if (!rows.length) return { state: "idle", sub: "No check reported" };
  const worst = rows.reduce((a, b) => (TONE_RANK[b.tone] > TONE_RANK[a.tone] ? b : a));
  const last = rows.reduce((a, b) => Math.max(a, b.lastRun || 0), 0) || null;
  return {
    state: TONE_STATE[worst.tone] || "idle",
    ...(last ? { lastAt: last } : {}),
    sub: rows.length > 1 ? `${worst.label} · ${rows.length} checks` : worst.label,
    say: worst.detail || worst.schedule,
  };
}
/** The selected workflow owns a shared step (the phone alert, the transport) while it is open. */
function currentPipeline(id) {
  const p = pipelineOf(selected);
  return p && stepIdsOf(p).includes(id) ? p : null;
}
function viewOf(id) {
  const sv = securityView(id, currentPipeline(id));
  if (sv) return sv;
  return snap?.steps.find((x) => x.id === id) || { state: "idle", open: 0, failures: 0 };
}

const TOGGLES = {
  "dispatch-tick": "dispatcher",
  "opener-tick": "opener",
  "effort-weekly": "effort_schedule",
};
async function toggle(target, enabled, btn) {
  btn.disabled = true;
  try {
    render(
      await getJson("/api/automation/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, enabled }),
      }),
    );
  } catch (e) {
    alert(`Could not change automation: ${e.message}`);
    btn.disabled = false;
  }
}

// ---------- steps ----------
function stepNode(n) {
  const b = el("button", "node");
  b.type = "button";
  b.dataset.step = n.id;
  b.title = n.hint;
  const ni = el("span", "ni");
  ni.append(icon(n.icon));
  b.append(ni, el("span", "nl", n.label), el("span", "ns"));
  b.onclick = () => openDrawer(n.id);
  return b;
}

function buildChain(s, p) {
  const edges = new Map(s.flow.edges.map((e) => [`${e.from}>${e.to}`, e]));
  const arrow = (name, label) => {
    const a = el("span", "arrow");
    a.append(icon(name));
    if (label) a.append(el("span", "", label));
    return a;
  };
  const phases = el("ol", "phases");
  p.phases.forEach((ph, i) => {
    const li = el("li", "phase");
    li.append(el("h3", "", `${i + 1}. ${ph.label}`));
    const chain = el("div", "chain");
    let box;
    ph.steps.forEach((id, j) => {
      const n = s.flow.nodes.find((x) => x.id === id);
      if (!n) return;
      const inLoop = ph.loop?.steps.includes(id);
      if (j) {
        const prev =
          (!inLoop && ph.loop?.steps.find((x) => edges.has(`${x}>${id}`))) || ph.steps[j - 1];
        const fwd = edges.get(`${prev}>${id}`),
          back = inLoop && box && edges.get(`${id}>${prev}`);
        const link = el("span", `link${back ? " loop" : ""}`);
        link.dataset.to = id;
        link.append(arrow("next", fwd?.label));
        if (back) link.append(arrow("back", back.label));
        (inLoop && box ? box : chain).append(link);
      }
      if (inLoop && !box) {
        box = el("div", "cycle");
        box.append(el("span", "cap", ph.loop.label));
        chain.append(box);
      }
      (inLoop ? box : chain).append(stepNode(n));
    });
    li.append(chain);
    phases.append(li);
  });
  return phases;
}

function updateFlow(s) {
  for (const st of s.steps) {
    const b = document.querySelector(`[data-step="${st.id}"]`);
    if (!b) continue;
    const v = viewOf(st.id);
    b.dataset.state = v.state;
    const sub =
      v.sub ??
      (v.state === "idle"
        ? STATE_TEXT.idle
        : `${STATE_TEXT[v.state]}${v.lastAt ? ` · ${when(v.lastAt, s.now)}` : ""}`);
    b.querySelector(".ns").textContent = sub;
    const node = s.flow.nodes.find((n) => n.id === st.id);
    b.setAttribute(
      "aria-label",
      `${node?.label}: ${STATE_TEXT[v.state].toLowerCase()}${v.failures ? `, ${v.failures} failures in 24 hours` : ""}`,
    );
    let badge = b.querySelector(".badge");
    const count = v.failures || 0;
    if (count) {
      if (!badge) {
        badge = el("span", "badge");
        b.append(badge);
      }
      badge.textContent = String(count);
    } else badge?.remove();
    document
      .querySelector(`.link[data-to="${st.id}"]`)
      ?.classList.toggle("live", v.state === "active");
  }
  for (const t of s.triggers) {
    const w = document.querySelector(`[data-trigger="${t.id}"] .w`);
    if (w) w.textContent = t.enabled ? (t.lastAt ? when(t.lastAt, s.now) : "waiting") : "off";
    const sw = document.querySelector(`[data-trigger="${t.id}"] .tog`);
    if (sw) {
      sw.textContent = t.enabled ? "On" : "Off";
      sw.setAttribute("aria-checked", String(t.enabled));
      sw.setAttribute("aria-label", `${t.label}: ${t.enabled ? "on" : "off"}`);
      sw.disabled = false;
      sw.onclick = () => toggle(TOGGLES[t.id], !t.enabled, sw);
    }
    document.querySelector(`[data-trigger="${t.id}"]`)?.classList.toggle("off", !t.enabled);
  }
}

// ---------- sidebar ----------
function navItems() {
  return snap.flow.pipelines.map((p) => ({
    id: p.id,
    label: p.label,
    icon: p.icon,
    group: p.group,
  }));
}
function pipelineStatus(id) {
  const p = pipelineOf(id);
  if (!p) return "";
  if (isSecurity(p)) {
    const rows = secRows(p);
    const bad = rows.filter((r) => r.tone === "bad").length;
    const warn = rows.filter((r) => r.tone === "warn").length;
    if (!sec) return secError ? "Status unavailable" : "Loading…";
    return bad ? `${bad} failing` : warn ? `${warn} overdue` : "All OK";
  }
  const steps = stepIdsOf(p).map(viewOf);
  const bad = steps.filter((s) => s.state === "failed").length;
  const active = steps.filter((s) => s.state === "active").length;
  if (bad) return `${bad} failed`;
  if (active) return "Working";
  const disabled = steps.every((s) => s.state === "disabled");
  return disabled ? "Off" : "Idle";
}
function statusTone(id) {
  const p = pipelineOf(id);
  if (!p) return "";
  if (isSecurity(p)) {
    if (!sec) return "idle";
    const rows = secRows(p);
    return rows.some((r) => r.tone === "bad")
      ? "bad"
      : rows.some((r) => r.tone === "warn")
        ? "warn"
        : "ok";
  }
  const steps = stepIdsOf(p).map(viewOf);
  if (steps.some((s) => s.state === "failed")) return "bad";
  if (steps.some((s) => s.state === "active")) return "live";
  return "idle";
}
function buildNav() {
  const nav = $("wf-nav");
  if (nav.childElementCount) return;
  for (const [group, title] of [
    ["workflow", "Workflows"],
    ["security", "Security"],
  ]) {
    const items = navItems().filter((i) => i.group === group);
    if (!items.length) continue;
    const box = el("div", "rail-group");
    box.append(el("h2", "rail-title", title));
    for (const item of items) {
      const b = el("button", "rail-item");
      b.type = "button";
      b.dataset.wf = item.id;
      b.append(icon(item.icon), el("span", "rl", item.label), el("span", "rs"));
      b.onclick = () => select(item.id);
      box.append(b);
    }
    nav.append(box);
  }
}
let wfMenu;
const wfItems = () =>
  navItems().map((item) => ({
    value: item.id,
    label: `${item.label} · ${pipelineStatus(item.id)}`,
    group: item.group === "security" ? "Security" : "Workflows",
  }));
const wfTrigger = (item, button) =>
  button.replaceChildren(el("span", "", item?.label ?? "Choose workflow"), icon("chev"));
function buildPicker() {
  if (wfMenu) return;
  wfMenu = createMenu({
    trigger: $("wf-select"),
    label: "Workflow",
    getItems: wfItems,
    renderTrigger: wfTrigger,
    onSelect: (id) => select(id),
  });
}
function updateNav() {
  for (const b of document.querySelectorAll("[data-wf]")) {
    const id = b.dataset.wf;
    b.querySelector(".rs").textContent = pipelineStatus(id);
    b.dataset.tone = statusTone(id);
    if (id === selected) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const hidden = document.querySelectorAll("[data-wf]").length <= 1;
  $("wf-nav").hidden = hidden;
  const button = $("wf-select");
  if (button && wfMenu) {
    wfMenu.setItems(wfItems(), selected);
    button.dataset.value = selected;
    button.dataset.tone = statusTone(selected);
    $("wf-picker").hidden = hidden;
  }
}

function select(id) {
  if (!snap) return;
  if (!navItems().some((i) => i.id === id)) id = "pr";
  if (id === selected) return;
  selected = id;
  detailFor = null;
  const hash = `#${id}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
  render(snap);
  $("am").focus({ preventScroll: true });
}

// ---------- panels ----------
function panel(title, sub) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div");
  t.append(el("h2", "", title));
  if (sub) t.append(el("p", "sub", sub));
  head.append(t);
  p.append(head);
  return p;
}
const empty = (text) => el("div", "empty-c", text);

function triggersPanel(s, p) {
  const trig = s.triggers.filter((t) => t.pipeline === p.id);
  const box = panel("Triggers", "What starts this workflow");
  if (!trig.length) {
    box.append(empty("No trigger is attached to this workflow."));
    return box;
  }
  const ul = el("ul", "ptrig");
  ul.id = "triggers";
  for (const t of trig) {
    const li = el("li", t.enabled ? "" : "off");
    li.dataset.trigger = t.id;
    li.title = t.detail;
    li.append(el("span", "k", t.kind), el("span", "", t.label), el("span", "w"));
    const target = TOGGLES[t.id];
    if (target) {
      const sw = el("button", "tog", t.enabled ? "On" : "Off");
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(t.enabled));
      sw.setAttribute("aria-label", `${t.label}: ${t.enabled ? "on" : "off"}`);
      sw.onclick = () => toggle(target, !t.enabled, sw);
      li.append(sw);
    }
    ul.append(li);
  }
  box.append(ul);
  return box;
}

function failuresPanel(s, p) {
  const ids = p ? stepIdsOf(p) : [];
  const list = p ? s.failures.filter((f) => ids.includes(f.step)) : [];
  const box = panel("Failures", "Most recent first · Resolved entries remain in history");
  const ul = el("ul", "rows");
  ul.id = "failures";
  if (!list.length) box.append(empty("No failures recorded for this workflow."));
  for (const f of list) {
    const li = el("li");
    const button = el("button", "failure-row");
    button.type = "button";
    button.dataset.failure = JSON.stringify([f.ts, f.step, f.ref, f.msg]);
    const label = s.flow.nodes.find((n) => n.id === f.step)?.label || f.step;
    button.append(
      el("span", "a", `${label}${f.ref ? ` · ${f.ref}` : ""}`),
      el("span", "b", when(f.ts, s.now)),
      el("span", f.resolvedAt != null ? "c" : "c bad", f.msg || "No message"),
      el(
        "span",
        f.resolvedAt != null ? "c" : "c bad",
        f.resolvedAt != null ? `Resolved · ${when(f.resolvedAt, s.now)}` : "Unresolved",
      ),
    );
    button.setAttribute("aria-haspopup", "dialog");
    button.onclick = () => openDrawer(f.step, button);
    li.append(button);
    ul.append(li);
  }
  if (list.length) box.append(ul);
  return box;
}

function hooksPanel(s) {
  const p = panel("Git hooks", "Dispatched worktrees refuse pushes to the default branch");
  const ul = el("ul", "rows");
  ul.id = "hooks";
  if (!s.hooks.length) {
    const li = el("li");
    li.append(el("span", "c", "No dispatched worktrees have hooks right now."));
    ul.append(li);
  }
  for (const h of s.hooks) {
    const li = el("li");
    li.append(
      el("span", "a", h.worktree),
      el("span", "b", `${h.hook} blocks ${h.protects}`),
      el("span", "c", h.path),
    );
    ul.append(li);
  }
  p.append(ul);
  return p;
}

function runsPanel(s, p) {
  const list = p.id === "pr" ? s.runs.filter((r) => r.role !== "debug") : [];
  const box = panel("Runs", "Threads this workflow started");
  const ul = el("ul", "rows");
  ul.id = "runs";
  if (!list.length) box.append(empty("No runs from this workflow yet."));
  for (const r of list) {
    const li = el("li");
    const a = el("a", "a", r.title);
    a.href = `/#thread=${encodeURIComponent(r.thread)}`;
    const name = el("span", "a");
    name.append(a);
    li.append(
      name,
      el("span", "b", `${r.role} · ${r.effort} · ${r.state}`),
      el("span", "c", r.key),
    );
    if (r.role === "work") {
      const retry = [];
      if (r.retryAttempts != null) retry.push(`Retries ${r.retryAttempts}`);
      if (r.recoveries != null && r.retriesRemaining != null)
        retry.push(`Task budget: ${r.recoveries} used, ${r.retriesRemaining} remaining`);
      if (r.premiumStatus) retry.push(`Premium ${r.premiumStatus}`);
      if (retry.length) li.append(el("span", "c", retry.join(" · ")));
    }
    ul.append(li);
  }
  if (list.length) box.append(ul);
  return box;
}

function configPanel(s, section) {
  const dispatch = section === "dispatch";
  const p = panel(
    "Settings",
    `${dispatch ? "Window dispatch" : "Window opener"} · ~/.config/agent-console/window-dispatch.json`,
  );
  const dl = el("dl", "kv");
  const add = (k, v) =>
    dl.append(el("dt", "", k), el("dd", "", Array.isArray(v) ? v.join(", ") : String(v)));
  const d = s.config.dispatch,
    o = s.config.opener;
  if (dispatch) {
    add("Dispatcher", d.enabled ? (d.dryRun ? "dry run" : "live") : "off");
    add("Last minutes of a window", d.leadMinutes);
    add("Skip windows used above", `${d.maxUsedPct}%`);
    add("Issues per window", d.perWindow);
    add("Repositories", d.repos);
    add("Issue authors", d.authors);
    add("Routing", `${d.routing?.mode}${d.routing?.bauOnPi ? ", BAU on Pi" : ""}`);
  } else {
    add("Opener", o.enabled ? (o.dryRun ? "dry run" : "live") : "off");
    add("Opener hours", `${o.from}–${o.to} ${o.tz}`);
    add("Opener providers", o.providers);
  }
  p.append(dl);
  return p;
}

// ---------- effort model ----------
async function runEffort(btn) {
  btn.disabled = true;
  try {
    await getJson("/api/automation/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline: "effort" }),
    });
    await refresh();
  } catch (e) {
    alert(`Could not start the run: ${e.message}`);
    btn.disabled = false;
  }
}
function retrainPanel(s, p) {
  const box = panel("Retrain", "Weekly, or at once · the triage worker runs it in the background");
  const running = stepIdsOf(p).some((id) => viewOf(id).state === "active");
  const b = el("button", "btn sm run-now", running ? "Running…" : "Run now");
  b.type = "button";
  b.id = "effort-run";
  b.disabled = running;
  b.onclick = () => runEffort(b);
  const row = el("div", "effort-run");
  row.append(b);
  box.append(row);
  return box;
}
function effortStepsPanel(s, p) {
  const box = panel(
    "Steps",
    "Each step switches on its own · ~/.config/agent-console/effort-model.json",
  );
  const ul = el("ul", "ptrig steps-sw");
  ul.id = "effort-steps";
  for (const id of stepIdsOf(p).filter((x) => x !== "effort_schedule")) {
    const node = s.flow.nodes.find((n) => n.id === id);
    const on = viewOf(id).state !== "disabled";
    const li = el("li", on ? "" : "off");
    li.dataset.effortStep = id;
    li.title = node?.hint || "";
    li.append(el("span", "", node?.label || id));
    const sw = el("button", "tog", on ? "On" : "Off");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(on));
    sw.setAttribute("aria-label", `${node?.label}: ${on ? "on" : "off"}`);
    sw.onclick = () => toggle(id, !on, sw);
    li.append(sw);
    ul.append(li);
  }
  box.append(ul);
  return box;
}

// ---------- security ----------
async function runNow(kind, btn) {
  btn.disabled = true;
  try {
    await getJson(
      kind === "quick-scan" ? "/api/security/run?mode=quick" : "/api/security/tools/run",
      { method: "POST" },
    );
    await refreshSecurity();
  } catch (e) {
    alert(`Could not start the run: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}
function securityChecks(p) {
  const box = panel("Runs and checks", "The VPS units behind this workflow · Updated every minute");
  box.id = "sec-auto";
  if (secError && !sec) {
    box.append(empty(`Security status is unavailable: ${secError}`));
    return box;
  }
  if (!sec) {
    box.append(empty("Loading security status…"));
    return box;
  }
  const ul = el("ul", "rows sec-rows");
  ul.id = "sec-rows";
  for (const r of secRows(p)) {
    const li = el("li", `sec-row ${r.tone}`);
    li.dataset.sec = r.id;
    li.dataset.tone = r.tone;
    const name = el("span", "a");
    name.append(el("span", `sdot ${r.tone}`));
    const a = el("a", "", r.name);
    a.href = r.link;
    if (/^https:/.test(r.link)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    name.append(a);
    const state = el("span", `b st ${r.tone}`, r.label);
    const facts = el(
      "span",
      "c",
      [
        r.schedule,
        r.lastRun
          ? `Last run ${when(r.lastRun, sec.generatedAt)}`
          : r.continuous
            ? "Always on"
            : "Never run",
        r.next ? `Next ${until(r.next, sec.generatedAt)}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    li.append(name, state, facts);
    if (r.detail) li.append(el("span", r.tone === "bad" ? "c bad" : "c", r.detail));
    if (r.runnable) {
      const b = el(
        "button",
        "btn sm run-now",
        r.runnable === "quick-scan" ? "Run quick scan" : "Run now",
      );
      b.type = "button";
      b.onclick = () => runNow(r.runnable, b);
      const c = el("span", "c");
      c.append(b);
      li.append(c);
    }
    if (r.id === "crashes") {
      const b = el("button", "btn sm crash-log-btn", "Log");
      b.type = "button";
      b.onclick = () => openCrashLog(b);
      const c = el("span", "c");
      c.append(b);
      li.append(c);
    }
    ul.append(li);
  }
  if (sec.stale)
    box.append(el("div", "empty-c", "The VPS did not answer; showing the last answer."));
  box.append(ul);
  return box;
}

// ---------- detail ----------
function workflowState(p) {
  if (isSecurity(p)) {
    if (!sec) return { text: secError ? "Unavailable" : "Loading…", tone: "off" };
    const rows = secRows(p);
    const bad = rows.filter((r) => r.tone === "bad").length;
    const warn = rows.filter((r) => r.tone === "warn").length;
    return {
      text: bad ? `${bad} failing` : warn ? `${warn} overdue` : "All OK",
      tone: bad ? "bad" : warn ? "warn" : "ok",
    };
  }
  const steps = stepIdsOf(p).map(viewOf);
  const bad = steps.filter((s) => s.state === "failed").length;
  const active = steps.filter((s) => s.state === "active").length;
  if (bad) return { text: `${bad} failed`, tone: "bad" };
  if (active) return { text: "Working", tone: "live" };
  if (steps.every((s) => s.state === "disabled")) return { text: "Off", tone: "off" };
  return { text: "Idle", tone: "ok" };
}

function detailHead(item) {
  const p = pipelineOf(item.id);
  const head = el("header", "wf-head");
  const ic = el("span", "wf-ic");
  ic.append(icon(item.icon));
  const text = el("div", "wf-title");
  text.append(el("h2", "", item.label));
  text.append(
    el(
      "p",
      "wf-hint",
      p ? p.hint : "Scheduled prompts and the Debug button, outside every drawn workflow",
    ),
  );
  head.append(ic, text);
  if (p) {
    const st = workflowState(p);
    const chip = el("span", `chip-s wf-state ${st.tone}`, st.text);
    if (isSecurity(p)) chip.id = "sec-summary";
    else chip.id = "wf-state";
    head.append(chip);
  }
  return head;
}

function buildDetail(s) {
  const item = navItems().find((i) => i.id === selected) || navItems()[0];
  const p = pipelineOf(item.id);
  const main = $("am");
  const nodes = [detailHead(item)];
  if (p) {
    const flow = el("section", "wf-flow panel");
    flow.dataset.pipeline = p.id;
    flow.append(buildChain(s, p));
    nodes.push(flow);
  }
  const tagged = (node, zone) => {
    node.dataset.zone = zone;
    return node;
  };
  if (p && isSecurity(p)) {
    nodes.push(tagged(securityChecks(p), "checks"));
  } else if (p && p.id === "pr") {
    const cols = el("div", "cols");
    cols.append(tagged(triggersPanel(s, p), "triggers"), tagged(failuresPanel(s, p), "failures"));
    const cols2 = el("div", "cols");
    cols2.append(tagged(runsPanel(s, p), "runs"), tagged(hooksPanel(s), "hooks"));
    nodes.push(cols, cols2, tagged(configPanel(s, "dispatch"), "config"));
  } else if (p && p.id === "windows") {
    const cols = el("div", "cols");
    cols.append(tagged(triggersPanel(s, p), "triggers"), tagged(failuresPanel(s, p), "failures"));
    nodes.push(cols, tagged(configPanel(s, "opener"), "config"));
  } else if (p && p.id === "effort") {
    const cols = el("div", "cols");
    cols.append(tagged(triggersPanel(s, p), "triggers"), tagged(failuresPanel(s, p), "failures"));
    const cols2 = el("div", "cols");
    cols2.append(tagged(retrainPanel(s, p), "retrain"), tagged(effortStepsPanel(s, p), "steps"));
    nodes.push(cols, cols2);
  } else if (p) {
    const cols = el("div", "cols");
    cols.append(tagged(triggersPanel(s, p), "triggers"), tagged(failuresPanel(s, p), "failures"));
    nodes.push(cols);
  }
  main.replaceChildren(...nodes);
  main.setAttribute("aria-busy", "false");
  detailFor = item.id;
  if (matchMedia("(max-width: 760px)").matches)
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-wf="${item.id}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "center" }),
    );
}

// ---------- render ----------
const modeChip = (label, c) => {
  const on = c.enabled,
    text = !on ? "off" : c.dryRun ? "dry run" : "live";
  return el("span", `chip-s ${!on ? "off" : c.dryRun ? "dry" : "live"}`, `${label}: ${text}`);
};

function render(s) {
  const focusedFailure = document.activeElement?.dataset?.failure;
  snap = s;
  $("am").setAttribute("aria-busy", "false");
  $("mode").replaceChildren(
    modeChip("Dispatcher", s.config.dispatch),
    modeChip("Opener", s.config.opener),
  );
  buildNav();
  buildPicker();
  if (detailFor !== selected) buildDetail(s);
  else {
    const p = pipelineOf(selected);
    const head = $("am").querySelector(".wf-head");
    if (p && head) {
      const st = workflowState(p);
      const chip = head.querySelector(".chip-s");
      if (chip) {
        chip.className = `chip-s wf-state ${st.tone}`;
        chip.textContent = st.text;
      }
    }
    // Refresh the panels in place: the step boxes keep their pulse and keyboard focus.
    const make = {
      triggers: () => (p ? triggersPanel(s, p) : null),
      failures: () => failuresPanel(s, p),
      runs: () => (p?.id === "pr" ? runsPanel(s, p) : null),
      hooks: () => hooksPanel(s),
      config: () =>
        p?.id === "pr"
          ? configPanel(s, "dispatch")
          : p?.id === "windows"
            ? configPanel(s, "opener")
            : null,
      checks: () => securityChecks(p),
      retrain: () => (p?.id === "effort" ? retrainPanel(s, p) : null),
      steps: () => (p?.id === "effort" ? effortStepsPanel(s, p) : null),
    };
    for (const zone of document.querySelectorAll("[data-zone]")) {
      const fresh = make[zone.dataset.zone]?.();
      if (!fresh) continue;
      fresh.dataset.zone = zone.dataset.zone;
      zone.replaceWith(fresh);
    }
  }
  updateNav();
  updateFlow(s);
  if (focusedFailure) findFailure(focusedFailure)?.focus({ preventScroll: true });
  if (openStep) fillDrawerFacts(openStep);
}

// ---------- drawer ----------
function fillDrawerFacts(id) {
  const st = viewOf(id),
    node = snap.flow.nodes.find((n) => n.id === id);
  if (!node) return;
  $("drawer-title").textContent = node.label;
  $("drawer-hint").textContent = node.hint;
  const f = $("drawer-facts");
  f.replaceChildren();
  const add = (k, v) => f.append(el("dt", "", k), el("dd", "", v));
  const p = currentPipeline(id) || pipelineOfStep(id);
  if (isSecurity(p)) {
    const rows = SEC_ROW_MAP[id]
      ? secRows(p).filter((r) => SEC_ROW_MAP[id].includes(r.id))
      : secRows(p);
    add("State", STATE_TEXT[st.state] || st.state);
    if (!rows.length) add("Checks", "The VPS did not report this step.");
    for (const r of rows) {
      add(r.name, `${r.label} · ${r.schedule}`);
      if (r.lastRun) add("Last run", `${when(r.lastRun, sec.generatedAt)} (${time(r.lastRun)})`);
      if (r.next) add("Next run", until(r.next, sec.generatedAt));
      if (r.detail) add("Detail", r.detail);
    }
    add("Where", "VPS units; full results are on the Security page.");
  } else {
    add("State", STATE_TEXT[st.state] || st.state);
    if (st.lastAt) add("Last event", `${when(st.lastAt, snap.now)} (${time(st.lastAt)})`);
    if (st.lastMsg) add("Last message", st.lastMsg);
    add("Running now", String(st.open ?? 0));
    add("Failures, 24 h", String(st.failures ?? 0));
  }
}

function renderLog() {
  const ol = $("drawer-log");
  ol.replaceChildren();
  if (!logState.entries.length) {
    const li = el("li");
    const p = currentPipeline(openStep) || pipelineOfStep(openStep);
    li.append(
      el(
        "span",
        "m",
        isSecurity(p)
          ? "This step runs on the VPS. Its runs are listed above."
          : "Nothing recorded for this step yet.",
      ),
    );
    ol.append(li);
  }
  for (const e of logState.entries) {
    const li = el("li");
    const m = el("span", "m", e.msg || "");
    if (e.ref) m.append(el("small", "", e.ref));
    li.append(el("time", "", `${day(e.ts)} ${time(e.ts)}`), el("span", `k ${e.kind}`, e.kind), m);
    ol.append(li);
  }
  $("drawer-more").hidden = logState.next == null;
}

async function loadLog(more = false) {
  const q = new URLSearchParams({ step: openStep, limit: "50" });
  if (more && logState.next != null) q.set("before", String(logState.next));
  const page = await getJson(`/api/automation/log?${q}`);
  if (page.step !== openStep) return;
  logState.entries = more ? logState.entries.concat(page.entries) : page.entries;
  logState.next = page.next;
  renderLog();
}

const findFailure = (key) =>
  [...document.querySelectorAll(".failure-row")].find((b) => b.dataset.failure === key);
let drawerFailure;
function openDrawer(id, trigger) {
  drawerFailure = trigger?.dataset.failure;
  openStep = id;
  logState.entries = [];
  logState.next = undefined;
  fillDrawerFacts(id);
  $("drawer").hidden = false;
  renderLog();
  loadLog().catch((e) => {
    logState.entries = [];
    $("drawer-log").replaceChildren(el("li", "m", e.message));
  });
  $("drawer-close").focus();
}
function closeDrawer() {
  if (!openStep) return;
  const id = openStep;
  openStep = null;
  $("drawer").hidden = true;
  (findFailure(drawerFailure) || document.querySelector(`[data-step="${id}"]`))?.focus();
}
$("drawer-close").onclick = closeDrawer;
$("drawer-more").onclick = () => loadLog(true).catch(() => {});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

// ---------- new workflow ----------
$("new-workflow").onclick = () => {
  location.href = "/?new=workflow";
};

// ---------- debug ----------
$("debug").onclick = async () => {
  const b = $("debug");
  b.disabled = true;
  try {
    const r = await getJson("/api/automation/debug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, ...(openStep ? { focus: openStep } : {}) }),
    });
    location.href = `/#thread=${encodeURIComponent(r.thread)}`;
  } catch (e) {
    $("status")?.remove();
    b.title = e.message;
    alert(`Could not start debugging: ${e.message}`);
  } finally {
    b.disabled = false;
  }
};

// ---------- refresh ----------
async function refresh() {
  try {
    const s = await getJson("/api/automation");
    snap = s;
    if (!selected) {
      const hash = location.hash.slice(1);
      selected = s.flow.pipelines.some((p) => p.id === hash) ? hash : "pr";
    }
    render(s);
    if (openStep) loadLog().catch(() => {});
  } catch (e) {
    const st = $("status");
    if (st) st.textContent = `Automation data is unavailable: ${e.message}`;
  }
}
async function refreshSecurity() {
  try {
    sec = await getJson("/api/security/automations");
    secError = null;
  } catch (e) {
    secError = e.message;
    sec = null;
  }
  if (snap) render(snap);
}
addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (snap && navItems().some((i) => i.id === id)) select(id);
});
await refresh();
void refreshSecurity();
setInterval(() => {
  if (!document.hidden) void refreshSecurity();
}, 30000);
setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
