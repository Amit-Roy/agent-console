import { el } from "./render.js";

const fmt = (n) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const kinds = new Set([
  "system",
  "tools",
  "memory",
  "messages",
  "tool_results",
  "thinking",
  "summary",
  "unknown",
  "free",
]);

function allocationKey(thread) {
  return `${thread.id}:${thread.context?.used}:${thread.context?.max}:${thread.lastCompactedAt}:${thread.updatedAt}`;
}

function usageText(allocation) {
  if (allocation.used == null) return "Context size is not reported yet.";
  return `${fmt(allocation.used)} used${allocation.max > 0 ? ` of ${fmt(allocation.max)} tokens` : " tokens; window size unknown"}.`;
}

function kindOf(category) {
  return kinds.has(category.id) ? category.id : "unknown";
}

// Largest-remainder rounding preserves 100 cells without claiming per-cell precision.
function allocateCells(categories, capacity) {
  const cells = categories.map((category) => ({
    ...category,
    share: capacity > 0 ? (category.tokens / capacity) * 100 : 0,
  }));
  for (const cell of cells) cell.count = Math.floor(cell.share);
  let remaining = Math.max(0, 100 - cells.reduce((sum, cell) => sum + cell.count, 0));
  for (const cell of [...cells].sort((first, second) => (second.share % 1) - (first.share % 1))) {
    if (!remaining--) break;
    cell.count++;
  }
  return cells;
}

function buildGrid(categories, capacity) {
  const grid = el("div", "context-token-grid");
  grid.setAttribute("role", "img");
  grid.setAttribute(
    "aria-label",
    `Context allocation. ${categories.map((category) => `${category.label}: ${fmt(category.tokens)}${category.estimated ? " estimated" : ""} tokens`).join(". ")}`,
  );
  for (const category of allocateCells(categories, capacity))
    for (let index = 0; index < Math.min(100, category.count); index++) {
      const cell = el("span");
      cell.dataset.kind = kindOf(category);
      cell.title = `${category.label} · ${fmt(category.tokens)} tokens${category.estimated ? " (estimated)" : ""}`;
      cell.setAttribute("aria-hidden", "true");
      grid.append(cell);
    }
  return grid;
}

function buildLegend(categories) {
  const legend = el("ul", "context-allocation-legend");
  for (const category of categories) {
    const row = el("li");
    const swatch = el("span", "context-allocation-swatch");
    swatch.dataset.kind = kindOf(category);
    swatch.setAttribute("aria-hidden", "true");
    row.append(
      swatch,
      el("span", "", category.label),
      el(
        "span",
        "context-allocation-value",
        `${fmt(category.tokens)}${category.estimated ? " est." : ""}`,
      ),
    );
    legend.append(row);
  }
  return legend;
}

function renderAllocation(content, allocation) {
  const categories = (allocation.categories || []).filter(
    (category) => Number.isFinite(category.tokens) && category.tokens > 0,
  );
  const total = categories.reduce((sum, category) => sum + category.tokens, 0);
  const capacity = allocation.max > 0 ? allocation.max : total;
  const text = el("p", "sub", usageText(allocation));
  const grid = buildGrid(categories, capacity);
  const legend = buildLegend(categories);
  const note = el(
    "p",
    "sub",
    allocation.note || "Category counts are estimates; the provider reports the total.",
  );
  content.replaceChildren(
    text,
    ...(total > 0 ? [grid, legend] : []),
    note,
    el(
      "p",
      "context-allocation-scale",
      `Each square represents about 1% of ${allocation.max > 0 ? "the window" : "the used context"}. Small categories may round below one square.`,
    ),
  );
}

async function refreshAllocation(state) {
  const thread = state.getThread();
  if (!thread || state.closed) return;
  const nextKey = allocationKey(thread);
  if (nextKey === state.key) return;
  state.key = nextKey;
  const serial = ++state.request;
  const { content } = state;
  if (!content.children.length) content.append(el("p", "sub", "Loading token allocation…"));
  try {
    const response = await fetch(`/api/context-allocation/${encodeURIComponent(thread.id)}`, {
      credentials: "same-origin",
      signal: state.controller.signal,
    });
    if (!response.ok) throw new Error("Allocation unavailable");
    const allocation = await response.json();
    if (state.closed || serial !== state.request) return;
    renderAllocation(content, allocation);
  } catch {
    if (state.closed || serial !== state.request) return;
    state.key = undefined;
    content.replaceChildren(
      el("p", "sub", "Token allocation unavailable. Provider context totals remain visible above."),
    );
  }
}

export function createContextAllocation(getThread) {
  const root = el("details", "context-allocation");
  root.open = true;
  root.append(el("summary", "", "Token allocation"));
  const content = el("div", "context-allocation-content");
  root.append(content);
  const state = {
    getThread,
    content,
    key: undefined,
    request: 0,
    closed: false,
    controller: new AbortController(),
  };
  return {
    root,
    refresh: () => refreshAllocation(state),
    destroy: () => {
      state.closed = true;
      state.controller.abort();
    },
  };
}
