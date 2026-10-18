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
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const usd = (n) => `$${n.toFixed(n >= 0.01 ? 2 : n > 0 ? 4 : 3)}`;
const pct = (n) => `${n >= 10 ? Math.round(n) : n.toFixed(1)}%`;
const PROVIDERS = { claude: ["Claude", "--c-claude"], codex: ["Codex", "--c-codex"], pi: ["Pi", "--c-pi"] };
const provMeta = (p) => PROVIDERS[p] || [p === "mock" ? "Mock" : p, "--c-other"];
const css = (v) => `var(${v})`;
const localDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms) => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

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
  for (const b of document.querySelectorAll(".range button")) b.setAttribute("aria-pressed", String(b.dataset.r === key));
  $("custom").hidden = key !== "custom";
  if (key === "custom") { $("from").value = localDay(from); $("to").value = localDay(to); }
  history.replaceState(null, "", key === "custom" ? `#${localDay(from)}..${localDay(to)}` : `#${key}`);
  void load();
}
for (const b of document.querySelectorAll(".range button")) b.onclick = () => {
  if (b.dataset.r === "custom") { const to = Date.now(); setRange("custom", to - 14 * DAY, to); } else setRange(b.dataset.r);
};
$("custom").onsubmit = (e) => {
  e.preventDefault();
  const from = new Date(`${$("from").value}T00:00:00Z`).getTime(), to = new Date(`${$("to").value}T23:59:59Z`).getTime();
  if (!(from < to)) return;
  setRange("custom", from, Math.min(to, Date.now()));
};

// ---------- data ----------
async function fetchRange(from, to) {
  const r = await fetch(`/api/dashboard?from=${from}&to=${to}`, { credentials: "same-origin" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
let seq = 0;
async function load() {
  const mine = ++seq;
  $("dm").setAttribute("aria-busy", "true");
  try {
    const span = range.to - range.from;
    const [cur, prev] = await Promise.all([fetchRange(range.from, range.to), fetchRange(range.from - span, range.from - 1).catch(() => null)]);
    if (mine === seq) { render(cur, prev); }
  } catch (e) {
    if (mine === seq) $("dm").replaceChildren(el("p", "muted", `Could not load usage: ${e.message}`));
  }
  if (mine === seq) $("dm").setAttribute("aria-busy", "false");
}

const hasTokens = (t) => Number.isFinite(t.in) && t.in >= 0 && Number.isFinite(t.out) && t.out >= 0;
const tokensOf = (t) => hasTokens(t) ? t.in + t.out : 0;
const sumTurns = (turns) => ({
  knownTokens: turns.filter(hasTokens).length,
  knownCost: turns.filter(t => t.cost != null && t.accounting === 2).length,
  turns: turns.length,
  tokens: turns.reduce((s, t) => s + tokensOf(t), 0),
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
let monthlyFees = {};
try { monthlyFees = JSON.parse(localStorage.getItem(PLAN_KEY) || "{}"); } catch {}
if (!monthlyFees || typeof monthlyFees !== "object" || Array.isArray(monthlyFees)) monthlyFees = {};
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
function subscriptionPanel(cur) {
  const p = panel("API estimate vs your subscriptions", "Compare public API list prices with the fees you enter for this period.");
  const result = el("div", "comparison-result");
  const draw = () => {
    const providers = ["claude", "codex"];
    const active = providers.filter(provider => cur.turns.some(t => t.provider === provider));
    const missing = active.filter(provider => !feeKnown(provider));
    const configured = providers.filter(feeKnown);
    const comparable = cur.turns.filter(t => configured.includes(t.provider));
    const measured = comparable.filter(t => t.accounting === 2 && t.cost != null);
    const api = measured.reduce((sum, t) => sum + t.cost, 0);
    const fees = configured.reduce((sum, provider) => sum + allocatedFee(monthlyFees[provider], range.from, range.to), 0);
    const complete = !missing.length && comparable.length > 0 && measured.length === comparable.length;
    const values = el("div", "comparison-values");
    values.append(kpi("Estimated API cost", measured.length ? usd(api) : "—", `${measured.length}/${comparable.length} matching turns priced · ${configured.map(p => provMeta(p)[0]).join(" + ") || "no fees configured"}`),
      kpi("Your allocated subscription cost", configured.length ? usd(fees) : "Not configured", "All configured plans, including days without activity; prorated by UTC calendar day"),
      kpi("API estimate minus subscriptions", complete ? `${api < fees ? "−" : ""}${usd(Math.abs(api - fees))}` : "—", complete ? (api >= fees ? "API estimate is higher" : "Subscription allocation is higher") : "Requires fees and full API cost coverage"));
    const note = missing.length ? `Enter your monthly ${missing.map(p => p === "codex" ? "Codex / ChatGPT" : "Claude").join(" and ")} fee to compare.` : "Enter the full monthly fee you pay, including any taxes you want counted. Use 0 for no paid plan.";
    result.replaceChildren(values, el("p", "note", note), el("p", "note", "This compares recorded console activity with allocated plan fees, not a bill or a claim of savings. Pi / pay-as-you-go activity is excluded. Fees apply across this selected range; adjust them if your plan changed."));
  };
  draw();
  const settings = el("details", "subscription-settings");
  settings.append(el("summary", "", "Set your monthly subscription fees"));
  const form = el("form", "subscription-form");
  for (const [provider, name] of [["claude", "Claude monthly fee (USD)"], ["codex", "Codex / ChatGPT monthly fee (USD)"]]) {
    const label = el("label", "", name), input = el("input");
    input.type = "number"; input.min = "0"; input.max = "100000"; input.step = "0.01"; input.inputMode = "decimal";
    input.name = provider; input.value = feeKnown(provider) ? String(monthlyFees[provider]) : ""; input.placeholder = "Not configured";
    label.append(input); form.append(label);
  }
  const save = el("button", "btn primary", "Save fees"); save.type = "submit";
  const status = el("p", "note", "Stored only in this browser. Leave a fee blank to clear it."); status.setAttribute("role", "status");
  form.append(save);
  form.onsubmit = e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const next = {};
    for (const input of form.querySelectorAll("input")) if (input.value.trim()) next[input.name] = Number(input.value);
    monthlyFees = next;
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(next)); status.textContent = "Saved in this browser."; }
    catch { status.textContent = "Applied for this page; this browser could not save your fees."; }
    draw();
  };
  settings.append(form, status); p.append(result, settings);
  return p;
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
  tip.replaceChildren(el("b", "", title), ...rows.map(([k, v, c]) => { const r = el("div", "r"); const l = el("span"); if (c) { const i = el("i"); i.style.cssText = `display:inline-block;width:.5rem;height:.5rem;border-radius:2px;margin-right:6px;background:${c}`; l.append(i); } l.append(k); r.append(l, el("span", "", v)); return r; }));
  tip.hidden = false;
  const pad = 12, w = tip.offsetWidth, hh = tip.offsetHeight;
  const x = e.clientX ?? e.target.getBoundingClientRect().left, y = e.clientY ?? e.target.getBoundingClientRect().top;
  tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x + pad))}px`;
  tip.style.top = `${Math.max(8, y - hh - pad < 8 ? y + pad : y - hh - pad)}px`;
}
const hideTip = () => { tip.hidden = true; };

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
  for (const [name, color] of items) { const s = el("span"); const i = el("i"); i.style.background = color; s.append(i, name); l.append(s); }
  return l;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// Stacked daily bars. series: [{name,color}], rows: [{label, title, values:[n..]}]. 2px gaps, 4px rounded data end, direct hover tips.
function barChart(rows, series, format) {
  const W = 640, H = 220, L = 44, B = 22, T = 8, R = 4;
  const svg = h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Bar chart; the data table below has the same numbers" });
  const max = niceMax(Math.max(...rows.map((r) => r.values.reduce((a, b) => a + b, 0)), 0));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    svg.append(h("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const t = h("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" }); t.textContent = format(v); svg.append(t);
  }
  const slot = (W - L - R) / Math.max(rows.length, 1), bw = Math.max(2, Math.min(28, slot - 2));
  const every = Math.ceil(rows.length / Math.max(2, Math.floor((W - L) / 70)));
  rows.forEach((r, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    const g = h("g", { class: "hov", tabindex: "0" });
    let acc = 0;
    const live = r.values.map((v, k) => [v, k]).filter(([v]) => v > 0);
    live.forEach(([v, k], j) => {
      const top = y(acc + v), bottom = y(acc) - (j ? 2 : 0), ht = Math.max(1, bottom - top);
      const last = j === live.length - 1, rad = Math.min(4, bw / 2, ht);
      const d = last ? `M${x},${top + ht} V${top + rad} Q${x},${top} ${x + rad},${top} H${x + bw - rad} Q${x + bw},${top} ${x + bw},${top + rad} V${top + ht} Z` : `M${x},${top} h${bw} v${ht} h${-bw} Z`;
      g.append(h("path", { class: "bar", d, style: `fill:${series[k].color}` }));
      acc += v;
    });
    g.append(h("rect", { class: "hit", x: L + slot * i, y: T, width: slot, height: H - T - B }));
    const tipRows = r.values.map((v, k) => [series[k].name, format(v), series[k].color]).filter((_, k) => r.values[k] > 0);
    const lab = `${r.title}: ${tipRows.map(([n, v]) => `${n} ${v}`).join(", ") || "none"}`;
    g.setAttribute("aria-label", lab);
    g.addEventListener("pointermove", (e) => showTip(e, r.title, tipRows.length ? tipRows : [["No activity", "", null]]));
    g.addEventListener("focus", (e) => showTip(e, r.title, tipRows.length ? tipRows : [["No activity", "", null]]));
    g.addEventListener("pointerleave", hideTip); g.addEventListener("blur", hideTip);
    svg.append(g);
    if (i % every === 0) { const t = h("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" }); t.textContent = r.label; svg.append(t); }
  });
  return svg;
}
function hbars(rows, format) {
  const box = el("div", "hbars");
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return el("div", "empty-c", "Nothing recorded in this range.");
  for (const r of rows) {
    const row = el("div", "hb");
    const t = el("div", "t"); const i = el("i"); i.style.width = `${Math.max(1, (r.value / max) * 100)}%`; i.style.background = r.color || css("--c-used"); t.append(i);
    const n = el("div", "n", r.name); n.title = r.name;
    row.append(n, t, el("div", "x", format(r.value) + (r.extra ? ` · ${r.extra}` : "")));
    box.append(row);
  }
  return box;
}
function heatmap(turns) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const t of turns) { const d = new Date(t.ts); grid[(d.getDay() + 6) % 7][d.getHours()]++; }
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
      c.addEventListener("pointermove", (e) => showTip(e, `${day} ${String(hr).padStart(2, "0")}:00`, [["Turns", String(n)]]));
      c.addEventListener("pointerleave", hideTip);
      box.append(c);
    }
  });
  return box;
}

// ---------- turn latency ----------
const ms = (n) => (n == null ? "—" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`);
// Per-provider p50 (solid) and p95 (lighter, same hue) on one shared time scale. Nearest-rank, like Run details.
function pctBars(rows) {
  if (!rows.length) return el("div", "empty-c", "No turns with output in this range.");
  const box = el("div", "pbars");
  const max = Math.max(...rows.map((r) => r.p95_ms || 0), 1);
  for (const r of rows) {
    const [name, color] = r.provider === "all" ? ["All agents", css("--c-other")] : provMeta(r.provider);
    const row = el("div", "pb"), track = el("div", "t");
    const p95 = el("i", "p95"), p50 = el("i", "p50");
    p95.style.cssText = `width:${Math.max(1, ((r.p95_ms || 0) / max) * 100)}%;background:color-mix(in srgb,${color} 35%,transparent)`;
    p50.style.cssText = `width:${Math.max(1, ((r.p50_ms || 0) / max) * 100)}%;background:${color}`;
    track.append(p95, p50);
    const label = el("div", "n", name); label.title = `${name} · ${r.count} turns`;
    row.append(label, track, el("div", "x", `${ms(r.p50_ms)} · ${ms(r.p95_ms)}`));
    row.setAttribute("aria-label", `${name}: p50 ${ms(r.p50_ms)}, p95 ${ms(r.p95_ms)}, ${r.count} turns`);
    row.addEventListener("pointermove", (e) => showTip(e, name, [["Typical (p50)", ms(r.p50_ms), color], ["Slow (p95)", ms(r.p95_ms)], ["Turns", String(r.count)]]));
    row.addEventListener("pointerleave", hideTip);
    box.append(row);
  }
  return box;
}
function latencyPanel(lat) {
  const p = panel("Turn latency", "Measured by this server from agent events; metadata only, never sent anywhere");
  if (!lat?.available) { p.append(el("div", "empty-c", "Turn timing is unavailable on this server.")); return p; }
  if (!lat.turns) { p.append(el("div", "empty-c", "No timed turns in this range yet.")); return p; }
  const kp = el("div", "kpis lat-kpis");
  const all = lat.ttft.find((r) => r.provider === "all") || lat.ttft[0];
  const split = lat.split.reduce((m, r) => ({ model: m.model + r.model_ms, tool: m.tool + r.tool_ms, other: m.other + r.other_ms }), { model: 0, tool: 0, other: 0 });
  const total = split.model + split.tool + split.other;
  const share = (n) => (total ? pct((n / total) * 100) : "—");
  kp.append(
    kpi("First token p50", ms(all?.p50_ms), `p95 ${ms(all?.p95_ms)} · ${lat.turns} turns`),
    kpi("Model / tools", `${share(split.model)} / ${share(split.tool)}`, `other ${share(split.other)}: startup and waiting for you`),
    kpi("Cold starts", lat.cold.share == null ? "—" : pct(lat.cold.share * 100), `${lat.cold.cold}/${lat.cold.turns} turns · spawn p50 ${ms(lat.cold.spawn.p50_ms)}`),
    kpi("Retries", fmt(lat.retries.retries + lat.retries.rate_limits), `${lat.retries.retries} API retries · ${lat.retries.rate_limits} rate-limit warnings`),
  );
  const ttft = el("div", "lat-block");
  ttft.append(el("h3", "", "Time to first token by agent"), pctBars(lat.ttft), legend([["p50", css("--c-used")], ["p95", "color-mix(in srgb,var(--c-used) 35%,transparent)"]]));
  if (lat.phone_ttft?.length) ttft.append(el("h3", "", "Until shown on your device"), pctBars(lat.phone_ttft));
  const tools = el("div", "lat-block");
  tools.append(el("h3", "", "Tool time, top 5"), hbars(lat.tools.map((t) => ({ name: t.name, value: t.total_ms, color: css("--c-used"), extra: `${t.count} calls · p95 ${ms(t.p95_ms)}${t.errors ? ` · ${t.errors} failed` : ""}` })), ms));
  const classes = Object.entries(lat.retries.by_class || {}).sort((a, b) => b[1] - a[1]);
  if (classes.length) tools.append(el("p", "note", `Retry causes: ${classes.map(([c, n]) => `${c.replace(/_/g, " ")} ${n}`).join(" · ")}`));
  const g = el("div", "grid2"); g.append(ttft, tools);
  p.append(kp, g);
  return p;
}

// ---------- page ----------
function dayList(from, to) {
  const out = [];
  for (let d = startOfDay(from); d <= to && out.length < 400; d += DAY) { const dt = new Date(d); out.push({ key: localDay(d), label: dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }), title: dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) }); }
  return out;
}
let metric = "tokens";
function render(cur, prev) {
  const root = $("dm");
  const cs = sumTurns(cur.turns), ps = prev ? sumTurns(prev.turns) : null;
  const sv = savedOf(cur), pv = prev ? savedOf(prev) : null;
  const days = dayList(range.from, range.to);
  const idx = new Map(days.map((d, i) => [d.key, i]));

  const kpis = el("div", "kpis");
  kpis.append(
    kpi("Turns", fmt(cs.turns), ps ? delta(cs.turns, ps.turns) : "", false),
    kpi("Tokens processed", cs.knownTokens ? fmt(cs.tokens) : "—", `${cs.knownTokens}/${cs.turns} turns with token counts · ${fmt(cs.cache)} verified cache reads included`, false),
    kpi("Estimated API cost", cs.knownCost ? usd(cs.cost) : "—", `${cs.knownCost}/${cs.turns} turns priced${cs.knownCost < cs.turns ? " · partial coverage" : ""} · public list prices`, false),
    kpi("RTK output reduction", fmt(sv.rtk), "Command output; all local CLI activity", true),
    kpi("Headroom input reduction", fmt(sv.hr), "Claude proxy activity; separate scope", true),
  );

  // usage chart with a metric switch
  const seg = el("div", "seg");
  seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Metric");
  const usagePanel = panel("Usage", "Per UTC day, by agent; missing measurements are excluded", seg);
  const usageBody = el("div");
  const provs = [...new Set(cur.turns.map((t) => t.provider))].sort();
  const series = provs.map((p) => ({ name: provMeta(p)[0], color: css(provMeta(p)[1]), p }));
  const drawUsage = () => {
    const f = { tokens: fmt, turns: fmt, cost: usd }[metric];
    const rows = days.map((d) => ({ ...d, values: series.map(() => 0) }));
    for (const t of cur.turns) {
      const i = idx.get(localDay(t.ts)); if (i == null) continue;
      const k = provs.indexOf(t.provider);
      rows[i].values[k] += metric === "turns" ? 1 : metric === "cost" ? (t.accounting === 2 ? t.cost || 0 : 0) : tokensOf(t);
    }
    usageBody.replaceChildren(cur.turns.length ? barChart(rows, series, f) : el("div", "empty-c", "No turns in this range."), ...(series.length ? [legend(series.map((s) => [s.name, s.color]))] : []));
  };
  for (const [k, label] of [["tokens", "Tokens"], ["turns", "Turns"], ["cost", "Cost"]]) {
    const b = el("button", "", label); b.type = "button";
    b.setAttribute("aria-pressed", String(k === metric));
    b.onclick = () => { metric = k; for (const x of seg.children) x.setAttribute("aria-pressed", String(x === b)); drawUsage(); };
    seg.append(b);
  }
  drawUsage();
  usagePanel.append(usageBody);

  // savings chart
  const savePanel = panel("Context saved", "Separate measurements by source day; scopes can overlap and must not be added");
  const hrSeries = [{ name: "RTK (command output)", color: css("--c-rtk") }, { name: "Headroom (compression)", color: css("--c-headroom") }];
  const srows = days.map((d) => ({ ...d, values: [0, 0] }));
  for (const d of cur.rtk?.daily || []) { const i = idx.get(d.date); if (i != null) srows[i].values[0] += d.saved_tokens || 0; }
  for (const d of cur.headroom?.daily || []) { const i = idx.get(d.timestamp.slice(0, 10)); if (i != null) srows[i].values[1] += d.tokens_saved || 0; }
  savePanel.append(sv.rtk || sv.hr ? barChart(srows, hrSeries, fmt) : el("div", "empty-c", "No savings recorded in this range."), legend(hrSeries.map((s) => [s.name, s.color])));

  // breakdowns
  const byModel = new Map(), byTool = new Map(), byThread = new Map();
  for (const t of cur.turns) {
    const m = `${provMeta(t.provider)[0]} · ${t.model || "default"}`;
    byModel.set(m, (byModel.get(m) || 0) + 1);
    for (const [n, c] of Object.entries(t.tools || {})) byTool.set(n, (byTool.get(n) || 0) + c);
    const th = byThread.get(t.thread) || { turns: 0, tokens: 0, cost: 0, p: t.provider };
    th.turns++; th.tokens += tokensOf(t); th.cost += t.accounting === 2 ? t.cost || 0 : 0; byThread.set(t.thread, th);
  }
  const top = (m, n = 8) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const modelPanel = panel("Models", "Turns by configured model; Claude may use additional unattributed models");
  modelPanel.append(hbars(top(byModel).map(([name, value]) => ({ name, value, color: css(provMeta(name.split(" · ")[0].toLowerCase())[1]) })), (v) => `${v} turns`));
  const measuredModels = new Map();
  for (const turn of cur.turns.filter(t => t.accounting === 2)) for (const model of turn.models || []) {
    const row = measuredModels.get(model.model) || { cost: 0, known: false };
    if (model.cost != null) { row.cost += model.cost; row.known = true; }
    measuredModels.set(model.model, row);
  }
  if (measuredModels.size) {
    const list = el("dl");
    for (const [name, row] of [...measuredModels].sort((a, b) => b[1].cost - a[1].cost)) list.append(el("dt", "", name), el("dd", "", row.known ? usd(row.cost) : "Cost unknown"));
    modelPanel.append(list, el("p", "note", "Estimated API costs by actual model. Claude does not separately identify advisor and subagent cost."));
  }
  const toolPanel = panel("Tools", "What the agents reached for");
  toolPanel.append(hbars(top(byTool, 10).map(([name, value]) => ({ name, value, color: css("--c-used") })), (v) => `${fmt(v)} calls`));
  const threadPanel = panel("Busiest threads", "By turns");
  threadPanel.append(hbars([...byThread.entries()].sort((a, b) => b[1].turns - a[1].turns).slice(0, 8).map(([id, v]) => ({ name: cur.titles?.[id] || "Thread", value: v.turns, color: css(provMeta(v.p)[1]), extra: v.tokens ? `${fmt(v.tokens)} tok` : "" })), (v) => `${v} turns`));
  const heatPanel = panel("When you work", "Turns by weekday and hour, local time");
  heatPanel.append(heatmap(cur.turns));

  // savings sources
  const srcs = el("div", "srcs");
  const rt = cur.rtk, hr = cur.headroom;
  const rtkIn = (rt?.daily || []).reduce((s, d) => s + (d.input_tokens || 0), 0), rtkCmd = (rt?.daily || []).reduce((s, d) => s + (d.commands || 0), 0);
  const rtkP = el("section", "panel src");
  const rh = el("div", "head"); const rt1 = el("div"); rt1.append(el("h2", "", "RTK"), el("p", "sub", "Filters noisy command output before the agent reads it")); rh.append(rt1, el("span", `chip-s ${rt ? "ok" : "off"}`, rt ? "Active" : "Not found")); rtkP.append(rh);
  const dl1 = el("dl");
  for (const [k, v] of [["Commands tracked", fmt(rtkCmd)], ["Captured output before filtering", fmt(rtkIn)], ["Tokens saved", fmt(sv.rtk)], ["Reduction", rtkIn ? pct((sv.rtk / rtkIn) * 100) : "–"]]) dl1.append(el("dt", "", k), el("dd", "", v));
  rtkP.append(dl1, el("p", "note", "All local RTK activity. Filtering commands compress output; proxy/bypass only track it."));
  const hrP = el("section", "panel src");
  const hh = el("div", "head"); const ht = el("div"); ht.append(el("h2", "", "Headroom"), el("p", "sub", "Compresses what Claude sends to the API")); hh.append(ht, el("span", `chip-s ${hr?.running ? "ok" : "off"}`, !hr?.enabled ? "Disabled" : hr.running ? "Running" : "Offline")); hrP.append(hh);
  const hd = hr?.daily || [];
  const sum = (k) => hd.reduce((s, d) => s + (d[k] || 0), 0);
  const dl2 = el("dl");
  for (const [k, v] of [["Compressed tokens saved", fmt(sv.hr)], ["Input tokens sent", fmt(sum("total_input_tokens_delta"))], ["Prompt-cache reads", fmt(sum("cache_read_tokens_delta"))], ["Compression value (est.)", usd(sum("compression_savings_usd_delta"))], ["Tool-schema deferral (est.)", fmt(sum("tool_tokens_saved_delta"))]]) dl2.append(el("dt", "", k), el("dd", "", v));
  hrP.append(dl2, el("p", "note", hr?.error ? hr.error : "Claude threads only: Codex (ChatGPT sign-in) and Pi (OpenRouter) use hosts the proxy cannot serve. Tool-schema deferral is an estimate and is not counted in Tokens saved."));
  srcs.append(rtkP, hrP);

  // table
  const tbl = el("details", "table");
  tbl.append(el("summary", "", "Show data as a table"));
  const t = el("table");
  const thead = el("thead"); const hr0 = el("tr");
  for (const c of ["Day (UTC)", "Turns", "Known tokens", "Estimated API cost", "RTK saved", "Headroom saved"]) hr0.append(el("th", "", c));
  thead.append(hr0); t.append(thead);
  const tb = el("tbody");
  const perDay = days.map(() => []);
  for (const x of cur.turns) { const i = idx.get(localDay(x.ts)); if (i != null) perDay[i].push(x); }
  days.forEach((d, i) => { const s = sumTurns(perDay[i]), r = el("tr"); for (const c of [d.title, s.turns, s.knownTokens ? fmt(s.tokens) : "Unknown", s.knownCost ? usd(s.cost) : "Unknown", fmt(srows[i].values[0]), fmt(srows[i].values[1])]) r.append(el("td", "", String(c))); tb.append(r); });
  t.append(tb);
  const sc = el("div", "scroll"); sc.append(t); tbl.append(sc);

  const g1 = el("div", "grid2"); g1.append(usagePanel, savePanel);
  const g2 = el("div", "grid2"); g2.append(modelPanel, toolPanel);
  const g3 = el("div", "grid2"); g3.append(threadPanel, heatPanel);
  const priceNote = el("p", "muted", "Estimated API cost uses public per-model input, cached-input, cache-write and output rates where usage is available. Unpriced turns are excluded. This is not your subscription bill.");
  if (cur.turns.some(t => hasTokens(t) && t.accounting !== 2)) priceNote.append(" Historical token counts are shown as recorded; their cache categories and old costs are unverified.");
  const pricingDetails = el("details", "pricing-details");
  pricingDetails.append(el("summary", "", `Pricing basis${cur.pricing?.verifiedAt ? ` · verified ${cur.pricing.verifiedAt}` : ""}`));
  const sourceList = el("p", "note");
  for (const source of cur.pricing?.sources || []) {
    // Accept public HTTPS references only; never turn arbitrary response text into markup.
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") continue;
      if (sourceList.childNodes.length) sourceList.append(" · ");
      const link = el("a", "", source.name); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; sourceList.append(link);
    } catch {}
  }
  if (sourceList.childNodes.length) pricingDetails.append(sourceList);
  for (const assumption of cur.pricing?.assumptions || []) pricingDetails.append(el("p", "note", assumption));
  root.replaceChildren(kpis, priceNote, ...(cur.pricing ? [pricingDetails] : []), subscriptionPanel(cur), g1, latencyPanel(cur.latency), srcs, g2, g3, tbl);
  if (cur.turns.some((x) => x.b)) root.append(el("p", "muted", "Historical rows were reconstructed from local logs. Missing usage and costs remain unknown; API-equivalent costs do not establish actual billing."));
}

// ---------- boot ----------
const m = /^#(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
if (m) setRange("custom", new Date(`${m[1]}T00:00:00Z`).getTime(), Math.min(Date.now(), new Date(`${m[2]}T23:59:59Z`).getTime()));
else setRange(["1", "7", "30", "90"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "7");
setInterval(() => { if (!document.hidden) void load(); }, 60_000);
