// Security page: results of the VPS host scans (clamav, falco, trivy, nmap), read through the console server.
// Static skeleton in security.html; this file renders it from /api/security/*. Listeners via addEventListener
// only: module-scoped functions are not reachable from inline onclick.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const POLL = 5000;
const TOOLS = [
  ["clamav", "ClamAV", "Malware"],
  ["falco", "Falco", "Runtime threats"],
  ["trivy", "Trivy", "Vulnerabilities"],
  ["nmap", "Nmap", "Open ports"],
];
const STATUS = { clean: "Clean", findings: "Findings", error: "Error", skipped: "Skipped" };
const TONE = { clean: "ok", findings: "bad", error: "warn", skipped: "" };
const SEV = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const state = {
  latest: null,
  history: [],
  viewing: null,
  running: null,
  down: "",
  loaded: false,
  fixedOnly: false,
  open: new Set(),
};
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
  t.textContent = text;
  t.className = `show ${tone || ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = "";
  }, 3000);
}
const dur = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "unknown time";
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
};
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d)
    ? ""
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

/* ---------- counts across one result ---------- */
/* Fixable counts per severity for one target: scan-reported, else derived from listed vulns, else null. */
function fixableOf(g) {
  if (g.fixable) return { CRITICAL: g.fixable.CRITICAL || 0, HIGH: g.fixable.HIGH || 0 };
  const vs = g.vulns;
  if (!Array.isArray(vs) || !vs.some((v) => v.severity)) return null;
  const f = { CRITICAL: 0, HIGH: 0 };
  for (const v of vs) if (v.fixed && v.severity in f) f[v.severity]++;
  return f;
}
function totals(r) {
  const t = r.tools || {},
    c = {
      infected: 0,
      runtimeAlerts: 0,
      critical: 0,
      high: 0,
      openPorts: 0,
      fixCritical: null,
      fixHigh: null,
    };
  c.infected = t.clamav?.infected?.length || 0;
  c.runtimeAlerts = t.falco?.alerts?.length || 0;
  for (const g of t.trivy?.targets || []) {
    if (g.thirdParty) continue; // third-party clones are listed separately and never counted
    c.critical += g.counts?.CRITICAL || 0;
    c.high += g.counts?.HIGH || 0;
    const f = fixableOf(g);
    if (f) {
      c.fixCritical += f.CRITICAL;
      c.fixHigh += f.HIGH;
    }
  }
  c.openPorts = (t.nmap?.openPorts || []).filter((p) => p.exposed !== false).length;
  return c;
}

/* Results without a mode predate quick scans: they were full. */
const modeLabel = (m) => (m === "quick" ? "Quick scan" : "Full scan");

/* ---------- verdict ---------- */
function verdictHeading(result) {
  if (state.down && !result)
    return { tone: "warn", word: "Scan host unreachable", sub: state.down };
  if (!result)
    return {
      tone: "",
      word: "No scan yet",
      sub: "Nothing has been scanned yet. Run a scan to check the host for malware, rootkits, known vulnerabilities and open ports.",
    };
  const word =
    result.status === "clean"
      ? "All clear"
      : result.status === "findings"
        ? "Findings need a look"
        : "Scan finished with errors";
  const bits = [
    `${state.viewing ? "Scan from" : "Last scan"} ${when(result.finishedAt)} (${ago(result.finishedAt)})`,
    modeLabel(result.mode),
    result.trigger === "manual" ? "started by hand" : "scheduled",
  ];
  return { tone: TONE[result.status] || "", word, sub: bits.join(" · ") };
}
function buildRetryButton() {
  const retry = el("button", "btn sm", "Try again");
  retry.type = "button";
  retry.addEventListener("click", () => {
    void load();
  });
  return retry;
}
function buildVerdictButtons(result) {
  const buttonBar = el("div", "vbtns");
  if (state.viewing) {
    const back = el("button", "btn sm", "Back to latest");
    back.type = "button";
    back.addEventListener("click", () => {
      state.viewing = null;
      render();
    });
    buttonBar.append(back);
  }
  if (result?.id) buttonBar.append(logButton(result.id, "Scan log"));
  return buttonBar;
}
function buildReadout(result) {
  const counts = totals(result);
  const strip = el("dl", "readout");
  for (const [, label, count, bad, fix] of [
    ["infected", "Infected files", counts.infected, 1],
    ["runtimeAlerts", "Runtime alerts", counts.runtimeAlerts, 1],
    ["critical", "Critical CVEs", counts.critical, 1, counts.fixCritical],
    ["high", "High CVEs", counts.high, 1, counts.fixHigh],
    ["openPorts", "Open ports", counts.openPorts, 0],
  ]) {
    const wrap = el("div", count && bad ? "hot" : "");
    wrap.append(el("dt", "", label), el("dd", "", String(count)));
    if (fix != null) wrap.append(el("small", "fixable", `${fix} fixable`));
    strip.append(wrap);
  }
  return strip;
}
function renderVerdict() {
  const verdict = $("verdict");
  verdict.replaceChildren();
  const result = state.viewing || state.latest;
  const { tone, word, sub } = verdictHeading(result);
  verdict.className = `verdict ${tone}`;
  const head = el("div", "vhead");
  head.append(el("i", "vdot"), el("h2", "", word));
  verdict.append(head, el("p", "vsub", sub));
  if (state.down && result)
    verdict.append(el("p", "vwarn", `Showing the last result received. ${state.down}`));
  if (state.down) verdict.append(buildRetryButton());
  if (result?.id || state.viewing) verdict.append(buildVerdictButtons(result));
  if (result) verdict.append(buildReadout(result));
}

/* ---------- running banner ---------- */
function renderRunning() {
  const box = $("running"),
    s = state.running;
  box.hidden = !s?.running;
  for (const id of ["run-quick", "run-full"]) $(id).disabled = !!s?.running;
  if (!s?.running) return;
  const tool = TOOLS.find((t) => t[0] === s.currentTool);
  box.replaceChildren();
  const h = el("div", "rhead");
  h.append(
    el("i", "spin"),
    el("b", "", "Scan running"),
    el("span", "", s.startedAt ? `started ${ago(s.startedAt)}` : ""),
  );
  box.append(
    h,
    el("p", "", tool ? `Now running ${tool[1]} (${tool[2].toLowerCase()}).` : "Starting up."),
    el(
      "p",
      "note",
      `${
        s.mode === "quick"
          ? "A quick scan takes a few minutes."
          : s.mode === "full"
            ? "A full scan takes about 80 minutes."
            : "Quick scans take a few minutes; full scans about 80 minutes."
      } You can leave this page; results appear here when it finishes.`,
    ),
  );
  if (s.id) box.append(logButton(s.id, "View live log"));
}

/* ---------- findings (what the scan caught) ---------- */
function renderFindings() {
  const box = $("findings"),
    r = state.viewing || state.latest;
  const inf = r?.tools?.clamav?.infected || [];
  box.hidden = !inf.length;
  if (box.hidden) return;
  box.replaceChildren();
  const head = el("div", "head");
  head.append(el("h2", "", "Infected files"));
  box.append(head);
  const rows = el("div", "rows");
  for (const f of inf) {
    const row = el("div", "hrow find");
    const n = el("div", "hname");
    n.append(el("b", "", f.path), el("span", "hctx", `ClamAV · ${f.signature}`));
    row.append(el("span", "pill bad", "Infected"), n);
    rows.append(row);
  }
  box.append(rows);
}

/* ---------- per-tool cards ---------- */
function toolFacts(key, t) {
  if (key === "clamav")
    return [
      [
        "Files",
        t.mode === "quick"
          ? `Checked ${(t.scannedFiles ?? 0).toLocaleString()} files changed since ${t.since ? when(t.since) : "the previous scan"}`
          : t.scannedFiles?.toLocaleString(),
      ],
      ["Paths", (t.scannedPaths || []).join(", ")],
      ["Database", t.dbDate],
    ];
  if (key === "falco")
    return [
      ["Alerts", String((t.alerts || []).length)],
      ["Since", t.since ? when(t.since) : ""],
    ];
  if (key === "trivy") {
    const own = (t.targets || []).filter((g) => !g.thirdParty).length,
      tp = (t.targets || []).length - own;
    return [["Targets", String(own)], ...(tp ? [["Third-party", `${tp} (not counted)`]] : [])];
  }
  return [
    ["Target", t.target],
    ["Open", String((t.openPorts || []).filter((p) => p.exposed !== false).length)],
  ];
}
function appendToolDetails(card, key, t) {
  const facts = el("dl", "tfacts");
  const rows = [
    ["Version", t.version],
    ["Took", t.durationSec ? dur(t.durationSec) : ""],
    ...toolFacts(key, t),
  ].filter(([, value]) => value);
  for (const [label, value] of rows) {
    const wrap = el("div");
    wrap.append(el("dt", "", label), el("dd", "", value));
    facts.append(wrap);
  }
  card.append(facts);
  if (t.error) card.append(el("p", "terr", t.error));
  if (t.status === "skipped" && !t.error)
    card.append(el("p", "note", "This scanner was skipped in the last run."));
}
function buildToolCard(key, name, role, result) {
  const toolResult = result?.tools?.[key];
  const card = el("article", `tool ${toolResult ? TONE[toolResult.status] || "" : ""}`);
  const top = el("div", "ttop");
  const title = el("div");
  title.append(el("h3", "", name), el("span", "trole", role));
  top.append(
    title,
    el(
      "span",
      `pill ${toolResult ? TONE[toolResult.status] || "" : ""}`,
      toolResult ? STATUS[toolResult.status] || toolResult.status : "Not run",
    ),
  );
  card.append(top);
  if (toolResult) appendToolDetails(card, key, toolResult);
  else
    card.append(
      el("p", "note", result ? "No data from this scanner." : "Waiting for the first scan."),
    );
  return card;
}
function renderTools() {
  const box = $("tools"),
    result = state.viewing || state.latest;
  box.replaceChildren();
  box.hidden = !!state.down && !result;
  if (box.hidden) return;
  for (const [key, name, role] of TOOLS) box.append(buildToolCard(key, name, role, result));
}

/* ---------- falco: live runtime detection, alerts since the previous scan grouped by rule ---------- */
const PRIO = { Critical: 3, Error: 2, Warning: 1 };
function groupFalcoAlerts(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    const group = groups.get(alert.rule) || {
      rule: alert.rule,
      prio: alert.priority,
      items: [],
    };
    if ((PRIO[alert.priority] || 0) > (PRIO[group.prio] || 0)) group.prio = alert.priority;
    group.items.push(alert);
    groups.set(alert.rule, group);
  }
  return [...groups.values()].sort(
    (a, b) => (PRIO[b.prio] || 0) - (PRIO[a.prio] || 0) || b.items.length - a.items.length,
  );
}
function buildFalcoAlertList(group) {
  const list = el("ul", "vulns");
  for (const alert of group.items) {
    const alertItem = el("li", "vuln");
    const top = el("div", "vtop");
    top.append(
      el("span", `sev ${alert.priority === "Warning" ? "high" : "crit"}`, alert.priority),
      el("b", "", alert.container || "host"),
      el("span", "vnofix", when(alert.time)),
    );
    alertItem.append(top, el("p", "vtitle", alert.output || ""));
    list.append(alertItem);
  }
  return list;
}
function buildFalcoGroup(group, index) {
  const key = `falco:${group.rule}`,
    open = state.open.has(key),
    panelId = `fg-${index}`;
  const item = el("div", "target");
  const btn = el("button", "hrow tgt");
  btn.type = "button";
  btn.setAttribute("aria-expanded", String(open));
  btn.setAttribute("aria-controls", panelId);
  const name = el("div", "hname");
  const where = [...new Set(group.items.map((alert) => alert.container || "host"))];
  name.append(el("b", "", group.rule), el("span", "hctx", where.join(", ")));
  const chips = el("div", "chips");
  chips.append(
    el("span", `chip ${group.prio === "Warning" ? "high" : "critical"}`, group.prio),
    el("span", "chip", `${group.items.length}×`),
  );
  const chevron = el("span", "hchev", open ? "−" : "+");
  const body = el("div", "tbody");
  body.id = panelId;
  body.hidden = !open;
  if (open) body.append(buildFalcoAlertList(group));
  btn.append(name, chips, chevron);
  btn.addEventListener("click", () => {
    const expanded = !state.open.has(key);
    expanded ? state.open.add(key) : state.open.delete(key);
    btn.setAttribute("aria-expanded", String(expanded));
    chevron.textContent = expanded ? "−" : "+";
    if (expanded && !body.firstChild) body.append(buildFalcoAlertList(group));
    body.hidden = !expanded;
  });
  item.append(btn, body);
  return item;
}
function renderFalco() {
  const box = $("falco"),
    r = state.viewing || state.latest,
    t = r?.tools?.falco;
  box.hidden = !t || t.status === "skipped";
  if (box.hidden) return;
  const alerts = t.alerts || [];
  $("falco-count").textContent = t.since ? `since ${when(t.since)}` : "";
  const rows = $("falco-rows");
  rows.replaceChildren();
  if (!alerts.length) {
    rows.append(
      el(
        "p",
        "note",
        t.error
          ? "No alerts could be read; see the Falco card above."
          : "No runtime alerts since the previous scan. Falco watches live and reports Warning and above.",
      ),
    );
    return;
  }
  groupFalcoAlerts(alerts).forEach((group, index) => {
    rows.append(buildFalcoGroup(group, index));
  });
}

/* ---------- trivy ---------- */
function vulnRow(v) {
  const row = el("li", "vuln");
  const top = el("div", "vtop");
  top.append(
    el(
      "span",
      `sev ${v.severity === "CRITICAL" ? "crit" : "high"}`,
      v.severity === "CRITICAL" ? "Critical" : "High",
    ),
    el("b", "", v.id),
  );
  const fix = el(
    "span",
    v.fixed ? "vfix" : "vnofix",
    v.fixed ? `Fixed in ${v.fixed}` : "No fix yet",
  );
  top.append(fix);
  row.append(
    top,
    el("p", "vtitle", v.title || ""),
    el("p", "hctx", `${v.pkg} ${v.installed || ""}`.trim()),
  );
  return row;
}
function buildTrivyChips(target) {
  const chips = el("div", "chips");
  let any = false;
  for (const sev of SEV) {
    const count = target.counts?.[sev] || 0;
    if (!count) continue;
    any = true;
    chips.append(
      el("span", `chip ${sev.toLowerCase()}`, `${count} ${sev[0] + sev.slice(1).toLowerCase()}`),
    );
  }
  const fixable = fixableOf(target),
    fixableCount = fixable ? fixable.CRITICAL + fixable.HIGH : 0;
  if (fixableCount) chips.append(el("span", "chip fix", `${fixableCount} fixable`));
  if (!any) chips.append(el("span", "chip none", "No vulnerabilities"));
  return chips;
}
function buildTrivyBody(target, id) {
  const all = target.vulns || [];
  const vulns = state.fixedOnly ? all.filter((vuln) => vuln.fixed) : all;
  const body = el("div", "tbody");
  body.id = id;
  if (vulns.length) {
    const list = el("ul", "vulns");
    vulns.forEach((vuln) => {
      list.append(vulnRow(vuln));
    });
    body.append(list);
  } else
    body.append(
      el(
        "p",
        "note",
        all.length
          ? "No vulnerabilities with a fix available in this target."
          : "Nothing critical or high found.",
      ),
    );
  const lows = (target.counts?.MEDIUM || 0) + (target.counts?.LOW || 0);
  if (all.length)
    body.append(
      el(
        "p",
        "note",
        `Only critical and high are listed${lows ? `; ${lows} medium and low are counted but hidden` : ""}.${all.length >= 50 ? " Capped at 50 per target." : ""}`,
      ),
    );
  return body;
}
function buildTrivyTarget(target, index) {
  const panelId = `tg-${index}`,
    open = state.open.has(target.name);
  const item = el("div", "target");
  const btn = el("button", "hrow tgt");
  btn.type = "button";
  btn.setAttribute("aria-expanded", String(open));
  btn.setAttribute("aria-controls", panelId);
  const name = el("div", "hname");
  name.append(el("b", "", target.name), el("span", "hctx", target.type));
  btn.append(name, buildTrivyChips(target), el("span", "hchev", open ? "−" : "+"));
  btn.addEventListener("click", () => {
    state.open.has(target.name) ? state.open.delete(target.name) : state.open.add(target.name);
    renderTrivy();
  });
  item.append(btn);
  if (open) item.append(buildTrivyBody(target, panelId));
  return item;
}
function renderTrivy() {
  const box = $("trivy"),
    r = state.viewing || state.latest,
    t = r?.tools?.trivy;
  const targets = t?.targets || [];
  box.hidden = !targets.length;
  if (box.hidden) return;
  $("fixed-only").checked = state.fixedOnly;
  $("trivy-count").textContent = String(targets.filter((g) => !g.thirdParty).length);
  const rows = $("trivy-rows");
  rows.replaceChildren();
  let sepDone = false;
  [...targets.entries()]
    .sort((a, b) => !!a[1].thirdParty - !!b[1].thirdParty || a[0] - b[0])
    .forEach(([index, target]) => {
      if (target.thirdParty && !sepDone) {
        sepDone = true;
        rows.append(el("h3", "tpsep", "Third-party clones (not counted)"));
      }
      rows.append(buildTrivyTarget(target, index));
    });
}
$("fixed-only").addEventListener("change", (e) => {
  state.fixedOnly = e.target.checked;
  renderTrivy();
});

/* ---------- ports ---------- */
function renderPorts() {
  const box = $("ports"),
    r = state.viewing || state.latest,
    t = r?.tools?.nmap;
  box.hidden = !t || t.status === "skipped" || (t.status === "error" && !t.openPorts?.length);
  if (box.hidden) return;
  const ports = t.openPorts || [];
  const exposed = ports.filter((p) => p.exposed !== false).length;
  $("port-count").textContent = `${exposed}${t.target ? ` on ${t.target}` : ""}`;
  const rows = $("port-rows");
  rows.replaceChildren();
  if (!ports.length) rows.append(el("p", "note", "No open ports found."));
  for (const p of ports) {
    const row = el("div", "hrow port sport");
    const n = el("div", "hname");
    n.append(el("b", "", p.service || "unknown"), el("span", "hctx", p.product || ""));
    row.append(
      el("span", "pn", String(p.port)),
      n,
      el("span", "hnum", p.exposed === false ? "internal only" : p.proto || "tcp"),
    );
    rows.append(row);
  }
}

/* ---------- history strip ---------- */
function renderHistory() {
  const box = $("history"),
    list = state.history;
  box.hidden = !list.length;
  if (box.hidden) return;
  $("hist-count").textContent = String(list.length);
  const strip = $("strip");
  strip.replaceChildren();
  const cur = (state.viewing || state.latest)?.id;
  for (const s of [...list].reverse()) {
    const b = el("button", `tick ${TONE[s.status] || ""}`);
    b.type = "button";
    b.setAttribute("role", "listitem");
    const c = s.counts || {};
    b.setAttribute(
      "aria-label",
      `${when(s.finishedAt)}, ${modeLabel(s.mode)}, ${STATUS[s.status] || s.status}, ${plural(c.critical || 0, "critical")}, ${plural(c.high || 0, "high")}`,
    );
    b.title = `${when(s.finishedAt)} · ${modeLabel(s.mode)} · ${STATUS[s.status] || s.status}`;
    if (s.id === cur) b.setAttribute("aria-current", "true");
    const h = Math.min(
      100,
      28 +
        ((c.infected || 0) + (c.runtimeAlerts || 0)) * 24 +
        Math.min(40, (c.critical || 0) * 6 + (c.high || 0)),
    );
    b.style.setProperty("--h", `${h}%`);
    b.addEventListener("click", () => openScan(s.id));
    strip.append(b);
  }
  $("hist-note").textContent =
    "Newest on the right. Taller bar means more findings. Tap one to read that scan, then open its log.";
}
async function openScan(id) {
  if (id === state.latest?.id) {
    state.viewing = null;
    return render();
  }
  try {
    state.viewing = await getJSON(`/api/security/scans/${encodeURIComponent(id)}`);
    render();
  } catch (e) {
    toast(`Could not load that scan: ${e.message}`, "bad");
  }
}

/* ---------- scan log sheet ---------- */
const LOG_POLL = 3000,
  LOG_MAX = 5000;
const LTIME = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
const log = { id: null, total: 0, running: false, follow: true, gen: 0, timer: null, shown: 0 };
const sheet = $("logsheet"),
  lbody = $("log-body");
function logButton(id, label) {
  const b = el("button", "btn sm", label);
  b.type = "button";
  b.addEventListener("click", () => {
    void openLog(id);
  });
  return b;
}
const scanStart = (id) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id || "");
  return m ? when(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : "";
};
function logLine(raw) {
  const m = /^(\S+) ([a-z][a-z0-9_-]*): ([\s\S]*)$/.exec(raw);
  const row = el("div", "ll");
  if (!m) {
    row.textContent = raw;
    return row;
  }
  const d = new Date(m[1]);
  row.append(
    el("span", "lt", Number.isNaN(+d) ? m[1] : d.toLocaleTimeString([], LTIME)),
    el("span", `lk ${m[2]}`, m[2]),
    document.createTextNode(m[3]),
  );
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
function logMessage(text, cls) {
  lbody.replaceChildren(el("p", `lmsg ${cls || ""}`, text));
  log.shown = 0;
  logState();
  $("log-jump").hidden = true;
}
const atBottom = () => lbody.scrollHeight - lbody.scrollTop - lbody.clientHeight < 24;
function appendLines(lines, from) {
  lbody.querySelector(".lmsg")?.remove();
  if (from > 0 && !log.shown && !lbody.querySelector(".lmore"))
    lbody.append(el("p", "lmore", `${from} earlier lines not shown.`));
  const frag = document.createDocumentFragment();
  for (const l of lines) frag.append(logLine(l));
  lbody.append(frag);
  log.shown += lines.length;
  for (let n = lbody.querySelectorAll(".ll").length; n > LOG_MAX; n--)
    lbody.querySelector(".ll").remove();
  if (log.follow) lbody.scrollTop = lbody.scrollHeight;
  else $("log-jump").hidden = false;
}
function handleLogFetchError(failure, gen) {
  if (gen !== log.gen) return;
  // 404: scan has no log (finished before logs existed) or an older server without the route
  if (/HTTP 404|not found|No such scan/i.test(failure.message) && !log.total)
    return logMessage("No log for this scan.");
  if (!log.total) return logMessage(`Could not load the log: ${failure.message}`, "warn");
  return schedule(gen);
}
function applyLogResponse(payload) {
  log.running = !!payload.running;
  if (payload.lines?.length) {
    appendLines(payload.lines, payload.from || 0);
  } else if (!log.total && !lbody.querySelector(".ll"))
    logMessage(log.running ? "Waiting for the first log line…" : "This log is empty.");
  log.total = Number.isFinite(payload.total)
    ? payload.total
    : log.total + (payload.lines?.length || 0);
  logState();
}
async function fetchLog(gen) {
  let payload;
  try {
    payload = await getJSON(
      `/api/security/scans/${encodeURIComponent(log.id)}/log?after=${log.total}`,
    );
  } catch (failure) {
    return handleLogFetchError(failure, gen);
  }
  if (gen !== log.gen) return;
  const was = log.running;
  applyLogResponse(payload);
  if (log.running) return schedule(gen);
  if (was) {
    toast("Scan finished.", "ok");
    await load();
  }
}
function schedule(gen) {
  clearTimeout(log.timer);
  log.timer = setTimeout(() => {
    void fetchLog(gen);
  }, LOG_POLL);
}
async function openLog(id) {
  clearTimeout(log.timer);
  Object.assign(log, {
    id,
    total: 0,
    running: state.running?.running && state.running.id === id,
    follow: true,
    shown: 0,
    gen: log.gen + 1,
  });
  $("log-sub").textContent = [scanStart(id), id].filter(Boolean).join(" · ");
  logMessage("Loading log…");
  if (!sheet.open) sheet.showModal();
  await fetchLog(log.gen);
}
function closeLog() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener("close", () => {
  clearTimeout(log.timer);
  log.gen++;
  log.id = null;
});
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) closeLog();
});
$("log-close").addEventListener("click", closeLog);
lbody.addEventListener("scroll", () => {
  log.follow = atBottom();
  $("log-jump").hidden = log.follow;
});
$("log-jump").addEventListener("click", () => {
  log.follow = true;
  lbody.scrollTop = lbody.scrollHeight;
  $("log-jump").hidden = true;
});

function render() {
  renderVerdict();
  renderRunning();
  renderFindings();
  renderTools();
  renderFalco();
  renderTrivy();
  renderPorts();
  renderHistory();
  $("hm").setAttribute("aria-busy", "false");
}

/* ---------- data ---------- */
async function load() {
  const [latest, history, status] = await Promise.allSettled([
    getJSON("/api/security/latest"),
    getJSON("/api/security/history"),
    getJSON("/api/security/status"),
  ]);
  const err = [latest, history, status].find((x) => x.status === "rejected");
  if (latest.status === "fulfilled") {
    state.latest = latest.value.result;
    state.down = "";
  } else state.down = latest.reason.message;
  if (history.status === "fulfilled")
    state.history = Array.isArray(history.value.scans) ? history.value.scans : [];
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
    try {
      s = await getJSON("/api/security/status");
    } catch {
      return startPoll();
    }
    const was = state.running?.running;
    state.running = s;
    renderRunning();
    if (s.running) return startPoll();
    if (was) {
      toast("Scan finished.", "ok");
      await load();
    }
  }, POLL);
}

for (const [id, mode] of [
  ["run-quick", "quick"],
  ["run-full", "full"],
]) {
  $(id).addEventListener("click", async () => {
    for (const b of ["run-quick", "run-full"]) $(b).disabled = true;
    try {
      const r = await fetch(`/api/security/run?mode=${mode}`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast(
        j.started
          ? `${modeLabel(j.mode || mode)} started. It takes ${(j.mode || mode) === "quick" ? "a few minutes" : "about 80 minutes"}.`
          : "A scan is already running.",
        j.started ? "ok" : "",
      );
      state.running = {
        running: true,
        startedAt: new Date().toISOString(),
        currentTool: null,
        mode: j.mode || mode,
      };
      renderRunning();
      startPoll();
    } catch (e) {
      for (const b of ["run-quick", "run-full"]) $(b).disabled = false;
      toast(`Could not start a scan: ${e.message}`, "bad");
    }
  });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.loaded) void load();
});

/* ---------- tools (tool-watch) ---------- */
const TW_PR = "https://github.com/Amit-Roy/dotfiles/pull/";
function twRows(d) {
  const rows = new Map();
  for (const r of d.records || [])
    rows.set(r.tool, {
      tool: r.tool,
      installed: r.installed,
      fixed: r.fixed,
      label: r.installed === r.fixed ? "OK" : "Update available",
      tone: r.installed === r.fixed ? "ok" : "warn",
      ...(r.failed && { label: "Patch failed", tone: "bad" }),
      pr: r.pr,
    });
  for (const m of d.mismatches || [])
    rows.set(m.tool, {
      ...(rows.get(m.tool) || { tool: m.tool, installed: "", fixed: "" }),
      label: "Unsanctioned change",
      tone: "bad",
    });
  return [...rows.values()].sort((a, b) => a.tool.localeCompare(b.tool));
}
function renderToolWatch(d) {
  const box = $("toolwatch");
  const rows = d ? twRows(d) : [];
  box.hidden = !rows.length;
  if (box.hidden) return;
  $("tw-count").textContent = String(rows.length);
  const body = $("tw-rows");
  body.replaceChildren();
  for (const r of rows) {
    const tr = el("tr");
    const th = el("th", "", r.tool);
    th.scope = "row";
    const st = el("td");
    st.append(el("span", `pill ${r.tone}`, r.label));
    if (r.pr) {
      const a = el("a", "", ` PR #${r.pr}`);
      a.href = TW_PR + r.pr;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      st.append(a);
    }
    tr.append(th, el("td", "", r.installed || "-"), el("td", "", r.fixed || "-"), st);
    body.append(tr);
  }
}
async function loadTools() {
  try {
    renderToolWatch(await getJSON("/api/security/tools"));
  } catch {
    renderToolWatch(null);
  }
}
$("tw-check").addEventListener("click", async () => {
  const b = $("tw-check");
  b.disabled = true;
  try {
    const r = await fetch("/api/security/tools/run", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    toast("Tool check started.", "ok");
    setTimeout(loadTools, 4000);
  } catch (e) {
    toast(`Could not start the tool check: ${e.message}`, "bad");
  } finally {
    b.disabled = false;
  }
});

await load();
void loadTools();
