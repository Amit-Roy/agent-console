// Host dashboard: live dials, history charts, processes, ports with kill, and a drill-down disk map.
// Static skeleton in host.html; every refresh updates nodes in place (keyed by pid/port) so taps
// on Kill never land on a row that was just replaced.
const REFRESH = 2000;
const PROC_LIMIT = 30;
let timer = null,
  paused = false,
  seq = 0,
  range = 300,
  historyAt = 0,
  headroomAt = 0,
  hrRange = "1h",
  portsAt = 0,
  showAll = false;
let procSort = "cpu",
  procFilter = "",
  lastProcs = [],
  lastMetrics = null;
let duPath = "/home/coder";
const confirming = new Map(); // "pid" or "pid:SIGKILL" -> revert timer
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const bytes = (b, d = 1) => {
  if (!Number.isFinite(b)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return (i === 0 ? String(Math.round(b)) : b.toFixed(b >= 100 ? 0 : d)) + " " + u[i];
};
const rate = (b) => bytes(b) + "/s";
const pct = (n) => (Number.isFinite(n) ? (n >= 10 ? Math.round(n) : n.toFixed(1)) + "%" : "—");
const tier = (n) => (n >= 90 ? "bad" : n >= 75 ? "warn" : "");
const dur = (s) => {
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  return s < 90 ? "just now" : `${dur(s)} ago`;
};
const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
async function postJSON(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
let toastTimer;
function toast(text, tone) {
  const t = $("toast");
  t.textContent = text;
  t.className = `show ${tone || ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = "";
  }, 2500);
}

/* Reuse child nodes by key, update them, and only move the ones whose position changed. */
function keyed(container, items, key, create, update) {
  const map = (container._keyed ||= new Map());
  const live = new Set();
  items.forEach((item, i) => {
    const k = key(item);
    live.add(k);
    let node = map.get(k);
    if (!node) {
      node = create(item);
      map.set(k, node);
    }
    update(node, item);
    if (container.children[i] !== node) container.insertBefore(node, container.children[i] || null);
  });
  for (const [k, node] of map)
    if (!live.has(k)) {
      node.remove();
      map.delete(k);
    }
}

// ---------- dials ----------

const ARC = 270,
  R = 42,
  C = 2 * Math.PI * R;
const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function makeDial(id, label) {
  const d = el("div", "dial");
  d.id = `dial-${id}`;
  const s = svg("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
  const arcLen = (C * ARC) / 360;
  const ticks = svg("g", { class: "ticks" });
  for (let i = 0; i <= 10; i++) {
    const a = ((135 + i * 27) * Math.PI) / 180;
    const r1 = 49,
      r2 = i % 5 ? 47 : 45.5;
    ticks.append(
      svg("line", {
        x1: 50 + r1 * Math.cos(a),
        y1: 50 + r1 * Math.sin(a),
        x2: 50 + r2 * Math.cos(a),
        y2: 50 + r2 * Math.sin(a),
      }),
    );
  }
  const track = svg("circle", {
    class: "track",
    cx: 50,
    cy: 50,
    r: R,
    "stroke-dasharray": `${arcLen} ${C}`,
    transform: "rotate(135 50 50)",
  });
  const fill = svg("circle", {
    class: "fill",
    cx: 50,
    cy: 50,
    r: R,
    "stroke-dasharray": `0 ${C}`,
    transform: "rotate(135 50 50)",
  });
  s.append(ticks, track, fill);
  const center = el("div", "c");
  center.append(el("div", "v"), el("div", "l", label));
  d.append(s, center, el("div", "sub"));
  d._fill = fill;
  d._arc = arcLen;
  return d;
}
function setDial(d, value, text, sub) {
  const v = Math.max(0, Math.min(100, value || 0));
  d._fill.setAttribute("stroke-dasharray", `${(d._arc * v) / 100} ${C}`);
  d.className = `dial ${tier(v)}`;
  d.querySelector(".c .v").textContent = text;
  d.querySelector(".sub").replaceChildren(...sub);
}
const dials = {};
for (const [id, label] of [
  ["cpu", "CPU"],
  ["mem", "Memory"],
  ["disk", "Disk"],
  ["load", "Load"],
])
  $("dials").append((dials[id] = makeDial(id, label)));
const coreStrip = el("div", "cores");
dials.cpu.append(coreStrip);
const subLine = (...parts) =>
  parts.map(([k, v]) => {
    const s = el("span");
    s.append(el("b", "", v), ` ${k}`);
    return s;
  });

function renderMetrics(m) {
  lastMetrics = m;
  const root = m.disk[0]; // the server lists / first
  setDial(dials.cpu, m.cpu.total, pct(m.cpu.total), subLine(["cores", String(m.cpu.n)]));
  keyed(
    coreStrip,
    m.cpu.cores.map((v, i) => ({ v, i })),
    (c) => c.i,
    () => el("i"),
    (n, c) => {
      n.style.setProperty("--h", `${Math.max(4, c.v)}%`);
      n.className = tier(c.v);
      n.title = `Core ${c.i}: ${pct(c.v)}`;
    },
  );
  setDial(
    dials.mem,
    m.mem.pct,
    pct(m.mem.pct),
    subLine([`of ${bytes(m.mem.total)}`, bytes(m.mem.used)]),
  );
  setDial(
    dials.disk,
    root?.pcent ?? 0,
    root ? pct(root.pcent) : "—",
    root ? subLine(["free", bytes(root.avail)]) : [],
  );
  const loadPct = m.cpu.n ? (m.load[0] / m.cpu.n) * 100 : 0;
  // load = processes running or queued for a CPU (plus ones blocked on disk); 1 per core = fully busy
  setDial(
    dials.load,
    loadPct,
    m.load[0].toFixed(1),
    subLine(
      ["per core", (m.cpu.n ? m.load[0] / m.cpu.n : 0).toFixed(1)],
      ["15m", m.load[2].toFixed(1)],
    ),
  );
  dials.load.title = `Load ${m.load[0].toFixed(2)}: processes running or waiting for a CPU, averaged over 1 minute. ${m.cpu.n} means all ${m.cpu.n} cores busy; above that, work queues.`;
  const swap =
    m.mem.swapTotal > 0 ? ` · swap ${pct((1 - m.mem.swapFree / m.mem.swapTotal) * 100)}` : "";
  // page files go live on pull, the server only on restart: tolerate an older server's payload
  const io = m.io
    ? ` · net in ${rate(m.io.rx)} out ${rate(m.io.tx)} · disk read ${rate(m.io.rd)} write ${rate(m.io.wr)}`
    : "";
  $("meta").textContent = `Up ${dur(m.uptime)} · ${m.platform} ${m.arch}${io}${swap}`;
  renderMounts(m.disk);
}

// ---------- history ----------

let Chart = null;
const charts = {};
const loadChart = () =>
  import("/vendor/chart.umd.min.js")
    .then(() => {
      Chart = globalThis.Chart;
      Chart.defaults.font.family = css("--font-mono");
      Chart.defaults.font.size = 10;
    })
    .catch(() => {});
const timeTick = (v) => {
  const d = new Date(v);
  return range > 3600
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: range <= 300 ? "2-digit" : undefined,
      });
};
function chartOptions(yFmt, max) {
  const grid = css("--edge"),
    t3 = css("--t3");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    interaction: { mode: "index", intersect: false },
    elements: { point: { radius: 0, hoverRadius: 3 }, line: { borderWidth: 1.5, tension: 0.25 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => new Date(items[0].parsed.x).toLocaleString(),
          label: (c) => `${c.dataset.label} ${yFmt(c.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        min: Date.now() - range * 1000,
        max: Date.now(),
        ticks: { color: t3, maxTicksLimit: 4, maxRotation: 0, callback: timeTick },
        grid: { color: grid, drawTicks: false },
        border: { display: false },
      },
      y: {
        beginAtZero: true,
        max,
        ticks: { color: t3, maxTicksLimit: 3, callback: (v) => (v === 0 ? "0" : yFmt(v)) },
        grid: { color: grid, drawTicks: false },
        border: { display: false },
      },
    },
  };
}
function series(label, color, data, fill) {
  return { label, data, borderColor: color, backgroundColor: color + "22", fill };
}
function drawChart(id, datasets, yFmt, max) {
  if (!Chart) return;
  const opts = chartOptions(yFmt, max);
  if (charts[id]) {
    charts[id].data.datasets = datasets;
    charts[id].options = opts;
    charts[id].update("none");
  } else charts[id] = new Chart($(id), { type: "line", data: { datasets }, options: opts });
}
const peak = (rows, i) => rows.reduce((m, r) => Math.max(m, r[i]), 0);
const mean = (rows, i) => (rows.length ? rows.reduce((s, r) => s + r[i], 0) / rows.length : 0);

async function loadHistory() {
  historyAt = Date.now();
  let h;
  try {
    h = await getJSON(`/api/host/history?range=${range}`);
  } catch (e) {
    // a server older than this page has no history endpoint until it restarts
    $("cap-cpu").textContent = /404/.test(e.message)
      ? "available after the server restarts"
      : "unavailable";
    return;
  }
  const p = h.points;
  const col = (name) => p.map((r) => ({ x: r[0], y: r[h.cols.indexOf(name)] }));
  const ix = (name) => h.cols.indexOf(name);
  $("cap-cpu").textContent = p.length
    ? `avg ${pct(mean(p, ix("cpu")))} · peak ${pct(peak(p, ix("cpu")))}`
    : "collecting…";
  $("cap-net").textContent = p.length
    ? `peak in ${rate(peak(p, ix("rx")))} · out ${rate(peak(p, ix("tx")))}`
    : "";
  $("cap-io").textContent = p.length
    ? `peak read ${rate(peak(p, ix("rd")))} · write ${rate(peak(p, ix("wr")))}`
    : "";
  const c1 = css("--viz-1"),
    c2 = css("--viz-2"),
    c3 = css("--viz-3");
  drawChart(
    "ch-cpu",
    [series("CPU", c1, col("cpu"), true), series("Memory", c2, col("mem"), false)],
    pct,
    100,
  );
  drawChart(
    "ch-net",
    [series("In", c2, col("rx"), true), series("Out", c3, col("tx"), false)],
    rate,
  );
  drawChart(
    "ch-io",
    [series("Read", c1, col("rd"), true), series("Write", c3, col("wr"), false)],
    rate,
  );
}
$("range").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-range]");
  if (!b) return;
  range = Number(b.dataset.range);
  for (const x of $("range").children) x.setAttribute("aria-pressed", String(x === b));
  void loadHistory().catch(() => {});
});

// ---------- headroom memory ----------

const HR_RANGE_MS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const HR_GAP_MS = 5 * 60_000;
const HR_TRIGGERS = {
  step: { label: "Step snapshot", glyph: "●", style: "circle", color: "--viz-5" },
  periodic: { label: "Periodic snapshot", glyph: "◆", style: "rectRot", color: "--t2" },
  breaker: { label: "Breaker snapshot", glyph: "▲", style: "triangle", color: "--bad" },
};
const signedBytes = (v) => (v === 0 ? "0" : `${v > 0 ? "+" : "−"}${bytes(Math.abs(v))}`);
const hrTick = (v) => {
  const when = new Date(v);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return HR_RANGE_MS[hrRange] > 86_400_000 ? `${when.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
};
const lastValue = (rows, match = () => true) => {
  for (let idx = (rows?.length ?? 0) - 1; idx >= 0; idx--) if (match(rows[idx])) return rows[idx].value;
  return null;
};
// Points as {x,y}; a null y between samples more than HR_GAP_MS apart breaks the line.
function gapped(points) {
  const out = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (prev && point.x - prev.x > HR_GAP_MS) out.push({ x: prev.x + 1, y: null });
    out.push(point);
  }
  return out;
}
function rssSegments(rss) {
  const byPid = new Map();
  for (const row of rss) {
    if (!byPid.has(row.pid)) byPid.set(row.pid, []);
    byPid.get(row.pid).push(row);
  }
  return [...byPid.values()];
}
const metricPoints = (rows) => gapped((rows ?? []).map((r) => ({ x: r.at, y: r.value })));
function growthPerHour(rss) {
  const segs = rssSegments(rss);
  const seg = segs[segs.length - 1] ?? [];
  if (seg.length < 2) return null;
  const hours = (seg[seg.length - 1].at - seg[0].at) / 3_600_000;
  return hours > 0 ? (seg[seg.length - 1].rss - seg[0].rss) / 1048576 / hours : null;
}
function hrStats(data) {
  const metrics = data.metrics;
  const rssNow = data.rss[data.rss.length - 1]?.rss ?? null;
  const growth = growthPerHour(data.rss);
  const freeHeld = lastValue(metrics["headroom.malloc.free_held_bytes"]);
  const gcRows = metrics["process.runtime.cpython.gc_count"] ?? [];
  const attrs = [...new Set(gcRows.map((r) => r.attr))].sort();
  const gcParts = attrs.map((a) => `g${String(a ?? "").replace(/^\w+=/, "")} ${lastValue(gcRows, (r) => r.attr === a)}`);
  const threads = lastValue(metrics["process.runtime.cpython.thread_count"]);
  return [
    ["RSS now", rssNow == null ? "—" : bytes(rssNow)],
    ["Growth", growth == null ? "—" : `${growth >= 0 ? "+" : "−"}${Math.abs(growth).toFixed(0)} MB/h`],
    ["Malloc free-held", freeHeld == null ? "—" : bytes(freeHeld)],
    ["GC counts", gcParts.length ? gcParts.join(" · ") : "—"],
    ["Threads", threads == null ? "—" : String(threads)],
  ];
}
function renderHrStats(data) {
  $("hr-stats").replaceChildren(
    ...hrStats(data).map(([label, value]) => {
      const box = el("div");
      box.append(el("dt", "", label), el("dd", "", value));
      return box;
    }),
  );
}
function hrDatasets(data) {
  const colors = { rss: css("--viz-1"), anon: css("--viz-2"), free: css("--viz-3"), traced: css("--viz-4") };
  const sets = [];
  const line = (label, color, points) => ({ ...series(label, color, points, false), pointRadius: 0 });
  rssSegments(data.rss).forEach((seg) =>
    sets.push(line("RSS", colors.rss, seg.map((r) => ({ x: r.at, y: r.rss })))),
  );
  const anon = data.rss.filter((r) => r.anon != null);
  if (anon.length) sets.push(line("Anon", colors.anon, gapped(anon.map((r) => ({ x: r.at, y: r.anon })))));
  const free = data.metrics["headroom.malloc.free_held_bytes"];
  if (free?.length) sets.push(line("Malloc free-held", colors.free, metricPoints(free)));
  const traced = data.metrics["headroom.tracemalloc.traced_bytes"];
  if (traced?.length) sets.push(line("Tracemalloc traced", colors.traced, metricPoints(traced)));
  for (const [trigger, spec] of Object.entries(HR_TRIGGERS)) {
    const points = data.snapshots.filter((s) => s.trigger === trigger).map((s) => ({ x: s.at, y: s.rss }));
    if (!points.length) continue;
    const color = css(spec.color);
    sets.push({
      label: spec.label,
      data: points,
      showLine: false,
      pointStyle: spec.style,
      pointRadius: 6,
      pointHoverRadius: 8,
      pointBackgroundColor: color,
      pointBorderColor: css("--card"),
      pointBorderWidth: 1.5,
      borderColor: color,
    });
  }
  return sets;
}
function renderHrLegend(data, sets) {
  const items = [];
  const seen = new Set();
  for (const set of sets) {
    if (seen.has(set.label)) continue;
    seen.add(set.label);
    const spec = Object.values(HR_TRIGGERS).find((t) => t.label === set.label);
    const count = spec ? ` ×${data.snapshots.filter((s) => HR_TRIGGERS[s.trigger] === spec).length}` : "";
    const item = el("li");
    const swatch = el("span", "sw", spec ? spec.glyph : "━");
    swatch.style.color = spec ? css(spec.color) : set.borderColor;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, el("span", "", set.label + count));
    items.push(item);
  }
  $("hr-legend").replaceChildren(...items);
}
function drawHrChart(data) {
  if (!Chart) return;
  const sets = hrDatasets(data);
  renderHrLegend(data, sets);
  const opts = chartOptions(bytes);
  const now = Date.now();
  opts.scales.x.min = now - HR_RANGE_MS[hrRange];
  opts.scales.x.max = now;
  opts.scales.x.ticks.callback = hrTick;
  opts.scales.y.beginAtZero = false;
  opts.scales.y.ticks.maxTicksLimit = 5;
  opts.interaction = { mode: "nearest", intersect: true };
  if (charts["ch-hr"]) {
    charts["ch-hr"].data.datasets = sets;
    charts["ch-hr"].options = opts;
    charts["ch-hr"].update("none");
  } else charts["ch-hr"] = new Chart($("ch-hr"), { type: "line", data: { datasets: sets }, options: opts });
}
function siteRow(site) {
  const row = el("tr");
  const loc = el("td", "loc", site.location);
  loc.title = site.location;
  const delta = site.deltaBytes;
  const change = el("td", `num ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`, delta == null ? "new" : signedBytes(delta));
  row.append(loc, el("td", "num", bytes(site.bytes)), change, el("td", "num", Math.round(site.count).toLocaleString()));
  return row;
}
function renderHrSites(sites) {
  const empty = sites.at == null;
  $("hr-sites-empty").hidden = !empty;
  $("hr-sites-wrap").hidden = empty;
  $("hr-sites-at").textContent = empty ? "" : `as of ${new Date(sites.at).toLocaleTimeString()}`;
  const top = [...sites.rows].sort((a, b) => b.bytes - a.bytes).slice(0, 20);
  $("hr-sites").tBodies[0].replaceChildren(...top.map(siteRow));
}
function renderHeadroom(data) {
  const reporting =
    data.rss.length > 0 || data.snapshots.length > 0 || Object.keys(data.metrics).length > 0;
  $("hr-empty").hidden = reporting;
  $("hr-body").hidden = !reporting;
  if (!reporting) {
    $("hr-empty").textContent = "Headroom profiler not reporting";
    return;
  }
  renderHrStats(data);
  renderHrSites(data.sites);
  drawHrChart(data);
}
async function loadHeadroom() {
  headroomAt = Date.now();
  try {
    renderHeadroom(await getJSON(`/api/host/headroom-profile?range=${hrRange}`));
  } catch (err) {
    $("hr-body").hidden = true;
    $("hr-empty").hidden = false;
    $("hr-empty").textContent = /404/.test(err.message)
      ? "Headroom profile available after the server restarts"
      : "Headroom profile unavailable";
  }
}
$("hr-range").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  hrRange = button.dataset.range;
  for (const other of $("hr-range").children) other.setAttribute("aria-pressed", String(other === button));
  void loadHeadroom();
});

// ---------- kill ----------

function killButton(pid, signal = "SIGTERM", label = "Kill") {
  const b = el("button", "kill", label);
  b.type = "button";
  b.dataset.pid = String(pid);
  b.dataset.signal = signal;
  b.dataset.label = label;
  return b;
}
function syncKill(b) {
  const on = confirming.has(`${b.dataset.pid}:${b.dataset.signal}`);
  b.classList.toggle("armed", on);
  b.textContent = on ? "Confirm" : b.dataset.label;
  b.setAttribute(
    "aria-label",
    on
      ? `Confirm ${b.dataset.signal} to process ${b.dataset.pid}`
      : `${b.dataset.label} process ${b.dataset.pid}`,
  );
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button.kill[data-pid]");
  if (!b) return;
  e.stopPropagation();
  const pid = Number(b.dataset.pid),
    signal = b.dataset.signal,
    k = `${pid}:${signal}`;
  if (!confirming.has(k)) {
    confirming.set(
      k,
      setTimeout(() => {
        confirming.delete(k);
        document.querySelectorAll(`button.kill[data-pid="${pid}"]`).forEach(syncKill);
      }, 4000),
    );
    document.querySelectorAll(`button.kill[data-pid="${pid}"]`).forEach(syncKill);
    return;
  }
  clearTimeout(confirming.get(k));
  confirming.delete(k);
  b.disabled = true;
  try {
    await postJSON(`/api/host/processes/${pid}/kill`, { signal });
    toast(`Sent ${signal} to ${pid}.`, "ok");
    if (signal === "SIGKILL" || !$("proc-modal").hidden) closeModal();
  } catch (err) {
    toast(`Kill failed: ${err.message}`, "bad");
  }
  b.disabled = false;
  syncKill(b);
  portsAt = 0;
  void tick();
});

// ---------- processes ----------

const STATE = {
  R: "Running",
  S: "Sleeping",
  D: "Waiting on I/O",
  Z: "Zombie",
  T: "Stopped",
  I: "Idle",
};
function procRow(r) {
  const row = el("div", "hrow proc");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const name = el("div", "hname");
  name.append(el("b"), el("span", "hctx"));
  const nums = el("div", "hnum");
  nums.append(el("b", "cpu"), el("span", "mem"));
  row.append(el("span", "hst"), name, nums, killButton(r.pid));
  row.addEventListener("click", (e) => {
    if (!e.target.closest("button")) openModal(row._pid);
  });
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === row) openModal(row._pid);
  });
  return row;
}
function updateProc(row, r) {
  row._pid = r.pid;
  const st = row.children[0];
  st.className = `hst ${r.state}`;
  st.title = STATE[r.state] || r.state;
  row.querySelector(".hname b").textContent = r.label || r.name;
  row.querySelector(".hctx").textContent = r.cwd || `pid ${r.pid}`;
  row.title = r.cmd;
  const cpu = row.querySelector(".cpu");
  cpu.textContent = pct(r.cpu);
  cpu.className = `cpu ${tier(r.cpu)}`;
  row.querySelector(".mem").textContent = bytes(r.rss, 0);
  const kill = row.querySelector(".kill");
  kill.hidden = !!r.protected; // the server refuses these anyway: the console's own process tree and the Coder agent
  syncKill(kill);
}
function renderProcs() {
  const f = procFilter.toLowerCase();
  const list = lastProcs.filter(
    (p) => !f || `${p.label} ${p.name} ${p.cmd} ${p.cwd} ${p.pid}`.toLowerCase().includes(f),
  );
  const cmp =
    procSort === "label"
      ? (a, b) => a.label.localeCompare(b.label)
      : procSort === "mem"
        ? (a, b) => b.rss - a.rss
        : (a, b) => b.cpu - a.cpu || b.rss - a.rss;
  list.sort(cmp);
  const shown = showAll ? list : list.slice(0, PROC_LIMIT);
  keyed($("proc-rows"), shown, (p) => p.pid, procRow, updateProc);
  $("proc-count").textContent = String(lastProcs.length);
  const more = $("proc-more");
  more.hidden = list.length <= PROC_LIMIT;
  more.textContent = showAll ? "Show fewer" : `Show all ${list.length}`;
  if (!shown.length)
    $("proc-rows").replaceChildren(
      el("div", "empty-c", f ? "No matching processes." : "No processes visible."),
    ),
      ($("proc-rows")._keyed = null);
}
$("proc-more").onclick = () => {
  showAll = !showAll;
  renderProcs();
};
$("proc-filter").addEventListener("input", (e) => {
  procFilter = e.target.value.trim();
  renderProcs();
});
$("proc-sort").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sort]");
  if (!b) return;
  procSort = b.dataset.sort;
  for (const x of $("proc-sort").children) x.setAttribute("aria-pressed", String(x === b));
  renderProcs();
});

// ---------- ports ----------

function portRow() {
  const row = el("div", "hrow port");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const name = el("div", "hname");
  name.append(el("b"), el("span", "hctx"));
  row.append(el("span", "pn"), name, el("span", "kill-slot"));
  row.addEventListener("click", (e) => {
    if (!e.target.closest("button") && row._pid) openModal(row._pid);
  });
  return row;
}
function updatePort(row, r) {
  row._pid = r.pid;
  row.children[0].textContent = String(r.port);
  row.querySelector(".hname b").textContent = r.label || "unknown";
  row.querySelector(".hctx").textContent = [
    r.proto === "tcp6" ? "IPv6" : "IPv4",
    r.pid ? `pid ${r.pid}` : "",
    r.user,
  ]
    .filter(Boolean)
    .join(" · ");
  row.title = r.cmd;
  const slot = row.children[2];
  if (r.pid && !r.protected && slot.firstChild?.dataset.pid !== String(r.pid))
    slot.replaceChildren(killButton(r.pid));
  if (!r.pid || r.protected) slot.replaceChildren();
  if (slot.firstChild) syncKill(slot.firstChild);
}
function renderPorts(list) {
  $("port-count").textContent = String(list.length);
  keyed($("port-rows"), list, (p) => `${p.port}:${p.pid}`, portRow, updatePort);
}

// ---------- storage ----------

function renderMounts(disk) {
  keyed(
    $("mounts"),
    disk,
    (d) => d.target,
    () => {
      const r = el("div", "mount");
      const top = el("div", "top");
      top.append(el("b"), el("span"));
      const bar = el("div", "meter");
      bar.append(el("i"));
      r.append(top, bar);
      return r;
    },
    (r, d) => {
      r.querySelector(".top b").textContent = d.target;
      r.querySelector(".top span").textContent =
        `${bytes(d.used)} used · ${bytes(d.avail)} free · ${bytes(d.size)}`;
      const i = r.querySelector(".meter i");
      i.style.width = `${d.pcent}%`;
      i.className = tier(d.pcent);
    },
  );
}
function renderDuCrumbs(crumbs, duData) {
  crumbs.replaceChildren();
  const parts = duData.path === "/" ? [""] : duData.path.split("/");
  parts.forEach((seg, i) => {
    const p = parts.slice(0, i + 1).join("/") || "/";
    const b = el("button", "", i === 0 ? "/" : seg);
    b.type = "button";
    b.dataset.path = p;
    if (i === parts.length - 1) b.setAttribute("aria-current", "location");
    crumbs.append(b);
  });
  if (duData.size) crumbs.append(el("span", "total", bytes(duData.size)));
}
function buildDuRow(child, maxSize) {
  const row = el(child.more ? "button" : "div", "hrow du");
  if (child.more) {
    row.type = "button";
    row.dataset.path = child.path;
  }
  const name = el("div", "hname");
  name.append(el("b", "", child.path.split("/").pop()));
  const meterBar = el("div", "meter");
  const fill = el("i");
  fill.style.width = `${(child.size / maxSize) * 100}%`;
  meterBar.append(fill);
  name.append(meterBar);
  row.append(
    name,
    el("div", "hnum", bytes(child.size)),
    el("span", "hchev", child.more ? "›" : ""),
  );
  return row;
}
function duEmptyText(duData) {
  if (duData.scannedAt) return "Nothing larger than 16 MB here.";
  if (duData.scanning) return "Scanning the disk. This takes about two minutes.";
  return "No scan yet.";
}
async function loadDu(path = duPath) {
  const duData = await getJSON(`/api/host/du?path=${encodeURIComponent(path)}`);
  duPath = duData.path;
  renderDuCrumbs($("du-crumbs"), duData);
  const rows = $("du-rows");
  rows.replaceChildren();
  const max = duData.children[0]?.size || 1;
  for (const child of duData.children) rows.append(buildDuRow(child, max));
  if (!duData.children.length) rows.append(el("div", "empty-c", duEmptyText(duData)));
  $("du-note").textContent = duData.scannedAt
    ? `Scanned ${ago(duData.scannedAt)}${duData.scanning ? " · rescanning…" : ""}. Folders under 16 MB are hidden.`
    : "";
  $("du-rescan").disabled = duData.scanning;
  return duData;
}
$("storage").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-path]");
  if (!b) return;
  void loadDu(b.dataset.path).catch((err) => toast(err.message, "bad"));
});
let duPoll = null;
$("du-rescan").onclick = async () => {
  try {
    await postJSON("/api/host/du/rescan");
    toast("Disk scan started. It takes about two minutes.", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
  clearInterval(duPoll);
  duPoll = setInterval(async () => {
    const d = await loadDu().catch(() => null);
    if (d && !d.scanning) clearInterval(duPoll);
  }, 10000);
  void loadDu();
};

// ---------- detail modal ----------

let lastFocus = null;
function closeModal() {
  const m = $("proc-modal");
  if (m.hidden) return;
  m.hidden = true;
  lastFocus?.focus?.();
}
$("proc-modal").querySelector(".modal-backdrop").onclick = closeModal;
$("proc-modal").querySelector(".close").onclick = closeModal;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

async function openModal(pid) {
  const m = $("proc-modal"),
    body = $("proc-modal-body");
  lastFocus = document.activeElement;
  m.hidden = false;
  body.replaceChildren(el("p", "muted", "Loading…"));
  m.querySelector(".close").focus();
  try {
    const d = await getJSON(`/api/host/processes/${pid}/detail`);
    const live = lastProcs.find((p) => p.pid === pid);
    const head = el("div", "pm-head");
    const t = el("h2", "", d.label || d.name);
    t.id = "pm-title";
    head.append(
      t,
      el(
        "p",
        "hctx",
        [d.cwd, `pid ${d.pid}`, STATE[d.state] || d.state].filter(Boolean).join(" · "),
      ),
    );
    const facts = el("dl", "hfacts");
    for (const [k, v] of [
      ["CPU", pct(live?.cpu ?? 0)],
      ["Memory", bytes(d.rss)],
      ["Threads", String(d.threads)],
      ["Running", d.uptime],
      ["User", d.user],
      ["Parent", String(d.ppid)],
      ["Nice", String(d.nice)],
      ["Ports", d.ports.length ? d.ports.join(", ") : "none"],
    ]) {
      const w = el("div");
      w.append(el("dt", "", k), el("dd", "", v));
      facts.append(w);
    }
    const cmd = el("pre", "hcmd", d.cmd);
    const acts = el("div", "pm-acts");
    acts.append(
      killButton(d.pid, "SIGTERM", "Terminate"),
      killButton(d.pid, "SIGKILL", "Force kill"),
    );
    acts.querySelectorAll(".kill").forEach(syncKill);
    body.replaceChildren(head, facts, el("h3", "", "Command"), cmd);
    if (d.children.length) {
      const list = el("ul", "kids");
      for (const c of d.children) {
        const li = el("li");
        li.append(el("b", "", c.name), el("span", "", ` pid ${c.pid}`));
        li.title = c.cmd;
        list.append(li);
      }
      body.append(el("h3", "", `Child processes · ${d.children.length}`), list);
    }
    body.append(
      d.protected
        ? el(
            "p",
            "note",
            "Protected: stopping this process would take down the console or the workspace.",
          )
        : acts,
    );
  } catch (e) {
    body.replaceChildren(el("p", "muted", `Could not load details: ${e.message}`));
  }
}

// ---------- loop ----------

async function tick() {
  const mine = ++seq;
  try {
    // ports change rarely and cost the most to resolve, so they refresh every 10 s
    const wantPorts = Date.now() - portsAt > 10_000;
    if (wantPorts) portsAt = Date.now();
    const [metrics, procs, ports] = await Promise.all([
      getJSON("/api/host/metrics"),
      getJSON("/api/host/processes"),
      wantPorts ? getJSON("/api/host/ports") : null,
    ]);
    if (mine !== seq) return;
    renderMetrics(metrics);
    lastProcs = procs.processes;
    renderProcs();
    if (ports) renderPorts(ports.ports);
    // 5 s samples move every tick on the 5 minute view; longer views refresh twice a minute
    if (Date.now() - historyAt > (range <= 300 ? REFRESH : 30000))
      void loadHistory().catch(() => {});
    if (Date.now() - headroomAt > 30_000) void loadHeadroom();
    $("hm").setAttribute("aria-busy", "false");
  } catch (e) {
    if (mine === seq) toast(`Could not load host metrics: ${e.message}`, "bad");
  }
}
function schedule() {
  clearTimeout(timer);
  timer = null;
  if (!paused && !document.hidden)
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, REFRESH);
}
function setPaused(p) {
  paused = p;
  $("pause").setAttribute("aria-pressed", String(p));
  $("pause").textContent = p ? "Resume" : "Pause";
  $("liveLabel").textContent = p ? "Paused" : "Live";
  $("live").classList.toggle("paused", p);
  if (p) clearTimeout(timer);
  else schedule();
}
$("pause").onclick = () => setPaused(!paused);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else if (!paused) {
    void tick();
    schedule();
  }
});

await loadChart();
void tick();
void loadDu().catch(() => {});
setPaused(false);
