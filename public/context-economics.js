import { el, iconButton } from "/render.js";
import { forecastContext, forecastModel } from "/context-forecast.js";

const tokens = n => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const usd = n => n == null ? "Unknown" : `$${n.toFixed(n > 1 ? 2 : 4)}`;
let activeDialog;
let chartLibrary;
const loadChart = () => chartLibrary ||= import("/vendor/chart.umd.min.js").then(() => globalThis.Chart)
  .catch(error => { chartLibrary = null; throw error; });

export async function openContextEconomics({ getThread, send, trigger }) {
  activeDialog?.close();
  const dialog = el("dialog", "context-economics");
  dialog.id = "context-economics";
  dialog.setAttribute("aria-labelledby", "context-economics-title");
  const head = el("div", "context-economics-head");
  const title = el("h3", "", "Context: continue or compact?"); title.id = "context-economics-title";
  const close = iconButton("x", "Close context forecast", "btn icon ghost");
  close.onclick = () => dialog.close();
  head.append(title, close);
  const body = el("div", "context-economics-body");
  body.append(el("p", "sub", "Loading forecast…"));
  dialog.append(head, body); document.body.append(dialog); dialog.showModal(); activeDialog = dialog;
  let chart, timer, Chart;
  dialog.addEventListener("close", () => {
    clearInterval(timer); chart?.destroy(); dialog.remove();
    if (activeDialog === dialog) activeDialog = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  // Preserve the browser's native dialog dismissal without closing the sidebar behind it.
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
  dialog.addEventListener("click", event => { if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  } });
  let pricing = {};
  try {
    const response = await fetch("/api/context-pricing", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Pricing unavailable");
    pricing = await response.json();
  } catch { /* Token projections remain useful while list prices are unavailable. */ }
  if (!dialog.open) return;
  const initial = getThread();
  if (!initial || !Number.isFinite(initial.context?.used) || initial.context.used <= 0) {
    body.replaceChildren(el("p", "sub", "Context size is not reported yet. Send a message, then reopen this graph."));
    return;
  }
  const threadTitle = el("p", "sub", initial.title);
  const status = el("p", "context-cache-state");
  const basis = el("p", "sub");
  const controls = el("div", "context-assumptions");
  const input = (label, value, min, max, step = 1) => {
    const wrap = el("label", "context-control");
    const field = el("input"); field.type = "number"; field.value = value;
    field.min = min; field.max = max; field.step = step;
    wrap.append(el("span", "", label), field); controls.append(wrap);
    field.addEventListener("change", update);
    return field;
  };
  const resume = input("Resume in (minutes)", 0, 0, 1440);
  const gap = input("Gap per request (minutes)", 1, 0, 1440);
  const retained = input("Context kept (%)", 20, 1, 100);
  const growth = input("New input tokens per request", 2000, 100, 20000, 100);
  const ttl = input("Cache lifetime estimate (minutes)", (initial.idleCompactionTtlMs || 0) / 60000, 0, 1440, 0.5);
  const measureWrap = el("label", "context-control");
  const measure = el("select");
  for (const [value, label] of [["cost", "Cost (USD)"], ["tokens", "Processed tokens"]]) {
    const option = el("option", "", label); option.value = value; measure.append(option);
  }
  measureWrap.append(el("span", "", "Graph"), measure); controls.append(measureWrap);
  measure.onchange = update;
  const stage = el("div", "context-chart-stage");
  const canvas = el("canvas"); canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Cumulative cost of continuing versus compacting, by additional input tokens");
  stage.append(canvas);
  const chartError = el("p", "sub"); chartError.hidden = true;
  const summary = el("p", "context-forecast-summary"); summary.setAttribute("aria-live", "polite");
  const automatic = el("p", "sub");
  const actions = el("div", "context-economics-actions");
  const compact = el("button", "btn", "Compact now"); compact.type = "button";
  compact.onclick = () => { const t = getThread(); if (t?.status === "idle" && !t.waiting && !t.archived) { send({ t: "compact", thread: t.id }); dialog.close(); } };
  const auto = el("button", "btn ghost"); auto.type = "button";
  auto.onclick = () => { const t = getThread(); if (t?.idleCompactionTtlMs) { send({ t: "update", thread: t.id, idleCompaction: t.idleCompaction === false }); dialog.close(); } };
  actions.append(compact, auto);
  const data = el("details", "context-forecast-data");
  data.append(el("summary", "", "Forecast data and assumptions"));
  const notes = el("p", "sub");
  notes.textContent = "Scenario, not a subscription charge. Includes reading context, generating a summary, and rebuilding its cache. Future response tokens, tools, extra compaction requests, and long-context price tiers are excluded. Assumes an unchanged prefix and a cache hit before estimated expiry; routing can still miss. Age is measured since the response ended; actual cache reuse may be earlier, especially after long generations. Retained context is also the assumed summary output; actual compaction size and cost may differ. Each point is one model request; tool loops can make many requests per turn. Graph stops at the reported context window. Cache lifetime 0 models no caching. These controls do not change automatic compaction settings.";
  const sources = el("p", "sub");
  sources.append(document.createTextNode(`Public list prices checked ${pricing.verifiedAt || "unknown"}. `));
  for (const source of [...(pricing.sources || []), { name: "OpenAI cache lifetime", url: "https://developers.openai.com/api/docs/guides/prompt-caching" },
    { name: "Claude cache pricing", url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching" }]) {
    const link = el("a", "", source.name); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    sources.append(link, document.createTextNode(" · "));
  }
  const table = el("table");
  data.append(notes, sources, table);
  body.replaceChildren(threadTitle, status, basis, controls, stage, chartError, summary, automatic, actions, data);
  try { Chart = await loadChart(); }
  catch { chartError.hidden = false; chartError.textContent = "Graph could not load. Forecast values remain available below."; stage.hidden = true; }
  if (!dialog.open) return;

  function update() {
    const t = getThread(); if (!t || !dialog.open) return;
    // Keep editable values bounded without turning a cleared field into an expensive scenario.
    const number = (field, fallback) => field.value !== "" && field.validity.valid ? Number(field.value) : fallback;
    const ttlMs = number(ttl, 0) * 60000;
    const ageMs = t.lastProviderActivityAt ? Math.max(0, Date.now() - t.lastProviderActivityAt) : Infinity;
    const model = forecastModel(t, pricing.rates);
    const rate = model.rate && [...model.rate];
    if (rate && t.provider === "claude" && ttlMs > 300000) rate[2] = rate[0] * 2;
    // With caching disabled, fresh input has no cache-write premium.
    if (rate && !ttlMs) rate[2] = rate[0];
    const result = forecastContext({ context: t.context?.used, maxContext: t.context?.max || Infinity,
      retained: number(retained, 20) / 100, added: number(growth, 2000), requests: 40, ttlMs, ageMs,
      resumeMs: number(resume, 0) * 60000, gapMs: number(gap, 1) * 60000, rate });
    if (!result) { summary.textContent = "Context changed. Reopen after token usage is reported."; return; }
    measure.options[0].disabled = !result.priced;
    if (!result.priced) measure.value = "tokens";
    const cost = measure.value === "cost";
    const age = Number.isFinite(ageMs) ? `${Math.floor(ageMs / 60000)}m since last response` : "Last response time unknown";
    const cacheState = !ttlMs ? "No cache assumed" : result.warmResume ? "Cache estimated warm at resume" : "Cache estimated stale at resume";
    status.textContent = `${tokens(t.context.used)} context tokens → ${tokens(result.summary)} after compaction · ${age}. ${cacheState}.`;
    basis.textContent = `${model.model || "Unknown model"} · API-equivalent context cost, not subscription billing. Future responses and tools excluded.`;
    const last = result.points.at(-1);
    const difference = result.priced ? last.keepCost - last.compactCost : null;
    summary.textContent = result.priced
      ? `At ${tokens(last.added)} new input tokens: continue ${usd(last.keepCost)}, compact ${usd(last.compactCost)}. `
        + (difference > 0 ? `Compacting saves ${usd(difference)} in this scenario. ` : `Continuing costs ${usd(-difference)} less in this scenario. `)
        + (result.breakEven != null ? `Compaction pays back around ${tokens(result.breakEven)} new input tokens.` : "No cost break-even within this graph.")
      : `No verified price for ${model.model || "this model"}; showing tokens only. Continue ${tokens(last.keepTokens)}, compact ${tokens(last.compactTokens)} processed tokens.`;
    if (result.windowLimited) summary.textContent += " Projection stops at the context window.";
    const lead = (t.idleCompactionLeadMs ?? 30000) / 1000;
    automatic.textContent = !t.idleCompactionTtlMs ? "Automatic compaction unavailable: cache lifetime unknown."
      : `Automatic compaction ${t.idleCompaction === false ? "off" : "on"}; at least ${tokens(t.idleCompactionMinTokens ?? 50000)} context tokens, ${lead}s before estimated staleness. `
        + (t.idleCompactionDueAt ? `Next attempt around ${new Date(t.idleCompactionDueAt).toLocaleTimeString()}. ` : "No attempt scheduled. ")
        + "Cache timing is estimated, not provider-reported.";
    compact.disabled = t.status !== "idle" || !!t.waiting || !!t.archived || t.operation === "compact" || !t.sessionId;
    auto.disabled = !t.idleCompactionTtlMs;
    auto.textContent = t.idleCompaction === false ? "Enable automatic compaction" : "Disable automatic compaction";
    const rows = el("tbody");
    const header = el("tr");
    for (const label of ["New input", "Continue", "Compact now"]) { const th = el("th", "", label); th.scope = "col"; header.append(th); }
    rows.append(header);
    for (const p of result.points) {
      const row = el("tr");
      for (const value of [tokens(p.added), cost ? usd(p.keepCost) : tokens(p.keepTokens), cost ? usd(p.compactCost) : tokens(p.compactTokens)]) row.append(el("td", "", value));
      rows.append(row);
    }
    const caption = el("caption", "", `${model.model || "Unknown model"} · ${cost ? "USD estimate" : "Processed tokens (input plus summary output)"}`);
    table.replaceChildren(caption, rows);
    canvas.setAttribute("aria-label", `${cost ? "Estimated USD cost" : "Processed tokens"} versus new input tokens: continue or compact now. Forecast data table follows.`);
    if (!Chart) return;
    const css = getComputedStyle(dialog);
    const options = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: css.getPropertyValue("--t2") } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${cost ? usd(ctx.parsed.y) : tokens(ctx.parsed.y)}` } } },
      scales: {
        x: { type: "linear", title: { display: true, text: "New input tokens", color: css.getPropertyValue("--t2") }, ticks: { maxTicksLimit: 5, color: css.getPropertyValue("--t3"), callback: tokens }, grid: { color: css.getPropertyValue("--edge") } },
        y: { beginAtZero: true, title: { display: true, text: cost ? "Cumulative USD estimate" : "Cumulative processed tokens", color: css.getPropertyValue("--t2") }, ticks: { color: css.getPropertyValue("--t3"), callback: cost ? usd : tokens }, grid: { color: css.getPropertyValue("--edge") } },
      },
    };
    const datasets = [
      { label: "Continue", borderColor: css.getPropertyValue("--accent"), borderWidth: 2, pointRadius: 2,
        data: result.points.map(p => ({ x: p.added, y: cost ? p.keepCost : p.keepTokens })) },
      { label: "Compact now", borderColor: css.getPropertyValue("--ok"), borderDash: [6, 3], borderWidth: 2, pointRadius: 2,
        data: result.points.map(p => ({ x: p.added, y: cost ? p.compactCost : p.compactTokens })) },
    ];
    if (chart) { chart.data.datasets = datasets; chart.options = options; chart.update("none"); }
    else chart = new Chart(canvas, { type: "line", data: { datasets }, options });
  }
  update();
  timer = setInterval(update, 15000);
}
