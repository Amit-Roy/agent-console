// Security page: results of the VPS host scans (clamav, falco, trivy, nmap), read through the console server.
// Static skeleton in security.html; this file renders it from /api/security/*. Listeners via addEventListener
// only: module-scoped functions are not reachable from inline onclick.
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const POLL = 5000;
const TOOLS = [["clamav", "ClamAV", "Malware"], ["falco", "Falco", "Runtime threats"], ["trivy", "Trivy", "Vulnerabilities"], ["nmap", "Nmap", "Open ports"]];
const STATUS = { clean: "Clean", findings: "Findings", error: "Error", skipped: "Skipped" };
const TONE = { clean: "ok", findings: "bad", error: "warn", skipped: "" };
const SEV = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const state = { latest: null, history: [], viewing: null, running: null, down: "", loaded: false, fixedOnly: false, open: new Set() };
let pollTimer = null;

async function getJSON(path) {
  const r = await fetch(path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
let toastTimer;
function toast(text, tone) {
  const t = $("toast");
  t.textContent = text; t.className = `show ${tone || ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ""; }, 3000);
}
const dur = s => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const ago = iso => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "unknown time";
  if (s < 90) return "just now";
  const m = s / 60; if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
};
const when = iso => { const d = new Date(iso); return Number.isNaN(+d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

/* ---------- counts across one result ---------- */
function totals(r) {
  const t = r.tools || {}, c = { infected: 0, runtimeAlerts: 0, critical: 0, high: 0, openPorts: 0 };
  c.infected = t.clamav?.infected?.length || 0;
  c.runtimeAlerts = t.falco?.alerts?.length || 0;
  for (const g of t.trivy?.targets || []) { c.critical += g.counts?.CRITICAL || 0; c.high += g.counts?.HIGH || 0; }
  c.openPorts = t.nmap?.openPorts?.length || 0;
  return c;
}

/* ---------- verdict ---------- */
function renderVerdict() {
  const v = $("verdict"); v.replaceChildren();
  const r = state.viewing || state.latest;
  let tone = "", word, sub;
  if (state.down && !r) {
    tone = "warn"; word = "Scan host unreachable";
    sub = state.down;
  } else if (!r) {
    word = "No scan yet";
    sub = "Nothing has been scanned yet. Run a scan to check the host for malware, rootkits, known vulnerabilities and open ports.";
  } else {
    tone = TONE[r.status] || ""; word = r.status === "clean" ? "All clear" : r.status === "findings" ? "Findings need a look" : "Scan finished with errors";
    const bits = [`${state.viewing ? "Scan from" : "Last scan"} ${when(r.finishedAt)} (${ago(r.finishedAt)})`, r.trigger === "manual" ? "started by hand" : "scheduled"];
    sub = bits.join(" · ");
  }
  v.className = `verdict ${tone}`;
  const head = el("div", "vhead");
  head.append(el("i", "vdot"), el("h2", "", word));
  v.append(head, el("p", "vsub", sub));
  if (state.down && r) v.append(el("p", "vwarn", `Showing the last result received. ${state.down}`));
  if (state.down) {
    const b = el("button", "btn sm", "Try again"); b.type = "button";
    b.addEventListener("click", () => { void load(); });
    v.append(b);
  }
  if (r?.id || state.viewing) {
    const bar = el("div", "vbtns");
    if (state.viewing) {
      const b = el("button", "btn sm", "Back to latest"); b.type = "button";
      b.addEventListener("click", () => { state.viewing = null; render(); });
      bar.append(b);
    }
    if (r?.id) bar.append(logButton(r.id, "Scan log"));
    v.append(bar);
  }
  if (r) {
    const c = totals(r);
    const strip = el("dl", "readout");
    for (const [k, label, n, bad] of [["infected", "Infected files", c.infected, 1], ["runtimeAlerts", "Runtime alerts", c.runtimeAlerts, 1], ["critical", "Critical CVEs", c.critical, 1], ["high", "High CVEs", c.high, 1], ["openPorts", "Open ports", c.openPorts, 0]]) {
      const w = el("div", n && bad ? "hot" : "");
      w.append(el("dt", "", label), el("dd", "", String(n)));
      strip.append(w);
    }
    v.append(strip);
  }
}

/* ---------- running banner ---------- */
function renderRunning() {
  const box = $("running"), s = state.running;
  box.hidden = !s?.running;
  $("run").disabled = !!s?.running;
  $("run").textContent = s?.running ? "Scanning…" : "Run scan";
  if (!s?.running) return;
  const tool = TOOLS.find(t => t[0] === s.currentTool);
  box.replaceChildren();
  const h = el("div", "rhead");
  h.append(el("i", "spin"), el("b", "", "Scan running"), el("span", "", s.startedAt ? `started ${ago(s.startedAt)}` : ""));
  box.append(h, el("p", "", tool ? `Now running ${tool[1]} (${tool[2].toLowerCase()}).` : "Starting up."),
    el("p", "note", "A full scan takes 10 to 40 minutes. You can leave this page; results appear here when it finishes."));
  if (s.id) box.append(logButton(s.id, "View live log"));
}

/* ---------- findings (what the scan caught) ---------- */
function renderFindings() {
  const box = $("findings"), r = state.viewing || state.latest;
  const inf = r?.tools?.clamav?.infected || [];
  box.hidden = !inf.length;
  if (box.hidden) return;
  box.replaceChildren();
  const head = el("div", "head"); head.append(el("h2", "", "Infected files")); box.append(head);
  const rows = el("div", "rows");
  for (const f of inf) {
    const row = el("div", "hrow find");
    const n = el("div", "hname"); n.append(el("b", "", f.path), el("span", "hctx", `ClamAV · ${f.signature}`));
    row.append(el("span", "pill bad", "Infected"), n);
    rows.append(row);
  }
  box.append(rows);
}

/* ---------- per-tool cards ---------- */
function toolFacts(key, t) {
  if (key === "clamav") return [["Files", t.scannedFiles?.toLocaleString()], ["Paths", (t.scannedPaths || []).join(", ")], ["Database", t.dbDate]];
  if (key === "falco") return [["Alerts", String((t.alerts || []).length)], ["Since", t.since ? when(t.since) : ""]];
  if (key === "trivy") return [["Targets", String((t.targets || []).length)]];
  return [["Target", t.target], ["Open", String((t.openPorts || []).length)]];
}
function renderTools() {
  const box = $("tools"), r = state.viewing || state.latest;
  box.replaceChildren();
  box.hidden = !!state.down && !r;
  if (box.hidden) return;
  for (const [key, name, role] of TOOLS) {
    const t = r?.tools?.[key];
    const card = el("article", `tool ${t ? TONE[t.status] || "" : ""}`);
    const top = el("div", "ttop");
    const title = el("div"); title.append(el("h3", "", name), el("span", "trole", role));
    top.append(title, el("span", `pill ${t ? TONE[t.status] || "" : ""}`, t ? STATUS[t.status] || t.status : "Not run"));
    card.append(top);
    if (t) {
      const facts = el("dl", "tfacts");
      const rows = [["Version", t.version], ["Took", t.durationSec ? dur(t.durationSec) : ""], ...toolFacts(key, t)].filter(([, v]) => v);
      for (const [k, v] of rows) { const w = el("div"); w.append(el("dt", "", k), el("dd", "", v)); facts.append(w); }
      card.append(facts);
      if (t.error) card.append(el("p", "terr", t.error));
      if (t.status === "skipped" && !t.error) card.append(el("p", "note", "This scanner was skipped in the last run."));
    } else card.append(el("p", "note", r ? "No data from this scanner." : "Waiting for the first scan."));
    box.append(card);
  }
}

/* ---------- falco: live runtime detection, alerts since the previous scan grouped by rule ---------- */
const PRIO = { Critical: 3, Error: 2, Warning: 1 };
function renderFalco() {
  const box = $("falco"), r = state.viewing || state.latest, t = r?.tools?.falco;
  box.hidden = !t || t.status === "skipped";
  if (box.hidden) return;
  const alerts = t.alerts || [];
  $("falco-count").textContent = t.since ? `since ${when(t.since)}` : "";
  const rows = $("falco-rows"); rows.replaceChildren();
  if (!alerts.length) { rows.append(el("p", "note", t.error ? "No alerts could be read; see the Falco card above." : "No runtime alerts since the previous scan. Falco watches live and reports Warning and above.")); return; }
  const groups = new Map();
  for (const a of alerts) {
    const g = groups.get(a.rule) || { rule: a.rule, prio: a.priority, items: [] };
    if ((PRIO[a.priority] || 0) > (PRIO[g.prio] || 0)) g.prio = a.priority;
    g.items.push(a); groups.set(a.rule, g);
  }
  const sorted = [...groups.values()].sort((a, b) => (PRIO[b.prio] || 0) - (PRIO[a.prio] || 0) || b.items.length - a.items.length);
  sorted.forEach((g, i) => {
    const key = `falco:${g.rule}`, open = state.open.has(key), id = `fg-${i}`;
    const item = el("div", "target");
    const btn = el("button", "hrow tgt"); btn.type = "button";
    btn.setAttribute("aria-expanded", String(open)); btn.setAttribute("aria-controls", id);
    const n = el("div", "hname");
    const where = [...new Set(g.items.map(a => a.container || "host"))];
    n.append(el("b", "", g.rule), el("span", "hctx", where.join(", ")));
    const chips = el("div", "chips");
    chips.append(el("span", `chip ${g.prio === "Warning" ? "high" : "critical"}`, g.prio), el("span", "chip", `${g.items.length}×`));
    btn.append(n, chips, el("span", "hchev", open ? "−" : "+"));
    btn.addEventListener("click", () => { state.open.has(key) ? state.open.delete(key) : state.open.add(key); renderFalco(); });
    item.append(btn);
    if (open) {
      const body = el("div", "tbody"); body.id = id;
      const list = el("ul", "vulns");
      for (const a of g.items) {
        const li = el("li", "vuln");
        const top = el("div", "vtop");
        top.append(el("span", `sev ${a.priority === "Warning" ? "high" : "crit"}`, a.priority), el("b", "", a.container || "host"), el("span", "vnofix", when(a.time)));
        li.append(top, el("p", "vtitle", a.output || ""));
        list.append(li);
      }
      body.append(list); item.append(body);
    }
    rows.append(item);
  });
}

/* ---------- trivy ---------- */
function vulnRow(v) {
  const row = el("li", "vuln");
  const top = el("div", "vtop");
  top.append(el("span", `sev ${v.severity === "CRITICAL" ? "crit" : "high"}`, v.severity === "CRITICAL" ? "Critical" : "High"), el("b", "", v.id));
  const fix = el("span", v.fixed ? "vfix" : "vnofix", v.fixed ? `Fixed in ${v.fixed}` : "No fix yet");
  top.append(fix);
  row.append(top, el("p", "vtitle", v.title || ""), el("p", "hctx", `${v.pkg} ${v.installed || ""}`.trim()));
  return row;
}
function renderTrivy() {
  const box = $("trivy"), r = state.viewing || state.latest, t = r?.tools?.trivy;
  const targets = t?.targets || [];
  box.hidden = !targets.length;
  if (box.hidden) return;
  $("fixed-only").checked = state.fixedOnly;
  $("trivy-count").textContent = String(targets.length);
  const rows = $("trivy-rows"); rows.replaceChildren();
  targets.forEach((g, i) => {
    const all = g.vulns || [];
    const vulns = state.fixedOnly ? all.filter(v => v.fixed) : all;
    const id = `tg-${i}`, open = state.open.has(g.name);
    const item = el("div", "target");
    const btn = el("button", "hrow tgt"); btn.type = "button";
    btn.setAttribute("aria-expanded", String(open)); btn.setAttribute("aria-controls", id);
    const n = el("div", "hname"); n.append(el("b", "", g.name), el("span", "hctx", g.type));
    const chips = el("div", "chips");
    let any = false;
    for (const s of SEV) {
      const c = g.counts?.[s] || 0; if (!c) continue; any = true;
      chips.append(el("span", `chip ${s.toLowerCase()}`, `${c} ${s[0] + s.slice(1).toLowerCase()}`));
    }
    if (!any) chips.append(el("span", "chip none", "No vulnerabilities"));
    btn.append(n, chips, el("span", "hchev", open ? "−" : "+"));
    btn.addEventListener("click", () => { state.open.has(g.name) ? state.open.delete(g.name) : state.open.add(g.name); renderTrivy(); });
    item.append(btn);
    if (open) {
      const body = el("div", "tbody"); body.id = id;
      if (vulns.length) {
        const list = el("ul", "vulns");
        vulns.forEach(v => list.append(vulnRow(v)));
        body.append(list);
      } else body.append(el("p", "note", all.length ? "No vulnerabilities with a fix available in this target." : "Nothing critical or high found."));
      const lows = (g.counts?.MEDIUM || 0) + (g.counts?.LOW || 0);
      if (all.length) body.append(el("p", "note", `Only critical and high are listed${lows ? `; ${lows} medium and low are counted but hidden` : ""}.${all.length >= 50 ? " Capped at 50 per target." : ""}`));
      item.append(body);
    }
    rows.append(item);
  });
}
$("fixed-only").addEventListener("change", e => { state.fixedOnly = e.target.checked; renderTrivy(); });

/* ---------- ports ---------- */
function renderPorts() {
  const box = $("ports"), r = state.viewing || state.latest, t = r?.tools?.nmap;
  box.hidden = !t || t.status === "skipped" || (t.status === "error" && !t.openPorts?.length);
  if (box.hidden) return;
  const ports = t.openPorts || [];
  $("port-count").textContent = `${ports.length}${t.target ? ` on ${t.target}` : ""}`;
  const rows = $("port-rows"); rows.replaceChildren();
  if (!ports.length) rows.append(el("p", "note", "No open ports found."));
  for (const p of ports) {
    const row = el("div", "hrow port sport");
    const n = el("div", "hname"); n.append(el("b", "", p.service || "unknown"), el("span", "hctx", p.product || ""));
    row.append(el("span", "pn", String(p.port)), n, el("span", "hnum", p.proto || "tcp"));
    rows.append(row);
  }
}

/* ---------- history strip ---------- */
function renderHistory() {
  const box = $("history"), list = state.history;
  box.hidden = !list.length;
  if (box.hidden) return;
  $("hist-count").textContent = String(list.length);
  const strip = $("strip"); strip.replaceChildren();
  const cur = (state.viewing || state.latest)?.id;
  for (const s of [...list].reverse()) {
    const b = el("button", `tick ${TONE[s.status] || ""}`); b.type = "button"; b.setAttribute("role", "listitem");
    const c = s.counts || {};
    b.setAttribute("aria-label", `${when(s.finishedAt)}, ${STATUS[s.status] || s.status}, ${plural(c.critical || 0, "critical")}, ${plural(c.high || 0, "high")}`);
    b.title = `${when(s.finishedAt)} · ${STATUS[s.status] || s.status}`;
    if (s.id === cur) b.setAttribute("aria-current", "true");
    const h = Math.min(100, 28 + ((c.infected || 0) + (c.runtimeAlerts || 0)) * 24 + Math.min(40, (c.critical || 0) * 6 + (c.high || 0)));
    b.style.setProperty("--h", `${h}%`);
    b.addEventListener("click", () => openScan(s.id));
    strip.append(b);
  }
  $("hist-note").textContent = "Newest on the right. Taller bar means more findings. Tap one to read that scan, then open its log.";
}
async function openScan(id) {
  if (id === state.latest?.id) { state.viewing = null; return render(); }
  try { state.viewing = await getJSON(`/api/security/scans/${encodeURIComponent(id)}`); render(); }
  catch (e) { toast(`Could not load that scan: ${e.message}`, "bad"); }
}

/* ---------- scan log sheet ---------- */
const LOG_POLL = 3000, LOG_MAX = 5000;
const LTIME = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
const log = { id: null, total: 0, running: false, follow: true, gen: 0, timer: null, shown: 0 };
const sheet = $("logsheet"), lbody = $("log-body");
function logButton(id, label) {
  const b = el("button", "btn sm", label); b.type = "button";
  b.addEventListener("click", () => { void openLog(id); });
  return b;
}
const scanStart = id => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id || ""); return m ? when(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : ""; };
function logLine(raw) {
  const m = /^(\S+) ([a-z][a-z0-9_-]*): ([\s\S]*)$/.exec(raw);
  const row = el("div", "ll");
  if (!m) { row.textContent = raw; return row; }
  const d = new Date(m[1]);
  row.append(el("span", "lt", Number.isNaN(+d) ? m[1] : d.toLocaleTimeString([], LTIME)), el("span", `lk ${m[2]}`, m[2]), document.createTextNode(m[3]));
  return row;
}
function logState() {
  const p = $("log-state");
  p.hidden = !log.id || !!lbody.querySelector(".lmsg");
  p.replaceChildren();
  p.className = log.running ? "pill live" : "pill";
  if (log.running) p.append(el("i", "spin"), document.createTextNode("Live"));
  else p.textContent = "Finished";
}
function logMessage(text, cls) { lbody.replaceChildren(el("p", `lmsg ${cls || ""}`, text)); log.shown = 0; logState(); $("log-jump").hidden = true; }
const atBottom = () => lbody.scrollHeight - lbody.scrollTop - lbody.clientHeight < 24;
function appendLines(lines, from) {
  lbody.querySelector(".lmsg")?.remove();
  if (from > 0 && !log.shown && !lbody.querySelector(".lmore")) lbody.append(el("p", "lmore", `${from} earlier lines not shown.`));
  const frag = document.createDocumentFragment();
  for (const l of lines) frag.append(logLine(l));
  lbody.append(frag);
  log.shown += lines.length;
  for (let n = lbody.querySelectorAll(".ll").length; n > LOG_MAX; n--) lbody.querySelector(".ll").remove();
  if (log.follow) lbody.scrollTop = lbody.scrollHeight;
  else $("log-jump").hidden = false;
}
async function fetchLog(gen) {
  let j;
  try { j = await getJSON(`/api/security/scans/${encodeURIComponent(log.id)}/log?after=${log.total}`); }
  catch (e) {
    if (gen !== log.gen) return;
    // 404: scan has no log (finished before logs existed) or an older server without the route
    if (/HTTP 404|not found|No such scan/i.test(e.message) && !log.total) return logMessage("No log for this scan.");
    if (!log.total) return logMessage(`Could not load the log: ${e.message}`, "warn");
    return schedule(gen);
  }
  if (gen !== log.gen) return;
  const was = log.running;
  log.running = !!j.running;
  if (j.lines?.length) { appendLines(j.lines, j.from || 0); }
  else if (!log.total && !lbody.querySelector(".ll")) logMessage(log.running ? "Waiting for the first log line…" : "This log is empty.");
  log.total = Number.isFinite(j.total) ? j.total : log.total + (j.lines?.length || 0);
  logState();
  if (log.running) return schedule(gen);
  if (was) { toast("Scan finished.", "ok"); await load(); }
}
function schedule(gen) { clearTimeout(log.timer); log.timer = setTimeout(() => { void fetchLog(gen); }, LOG_POLL); }
async function openLog(id) {
  clearTimeout(log.timer);
  Object.assign(log, { id, total: 0, running: state.running?.running && state.running.id === id, follow: true, shown: 0, gen: log.gen + 1 });
  $("log-sub").textContent = [scanStart(id), id].filter(Boolean).join(" · ");
  logMessage("Loading log…");
  if (!sheet.open) sheet.showModal();
  await fetchLog(log.gen);
}
function closeLog() { if (sheet.open) sheet.close(); }
sheet.addEventListener("close", () => { clearTimeout(log.timer); log.gen++; log.id = null; });
sheet.addEventListener("click", e => { if (e.target === sheet) closeLog(); });
$("log-close").addEventListener("click", closeLog);
lbody.addEventListener("scroll", () => { log.follow = atBottom(); $("log-jump").hidden = log.follow; });
$("log-jump").addEventListener("click", () => { log.follow = true; lbody.scrollTop = lbody.scrollHeight; $("log-jump").hidden = true; });

function render() {
  renderVerdict(); renderRunning(); renderFindings(); renderTools(); renderFalco(); renderTrivy(); renderPorts(); renderHistory();
  $("hm").setAttribute("aria-busy", "false");
}

/* ---------- data ---------- */
async function load() {
  const [latest, history, status] = await Promise.allSettled([getJSON("/api/security/latest"), getJSON("/api/security/history"), getJSON("/api/security/status")]);
  const err = [latest, history, status].find(x => x.status === "rejected");
  if (latest.status === "fulfilled") { state.latest = latest.value.result; state.down = ""; }
  else state.down = latest.reason.message;
  if (history.status === "fulfilled") state.history = Array.isArray(history.value.scans) ? history.value.scans : [];
  if (status.status === "fulfilled") state.running = status.value;
  if (err && latest.status === "fulfilled") state.down = "";
  state.loaded = true;
  render();
  if (state.running?.running) startPoll();
}
function startPoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    let s;
    try { s = await getJSON("/api/security/status"); } catch { return startPoll(); }
    const was = state.running?.running;
    state.running = s;
    renderRunning();
    if (s.running) return startPoll();
    if (was) { toast("Scan finished.", "ok"); await load(); }
  }, POLL);
}

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  try {
    const r = await fetch("/api/security/run", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    toast(j.started ? "Scan started. It takes 10 to 40 minutes." : "A scan is already running.", j.started ? "ok" : "");
    state.running = { running: true, startedAt: new Date().toISOString(), currentTool: null };
    renderRunning(); startPoll();
  } catch (e) {
    $("run").disabled = false;
    toast(`Could not start a scan: ${e.message}`, "bad");
  }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.loaded) void load(); });

await load();
