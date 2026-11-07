// Host dashboard "Workspace health" panel: latest check run, overall badge, 14-run history strip.
const REFRESH = 30000;
const RANK = { info: 0, ok: 1, warning: 2, error: 3 };
const LABEL = { ok: "OK", warning: "Warning", error: "Error", info: "Info" };
const $ = (id) => document.getElementById(id);
const makeNode = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
let running = false;

async function call(path, method) {
  const res = await fetch(path, { method });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function relTime(at) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function worstOf(checks) {
  return checks.reduce(
    (acc, check) => (RANK[check.status] > RANK[acc] ? check.status : acc),
    "info",
  );
}

function badge(status) {
  const node = makeNode("span", `health-badge ${status}`, LABEL[status] || status);
  return node;
}

function checkRow(check) {
  const item = makeNode("li", "health-row");
  item.append(makeNode("span", "health-label", check.label), badge(check.status));
  item.append(makeNode("span", "health-detail", check.detail || ""));
  if (check.healed) {
    item.append(
      makeNode("span", "health-healed", `healed: ${check.healed.action} — ${check.healed.result}`),
    );
  }
  return item;
}

function renderStrip(history) {
  const strip = $("health-strip");
  strip.replaceChildren();
  strip.hidden = !history.length;
  for (const run of [...history].reverse()) {
    const when = new Date(run.at).toLocaleString();
    const text = `${when}: ${LABEL[run.worst] || run.worst} (${run.trigger})`;
    const dot = makeNode("li", `health-dot ${run.worst}`);
    dot.title = text;
    dot.setAttribute("aria-label", text);
    dot.append(makeNode("span", "health-dot-text", LABEL[run.worst] || run.worst));
    strip.append(dot);
  }
}

function renderRunning() {
  const btn = $("health-run");
  btn.disabled = running;
  btn.textContent = running ? "Running…" : "Run now";
  btn.setAttribute("aria-busy", String(running));
}

function render(data) {
  running = Boolean(data.running);
  renderRunning();
  const latest = data.latest;
  const rows = $("health-rows");
  rows.replaceChildren();
  $("health-empty").hidden = Boolean(latest);
  $("health-last").hidden = !latest;
  const worst = $("health-worst");
  worst.hidden = !latest;
  if (latest) {
    const status = worstOf(latest.checks);
    worst.className = `health-badge ${status}`;
    worst.textContent = LABEL[status];
    worst.setAttribute("aria-label", `Overall status: ${LABEL[status]}`);
    $("health-last").textContent = `Last run ${relTime(latest.at)} (${latest.trigger})`;
    for (const check of latest.checks) rows.append(checkRow(check));
  }
  renderStrip(data.history || []);
}

async function load() {
  try {
    render(await call("/api/host/health"));
  } catch (err) {
    $("health-last").hidden = false;
    $("health-last").textContent = `Could not load health: ${err.message}`;
  }
}

async function runNow() {
  running = true;
  renderRunning();
  try {
    await call("/api/host/health/run", "POST");
  } catch (err) {
    if (!/409|already/i.test(err.message))
      $("health-last").textContent = `Run failed: ${err.message}`;
  }
  await load();
}

$("health-run").addEventListener("click", () => void runNow());
void load();
setInterval(() => {
  if (!document.hidden) void load();
}, REFRESH);
