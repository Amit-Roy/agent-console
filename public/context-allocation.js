import { el } from "/render.js";

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

export function createContextAllocation(getThread) {
  const root = el("details", "context-allocation");
  root.open = true;
  root.append(el("summary", "", "Token allocation"));
  const content = el("div", "context-allocation-content");
  root.append(content);
  let key,
    request = 0,
    closed = false;
  const controller = new AbortController();
  const refresh = async () => {
    const thread = getThread();
    if (!thread || closed) return;
    const nextKey = `${thread.id}:${thread.context?.used}:${thread.context?.max}:${thread.lastCompactedAt}:${thread.updatedAt}`;
    if (nextKey === key) return;
    key = nextKey;
    const serial = ++request;
    if (!content.children.length) content.append(el("p", "sub", "Loading token allocation…"));
    try {
      const response = await fetch(`/api/context-allocation/${encodeURIComponent(thread.id)}`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Allocation unavailable");
      const allocation = await response.json();
      if (closed || serial !== request) return;
      const categories = (allocation.categories || []).filter(
        (c) => Number.isFinite(c.tokens) && c.tokens > 0,
      );
      const total = categories.reduce((sum, c) => sum + c.tokens, 0);
      const capacity = allocation.max > 0 ? allocation.max : total;
      const text = el(
        "p",
        "sub",
        allocation.used == null
          ? "Context size is not reported yet."
          : `${fmt(allocation.used)} used${allocation.max > 0 ? ` of ${fmt(allocation.max)} tokens` : " tokens; window size unknown"}.`,
      );
      const grid = el("div", "context-token-grid");
      grid.setAttribute("role", "img");
      grid.setAttribute(
        "aria-label",
        `Context allocation. ${categories.map((c) => `${c.label}: ${fmt(c.tokens)}${c.estimated ? " estimated" : ""} tokens`).join(". ")}`,
      );
      // Largest-remainder rounding preserves 100 cells without claiming per-cell precision.
      const cells = categories.map((c) => ({
        ...c,
        share: capacity > 0 ? (c.tokens / capacity) * 100 : 0,
      }));
      for (const c of cells) c.count = Math.floor(c.share);
      let remaining = Math.max(0, 100 - cells.reduce((sum, c) => sum + c.count, 0));
      for (const c of [...cells].sort((a, b) => (b.share % 1) - (a.share % 1))) {
        if (!remaining--) break;
        c.count++;
      }
      for (const c of cells)
        for (let i = 0; i < Math.min(100, c.count); i++) {
          const cell = el("span");
          cell.dataset.kind = kinds.has(c.id) ? c.id : "unknown";
          cell.title = `${c.label} · ${fmt(c.tokens)} tokens${c.estimated ? " (estimated)" : ""}`;
          cell.setAttribute("aria-hidden", "true");
          grid.append(cell);
        }
      const legend = el("ul", "context-allocation-legend");
      for (const c of categories) {
        const row = el("li");
        const swatch = el("span", "context-allocation-swatch");
        swatch.dataset.kind = kinds.has(c.id) ? c.id : "unknown";
        swatch.setAttribute("aria-hidden", "true");
        row.append(
          swatch,
          el("span", "", c.label),
          el("span", "context-allocation-value", `${fmt(c.tokens)}${c.estimated ? " est." : ""}`),
        );
        legend.append(row);
      }
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
    } catch (error) {
      if (closed || serial !== request) return;
      key = undefined;
      content.replaceChildren(
        el(
          "p",
          "sub",
          "Token allocation unavailable. Provider context totals remain visible above.",
        ),
      );
    }
  };
  return {
    root,
    refresh,
    destroy: () => {
      closed = true;
      controller.abort();
    },
  };
}
