// Automation dashboard: each workflow (PR workflow, window opener) as its own panel of phases and boxes with icons, the active
// step, a log per step, triggers, failures and git hooks.
// Everything comes from GET /api/automation (see server/automation/contracts.ts); the page holds no state of its own.
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
  route: "M4 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5.5 4H9a2 2 0 0 1 2 2v1M10.5 12H7a2 2 0 0 1-2-2V9",
  branch: "M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 5v6M11.5 8v.5a2 2 0 0 1-2 2H6",
  bot: "M4.5 5h7A1.5 1.5 0 0 1 13 6.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-5A1.5 1.5 0 0 1 4.5 5zM8 5V3M6 8.5v1M10 8.5v1",
  check: "m3.5 8.5 3 3 6-7",
  pr: "M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 5v6M11.5 11V7a2 2 0 0 0-2-2H8M9.5 3.5 8 5l1.5 1.5",
  eye: "M1.75 8s2.25-4.5 6.25-4.5S14.25 8 14.25 8s-2.25 4.5-6.25 4.5S1.75 8 1.75 8zM8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z",
  merge: "M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 5v6M4.5 5.5c0 2.2 2.2 3 5.5 3",
  rocket: "M9.5 2.5c2.5 0 4 1.5 4 4-1.2 3-3.5 4.5-5.5 5l-3-3c.5-2 2-4.3 4.5-6zM6 10l-2.5 2.5M5 7.5 3 8l1.5-2.5M8.5 11 8 13l2.5-1.5",
  redo: "M3 8a5 5 0 0 1 8.5-3.5L13 6M13 2.5V6H9.5M13 8a5 5 0 0 1-8.5 3.5L3 10M3 13.5V10h3.5",
  next: "M2.5 8h10M9 4.5 12.5 8 9 11.5",
  loop: "M2.5 6h10M9.5 3 12.5 6 9.5 9M13.5 10h-10M6.5 7 3.5 10l3 3",
};
const icon = (name) => {
  const s = svg("svg", { class: "ico", viewBox: "0 0 16 16", "aria-hidden": "true" });
  s.append(svg("path", { d: ICONS[name] || ICONS.play }));
  return s;
};

const STATE_TEXT = { idle: "Idle", active: "Working", ok: "OK", failed: "Failed", abandoned: "Abandoned", disabled: "Off" };

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
const when = (ts, now) => {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${day(ts)} ${time(ts)}`;
};

let snap = null;
let openStep = null;
const logState = { entries: [], next: undefined };

async function getJson(url, init) {
  const r = await fetch(url, { cache: "no-store", ...init });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

// ---------- workflows ----------
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

// One panel per workflow; inside it the phases in order, each a chain of steps. A step that loops back to the one before it
// (review and redo) gets a two-way link.
function buildPipeline(s, p) {
  const sec = panel(p.label, p.hint);
  sec.classList.add("pipeline");
  sec.dataset.pipeline = p.id;
  const trig = s.triggers.filter((t) => t.pipeline === p.id);
  if (trig.length) {
    const ul = el("ul", "ptrig");
    for (const t of trig) {
      const li = el("li", t.enabled ? "" : "off");
      li.dataset.trigger = t.id;
      li.title = t.detail;
      li.append(el("span", "k", t.kind), el("span", "", t.label), el("span", "w"));
      ul.append(li);
    }
    sec.append(ul);
  }
  const back = new Set(s.flow.edges.map((e) => `${e.from}>${e.to}`));
  const phases = el("ol", "phases");
  p.phases.forEach((ph, i) => {
    const li = el("li", "phase");
    li.append(el("h3", "", `${i + 1}. ${ph.label}`));
    const chain = el("div", "chain");
    ph.steps.forEach((id, j) => {
      const n = s.flow.nodes.find((x) => x.id === id);
      if (!n) return;
      if (j) {
        const prev = ph.steps[j - 1], loop = back.has(`${id}>${prev}`);
        const link = el("span", `link${loop ? " loop" : ""}`);
        link.dataset.to = id;
        link.append(icon(loop ? "loop" : "next"));
        chain.append(link);
      }
      chain.append(stepNode(n));
    });
    li.append(chain);
    phases.append(li);
  });
  sec.append(phases);
  return sec;
}

function updateFlow(s) {
  for (const st of s.steps) {
    const b = document.querySelector(`[data-step="${st.id}"]`);
    if (!b) continue;
    b.dataset.state = st.state;
    const sub = st.state === "idle" ? STATE_TEXT.idle : `${STATE_TEXT[st.state]}${st.lastAt ? ` · ${when(st.lastAt, s.now)}` : ""}`;
    b.querySelector(".ns").textContent = sub;
    b.setAttribute("aria-label", `${s.flow.nodes.find((n) => n.id === st.id)?.label}: ${STATE_TEXT[st.state].toLowerCase()}${st.failures ? `, ${st.failures} failures in 24 hours` : ""}`);
    let badge = b.querySelector(".badge");
    if (st.failures) {
      if (!badge) { badge = el("span", "badge"); b.append(badge); }
      badge.textContent = String(st.failures);
    } else badge?.remove();
    document.querySelector(`.link[data-to="${st.id}"]`)?.classList.toggle("live", st.state === "active");
  }
  for (const t of s.triggers) {
    const w = document.querySelector(`[data-trigger="${t.id}"] .w`);
    if (w) w.textContent = t.enabled ? (t.lastAt ? when(t.lastAt, s.now) : "waiting") : "off";
  }
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

function triggersPanel(s) {
  const p = panel("Other triggers", "Scheduled prompts and manual starts outside the workflows above");
  const ul = el("ul", "rows");
  ul.id = "triggers";
  for (const t of s.triggers.filter((x) => !x.pipeline)) {
    const li = el("li");
    li.append(el("span", "a", t.label), el("span", "b", t.enabled ? (t.lastAt ? when(t.lastAt, s.now) : "waiting") : "off"), el("span", "c", `${t.kind} · ${t.detail}`));
    ul.append(li);
  }
  p.append(ul);
  return p;
}

function failuresPanel(s) {
  const p = panel("Failures", "Most recent first");
  const ul = el("ul", "rows");
  ul.id = "failures";
  if (!s.failures.length) p.append(empty("No failures recorded."));
  for (const f of s.failures) {
    const li = el("li");
    const label = s.flow.nodes.find((n) => n.id === f.step)?.label || f.step;
    li.append(el("span", "a", `${label}${f.ref ? ` · ${f.ref}` : ""}`), el("span", "b", when(f.ts, s.now)), el("span", "c bad", f.msg || "No message"));
    li.style.cursor = "pointer";
    li.onclick = () => openDrawer(f.step);
    ul.append(li);
  }
  if (s.failures.length) p.append(ul);
  return p;
}

function hooksPanel(s) {
  const p = panel("Git hooks", "Dispatched worktrees refuse pushes to the default branch");
  const ul = el("ul", "rows");
  ul.id = "hooks";
  if (!s.hooks.length) { const li = el("li"); li.append(el("span", "c", "No dispatched worktrees have hooks right now.")); ul.append(li); }
  for (const h of s.hooks) {
    const li = el("li");
    li.append(el("span", "a", h.worktree), el("span", "b", `${h.hook} blocks ${h.protects}`), el("span", "c", h.path));
    ul.append(li);
  }
  p.append(ul);
  return p;
}

function runsPanel(s) {
  const p = panel("Runs", "Threads the automation started");
  const ul = el("ul", "rows");
  ul.id = "runs";
  if (!s.runs.length) p.append(empty("No automated threads yet."));
  for (const r of s.runs) {
    const li = el("li");
    const a = el("a", "a", r.title);
    a.href = `/#thread=${encodeURIComponent(r.thread)}`;
    const name = el("span", "a");
    name.append(a);
    li.append(name, el("span", "b", `${r.role} · ${r.effort} · ${r.state}`), el("span", "c", r.key));
    ul.append(li);
  }
  if (s.runs.length) p.append(ul);
  return p;
}

function configPanel(s) {
  const p = panel("Settings", "~/.config/agent-console/window-dispatch.json");
  const dl = el("dl", "kv");
  const add = (k, v) => dl.append(el("dt", "", k), el("dd", "", Array.isArray(v) ? v.join(", ") : String(v)));
  const d = s.config.dispatch, o = s.config.opener;
  add("Dispatcher", d.enabled ? (d.dryRun ? "dry run" : "live") : "off");
  add("Last minutes of a window", d.leadMinutes); add("Skip windows used above", `${d.maxUsedPct}%`); add("Issues per window", d.perWindow);
  add("Repositories", d.repos); add("Issue authors", d.authors);
  add("Routing", `${d.routing?.mode}${d.routing?.bauOnPi ? ", BAU on Pi" : ""}`);
  add("Opener", o.enabled ? (o.dryRun ? "dry run" : "live") : "off");
  add("Opener hours", `${o.from}–${o.to} ${o.tz}`); add("Opener providers", o.providers);
  p.append(dl);
  return p;
}

const modeChip = (label, c) => {
  const on = c.enabled, text = !on ? "off" : c.dryRun ? "dry run" : "live";
  return el("span", `chip-s ${!on ? "off" : c.dryRun ? "dry" : "live"}`, `${label}: ${text}`);
};

function render(s) {
  snap = s;
  const main = $("am");
  main.setAttribute("aria-busy", "false");
  $("mode").replaceChildren(modeChip("Dispatcher", s.config.dispatch), modeChip("Opener", s.config.opener));
  if (!main.querySelector(".pipeline")) {
    main.replaceChildren(...s.flow.pipelines.map((p) => buildPipeline(s, p)), el("div", "cols"), el("div", "cols"));
  }
  updateFlow(s);
  const [a, b] = main.querySelectorAll(".cols");
  a.replaceChildren(failuresPanel(s), triggersPanel(s));
  b.replaceChildren(runsPanel(s), hooksPanel(s), configPanel(s));
  if (openStep) fillDrawerFacts(openStep);
}

// ---------- drawer ----------
function fillDrawerFacts(id) {
  const st = snap.steps.find((x) => x.id === id), node = snap.flow.nodes.find((n) => n.id === id);
  if (!st || !node) return;
  $("drawer-title").textContent = node.label;
  $("drawer-hint").textContent = node.hint;
  const f = $("drawer-facts");
  f.replaceChildren();
  const add = (k, v) => f.append(el("dt", "", k), el("dd", "", v));
  add("State", STATE_TEXT[st.state]);
  if (st.lastAt) add("Last event", `${when(st.lastAt, snap.now)} (${time(st.lastAt)})`);
  if (st.lastMsg) add("Last message", st.lastMsg);
  add("Running now", String(st.open));
  add("Failures, 24 h", String(st.failures));
}

function renderLog() {
  const ol = $("drawer-log");
  ol.replaceChildren();
  if (!logState.entries.length) { const li = el("li"); li.append(el("span", "m", "Nothing recorded for this step yet.")); ol.append(li); }
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

function openDrawer(id) {
  openStep = id;
  logState.entries = []; logState.next = undefined;
  fillDrawerFacts(id);
  $("drawer").hidden = false;
  renderLog();
  loadLog().catch((e) => { logState.entries = []; $("drawer-log").replaceChildren(el("li", "m", e.message)); });
  $("drawer-close").focus();
}
function closeDrawer() {
  if (!openStep) return;
  const id = openStep;
  openStep = null;
  $("drawer").hidden = true;
  document.querySelector(`[data-step="${id}"]`)?.focus();
}
$("drawer-close").onclick = closeDrawer;
$("drawer-more").onclick = () => loadLog(true).catch(() => {});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ---------- debug ----------
$("debug").onclick = async () => {
  const b = $("debug");
  b.disabled = true;
  try {
    const r = await getJson("/api/automation/debug", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, ...(openStep ? { focus: openStep } : {}) }) });
    location.href = `/#thread=${encodeURIComponent(r.thread)}`;
  } catch (e) {
    $("status")?.remove();
    b.title = e.message;
    alert(`Could not start debugging: ${e.message}`);
  } finally { b.disabled = false; }
};

// ---------- refresh ----------
async function refresh() {
  try {
    const s = await getJson("/api/automation");
    render(s);
    if (openStep) loadLog().catch(() => {});
  } catch (e) {
    const st = $("status");
    if (st) st.textContent = `Automation data is unavailable: ${e.message}`;
  }
}
await refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

