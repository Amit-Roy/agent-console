// Usage & savings dashboard. Plain SVG/DOM: a handful of bar charts does not justify a charting library or a build step.
const DAY = 864e5;
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (n) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
      : n >= 1e4
        ? `${Math.round(n / 1e3)}k`
        : n >= 1e3
          ? `${(n / 1e3).toFixed(1)}k`
          : String(Math.round(n));
const usd = (n) => `$${n.toFixed(n >= 0.01 ? 2 : n > 0 ? 4 : 3)}`;
const pct = (n) => `${n >= 10 ? Math.round(n) : n.toFixed(1)}%`;
const PROVIDERS = {
  claude: ["Claude", "--c-claude"],
  codex: ["Codex", "--c-codex"],
  pi: ["Pi", "--c-pi"],
};
const provMeta = (p) => PROVIDERS[p] || [p === "mock" ? "Mock" : p, "--c-other"];
const css = (v) => `var(${v})`;
const localDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};

// ---------- range ----------
let range = { key: "7", from: 0, to: 0 };
function setRange(key, from, to) {
  const now = Date.now();
  if (key !== "custom") {
    const days = Number(key);
    to = now;
    from = startOfDay(now) - (days - 1) * DAY;
  }
  range = { key, from, to };
  for (const b of document.querySelectorAll(".range button"))
    b.setAttribute("aria-pressed", String(b.dataset.r === key));
  $("custom").hidden = key !== "custom";
  if (key === "custom") {
    $("from").value = localDay(from);
    $("to").value = localDay(to);
  }
  history.replaceState(
    null,
    "",
    key === "custom" ? `#${localDay(from)}..${localDay(to)}` : `#${key}`,
  );
  void load();
}
for (const b of document.querySelectorAll(".range button"))
  b.onclick = () => {
    if (b.dataset.r === "custom") {
      const to = Date.now();
      setRange("custom", to - 14 * DAY, to);
    } else setRange(b.dataset.r);
  };
$("custom").onsubmit = (e) => {
  e.preventDefault();
  const from = new Date(`${$("from").value}T00:00:00Z`).getTime(),
    to = new Date(`${$("to").value}T23:59:59Z`).getTime();
  if (!(from < to)) return;
  setRange("custom", from, Math.min(to, Date.now()));
};

// ---------- data ----------
async function fetchRange(from, to) {
  const r = await fetch(`/api/dashboard?from=${from}&to=${to}`, { credentials: "same-origin" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
// ---------- tabs ----------
let tab = new URLSearchParams(location.search).get("tab") === "tokens" ? "tokens" : "usage";
let overhead = { loading: true },
  ohSeq = 0,
  lastCur = null,
  tokensMod = null;
function applyTab(focus) {
  for (const b of document.querySelectorAll(".tabs [role=tab]")) {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  $("dm").hidden = tab !== "usage";
  $("dt").hidden = tab !== "tokens";
  hideTip();
}
function setTab(next, focus) {
  if (next === tab) {
    if (focus) applyTab(true);
    return;
  }
  tab = next;
  const u = new URL(location.href);
  if (tab === "tokens") u.searchParams.set("tab", "tokens");
  else u.searchParams.delete("tab");
  history.replaceState(null, "", u);
  applyTab(focus);
  void load();
}
for (const b of document.querySelectorAll(".tabs [role=tab]")) {
  b.onclick = () => setTab(b.dataset.tab);
  b.onkeydown = (e) => {
    const order = ["usage", "tokens"],
      i = order.indexOf(b.dataset.tab);
    const next =
      e.key === "ArrowRight"
        ? order[(i + 1) % 2]
        : e.key === "ArrowLeft"
          ? order[(i + 1) % 2]
          : e.key === "Home"
            ? order[0]
            : e.key === "End"
              ? order[1]
              : null;
    if (next) {
      e.preventDefault();
      setTab(next, true);
    }
  };
}

// ---------- tokens tab ----------
async function fetchOverhead() {
  const mine = ++ohSeq;
  try {
    const r = await fetch("/api/dashboard/overhead", { credentials: "same-origin" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const data = await r.json();
    if (mine === ohSeq) overhead = data;
  } catch (e) {
    if (mine === ohSeq) overhead = { error: e.message };
  }
  if (mine === ohSeq && tab === "tokens") renderTokensTab();
}
function retryOverhead() {
  overhead = { loading: true };
  renderTokensTab();
  void fetchOverhead();
}
function renderTokensTab() {
  if (!lastCur || !tokensMod) return;
  tokensMod.renderTokens($("dt"), lastCur, overhead, {
    el,
    panel,
    kpi,
    hbars,
    legend,
    fmt,
    usd,
    pct,
    provMeta,
    showTip,
    hideTip,
    retryOverhead,
  });
}

let seq = 0;
async function load() {
  const mine = ++seq;
  const root = $(tab === "tokens" ? "dt" : "dm");
  root.setAttribute("aria-busy", "true");
  try {
    if (tab === "tokens") {
      const [cur, mod] = await Promise.all([
        fetchRange(range.from, range.to),
        tokensMod || import("/dashboard-tokens.js"),
      ]);
      if (mine !== seq) return;
      tokensMod = mod;
      lastCur = cur;
      if (!overhead || overhead.error) overhead = { loading: true };
      renderTokensTab();
      void fetchOverhead();
    } else {
      const span = range.to - range.from;
      const [cur, prev] = await Promise.all([
        fetchRange(range.from, range.to),
        fetchRange(range.from - span, range.from - 1).catch(() => null),
      ]);
      if (mine === seq) {
        render(cur, prev);
      }
    }
  } catch (e) {
    if (mine === seq)
      root.replaceChildren(
        el("p", "muted", `Could not load ${tab === "tokens" ? "tokens" : "usage"}: ${e.message}`),
      );
  }
  if (mine === seq) root.setAttribute("aria-busy", "false");
}

const hasTokens = (t) => Number.isFinite(t.in) && t.in >= 0 && Number.isFinite(t.out) && t.out >= 0;
const tokensOf = (t) => (hasTokens(t) ? t.in + t.out : 0);
const sumTurns = (turns) => ({
  knownTokens: turns.filter(hasTokens).length,
  knownCost: turns.filter((t) => t.cost != null && t.accounting === 2).length,
  turns: turns.length,
  tokens: turns.reduce((s, t) => s + tokensOf(t), 0),
  in: turns.reduce((s, t) => s + (hasTokens(t) ? t.in : 0), 0),
  out: turns.reduce((s, t) => s + (hasTokens(t) ? t.out : 0), 0),
  cache: turns.reduce((s, t) => s + (t.accounting === 2 ? t.cache || 0 : 0), 0),
  cost: turns.reduce((s, t) => s + (t.accounting === 2 ? t.cost || 0 : 0), 0),
  ms: turns.reduce((s, t) => s + (t.ms || 0), 0),
});
const savedOf = (d) => {
  const rtk = (d?.rtk?.daily || []).reduce((s, x) => s + (x.saved_tokens || 0), 0);
  const hr = (d?.headroom?.daily || []).reduce((s, x) => s + (x.tokens_saved || 0), 0);
  return { rtk, hr };
};
const PLAN_KEY = "ac_subscription_monthly_usd_v1";
const DEFAULT_MONTHLY_FEES = { claude: 40, codex: 20 };
let monthlyFees = { ...DEFAULT_MONTHLY_FEES };
try {
  const savedFees = localStorage.getItem(PLAN_KEY);
  if (savedFees !== null) {
    const parsedFees = JSON.parse(savedFees);
    if (parsedFees && typeof parsedFees === "object" && !Array.isArray(parsedFees))
      monthlyFees = parsedFees;
  }
} catch {}
// Include every selected UTC calendar day; each month contributes its own day fraction.
function allocatedFee(monthly, from, to) {
  let total = 0;
  for (let day = startOfDay(from); day <= startOfDay(to); day += DAY) {
    const d = new Date(day);
    total += monthly / new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  }
  return total;
}
const feeKnown = (p) => Number.isFinite(monthlyFees[p]) && monthlyFees[p] >= 0;
function comparisonKpis(figures) {
  const { measured, comparable, configured, api, fees, complete } = figures;
  const values = el("div", "comparison-values");
  values.append(
    kpi(
      "Estimated API cost",
      measured.length ? usd(api) : "—",
      `${measured.length}/${comparable.length} matching turns priced · ${configured.map((provider) => provMeta(provider)[0]).join(" + ") || "no fees configured"}`,
    ),
    kpi(
      "Your allocated subscription cost",
      configured.length ? usd(fees) : "Not configured",
      `${usd(configured.reduce((sum, provider) => sum + monthlyFees[provider], 0))}/month · prorated by UTC calendar day`,
    ),
    kpi(
      "API estimate minus subscriptions",
      complete ? `${api < fees ? "−" : ""}${usd(Math.abs(api - fees))}` : "—",
      complete
        ? api >= fees
          ? "API estimate is higher"
          : "Subscription allocation is higher"
        : "Requires fees and full API cost coverage",
    ),
  );
  return values;
}
function drawSubscriptionComparison(panelBox, result, cur) {
  const providers = ["claude", "codex"];
  const active = providers.filter((provider) => cur.turns.some((t) => t.provider === provider));
  const missing = active.filter((provider) => !feeKnown(provider));
  const configured = providers.filter(feeKnown);
  panelBox.querySelector(".head .sub").textContent = configured.length
    ? `${configured.map((provider) => `${provMeta(provider)[0]}: ${usd(monthlyFees[provider])}/month`).join(" · ")}. Fees are editable.`
    : "Set your monthly subscription fees to compare.";
  const comparable = cur.turns.filter((t) => configured.includes(t.provider));
  const measured = comparable.filter((t) => t.accounting === 2 && t.cost != null);
  const api = measured.reduce((sum, t) => sum + t.cost, 0);
  const fees = configured.reduce(
    (sum, provider) => sum + allocatedFee(monthlyFees[provider], range.from, range.to),
    0,
  );
  const complete =
    !missing.length && comparable.length > 0 && measured.length === comparable.length;
  const values = comparisonKpis({ measured, comparable, configured, api, fees, complete });
  const note = missing.length
    ? `Enter your monthly ${missing.map((provider) => (provider === "codex" ? "Codex / ChatGPT" : "Claude")).join(" and ")} fee to compare.`
    : "Enter the full monthly fee you pay, including any taxes you want counted. Use 0 for no paid plan.";
  result.replaceChildren(
    values,
    el("p", "note", note),
    el(
      "p",
      "note",
      "This compares recorded console activity with allocated plan fees, not a bill or a claim of savings. Pi / pay-as-you-go activity is excluded. Fees apply across this selected range; adjust them if your plan changed.",
    ),
  );
}
function saveSubscriptionFees(form, status, redraw) {
  if (!form.reportValidity()) return;
  const next = {};
  for (const input of form.querySelectorAll("input"))
    if (input.value.trim()) next[input.name] = Number(input.value);
  monthlyFees = next;
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(next));
    status.textContent = "Saved in this browser.";
  } catch {
    status.textContent = "Applied for this page; this browser could not save your fees.";
  }
  redraw();
}
function buildFeeInput(provider, name) {
  const label = el("label", "", name),
    input = el("input");
  input.type = "number";
  input.min = "0";
  input.max = "100000";
  input.step = "0.01";
  input.inputMode = "decimal";
  input.name = provider;
  input.value = feeKnown(provider) ? String(monthlyFees[provider]) : "";
  input.placeholder = "Not configured";
  label.append(input);
  return label;
}
function subscriptionPanel(cur) {
  const panelBox = panel(
    "API estimate vs your subscriptions",
    "Your configured monthly subscription fees.",
  );
  const result = el("div", "comparison-result");
  const draw = () => drawSubscriptionComparison(panelBox, result, cur);
  draw();
  const settings = el("details", "subscription-settings");
  settings.append(el("summary", "", "Set your monthly subscription fees"));
  const form = el("form", "subscription-form");
  for (const [provider, name] of [
    ["claude", "Claude combined monthly fee (USD)"],
    ["codex", "Codex / ChatGPT monthly fee (USD)"],
  ])
    form.append(buildFeeInput(provider, name));
  const save = el("button", "btn primary", "Save fees");
  save.type = "submit";
  const status = el("p", "note", "Stored only in this browser. Leave a fee blank to clear it.");
  status.setAttribute("role", "status");
  form.append(save);
  form.onsubmit = (event) => {
    event.preventDefault();
    saveSubscriptionFees(form, status, draw);
  };
  settings.append(form, status);
  panelBox.append(result, settings);
  return panelBox;
}
function delta(now, before) {
  if (before == null || !isFinite(before)) return "";
  if (before === 0) return now > 0 ? "nothing earlier to compare" : "no change";
  const p = ((now - before) / before) * 100;
  return `${p >= 0 ? "▲" : "▼"} ${Math.abs(p) >= 10 ? Math.round(Math.abs(p)) : Math.abs(p).toFixed(1)}% vs previous`;
}

// ---------- widgets ----------
const tip = $("tip");
function showTip(e, title, rows) {
  tip.replaceChildren(
    el("b", "", title),
    ...rows.map(([k, v, c]) => {
      const r = el("div", "r");
      const l = el("span");
      if (c) {
        const i = el("i");
        i.style.cssText = `display:inline-block;width:.5rem;height:.5rem;border-radius:2px;margin-right:6px;background:${c}`;
        l.append(i);
      }
      l.append(k);
      r.append(l, el("span", "", v));
      return r;
    }),
  );
  tip.hidden = false;
  const pad = 12,
    w = tip.offsetWidth,
    hh = tip.offsetHeight;
  const x = e.clientX ?? e.target.getBoundingClientRect().left,
    y = e.clientY ?? e.target.getBoundingClientRect().top;
  tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x + pad))}px`;
  tip.style.top = `${Math.max(8, y - hh - pad < 8 ? y + pad : y - hh - pad)}px`;
}
const hideTip = () => {
  tip.hidden = true;
};

function kpi(label, value, sub, hero) {
  const k = el("div", `kpi${hero ? " hero" : ""}`);
  k.append(el("div", "l", label), el("div", "v", value), el("div", "d", sub || " "));
  return k;
}
function panel(title, sub, extra) {
  const p = el("section", "panel");
  const head = el("div", "head");
  const t = el("div");
  t.append(el("h2", "", title));
  if (sub) t.append(el("p", "sub", sub));
  head.append(t);
  if (extra) head.append(extra);
  p.append(head);
  return p;
}
function legend(items) {
  const l = el("div", "legend");
  for (const [name, color] of items) {
    const s = el("span");
    const i = el("i");
    i.style.background = color;
    s.append(i, name);
    l.append(s);
  }
  return l;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)),
    f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// Stacked daily bars. series: [{name,color}], rows: [{label, title, values:[n..]}]. 2px gaps, 4px rounded data end, direct hover tips.
function barChart(rows, series, format) {
  const W = 640,
    H = 220,
    L = 44,
    B = 22,
    T = 8,
    R = 4;
  const svg = h("svg", {
    class: "chart",
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": "Bar chart; the data table below has the same numbers",
  });
  const max = niceMax(Math.max(...rows.map((r) => r.values.reduce((a, b) => a + b, 0)), 0));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    svg.append(h("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const t = h("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = format(v);
    svg.append(t);
  }
  const slot = (W - L - R) / Math.max(rows.length, 1),
    bw = Math.max(2, Math.min(28, slot - 2));
  const every = Math.ceil(rows.length / Math.max(2, Math.floor((W - L) / 70)));
  rows.forEach((r, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    const g = h("g", { class: "hov", tabindex: "0" });
    let acc = 0;
    const live = r.values.map((v, k) => [v, k]).filter(([v]) => v > 0);
    live.forEach(([v, k], j) => {
      const top = y(acc + v),
        bottom = y(acc) - (j ? 2 : 0),
        ht = Math.max(1, bottom - top);
      const last = j === live.length - 1,
        rad = Math.min(4, bw / 2, ht);
      const d = last
        ? `M${x},${top + ht} V${top + rad} Q${x},${top} ${x + rad},${top} H${x + bw - rad} Q${x + bw},${top} ${x + bw},${top + rad} V${top + ht} Z`
        : `M${x},${top} h${bw} v${ht} h${-bw} Z`;
      g.append(h("path", { class: "bar", d, style: `fill:${series[k].color}` }));
      acc += v;
    });
    g.append(h("rect", { class: "hit", x: L + slot * i, y: T, width: slot, height: H - T - B }));
    const tipRows = r.values
      .map((v, k) => [series[k].name, format(v), series[k].color])
      .filter((_, k) => r.values[k] > 0);
    const lab = `${r.title}: ${tipRows.map(([n, v]) => `${n} ${v}`).join(", ") || "none"}`;
    g.setAttribute("aria-label", lab);
    g.addEventListener("pointermove", (e) =>
      showTip(e, r.title, tipRows.length ? tipRows : [["No activity", "", null]]),
    );
    g.addEventListener("focus", (e) =>
      showTip(e, r.title, tipRows.length ? tipRows : [["No activity", "", null]]),
    );
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("blur", hideTip);
    svg.append(g);
    if (i % every === 0) {
      const t = h("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" });
      t.textContent = r.label;
      svg.append(t);
    }
  });
  return svg;
}
function hbars(rows, format) {
  const box = el("div", "hbars");
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return el("div", "empty-c", "Nothing recorded in this range.");
  for (const r of rows) {
    const row = el("div", "hb");
    const t = el("div", "t");
    const i = el("i");
    i.style.width = `${Math.max(1, (r.value / max) * 100)}%`;
    i.style.background = r.color || css("--c-used");
    t.append(i);
    const n = el("div", "n", r.name);
    n.title = r.name;
    row.append(n, t, el("div", "x", format(r.value) + (r.extra ? ` · ${r.extra}` : "")));
    box.append(row);
  }
  return box;
}
function heatmap(turns) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const t of turns) {
    const d = new Date(t.ts);
    grid[(d.getDay() + 6) % 7][d.getHours()]++;
  }
  const max = Math.max(...grid.flat(), 0);
  const box = el("div", "heat");
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", "Turns by weekday and hour of day (your local time)");
  box.append(el("span"));
  for (let hr = 0; hr < 24; hr++) box.append(el("span", "hx", hr % 6 === 0 ? String(hr) : ""));
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((day, di) => {
    box.append(el("span", "h", day));
    for (let hr = 0; hr < 24; hr++) {
      const n = grid[di][hr];
      const c = el("span", "c");
      c.dataset.l = n ? String(Math.max(1, Math.ceil((n / max) * 4))) : "0";
      c.addEventListener("pointermove", (e) =>
        showTip(e, `${day} ${String(hr).padStart(2, "0")}:00`, [["Turns", String(n)]]),
      );
      c.addEventListener("pointerleave", hideTip);
      box.append(c);
    }
  });
  return box;
}

// ---------- turn latency ----------
const ms = (n) =>
  n == null
    ? "—"
    : n < 1000
      ? `${Math.round(n)} ms`
      : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`;
// Per-provider p50 (solid) and p95 (lighter, same hue) on one shared time scale. Nearest-rank, like Run details.
function pctBars(rows) {
  if (!rows.length) return el("div", "empty-c", "No turns with output in this range.");
  const box = el("div", "pbars");
  const max = Math.max(...rows.map((r) => r.p95_ms || 0), 1);
  for (const r of rows) {
    const [name, color] =
      r.provider === "all"
        ? ["All agents", css("--c-other")]
        : [provMeta(r.provider)[0], css(provMeta(r.provider)[1])];
    const row = el("div", "pb"),
      track = el("div", "t");
    const p95 = el("i", "p95"),
      p50 = el("i", "p50");
    p95.style.cssText = `width:${Math.max(1, ((r.p95_ms || 0) / max) * 100)}%;background:color-mix(in srgb,${color} 35%,transparent)`;
    p50.style.cssText = `width:${Math.max(1, ((r.p50_ms || 0) / max) * 100)}%;background:${color}`;
    track.append(p95, p50);
    const label = el("div", "n", name);
    label.title = `${name} · ${r.count} turns`;
    row.append(label, track, el("div", "x", `${ms(r.p50_ms)} · ${ms(r.p95_ms)}`));
    row.setAttribute(
      "aria-label",
      `${name}: p50 ${ms(r.p50_ms)}, p95 ${ms(r.p95_ms)}, ${r.count} turns`,
    );
    row.addEventListener("pointermove", (e) =>
      showTip(e, name, [
        ["Typical (p50)", ms(r.p50_ms), color],
        ["Slow (p95)", ms(r.p95_ms)],
        ["Turns", String(r.count)],
      ]),
    );
    row.addEventListener("pointerleave", hideTip);
    box.append(row);
  }
  return box;
}
function latencyPanel(lat) {
  const p = panel(
    "Turn latency",
    "Measured by this server from agent events; metadata only, never sent anywhere",
  );
  if (!lat?.available) {
    p.append(el("div", "empty-c", "Turn timing is unavailable on this server."));
    return p;
  }
  if (!lat.turns) {
    p.append(el("div", "empty-c", "No timed turns in this range yet."));
    return p;
  }
  const kp = el("div", "kpis lat-kpis");
  const all = lat.ttft.find((r) => r.provider === "all") || lat.ttft[0];
  const split = lat.split.reduce(
    (m, r) => ({
      model: m.model + r.model_ms,
      tool: m.tool + r.tool_ms,
      other: m.other + r.other_ms,
    }),
    { model: 0, tool: 0, other: 0 },
  );
  const total = split.model + split.tool + split.other;
  const share = (n) => (total ? pct((n / total) * 100) : "—");
  kp.append(
    kpi("First token p50", ms(all?.p50_ms), `p95 ${ms(all?.p95_ms)} · ${lat.turns} turns`),
    kpi(
      "Model time",
      share(split.model),
      `tools ${share(split.tool)} · other ${share(split.other)} (startup, waiting for you)`,
    ),
    kpi(
      "Cold starts",
      lat.cold.share == null ? "—" : pct(lat.cold.share * 100),
      `${lat.cold.cold}/${lat.cold.turns} turns · spawn p50 ${ms(lat.cold.spawn.p50_ms)}`,
    ),
    kpi(
      "Retries",
      fmt(lat.retries.retries + lat.retries.rate_limits),
      `${lat.retries.retries} API retries · ${lat.retries.rate_limits} rate-limit warnings`,
    ),
  );
  const ttft = el("div", "lat-block");
  ttft.append(
    el("h3", "", "Time to first token by agent"),
    pctBars(lat.ttft),
    legend([
      ["p50 (solid)", css("--c-used")],
      ["p95 (light)", "color-mix(in srgb,var(--c-used) 35%,transparent)"],
    ]),
  );
  if (lat.phone_ttft?.length)
    ttft.append(el("h3", "", "Until shown on your device"), pctBars(lat.phone_ttft));
  const tools = el("div", "lat-block");
  tools.append(
    el("h3", "", "Tool time, top 5"),
    hbars(
      lat.tools.map((t) => ({
        name: t.name,
        value: t.total_ms,
        color: css("--c-used"),
        extra: `${t.count}×${t.errors ? ` · ${t.errors} failed` : ""}`,
      })),
      ms,
    ),
  );
  tools.append(
    el(
      "p",
      "note",
      `Typical (p50) call: ${lat.tools.map((t) => `${t.name} ${ms(t.p50_ms)}`).join(" · ")}`,
    ),
  );
  const classes = Object.entries(lat.retries.by_class || {}).sort((a, b) => b[1] - a[1]);
  if (classes.length)
    tools.append(
      el(
        "p",
        "note",
        `Retry causes: ${classes.map(([c, n]) => `${c.replace(/_/g, " ")} ${n}`).join(" · ")}`,
      ),
    );
  const g = el("div", "grid2");
  g.append(ttft, tools);
  p.append(kp, g);
  return p;
}

// ---------- page ----------
function dayList(from, to) {
  const out = [];
  for (let d = startOfDay(from); d <= to && out.length < 400; d += DAY) {
    const dt = new Date(d);
    out.push({
      key: localDay(d),
      label: dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
      title: dt.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    });
  }
  return out;
}
let metric = "tokens";
function buildKpis(current, previous, saved) {
  const kpis = el("div", "kpis");
  kpis.append(
    kpi("Turns", fmt(current.turns), previous ? delta(current.turns, previous.turns) : "", false),
    kpi(
      "Input tokens",
      current.knownTokens ? fmt(current.in) : "—",
      `${fmt(current.cache)} cache reads included`,
      false,
    ),
    kpi(
      "Output tokens",
      current.knownTokens ? fmt(current.out) : "—",
      `${current.knownTokens}/${current.turns} turns counted`,
      false,
    ),
    kpi(
      "Estimated API cost",
      current.knownCost ? usd(current.cost) : "—",
      `${current.knownCost}/${current.turns} turns priced${current.knownCost < current.turns ? " · partial coverage" : ""} · public list prices`,
      false,
    ),
    kpi("RTK output reduction", fmt(saved.rtk), "Command output; all local CLI activity", true),
    kpi(
      "Headroom input reduction",
      fmt(saved.hr),
      "Claude + Codex proxy activity; separate scope",
      true,
    ),
  );
  return kpis;
}

function turnMetricValue(turn) {
  if (metric === "turns") return 1;
  if (metric === "cost") return turn.accounting === 2 ? turn.cost || 0 : 0;
  return tokensOf(turn);
}
function drawUsageChart(chart) {
  const { cur, days, idx, provs, series, usageBody } = chart;
  const format = { tokens: fmt, turns: fmt, cost: usd }[metric];
  const rows = days.map((day) => ({ ...day, values: series.map(() => 0) }));
  for (const turn of cur.turns) {
    const dayIndex = idx.get(localDay(turn.ts));
    if (dayIndex == null) continue;
    rows[dayIndex].values[provs.indexOf(turn.provider)] += turnMetricValue(turn);
  }
  usageBody.replaceChildren(
    cur.turns.length
      ? barChart(rows, series, format)
      : el("div", "empty-c", "No turns in this range."),
    ...(series.length ? [legend(series.map((entry) => [entry.name, entry.color]))] : []),
  );
}
function buildUsagePanel(cur, days, idx) {
  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Metric");
  const usagePanel = panel(
    "Usage",
    "Per UTC day, by agent; missing measurements are excluded",
    seg,
  );
  const usageBody = el("div");
  const provs = [...new Set(cur.turns.map((turn) => turn.provider))].sort();
  const series = provs.map((provider) => ({
    name: provMeta(provider)[0],
    color: css(provMeta(provider)[1]),
    p: provider,
  }));
  const chart = { cur, days, idx, provs, series, usageBody };
  for (const [key, label] of [
    ["tokens", "Tokens"],
    ["turns", "Turns"],
    ["cost", "Cost"],
  ]) {
    const button = el("button", "", label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(key === metric));
    button.onclick = () => {
      metric = key;
      for (const sibling of seg.children)
        sibling.setAttribute("aria-pressed", String(sibling === button));
      drawUsageChart(chart);
    };
    seg.append(button);
  }
  drawUsageChart(chart);
  usagePanel.append(usageBody);
  return { usagePanel };
}

function buildSavingsRows(cur, days, idx) {
  const rows = days.map((day) => ({ ...day, values: [0, 0] }));
  for (const entry of cur.rtk?.daily || []) {
    const dayIndex = idx.get(entry.date);
    if (dayIndex != null) rows[dayIndex].values[0] += entry.saved_tokens || 0;
  }
  for (const entry of cur.headroom?.daily || []) {
    const dayIndex = idx.get(entry.timestamp.slice(0, 10));
    if (dayIndex != null) rows[dayIndex].values[1] += entry.tokens_saved || 0;
  }
  return rows;
}
function buildSavingsPanel(saved, savingsRows) {
  const savePanel = panel(
    "Context saved",
    "Separate measurements by source day; scopes can overlap and must not be added",
  );
  const savingsSeries = [
    { name: "RTK (command output)", color: css("--c-rtk") },
    { name: "Headroom (compression)", color: css("--c-headroom") },
  ];
  savePanel.append(
    saved.rtk || saved.hr
      ? barChart(savingsRows, savingsSeries, fmt)
      : el("div", "empty-c", "No savings recorded in this range."),
    legend(savingsSeries.map((entry) => [entry.name, entry.color])),
  );
  return savePanel;
}

function collectBreakdowns(cur) {
  const byTool = new Map(),
    byThread = new Map();
  for (const turn of cur.turns) {
    for (const [name, count] of Object.entries(turn.tools || {}))
      byTool.set(name, (byTool.get(name) || 0) + count);
    const thread = byThread.get(turn.thread) || {
      turns: 0,
      tokens: 0,
      cost: 0,
      p: turn.provider,
    };
    thread.turns++;
    thread.tokens += tokensOf(turn);
    thread.cost += turn.accounting === 2 ? turn.cost || 0 : 0;
    byThread.set(turn.thread, thread);
  }
  return { byTool, byThread };
}
function topEntries(counts, limit = 8) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
function collectModelUsage(cur) {
  const byModel = new Map();
  for (const turn of cur.turns.filter((entry) => entry.accounting === 2))
    for (const usage of turn.models || []) {
      const row = byModel.get(usage.model) || { in: 0, out: 0, cost: 0, known: false };
      row.in += (usage.fresh || 0) + (usage.cacheWrite || 0) + (usage.cacheRead || 0);
      row.out += usage.output || 0;
      if (usage.cost != null) {
        row.cost += usage.cost;
        row.known = true;
      }
      byModel.set(usage.model, row);
    }
  return byModel;
}
function buildModelPanel(cur) {
  const modelPanel = panel("Models", "Tokens and estimated API cost by actual model");
  const byModel = collectModelUsage(cur);
  const table = el("div", "mtab");
  table.append(...["Model", "In", "Out", "Cost"].map((heading) => el("div", "h", heading)));
  for (const [name, row] of [...byModel]
    .filter(([, entry]) => entry.in || entry.out || entry.cost)
    .sort((a, b) => b[1].cost - a[1].cost || b[1].in - a[1].in)) {
    const nameCell = el("div", "n", name);
    nameCell.title = name;
    table.append(
      nameCell,
      el("div", "", fmt(row.in)),
      el("div", "", fmt(row.out)),
      el("div", "", row.known ? usd(row.cost) : "—"),
    );
  }
  modelPanel.append(byModel.size ? table : el("div", "empty-c", "No model usage in this range."));
  return modelPanel;
}
function buildToolPanel(byTool) {
  const toolPanel = panel("Tools", "What the agents reached for");
  toolPanel.append(
    hbars(
      topEntries(byTool, 10).map(([name, value]) => ({ name, value, color: css("--c-used") })),
      (value) => `${fmt(value)} calls`,
    ),
  );
  return toolPanel;
}
function buildThreadPanel(cur, byThread) {
  const threadPanel = panel("Busiest threads", "By turns");
  threadPanel.append(
    hbars(
      [...byThread.entries()]
        .sort((a, b) => b[1].turns - a[1].turns)
        .slice(0, 8)
        .map(([threadId, info]) => ({
          name: cur.titles?.[threadId] || "Thread",
          value: info.turns,
          color: css(provMeta(info.p)[1]),
          extra: info.tokens ? `${fmt(info.tokens)} tok` : "",
        })),
      (value) => `${value} turns`,
    ),
  );
  return threadPanel;
}

function buildDefinitionList(pairs) {
  const list = el("dl");
  for (const [term, value] of pairs) list.append(el("dt", "", term), el("dd", "", value));
  return list;
}
function buildRtkSource(cur, saved) {
  const rtk = cur.rtk;
  const rtkIn = (rtk?.daily || []).reduce((sum, day) => sum + (day.input_tokens || 0), 0),
    rtkCmd = (rtk?.daily || []).reduce((sum, day) => sum + (day.commands || 0), 0);
  const rtkPanel = el("section", "panel src");
  const head = el("div", "head");
  const titleBox = el("div");
  titleBox.append(
    el("h2", "", "RTK"),
    el("p", "sub", "Filters noisy command output before the agent reads it"),
  );
  head.append(titleBox, el("span", `chip-s ${rtk ? "ok" : "off"}`, rtk ? "Active" : "Not found"));
  rtkPanel.append(head);
  rtkPanel.append(
    buildDefinitionList([
      ["Commands tracked", fmt(rtkCmd)],
      ["Captured output before filtering", fmt(rtkIn)],
      ["Tokens saved", fmt(saved.rtk)],
      ["Reduction", rtkIn ? pct((saved.rtk / rtkIn) * 100) : "–"],
    ]),
    el(
      "p",
      "note",
      "All local RTK activity. Filtering commands compress output; proxy/bypass only track it.",
    ),
  );
  return rtkPanel;
}
function buildHeadroomSource(cur, saved) {
  const headroom = cur.headroom;
  const headroomPanel = el("section", "panel src");
  const head = el("div", "head");
  const titleBox = el("div");
  titleBox.append(
    el("h2", "", "Headroom"),
    el("p", "sub", "Compresses Claude and Codex model input"),
  );
  head.append(
    titleBox,
    el(
      "span",
      `chip-s ${headroom?.running ? "ok" : "off"}`,
      !headroom?.enabled ? "Disabled" : headroom.running ? "Running" : "Offline",
    ),
  );
  headroomPanel.append(head);
  const daily = headroom?.daily || [];
  const sum = (field) => daily.reduce((total, day) => total + (day[field] || 0), 0);
  headroomPanel.append(
    buildDefinitionList([
      ["Compressed tokens saved", fmt(saved.hr)],
      ["Input tokens sent", fmt(sum("total_input_tokens_delta"))],
      ["Prompt-cache reads", fmt(sum("cache_read_tokens_delta"))],
      ["Compression value (est.)", usd(sum("compression_savings_usd_delta"))],
      ["Tool-schema deferral (est.)", fmt(sum("tool_tokens_saved_delta"))],
    ]),
    el(
      "p",
      "note",
      headroom?.error
        ? headroom.error
        : "Claude threads only: Codex (ChatGPT sign-in) and Pi (OpenRouter) use hosts the proxy cannot serve. Tool-schema deferral is an estimate and is not counted in Tokens saved.",
    ),
  );
  return headroomPanel;
}

function buildDataTable(cur, days, idx, savingsRows) {
  const details = el("details", "table");
  details.append(el("summary", "", "Show data as a table"));
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const column of [
    "Day (UTC)",
    "Turns",
    "Known tokens",
    "Estimated API cost",
    "RTK saved",
    "Headroom saved",
  ])
    headRow.append(el("th", "", column));
  thead.append(headRow);
  table.append(thead);
  const tbody = el("tbody");
  const perDay = days.map(() => []);
  for (const turn of cur.turns) {
    const dayIndex = idx.get(localDay(turn.ts));
    if (dayIndex != null) perDay[dayIndex].push(turn);
  }
  days.forEach((day, dayIndex) => {
    const totals = sumTurns(perDay[dayIndex]),
      row = el("tr");
    for (const cell of [
      day.title,
      totals.turns,
      totals.knownTokens ? fmt(totals.tokens) : "Unknown",
      totals.knownCost ? usd(totals.cost) : "Unknown",
      fmt(savingsRows[dayIndex].values[0]),
      fmt(savingsRows[dayIndex].values[1]),
    ])
      row.append(el("td", "", String(cell)));
    tbody.append(row);
  });
  table.append(tbody);
  const scroll = el("div", "scroll");
  scroll.append(table);
  details.append(scroll);
  return details;
}

function appendPricingSources(pricingDetails, cur) {
  const sourceList = el("p", "note");
  for (const source of cur.pricing?.sources || []) {
    // Accept public HTTPS references only; never turn arbitrary response text into markup.
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") continue;
      if (sourceList.childNodes.length) sourceList.append(" · ");
      const link = el("a", "", source.name);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      sourceList.append(link);
    } catch {}
  }
  if (sourceList.childNodes.length) pricingDetails.append(sourceList);
}
function buildPricingNotes(cur) {
  const priceNote = el(
    "p",
    "muted",
    "Estimated API cost uses public per-model input, cached-input, cache-write and output rates where usage is available. Unpriced turns are excluded. This is not your subscription bill.",
  );
  if (cur.turns.some((turn) => hasTokens(turn) && turn.accounting !== 2))
    priceNote.append(
      " Historical token counts are shown as recorded; their cache categories and old costs are unverified.",
    );
  const pricingDetails = el("details", "pricing-details");
  pricingDetails.append(
    el(
      "summary",
      "",
      `Pricing basis${cur.pricing?.verifiedAt ? ` · verified ${cur.pricing.verifiedAt}` : ""}`,
    ),
  );
  appendPricingSources(pricingDetails, cur);
  for (const assumption of cur.pricing?.assumptions || [])
    pricingDetails.append(el("p", "note", assumption));
  return { priceNote, pricingDetails };
}

function buildGrid(left, right) {
  const grid = el("div", "grid2");
  grid.append(left, right);
  return grid;
}
function render(cur, prev) {
  const root = $("dm");
  const currentTotals = sumTurns(cur.turns),
    previousTotals = prev ? sumTurns(prev.turns) : null;
  const saved = savedOf(cur);
  const days = dayList(range.from, range.to);
  const idx = new Map(days.map((day, dayIndex) => [day.key, dayIndex]));
  const kpis = buildKpis(currentTotals, previousTotals, saved);
  const { usagePanel } = buildUsagePanel(cur, days, idx);
  const savingsRows = buildSavingsRows(cur, days, idx);
  const savePanel = buildSavingsPanel(saved, savingsRows);
  const { byTool, byThread } = collectBreakdowns(cur);
  const modelPanel = buildModelPanel(cur);
  const toolPanel = buildToolPanel(byTool);
  const threadPanel = buildThreadPanel(cur, byThread);
  const heatPanel = panel("When you work", "Turns by weekday and hour, local time");
  heatPanel.append(heatmap(cur.turns));
  const srcs = el("div", "srcs");
  srcs.append(buildRtkSource(cur, saved), buildHeadroomSource(cur, saved));
  const tbl = buildDataTable(cur, days, idx, savingsRows);
  const { priceNote, pricingDetails } = buildPricingNotes(cur);
  root.replaceChildren(
    kpis,
    priceNote,
    ...(cur.pricing ? [pricingDetails] : []),
    subscriptionPanel(cur),
    buildGrid(usagePanel, savePanel),
    latencyPanel(cur.latency),
    srcs,
    buildGrid(modelPanel, toolPanel),
    buildGrid(threadPanel, heatPanel),
    tbl,
  );
  if (cur.turns.some((turn) => turn.b))
    root.append(
      el(
        "p",
        "muted",
        "Historical rows were reconstructed from local logs. Missing usage and costs remain unknown; API-equivalent costs do not establish actual billing.",
      ),
    );
}

// ---------- boot ----------
applyTab(false);
const m = /^#(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
if (m)
  setRange(
    "custom",
    new Date(`${m[1]}T00:00:00Z`).getTime(),
    Math.min(Date.now(), new Date(`${m[2]}T23:59:59Z`).getTime()),
  );
else
  setRange(["1", "7", "30", "90"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "7");
setInterval(() => {
  if (!document.hidden) void load();
}, 60_000);
