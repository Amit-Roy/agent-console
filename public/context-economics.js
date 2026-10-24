import { createContextAllocation } from "/context-allocation.js";
import { forecastContext, forecastModel, recommendCompaction } from "/context-forecast.js";
import { el, iconButton } from "/render.js";

const tokens = (n) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const usd = (n) => (n == null ? "Unknown" : `$${n.toFixed(n > 1 ? 2 : 4)}`);
let activeDialog;
let chartLibrary;
const loadChart = () =>
  (chartLibrary ||= import("/vendor/chart.umd.min.js")
    .then(() => globalThis.Chart)
    .catch((error) => {
      chartLibrary = null;
      throw error;
    }));

const FORECAST_NOTES =
  "Scenario, not a subscription charge. Includes reading context, generating a summary, and rebuilding its cache. Future response tokens, tools, extra compaction requests, and long-context price tiers are excluded. Assumes an unchanged prefix and a cache hit before estimated expiry; routing can still miss. Age is measured since the response ended; actual cache reuse may be earlier, especially after long generations. Retained context is also the assumed summary output; actual compaction size and cost may differ. Each point is one model request; tool loops can make many requests per turn. Graph stops at the reported context window. Cache lifetime 0 models no caching. Recommendation compares no compaction with one compaction now or immediately after each future request over the same workload. No further compaction is assumed. These controls do not change automatic compaction settings.";

const EXTRA_PRICE_SOURCES = [
  {
    name: "OpenAI cache lifetime",
    url: "https://developers.openai.com/api/docs/guides/prompt-caching",
  },
  {
    name: "Claude cache pricing",
    url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  },
];

function createShell() {
  const dialog = el("dialog", "context-economics");
  dialog.id = "context-economics";
  dialog.setAttribute("aria-labelledby", "context-economics-title");
  const head = el("div", "context-economics-head");
  const title = el("h2", "", "Context: continue or compact?");
  title.id = "context-economics-title";
  const closeButton = iconButton("x", "Close context forecast", "btn icon ghost");
  closeButton.onclick = () => dialog.close();
  head.append(title, closeButton);
  const body = el("div", "context-economics-body");
  body.append(el("p", "sub", "Loading forecast…"));
  dialog.append(head, body);
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body };
}

function isOutsideRect(event, rect) {
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

function attachDialogListeners(view) {
  const { dialog, trigger } = view;
  dialog.addEventListener(
    "close",
    () => {
      clearInterval(view.timer);
      view.chart?.destroy();
      view.allocation?.destroy();
      dialog.remove();
      if (activeDialog === dialog) activeDialog = null;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    },
    { once: true },
  );
  // Preserve the browser's native dialog dismissal without closing the sidebar behind it.
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && isOutsideRect(event, dialog.getBoundingClientRect()))
      dialog.close();
  });
}

async function fetchPricing() {
  let pricing = {};
  try {
    const response = await fetch("/api/context-pricing", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Pricing unavailable");
    pricing = await response.json();
  } catch {
    /* Token projections remain useful while list prices are unavailable. */
  }
  return pricing;
}

function hasContextUsage(thread) {
  return !!thread && Number.isFinite(thread.context?.used) && thread.context.used > 0;
}

function showRecommendation(view, action, title, detail) {
  view.recommendation.dataset.action = action;
  view.compact.classList.toggle("primary", action === "now");
  view.recommendationTitle.textContent = title;
  view.recommendationDetail.textContent = detail;
}

function buildRecommendation(view) {
  const recommendation = el("section", "context-recommendation");
  recommendation.setAttribute("aria-live", "polite");
  recommendation.setAttribute("aria-atomic", "true");
  recommendation.setAttribute("aria-labelledby", "context-recommendation-title");
  const recommendationLabel = el("p", "context-recommendation-label", "Recommendation");
  view.recommendationTitle = el("h3", "context-recommendation-title");
  view.recommendationTitle.id = "context-recommendation-title";
  view.recommendationDetail = el("p", "context-recommendation-detail");
  recommendation.append(recommendationLabel, view.recommendationTitle, view.recommendationDetail);
  view.recommendation = recommendation;
}

function buildNumberInput(view, label, value, min, max, step = 1) {
  const wrap = el("label", "context-control");
  const field = el("input");
  field.type = "number";
  field.value = value;
  field.min = min;
  field.max = max;
  field.step = step;
  wrap.append(el("span", "", label), field);
  view.controls.append(wrap);
  field.addEventListener("change", view.update);
  return field;
}

function buildMeasureSelect(view) {
  const measureWrap = el("label", "context-control");
  const measure = el("select");
  for (const [value, label] of [
    ["cost", "Cost (USD)"],
    ["tokens", "Processed tokens"],
  ]) {
    const option = el("option", "", label);
    option.value = value;
    measure.append(option);
  }
  measureWrap.append(el("span", "", "Graph"), measure);
  view.controls.append(measureWrap);
  measure.onchange = view.update;
  view.measure = measure;
}

function buildControls(view, initial) {
  view.controls = el("div", "context-assumptions");
  view.inputs = {
    resume: buildNumberInput(view, "Resume in (minutes)", 0, 0, 1440),
    gap: buildNumberInput(view, "Gap per request (minutes)", 1, 0, 1440),
    retained: buildNumberInput(view, "Context kept (%)", 20, 1, 100),
    growth: buildNumberInput(view, "New input tokens per request", 2000, 100, 20000, 100),
    requests: buildNumberInput(view, "Future requests", 40, 1, 50),
    ttl: buildNumberInput(
      view,
      "Cache lifetime estimate (minutes)",
      (initial.idleCompactionTtlMs || 0) / 60000,
      0,
      1440,
      0.5,
    ),
  };
  buildMeasureSelect(view);
}

function buildChartStage(view) {
  view.stage = el("div", "context-chart-stage");
  view.canvas = el("canvas");
  view.canvas.setAttribute("role", "img");
  view.canvas.setAttribute(
    "aria-label",
    "Cumulative cost of continuing versus compacting, by additional input tokens",
  );
  view.stage.append(view.canvas);
  view.chartError = el("p", "sub");
  view.chartError.hidden = true;
  view.summary = el("p", "context-forecast-summary");
  view.summary.setAttribute("aria-live", "polite");
}

function buildActions(view) {
  const { getThread, send, dialog } = view;
  view.automatic = el("p", "sub");
  view.actions = el("div", "context-economics-actions");
  view.compact = el("button", "btn", "Compact now");
  view.compact.type = "button";
  view.compact.onclick = () => {
    const thread = getThread();
    if (thread?.status === "idle" && !thread.waiting && !thread.archived) {
      send({ t: "compact", thread: thread.id });
      dialog.close();
    }
  };
  view.auto = el("button", "btn ghost");
  view.auto.type = "button";
  view.auto.onclick = () => {
    const thread = getThread();
    if (thread?.idleCompactionTtlMs) {
      send({ t: "update", thread: thread.id, idleCompaction: thread.idleCompaction === false });
      dialog.close();
    }
  };
  view.recommendation.append(view.compact);
  view.actions.append(view.auto);
}

function buildSources(pricing) {
  const sources = el("p", "sub");
  sources.append(
    document.createTextNode(`Public list prices checked ${pricing.verifiedAt || "unknown"}. `),
  );
  for (const source of [...(pricing.sources || []), ...EXTRA_PRICE_SOURCES]) {
    const link = el("a", "", source.name);
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    sources.append(link, document.createTextNode(" · "));
  }
  return sources;
}

function buildDataSection(view) {
  const data = el("details", "context-forecast-data");
  data.append(el("summary", "", "Forecast data and assumptions"));
  const notes = el("p", "sub");
  notes.textContent = FORECAST_NOTES;
  view.table = el("table");
  data.append(notes, buildSources(view.pricing), view.table);
  return data;
}

function buildLayout(view, initial) {
  const threadTitle = el("p", "sub", initial.title);
  view.status = el("p", "context-cache-state");
  view.basis = el("p", "sub");
  buildRecommendation(view);
  view.allocation = createContextAllocation(view.getThread);
  view.allocation.root.open = false;
  buildControls(view, initial);
  buildChartStage(view);
  buildActions(view);
  const data = buildDataSection(view);
  view.body.replaceChildren(
    threadTitle,
    view.recommendation,
    view.status,
    view.basis,
    view.stage,
    view.chartError,
    view.summary,
    view.allocation.root,
    view.controls,
    view.automatic,
    view.actions,
    data,
  );
}

// Keep editable values bounded without turning a cleared field into an expensive scenario.
function numberValue(field, fallback) {
  return field.value !== "" && field.validity.valid ? Number(field.value) : fallback;
}

function adjustedRate(thread, model, ttlMs) {
  const rate = model.rate && [...model.rate];
  if (rate && thread.provider === "claude" && ttlMs > 300000) rate[2] = rate[0] * 2;
  // With caching disabled, fresh input has no cache-write premium.
  if (rate && !ttlMs) rate[2] = rate[0];
  return rate;
}

function buildScenario(view, thread) {
  const { inputs } = view;
  const ttlMs = numberValue(inputs.ttl, 0) * 60000;
  const ageMs = thread.lastProviderActivityAt
    ? Math.max(0, Date.now() - thread.lastProviderActivityAt)
    : Infinity;
  const model = forecastModel(thread, view.pricing.rates);
  const scenario = {
    context: thread.context?.used,
    maxContext: thread.context?.max || Infinity,
    retained: numberValue(inputs.retained, 20) / 100,
    added: numberValue(inputs.growth, 2000),
    requests: numberValue(inputs.requests, 40),
    ttlMs,
    ageMs,
    resumeMs: numberValue(inputs.resume, 0) * 60000,
    gapMs: numberValue(inputs.gap, 1) * 60000,
    rate: adjustedRate(thread, model, ttlMs),
  };
  return { scenario, model, ttlMs, ageMs };
}

function showUnknownForecast(view) {
  view.summary.textContent = "Context changed. Reopen after token usage is reported.";
  showRecommendation(
    view,
    "unknown",
    "More data needed",
    "Wait for fresh context usage before comparing compaction points.",
  );
  view.compact.disabled = true;
  view.stage.hidden = true;
  void view.allocation.refresh();
}

function recommendationCopy(thread, best, result) {
  if (thread.status === "running")
    return [
      "running",
      "Finish current run",
      "Recheck when the run finishes; context is still changing.",
    ];
  if (best.action === "unknown")
    return [
      "unknown",
      "More data needed",
      "Context, pricing, or the remaining window is insufficient to compare compaction points.",
    ];
  if (best.action === "continue")
    return [
      "continue",
      "Continue for now",
      `Continue for ${best.horizonRequests} requests: about ${usd(result.points.at(-1).keepCost)}. Compaction does not repay its cost in this scenario.`,
    ];
  if (best.action === "now")
    return [
      "now",
      "Compact now",
      `Save about ${usd(best.savings)} over ${best.horizonRequests} requests. Estimated context: ${tokens(thread.context.used)} → ${tokens(result.summary)} tokens.`,
    ];
  return [
    "later",
    "Compact later",
    `Compact after about ${best.afterRequests} requests, at ${tokens(best.atContextTokens)} context tokens. Estimated savings: ${usd(best.savings)} over ${best.horizonRequests} requests.`,
  ];
}

function cacheStateText(ttlMs, result) {
  if (!ttlMs) return "No cache assumed";
  return result.warmResume ? "Cache estimated warm at resume" : "Cache estimated stale at resume";
}

function statusText(thread, result, ttlMs, ageMs) {
  const age = Number.isFinite(ageMs)
    ? `${Math.floor(ageMs / 60000)}m since last response`
    : "Last response time unknown";
  return `${tokens(thread.context.used)} context tokens → ${tokens(result.summary)} after compaction · ${age}. ${cacheStateText(ttlMs, result)}.`;
}

function pricedSummaryText(result) {
  const last = result.points.at(-1);
  const difference = last.keepCost - last.compactCost;
  return (
    `At ${tokens(last.added)} new input tokens: continue ${usd(last.keepCost)}, compact ${usd(last.compactCost)}. ` +
    (difference > 0
      ? `Compacting saves ${usd(difference)} in this scenario. `
      : `Continuing costs ${usd(-difference)} less in this scenario. `) +
    (result.breakEven != null
      ? `Compaction pays back around ${tokens(result.breakEven)} new input tokens.`
      : "No cost break-even within this graph.")
  );
}

function summaryText(result, model) {
  if (result.priced) return pricedSummaryText(result);
  const last = result.points.at(-1);
  return `No verified price for ${model.model || "this model"}; showing tokens only. Continue ${tokens(last.keepTokens)}, compact ${tokens(last.compactTokens)} processed tokens.`;
}

function automaticText(thread) {
  if (!thread.idleCompactionTtlMs)
    return "Automatic compaction unavailable: cache lifetime unknown.";
  const lead = (thread.idleCompactionLeadMs ?? 30000) / 1000;
  return (
    `Automatic compaction ${thread.idleCompaction === false ? "off" : "on"}; at least ${tokens(thread.idleCompactionMinTokens ?? 50000)} context tokens, ${lead}s before estimated staleness. ` +
    (thread.idleCompactionDueAt
      ? `Next attempt around ${new Date(thread.idleCompactionDueAt).toLocaleTimeString()}. `
      : "No attempt scheduled. ") +
    "Cache timing is estimated, not provider-reported."
  );
}

function compactUnavailable(thread) {
  return (
    thread.status !== "idle" ||
    !!thread.waiting ||
    !!thread.archived ||
    thread.operation === "compact" ||
    !thread.sessionId
  );
}

function writeTexts(view, thread, forecast) {
  const { result, model, ttlMs, ageMs } = forecast;
  view.status.textContent = statusText(thread, result, ttlMs, ageMs);
  view.basis.textContent = `${model.model || "Unknown model"} · API-equivalent context cost, not subscription billing. Future responses and tools excluded.`;
  view.summary.textContent = summaryText(result, model);
  if (result.windowLimited) view.summary.textContent += " Projection stops at the context window.";
  view.automatic.textContent = automaticText(thread);
  view.compact.disabled = compactUnavailable(thread);
  view.auto.disabled = !thread.idleCompactionTtlMs;
  view.auto.textContent =
    thread.idleCompaction === false
      ? "Enable automatic compaction"
      : "Disable automatic compaction";
}

function buildTableRows(result, cost) {
  const rows = el("tbody");
  const header = el("tr");
  for (const label of ["New input", "Continue", "Compact now"]) {
    const headCell = el("th", "", label);
    headCell.scope = "col";
    header.append(headCell);
  }
  rows.append(header);
  for (const point of result.points) {
    const row = el("tr");
    for (const value of [
      tokens(point.added),
      cost ? usd(point.keepCost) : tokens(point.keepTokens),
      cost ? usd(point.compactCost) : tokens(point.compactTokens),
    ])
      row.append(el("td", "", value));
    rows.append(row);
  }
  return rows;
}

function writeTable(view, result, model, cost) {
  const rows = buildTableRows(result, cost);
  const caption = el(
    "caption",
    "",
    `${model.model || "Unknown model"} · ${cost ? "USD estimate" : "Processed tokens (input plus summary output)"}`,
  );
  view.table.replaceChildren(caption, rows);
  view.canvas.setAttribute(
    "aria-label",
    `${cost ? "Estimated USD cost" : "Processed tokens"} versus new input tokens: continue or compact now. Forecast data table follows.`,
  );
}

function buildChartOptions(css, cost) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: css.getPropertyValue("--t2") } },
      tooltip: {
        callbacks: {
          label: (item) =>
            `${item.dataset.label}: ${cost ? usd(item.parsed.y) : tokens(item.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        title: { display: true, text: "New input tokens", color: css.getPropertyValue("--t2") },
        ticks: { maxTicksLimit: 5, color: css.getPropertyValue("--t3"), callback: tokens },
        grid: { color: css.getPropertyValue("--edge") },
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: cost ? "Cumulative USD estimate" : "Cumulative processed tokens",
          color: css.getPropertyValue("--t2"),
        },
        ticks: { color: css.getPropertyValue("--t3"), callback: cost ? usd : tokens },
        grid: { color: css.getPropertyValue("--edge") },
      },
    },
  };
}

function buildChartDatasets(css, result, cost) {
  return [
    {
      label: "Continue",
      borderColor: css.getPropertyValue("--accent"),
      borderWidth: 2,
      pointRadius: 2,
      data: result.points.map((point) => ({
        x: point.added,
        y: cost ? point.keepCost : point.keepTokens,
      })),
    },
    {
      label: "Compact now",
      borderColor: css.getPropertyValue("--ok"),
      borderDash: [6, 3],
      borderWidth: 2,
      pointRadius: 2,
      data: result.points.map((point) => ({
        x: point.added,
        y: cost ? point.compactCost : point.compactTokens,
      })),
    },
  ];
}

function drawChart(view, result, cost) {
  const css = getComputedStyle(view.dialog);
  const options = buildChartOptions(css, cost);
  const datasets = buildChartDatasets(css, result, cost);
  if (view.chart) {
    view.chart.data.datasets = datasets;
    view.chart.options = options;
    view.chart.update("none");
  } else view.chart = new view.Chart(view.canvas, { type: "line", data: { datasets }, options });
}

function updateForecast(view) {
  const thread = view.getThread();
  if (!thread || !view.dialog.open) return;
  const { scenario, model, ttlMs, ageMs } = buildScenario(view, thread);
  const result = forecastContext(scenario);
  if (!result) {
    showUnknownForecast(view);
    return;
  }
  if (view.Chart) view.stage.hidden = false;
  const best = recommendCompaction(scenario);
  showRecommendation(view, ...recommendationCopy(thread, best, result));
  void view.allocation.refresh();
  view.measure.options[0].disabled = !result.priced;
  if (!result.priced) view.measure.value = "tokens";
  const cost = view.measure.value === "cost";
  writeTexts(view, thread, { result, model, ttlMs, ageMs });
  writeTable(view, result, model, cost);
  if (view.Chart) drawChart(view, result, cost);
}

export async function openContextEconomics({ getThread, send, trigger }) {
  activeDialog?.close();
  const { dialog, body } = createShell();
  activeDialog = dialog;
  const view = { dialog, body, getThread, send, trigger, pricing: {} };
  view.update = () => updateForecast(view);
  attachDialogListeners(view);
  view.pricing = await fetchPricing();
  if (!dialog.open) return;
  const initial = getThread();
  if (!hasContextUsage(initial)) {
    body.replaceChildren(
      el("p", "sub", "Context size is not reported yet. Send a message, then reopen this graph."),
    );
    return;
  }
  buildLayout(view, initial);
  void view.allocation.refresh();
  try {
    view.Chart = await loadChart();
  } catch {
    view.chartError.hidden = false;
    view.chartError.textContent = "Graph could not load. Forecast values remain available below.";
    view.stage.hidden = true;
  }
  if (!dialog.open) return;
  updateForecast(view);
  view.timer = setInterval(view.update, 15000);
}
