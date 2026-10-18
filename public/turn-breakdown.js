// Run details > Full breakdown: where one turn's time went, segment by segment. A sub-view inside the Run details sheet
// (one sheet at a time; Back returns to the summary). Every number is written as text; bars only repeat what the text says.
import { $, el, icon } from "/render.js";

const ROWS = 40, STEPS = 10;
export const fmtDur = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const secs = Math.round(ms / 1000), m = Math.floor(secs / 60), s = secs % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
};
// Start offset, compact: "+340ms", "+4.2s", "+4:12", "+1:04:12". Turns under a minute keep sub-second detail.
export const fmtAt = (ms, total = ms) => {
  const sign = ms < 0 ? "−" : "+", a = Math.abs(ms);
  if (total < 60_000 && a < 1000) return `${sign}${Math.round(a)}ms`;
  if (total < 60_000) return `${sign}${(a / 1000).toFixed(1)}s`;
  const secs = Math.round(a / 1000), h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), ss = String(secs % 60).padStart(2, "0");
  return h ? `${sign}${h}:${String(m).padStart(2, "0")}:${ss}` : `${sign}${m}:${ss}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const RETRY = { rate_limit: "rate limited", overloaded: "overloaded", server_overloaded: "overloaded", timeout: "timed out", network: "network error", server_error: "server error", auth: "sign-in error", bad_request: "bad request" };
const retryWord = (s) => [s.s, RETRY[s.c] || (s.c && s.c !== "unknown" ? s.c.replace(/_/g, " ") : "")].filter(Boolean).join(" ") || "retry";

let state = null; // { thread, turns, index, trigger, showAllRows, showAllSteps }

const dialog = () => $("run-details");
const view = () => $("turn-breakdown");

export function closeBreakdown(focus = true) {
  const d = dialog();
  if (!d || d.dataset.view !== "breakdown") return;
  delete d.dataset.view;
  view().hidden = true;
  view().replaceChildren();
  const trigger = state?.trigger;
  state = null;
  if (focus && trigger?.isConnected) trigger.focus();
  else if (focus) document.querySelector("#turn-timing .tb-open")?.focus();
}

export async function openBreakdown(thread, trigger) {
  const d = dialog(), box = view();
  state = { thread, turns: null, index: 0, trigger, showAllRows: false, showAllSteps: false };
  d.dataset.view = "breakdown";
  box.hidden = false;
  box.replaceChildren(header(), el("p", "sub tb-status", "Loading this turn…"));
  box.querySelector(".tb-back").focus();
  d.scrollTop = 0;
  let turns = [];
  try {
    const r = await fetch(`/api/turn-latency?thread=${encodeURIComponent(thread)}&detail=10`, { cache: "no-store" });
    const j = await r.json();
    turns = j.available ? j.turns || [] : [];
  } catch {}
  if (state?.thread !== thread) return; // closed or reopened meanwhile
  state.turns = turns;
  render();
}

function header() {
  const head = el("div", "tb-nav");
  const back = el("button", "btn ghost tb-back");
  back.type = "button";
  back.append(icon("chev-left"), el("span", "", "Run details"));
  back.setAttribute("aria-label", "Back to Run details");
  back.onclick = () => closeBreakdown();
  const title = el("h4", "tb-title", "Turn breakdown");
  title.id = "tb-title";
  head.append(back, title);
  return head;
}

function render() {
  const box = view();
  const { turns, index } = state;
  if (!turns.length) { box.replaceChildren(header(), el("p", "sub tb-status", "No timed turns for this thread yet.")); return; }
  const t = turns[index];
  const kids = [header()];
  if (turns.length > 1) kids.push(picker(turns, index));
  kids.push(...totals(t));
  const seg = t.timeline?.seg;
  if (seg?.length) kids.push(...waterfall(t, seg, t.timeline.more));
  else kids.push(el("p", "note tb-old", "This turn was recorded before step-by-step timing. Totals and tools only."));
  kids.push(...toolTable(t, seg));
  if (seg?.length) kids.push(...stepList(seg));
  box.replaceChildren(...kids);
}

function picker(turns, index) {
  const wrap = el("label", "tb-pick");
  wrap.append(el("span", "sr-only", "Turn"));
  const sel = el("select", "input");
  turns.forEach((t, i) => {
    const when = new Date(t.turn_ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const o = el("option", "", `${i === 0 ? "Latest turn" : `${i + 1} turns ago`} · ${when} · ${fmtDur(t.total_ms)}`);
    o.value = String(i);
    sel.append(o);
  });
  sel.value = String(index);
  sel.onchange = () => { state.index = Number(sel.value); state.showAllRows = state.showAllSteps = false; render(); view().querySelector(".tb-pick select")?.focus(); };
  wrap.append(sel, icon("chev-down", "tb-pick-chev"));
  return wrap;
}

function totals(t) {
  const head = el("div", "tt-head");
  head.append(el("span", "tt-big", fmtDur(t.total_ms)), el("span", "tt-cap", "whole turn"));
  if (t.outcome && t.outcome !== "ok") head.append(el("span", "tt-tag cold", t.outcome === "aborted" ? "Stopped" : t.outcome === "exited" ? "Process exited" : "Ended with error"));
  const retries = (t.retries || 0) + (t.rate_limits || 0);
  const line = [`First token ${t.first_ms == null ? "none" : fmtDur(t.first_ms)}`, plural(t.steps || 0, "model step"), plural(t.tools?.length ?? 0, "tool call"),
    ...(retries ? [plural(retries, "retry", "retries")] : [])].join(" · ");
  const other = (t.startup_ms || 0) + (t.wait_ms || 0);
  const parts = [["model", "Model", t.model_ms || 0], ["tools", "Tools", t.tool_ms || 0], ["other", "Other", other]];
  const sum = parts.reduce((n, p) => n + p[2], 0);
  const legend = el("ul", "tt-legend");
  for (const [key, name, ms] of parts) {
    const li = el("li");
    li.append(el("i", `sw ${key}`), el("span", "", name), el("b", "", fmtDur(ms)), el("span", "pct", sum ? `${Math.round((ms / sum) * 100)}%` : ""));
    legend.append(li);
  }
  const notes = [t.queue_ms ? `Queued ${fmtDur(t.queue_ms)} before sending (not in the total)` : "", t.startup_ms ? `Startup ${fmtDur(t.startup_ms)}` : "", t.wait_ms ? `Waiting for you ${fmtDur(t.wait_ms)}` : ""].filter(Boolean);
  return [head, el("p", "note", line), legend, ...(notes.length ? [el("p", "note", notes.join(" · "))] : [])];
}

// Rows for the waterfall: model steps, then the tools each step started; same-name tools in one step fold into "Read ×4".
function rows(seg) {
  const out = [];
  for (const s of seg) {
    const prev = out[out.length - 1];
    if (s.k === "tool" && prev?.k === "tool" && prev.n === s.n && prev.i === s.i) {
      prev.count++; prev.end = Math.max(prev.end, s.a + s.d); prev.sum += s.d; if (s.e) prev.errors++;
      continue;
    }
    out.push({ ...s, end: s.a + s.d, count: 1, sum: s.d, errors: s.e ? 1 : 0 });
  }
  return out;
}
const rowLabel = (r) => r.k === "model" ? `Step ${r.i}` : r.k === "tool" ? `${r.n}${r.count > 1 ? ` ×${r.count}` : ""}` : r.k === "retry" ? `Retry ${retryWord(r)}` : r.k === "wait" ? "Waiting for you" : r.k === "queue" ? "Queued" : "Startup";

function waterfall(t, seg, more) {
  const all = rows(seg);
  // Bar length encodes duration on a square-root scale against the turn's longest row, so a 1.6 s Read stays visible next to
  // a 5 min Bash. When it happened is text: the start offset column.
  const longest = Math.max(1, ...all.map((r) => r.end - r.a));
  const len = (ms) => Math.sqrt(Math.max(0, ms) / longest) * 100;
  const shown = state.showAllRows ? all : all.slice(0, ROWS);
  const list = el("ol", "tb-fall");
  list.setAttribute("aria-label", "Timeline, in order");
  const axis = el("li", "tb-axis");
  axis.setAttribute("aria-hidden", "true");
  axis.append(el("span", "tb-lab", "Segment"), el("span", "tb-at", "Start"), el("span", "tb-track"), el("span", "tb-ms", "Duration"));
  list.append(axis);
  for (const r of shown) {
    const li = el("li", `tb-row ${r.k}${r.errors ? " err" : ""}`);
    const lab = el("span", "tb-lab");
    lab.append(el("span", "tb-name", rowLabel(r)));
    if (r.errors) lab.append(el("span", "tb-fail", r.count > 1 ? `${r.errors} failed` : "failed"));
    const track = el("span", "tb-track");
    track.setAttribute("aria-hidden", "true");
    const wall = r.end - r.a;
    const bar = el("i", "tb-bar");
    bar.style.width = `${len(wall)}%`;
    if (r.k === "model" && r.f != null && r.d > 0) { const f = el("i", "tb-ttft"); f.style.width = `${Math.min(100, (r.f / r.d) * 100)}%`; bar.append(f); }
    track.append(bar);
    li.append(lab, el("span", "tb-at", fmtAt(r.a, t.total_ms)), track, el("span", "tb-ms", r.k === "retry" && !wall ? "—" : fmtDur(wall)));
    li.title = `${rowLabel(r)}: starts at ${fmtDur(r.a)}, ${fmtDur(wall)}${r.k === "model" && r.f != null ? `, first output after ${fmtDur(r.f)}` : ""}${r.count > 1 ? `, ${r.count} calls` : ""}`;
    list.append(li);
  }
  const kids = [el("h5", "", "Timeline"), el("p", "note", "In order. Start is time since the turn began. Bar length is duration (square-root scale, longest = full). Steps are model requests; a step's lighter start is its wait for first output."), list];
  if (all.length > ROWS) {
    const btn = el("button", "btn block tb-more", state.showAllRows ? `Show first ${ROWS} rows` : `Show all ${all.length} rows`);
    btn.type = "button";
    btn.onclick = () => { state.showAllRows = !state.showAllRows; render(); view().querySelector(".tb-more")?.focus(); };
    kids.push(btn);
  }
  if (more) kids.push(el("p", "note tb-tail", `${plural(more.n, "later segment")} not itemized: model ${fmtDur(more.model_ms)}, tools ${fmtDur(more.tool_ms)} in ${plural(more.tools, "call")}${more.errors ? ` (${more.errors} failed)` : ""}${more.other_ms ? `, other ${fmtDur(more.other_ms)}` : ""}.`));
  return kids;
}

function toolTable(t, seg) {
  const by = new Map();
  const src = seg?.length ? seg.filter((s) => s.k === "tool").map((s) => ({ n: s.n, ms: s.d, e: s.e })) : t.tools || [];
  for (const x of src) { const a = by.get(x.n) || { calls: 0, total: 0, max: 0, errors: 0 }; a.calls++; a.total += x.ms; a.max = Math.max(a.max, x.ms); if (x.e) a.errors++; by.set(x.n, a); }
  if (!by.size) return [];
  const table = el("table", "speed tb-tools");
  const cap = el("caption", "sr-only", "Time per tool"); table.append(cap);
  const thead = el("thead"), hr = el("tr");
  for (const h of ["Tool", "Calls", "Total", "Max"]) { const th = el("th", "", h); th.scope = "col"; hr.append(th); }
  thead.append(hr);
  const body = el("tbody");
  for (const [name, a] of [...by].sort((x, y) => y[1].total - x[1].total)) {
    const tr = el("tr"), th = el("th", "", name);
    th.scope = "row";
    if (a.errors) th.append(el("span", "tb-fail", `${a.errors} failed`));
    tr.append(th, el("td", "", String(a.calls)), el("td", "", fmtDur(a.total)), el("td", "", fmtDur(a.max)));
    body.append(tr);
  }
  table.append(thead, body);
  return [el("h5", "", "Tools"), table];
}

function stepList(seg) {
  const steps = seg.filter((s) => s.k === "model");
  if (!steps.length) return [];
  const shown = state.showAllSteps ? steps : steps.slice(0, STEPS);
  const list = el("ol", "tb-steps");
  list.setAttribute("aria-label", "Model steps");
  for (const s of shown) {
    const tools = rows(seg.filter((x) => x.k === "tool" && x.i === s.i));
    const retries = seg.filter((x) => x.k === "retry" && x.i === s.i);
    const li = el("li");
    const top = el("div", "tb-step-top");
    top.append(el("span", "n", `Step ${s.i}`), el("span", "ms", fmtDur(s.d)));
    const bits = [s.f != null ? `first output ${fmtDur(s.f)}` : "", tools.length ? `then ${tools.map((r) => rowLabel(r) + (r.errors ? " (failed)" : "")).join(", ")}` : "answered without tools",
      retries.length ? plural(retries.length, "retry", "retries") : ""].filter(Boolean);
    li.append(top, el("p", "note", bits.join(" · ")));
    list.append(li);
  }
  const kids = [el("h5", "", "Model steps"), list];
  if (steps.length > STEPS) {
    const btn = el("button", "btn block tb-more-steps", state.showAllSteps ? `Show first ${STEPS} steps` : `Show all ${steps.length} steps`);
    btn.type = "button";
    btn.onclick = () => { state.showAllSteps = !state.showAllSteps; render(); view().querySelector(".tb-more-steps")?.focus(); };
    kids.push(btn);
  }
  return kids;
}
