// Host dashboard: CPU, RAM, disk, htop-style process list with kill, listening ports.
// Plain fetch + DOM, mirroring the usage dashboard's patterns and tokens.
const REFRESH = 2000;
let timer = null, paused = false, seq = 0;
const sort = { key: "cpu", dir: -1 };
const confirming = new Set(); // pids awaiting "Sure?" confirmation
const $ = id => document.getElementById(id);
const tip = $("tip");
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls != null) {
    if (typeof cls === "object") for (const [k, v] of Object.entries(cls)) n.setAttribute(k, v);
    else n.className = cls;
  }
  if (text != null) n.textContent = text;
  return n;
};
const bytes = (b) => {
  if (!Number.isFinite(b)) return "—";
  const neg = b < 0; b = Math.abs(b); const u = ["B","KB","MB","GB","TB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (neg ? "−" : "") + (i === 0 ? String(Math.round(b)) : b.toFixed(1)) + " " + u[i];
};
const pct = (n) => Number.isFinite(n) ? (n >= 10 ? Math.round(n) : n.toFixed(1)) + "%" : "—";
const tier = (n) => n >= 95 ? "bad" : n >= 80 ? "warn" : "";

function showTip(e, title, rows) {
  tip.replaceChildren(el("b", "", title), ...rows.map(([k, v]) => { const r = el("div", "r"); r.append(el("span", "", k), el("span", "", v)); return r; }));
  tip.hidden = false;
  const pad = 12, w = tip.offsetWidth, hh = tip.offsetHeight;
  const x = e.clientX, y = e.clientY;
  tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x + pad))}px`;
  tip.style.top = `${Math.max(8, y - hh - pad < 8 ? y + pad : y - hh - pad)}px`;
}
const hideTip = () => { tip.hidden = true; };
function toast(text, tone) {
  const t = $("toast");
  t.textContent = text; t.className = tone === "bad" ? "bad" : tone === "ok" ? "ok" : "";
  t.classList.add("show");
  setTimeout(() => { t.classList.remove("show"); }, 2500);
}

async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

// ---------- widgets ----------

function kpi(label, value, sub) {
  const k = el("div", "kpi");
  k.append(el("div", "l", label), el("div", "v", value), el("div", "d", sub || " "));
  return k;
}
function kpiRow(m) {
  const topDisk = m.disk.length ? m.disk[0] : null;
  const ks = el("div", "kpis");
  ks.append(
    kpi("CPU", pct(m.cpu.total), `${m.cpu.n} core${m.cpu.n !== 1 ? "s" : ""}`),
    kpi("RAM", pct(m.mem.pct), `${bytes(m.mem.used)} / ${bytes(m.mem.total)}`),
    kpi("Disk", topDisk ? pct(topDisk.pcent) : "—", topDisk ? `${bytes(topDisk.used)} / ${bytes(topDisk.size)} · ${topDisk.target}` : "no mounts"),
    kpi("Load", m.load.slice(0, 3).map(x => x.toFixed(2)).join(" · "), "1 · 5 · 15 min"),
  );
  return ks;
}
function gauge(label, value) {
  const cls = tier(value);
  const g = el("div", "gauge wrap");
  g.append(el("div", "l", label));
  const bar = el("div", "gauge");
  const fill = el("i"); fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (cls) bar.classList.add(cls);
  bar.append(fill);
  const v = el("div", "v"); v.textContent = pct(value);
  g.append(bar, v);
  return g;
}
function cpuPanel(m) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div"); t.append(el("h2", "", "CPU"), el("p", "sub", "Utilisation measured over two samples, per core"));
  head.append(t); p.append(head);
  const body = el("div");
  body.append(gauge("CPU", m.cpu.total));
  const cores = el("div", "cores");
  for (let i = 0; i < m.cpu.cores.length; i++) {
    const c = el("div", "core");
    const name = el("div", "n", `Core ${i}`);
    const bar = el("div", "b"); const fill = el("i");
    fill.style.width = `${Math.max(0, Math.min(100, m.cpu.cores[i]))}%`;
    const cls = tier(m.cpu.cores[i]); if (cls) fill.classList.add(cls);
    bar.append(fill);
    c.append(name, bar, el("div", "v", pct(m.cpu.cores[i])));
    cores.append(c);
  }
  body.append(cores);
  p.append(body);
  return p;
}
function memPanel(m) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div"); t.append(el("h2", "", "Memory"), el("p", "sub", "Used = total − available (includes page cache)"));
  head.append(t); p.append(head);
  const body = el("div");
  body.append(gauge("RAM", m.mem.pct));
  if (m.mem.swapTotal > 0) body.append(gauge("Swap", m.mem.swapTotal > 0 ? (1 - m.mem.swapFree / m.mem.swapTotal) * 100 : 0));
  p.append(body);
  return p;
}
function diskPanel(m) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div"); t.append(el("h2", "", "Disk"), el("p", "sub", "Usage by mount point"));
  head.append(t); p.append(head);
  const body = el("div");
  if (!m.disk.length) { body.append(el("div", "empty-c", "No disk mounts.")); p.append(body); return p; }
  for (const d of m.disk) {
    const row = el("div", "mount");
    const l = el("div", "l"); l.append(el("b", "", d.target), el("div", "m", `${bytes(d.used)} / ${bytes(d.size)} · ${d.fstype}`));
    const g = el("div", "gauge"); const cls = tier(d.pcent); if (cls) g.classList.add(cls);
    const fill = el("i"); fill.style.width = `${d.pcent}%`; g.append(fill);
    const v = el("div", "v"); v.textContent = pct(d.pcent);
    row.append(l, g, v);
    body.append(row);
  }
  for (const label of ["root", "home"]) {
    const dirs = m.dirs?.[label] || [];
    if (!dirs.length) continue;
    const title = label === "root" ? "/" : "/home/coder";
    const sec = el("div", "dirsec");
    sec.append(el("div", "l", el("b", "", title), el("div", "m", `Top directories`)));
    for (const d of dirs) {
      const row = el("div", "dirrow");
      const l2 = el("div", "l"); l2.append(el("b", "", d.path.replace(title + "/", "") || title), el("div", "m", bytes(d.size)));
      const g = el("div", "gauge"); const pctV = m.disk.length ? Math.round((d.size / m.disk[0].size) * 100) : 0; const cls = tier(pctV); if (cls) g.classList.add(cls);
      const fill = el("i"); fill.style.width = `${Math.min(100, pctV)}%`; g.append(fill);
      const v = el("div", "v"); v.textContent = pct(pctV);
      row.append(l2, g, v);
      sec.append(row);
    }
    body.append(sec);
  }
  p.append(body);
  return p;
}
function loadPanel(m) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div"); t.append(el("h2", "", "Load & uptime"), el("p", "sub", "Load average and time since boot"));
  head.append(t); p.append(head);
  const body = el("div", "kv");
  const boot = new Date(m.boot).toLocaleString();
  const up = m.uptime; const h = Math.floor(up / 3600), min = Math.floor((up % 3600) / 60);
  for (const [k, v] of [["Load 1 min", m.load[0].toFixed(2)], ["Load 5 min", m.load[1].toFixed(2)], ["Load 15 min", m.load[2].toFixed(2)], ["Uptime", `${h}h ${min}m`], ["Booted", boot]]) {
    const row = el("div"); row.append(el("span", "k", k + "\u00A0"), el("span", "v", v)); body.append(row);
  }
  p.append(body);
  return p;
}
function stateClass(s) { const m = { r: "r", s: "s", d: "d", z: "z", t: "t" }; return "state " + (m[s] || ""); }

function sortBtn(key, label, onChange) {
  const b = el("button", "", label); b.type = "button";
  b.dataset.sort = key;
  b.setAttribute("aria-pressed", String(sort.key === key));
  if (sort.key === key) b.classList.add(sort.dir < 0 ? "desc" : "asc");
  b.onclick = () => {
    if (sort.key === key) sort.dir = -sort.dir;
    else { sort.key = key; sort.dir = key === "cpu" || key === "mem" ? -1 : 1; }
    onChange();
  };
  return b;
}

function procsPanel(list) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div"); t.append(el("h2", "", "Processes"), el("p", "sub", "Owned by this user. Kill sends SIGTERM; Sure? confirms."));
  const bar = el("div", "seg"); bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Sort");
  bar.append(sortBtn("name", "Name", () => void load()), sortBtn("cpu", "CPU", () => void load()), sortBtn("mem", "MEM", () => void load()), sortBtn("pid", "PID", () => void load()));
  for (const x of bar.children) if (x.dataset.sort === sort.key) { x.setAttribute("aria-pressed", "true"); x.classList.add(sort.dir < 0 ? "sort-desc" : "sort-asc"); }
  head.append(t, bar); p.append(head);
  const wrap = el("div", "scroll");
  const table = el("table", "proc");
  const thead = el("thead"); const trh = el("tr");
  for (const c of ["Name", "PID", "User", "CPU", "MEM", "State", "Threads", ""]) trh.append(el("th", "", c));
  thead.append(trh); table.append(thead);
  const tbody = el("tbody");
  const rows = [...list].sort((a, b) => {
    let va = a[sort.key], vb = b[sort.key];
    if (sort.key === "name") { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
    if (va === vb) return 0;
    return sort.dir < 0 ? (va > vb ? -1 : 1) : (va > vb ? 1 : -1);
  });
  for (const r of rows) {
    const row = el("tr", "proc-row"); row.id = `proc-${r.pid}`;
    const tipRows = [["Command", r.cmd], ["PID", String(r.pid)], ["User", r.user], ["CPU", pct(r.cpu)], ["MEM", pct(r.mem)], ["RSS", bytes(r.rss)], ["Threads", String(r.threads)]];
    row.addEventListener("pointermove", e => showTip(e, r.name, tipRows));
    row.addEventListener("pointerleave", hideTip);
    row.append(el("td", "name", String(r.name || "—")), el("td", "", String(r.pid)), el("td", "user", r.user),
      el("td", "", pct(r.cpu)), el("td", "", pct(r.mem)), el("td", stateClass(r.state), r.state), el("td", "", String(r.threads)));
    row.firstChild.title = r.cmd;
    const act = el("div", "act");
    const mk = (cls, label, action) => { const b = el("button", cls, label); b.type = "button"; b.dataset.pid = String(r.pid); b.dataset.action = action; return b; };
    if (confirming.has(r.pid)) act.append(mk("btn sm kill sure", "Sure?", "sure"), mk("btn sm ghost", "Cancel", "cancel"));
    else { act.append(mk("btn sm kill", "Kill", "kill")); const cb = mk("btn sm ghost", "Cancel", "cancel"); cb.hidden = true; act.append(cb); }
    const actTd = el("td"); actTd.append(act); row.append(actTd);
    tbody.append(row);
  }
  table.append(tbody); wrap.append(table);
  if (!list.length) wrap.append(el("div", "empty-c", "No processes visible."));
  p.append(wrap);
  return p;
}

function portsPanel(list) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div"); t.append(el("h2", "", "Ports"), el("p", "sub", "Listening sockets and the process using each one"));
  head.append(t); p.append(head);
  const wrap = el("div", "scroll");
  const table = el("table", "ports");
  const thead = el("thead"); const trh = el("tr");
  for (const c of ["Port", "Proto", "Process", "PID", "User"]) trh.append(el("th", "", c));
  thead.append(trh); table.append(thead);
  const tbody = el("tbody");
  for (const r of list.slice().sort((a, b) => a.port - b.port)) {
    const row = el("tr");
    row.append(el("td", "", String(r.port)), el("td", "", r.proto.toUpperCase()), el("td", "cmd", r.cmd || "—"), el("td", "", r.pid ? String(r.pid) : "—"), el("td", "user", r.user || "—"));
    tbody.append(row);
  }
  table.append(tbody); wrap.append(table);
  if (!list.length) wrap.append(el("div", "empty-c", "No listening sockets visible."));
  p.append(wrap);
  return p;
}

// ---------- page ----------

function render(data) {
  const root = $("hm");
  const saved = [...root.querySelectorAll(".scroll")].map(s => ({ l: s.scrollLeft, t: s.scrollTop }));
  const frag = document.createDocumentFragment();
  frag.append(kpiRow(data.metrics));
  const g1 = el("div", "grid2"); g1.append(cpuPanel(data.metrics), memPanel(data.metrics));
  const g2 = el("div", "grid2"); g2.append(diskPanel(data.metrics), loadPanel(data.metrics));
  frag.append(g1, g2, procsPanel(data.procs), portsPanel(data.ports));
  root.replaceChildren(frag);
  const restored = root.querySelectorAll(".scroll");
  saved.forEach((s, i) => { if (restored[i]) { restored[i].scrollLeft = s.l; restored[i].scrollTop = s.t; } });
}

async function load() {
  const mine = ++seq;
  $("hm").setAttribute("aria-busy", "true");
  try {
    const [metrics, procs, ports] = await Promise.all([getJSON("/api/host/metrics"), getJSON("/api/host/processes"), getJSON("/api/host/ports")]);
    if (mine === seq) render({ metrics, procs: procs.processes, ports: ports.ports });
  } catch (e) {
    if (mine === seq) $("hm").replaceChildren(el("p", "muted", `Could not load host metrics: ${e.message}`));
  }
  if (mine === seq) $("hm").setAttribute("aria-busy", "false");
}

$("hm").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-pid][data-action]");
  if (!b) return;
  const pid = Number(b.dataset.pid);
  if (b.dataset.action === "kill") { confirming.add(pid); void load(); return; }
  if (b.dataset.action === "cancel") { confirming.delete(pid); void load(); return; }
  if (b.dataset.action === "sure") {
    confirming.delete(pid);
    try {
      const r = await fetch(`/api/host/processes/${pid}/kill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signal: "SIGTERM" }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      toast(`PID ${pid} terminated.`, "ok");
    } catch (err) { toast(`Kill failed: ${err.message}`, "bad"); }
    void load();
  }
});

function schedule() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!paused && !document.hidden) timer = setTimeout(() => { void load(); schedule(); }, REFRESH);
}
function setPaused(p) {
  paused = p;
  const btn = $("pause");
  btn.setAttribute("aria-pressed", String(p)); btn.textContent = p ? "Resume" : "Pause";
  $("liveLabel").textContent = p ? "Paused" : "Live · updates every 2 s";
  $("live").classList.toggle("paused", p);
  if (!p) schedule();
}
$("pause").onclick = () => setPaused(!paused);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (timer) { clearTimeout(timer); timer = null; } }
  else if (!paused) schedule();
});

setPaused(false);
void load();
