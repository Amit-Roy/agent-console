// Tokens tab: where input tokens go (range-scoped spend) and what every session carries before the first prompt (overhead, measured now).
// Pure DOM. dashboard.js passes its own helpers in `ui` so the look stays identical to the Usage tab.
//
// ui contract: { el, panel, kpi, hbars, legend, fmt, usd, pct, provMeta, showTip, hideTip?, retryOverhead? }
const KINDS = {
  instructions: ["Instructions", "--k-instructions"],
  import: ["Imports", "--k-import"],
  "brain-index": ["Brain index", "--k-brain"],
  style: ["Reply style", "--k-style"],
  session: ["Session rules", "--k-session"],
  "brain-contract": ["Brain contract", "--k-contract"],
  skills: ["Skills list", "--k-skills"],
  agents: ["Agents list", "--k-agents"],
};
const kindMeta = (k) => KINDS[k] || [k, "--c-other"];
const NF = new Intl.NumberFormat("en-US");
const bytesFmt = (n) =>
  n == null
    ? "—"
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MiB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${n} B`;
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const cssVar = (v) => `var(${v})`;
const homeRel = (p) =>
  p ? p.replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^\/root(?=\/|$)/, "~") : null;

const WARN_ICON =
  '<svg class="ico tk-warn-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 14.2 13H1.8L8 2.2Z"/><path d="M8 6.5v3"/><path d="M8 11.4v.1"/></svg>';

// ---------- shared DOM helpers ----------
function section(view, title, sub) {
  const { el: element } = view.ui;
  const sectionEl = element("section", "tk-sec");
  const headEl = element("div", "tk-sec-h");
  headEl.append(element("h2", "", title));
  if (sub) headEl.append(element("p", "muted", sub));
  sectionEl.append(headEl);
  return sectionEl;
}

// Hover/focus tip wiring shared by chart rows and stacked-bar segments.
function bindTip(view, node, show) {
  node.addEventListener("pointermove", show);
  node.addEventListener("focus", show);
  node.addEventListener("pointerleave", view.hideTip);
  node.addEventListener("blur", view.hideTip);
}

// Panel chart rows get hover/focus tips; hbars itself has none.
function tipRows(view, box, rows) {
  [...box.querySelectorAll(".hb")].forEach((row, index) => {
    const point = rows[index];
    if (!point) return;
    row.tabIndex = 0;
    row.setAttribute(
      "aria-label",
      `${point.name}: ${point.tip.map(([key, value]) => `${key} ${value}`).join(", ")}`,
    );
    bindTip(view, row, (event) => view.ui.showTip(event, point.name, point.tip));
  });
  return box;
}

function tableEl(view, headers, rows, cls = "") {
  const { el: element } = view.ui;
  const table = element("table", cls);
  const thead = element("thead"),
    headRow = element("tr");
  for (const header of headers) headRow.append(element("th", "", header));
  thead.append(headRow);
  const tableBody = element("tbody");
  for (const dataRow of rows) {
    const tableRow = element("tr");
    for (const cellText of dataRow) tableRow.append(element("td", "", cellText));
    tableBody.append(tableRow);
  }
  table.append(thead, tableBody);
  return table;
}

function asTable(view, headers, rows) {
  const { el: element } = view.ui;
  const details = element("details", "tk-table");
  details.append(element("summary", "", "Show as table"));
  const scroller = element("div", "tk-scroll");
  scroller.append(tableEl(view, headers, rows));
  details.append(scroller);
  return details;
}

function empty(view, text) {
  return view.ui.el("div", "empty-c", text);
}

// ---------- spend: aggregation ----------
function newBucket() {
  return { tokens: 0, in: 0, cache: 0, cost: 0 };
}

function addBucket(map, key, turn) {
  const bucket = map.get(key) || newBucket();
  bucket.tokens += (turn.in || 0) + (turn.out || 0);
  bucket.in += turn.in || 0;
  bucket.cache += turn.cache || 0;
  bucket.cost += turn.cost || 0;
  map.set(key, bucket);
  return bucket;
}

function addModels(byModel, models) {
  for (const modelUse of models) {
    const bucket = byModel.get(modelUse.model) || {
      in: 0,
      cacheRead: 0,
      out: 0,
      cost: 0,
      known: false,
    };
    bucket.in += (modelUse.fresh || 0) + (modelUse.cacheWrite || 0) + (modelUse.cacheRead || 0);
    bucket.cacheRead += modelUse.cacheRead || 0;
    bucket.out += modelUse.output || 0;
    if (modelUse.cost != null) {
      bucket.cost += modelUse.cost;
      bucket.known = true;
    }
    byModel.set(modelUse.model, bucket);
  }
}

function addTools(byTool, tools, per) {
  for (const [name, count] of Object.entries(tools || {})) {
    const bucket = byTool.get(name) || { calls: 0, samples: [] };
    bucket.calls += count;
    bucket.samples.push(per);
    byTool.set(name, bucket);
  }
}

function accumulateTurn(agg, turn, cur) {
  const tin = turn.in || 0;
  agg.tokens += tin + (turn.out || 0);
  agg.inp += tin;
  agg.cache += turn.cache || 0;
  if (turn.cost != null) {
    agg.cost += turn.cost;
    agg.costKnown = true;
  }
  const calls = Object.values(turn.tools || {}).reduce((sum, count) => sum + count, 0);
  const per = calls ? tin / (calls + 1) : null;
  if (per != null) agg.perReq.push(per);
  addBucket(agg.byProv, turn.provider || "other", turn);
  const thread = addBucket(agg.byThread, turn.thread, turn);
  thread.provider = turn.provider;
  addBucket(agg.byProj, homeRel(cur.cwds?.[turn.thread]) || "Unknown project", turn);
  addModels(agg.byModel, turn.models || []);
  if (per != null) addTools(agg.byTool, turn.tools, per);
}

function aggregateTurns(turns, cur) {
  const agg = {
    tokens: 0,
    inp: 0,
    cache: 0,
    cost: 0,
    costKnown: false,
    perReq: [],
    byProv: new Map(),
    byModel: new Map(),
    byProj: new Map(),
    byThread: new Map(),
    byTool: new Map(),
  };
  for (const turn of turns) accumulateTurn(agg, turn, cur);
  return agg;
}

// ---------- spend: rankings ----------
function sumBuckets(rest) {
  return rest.reduce(
    (acc, [, bucket]) => ({
      tokens: acc.tokens + bucket.tokens,
      in: acc.in + bucket.in,
      cache: acc.cache + bucket.cache,
      cost: acc.cost + bucket.cost,
    }),
    newBucket(),
  );
}

function rank(map, limit, nameOf, colorOf, extraOf, tipOf) {
  const sorted = [...map.entries()].sort((left, right) => right[1].tokens - left[1].tokens);
  const top = sorted.slice(0, limit).map(([key, bucket]) => ({ key: key, value: bucket }));
  const rest = sorted.slice(limit);
  const rows = top.map(({ key, value: bucket }) => ({
    name: nameOf(key, bucket),
    value: bucket.tokens,
    color: colorOf(key, bucket),
    extra: extraOf(bucket),
    tip: tipOf(bucket),
  }));
  if (rest.length) {
    const other = sumBuckets(rest);
    rows.push({
      name: "Other",
      value: other.tokens,
      color: cssVar("--c-other"),
      extra: extraOf(other),
      tip: tipOf(other),
    });
  }
  return rows;
}

function cachePct(view, bucket) {
  return bucket.in ? view.ui.pct((bucket.cache / bucket.in) * 100) : "—";
}

function costText(view, bucket) {
  return bucket.cost ? view.ui.usd(bucket.cost) : "—";
}

function tipOf(view, bucket) {
  return [
    ["Tokens", NF.format(bucket.tokens)],
    ["Cache share", cachePct(view, bucket)],
    ["Est. cost", costText(view, bucket)],
  ];
}

function renderRankings(view) {
  const { provMeta } = view.ui;
  const { byProv, byProj, byThread } = view.agg;
  const tip = (bucket) => tipOf(view, bucket);
  view.provRows = rank(
    byProv,
    6,
    (key) => provMeta(key)[0],
    (key) => cssVar(provMeta(key)[1]),
    (bucket) => `${cachePct(view, bucket)} cached`,
    tip,
  );
  view.projRows = rank(
    byProj,
    8,
    (key) => key,
    () => cssVar("--c-used"),
    (bucket) => costText(view, bucket),
    tip,
  );
  view.threadRows = rank(
    byThread,
    10,
    (key) => view.cur.titles?.[key] || "Thread",
    (key, bucket) => cssVar(provMeta(bucket.provider)[1]),
    (bucket) => costText(view, bucket),
    tip,
  );
  // "Other" never applies to threads: show only the top 10.
  if (byThread.size > 10) view.threadRows.pop();
}

// ---------- spend: summary + charts ----------
function renderSummaryPanel(view) {
  const { el: element, kpi, fmt, usd, pct } = view.ui;
  const { tokens, inp, cache, cost, costKnown, perReq } = view.agg;
  const kpiRow = element("div", "kpis");
  kpiRow.append(
    kpi("Total tokens", fmt(tokens), `${fmt(inp)} in · ${fmt(tokens - inp)} out`, true),
    kpi(
      "Est. API cost",
      costKnown ? usd(cost) : "—",
      costKnown ? "Pay-as-you-go equivalent" : "No priced turns",
    ),
    kpi("Cache share", inp ? pct((cache / inp) * 100) : "—", "Of input read from cache"),
    kpi("Input per request", perReq.length ? fmt(median(perReq)) : "—", "Median, estimate"),
  );
  view.spend.append(kpiRow);
}

function chartPanel(view, title, sub, rows, startEllipsis = false) {
  const { el: element, panel, hbars, fmt } = view.ui;
  const panelEl = panel(title, sub);
  const box = hbars(rows, fmt);
  // Paths differ at the end: clip the start so the folder name stays visible. Full text stays in title and the table.
  if (startEllipsis)
    box.querySelectorAll(".hb .n").forEach((labelEl) => {
      labelEl.classList.add("tk-clip-start");
      labelEl.replaceChildren(element("span", "", labelEl.title));
    });
  panelEl.append(tipRows(view, box, rows));
  panelEl.append(
    asTable(
      view,
      ["Name", "Tokens", "Cache share", "Est. cost"],
      rows.map((point) => [point.name, NF.format(point.value), point.tip[1][1], point.tip[2][1]]),
    ),
  );
  return panelEl;
}

function modelPanel(view) {
  const { el: element, panel, fmt, usd, pct } = view.ui;
  const panelEl = panel("By model", "Input includes cache reads and writes");
  const rows = [...view.agg.byModel]
    .filter(([, usage]) => usage.in || usage.out)
    .sort((left, right) => right[1].in + right[1].out - left[1].in - left[1].out);
  if (!rows.length) {
    panelEl.append(empty(view, "No model detail in this range."));
    return panelEl;
  }
  const table = element("div", "mtab tk-mtab");
  table.append(
    ...["Model", "In", "Cache %", "Out", "Cost"].map((header) => element("div", "h", header)),
  );
  for (const [name, usage] of rows) {
    const nameEl = element("div", "n", name);
    nameEl.title = name;
    table.append(
      nameEl,
      element("div", "", fmt(usage.in)),
      element("div", "", usage.in ? pct((usage.cacheRead / usage.in) * 100) : "—"),
      element("div", "", fmt(usage.out)),
      element("div", "", usage.known ? usd(usage.cost) : "—"),
    );
  }
  panelEl.append(table);
  return panelEl;
}

function toolPanel(view) {
  const { el: element, panel, fmt } = view.ui;
  const panelEl = panel("Tools", "Input carried per call, median");
  const toolRows = [...view.agg.byTool]
    .sort((left, right) => right[1].calls - left[1].calls)
    .slice(0, 12);
  if (!toolRows.length) {
    panelEl.append(empty(view, "No tool calls in this range."));
    return panelEl;
  }
  const table = element("div", "mtab tk-tools");
  table.append(
    ...["Tool", "Calls", "Median input/call"].map((header) => element("div", "h", header)),
  );
  for (const [name, usage] of toolRows) {
    const nameEl = element("div", "n", name);
    nameEl.title = name;
    table.append(
      nameEl,
      element("div", "", NF.format(usage.calls)),
      element("div", "", fmt(median(usage.samples))),
    );
  }
  panelEl.append(table);
  return panelEl;
}

function renderCharts(view) {
  const { el: element } = view.ui;
  const gridTop = element("div", "grid2");
  gridTop.append(
    chartPanel(view, "By provider", "Tokens in plus out", view.provRows),
    modelPanel(view),
  );
  const gridBottom = element("div", "grid2");
  gridBottom.append(
    chartPanel(view, "By project", "Working folder of each thread", view.projRows, true),
    chartPanel(view, "Top threads", "Largest 10 by tokens", view.threadRows),
  );
  view.spend.append(gridTop, gridBottom, toolPanel(view));
}

function renderSpend(view) {
  const turns = view.cur?.turns || [];
  const spend = section(view, "Spend", "Selected range, from recorded turns");
  view.spend = spend;
  view.wrap.append(spend);
  if (!turns.length) {
    const panelEl = view.ui.el("div", "panel");
    panelEl.append(empty(view, "No turns in this range. Try 30 days."));
    spend.append(panelEl);
    return;
  }
  view.agg = aggregateTurns(turns, view.cur);
  renderSummaryPanel(view);
  renderRankings(view);
  renderCharts(view);
}

// ---------- overhead ----------
function renderOverheadSkeleton(view, overheadEl) {
  const { el: element } = view.ui;
  overheadEl.setAttribute("aria-busy", "true");
  const skeleton = element("div", "tk-skel");
  skeleton.setAttribute("role", "status");
  skeleton.setAttribute("aria-label", "Measuring instruction files");
  for (let index = 0; index < 3; index++) skeleton.append(element("div", "tk-skel-b"));
  overheadEl.append(skeleton);
}

function renderOverheadError(view, overheadEl) {
  const { el: element } = view.ui;
  const { overhead } = view;
  const errorBox = element("div", "tk-err");
  errorBox.setAttribute("role", "alert");
  errorBox.append(
    element(
      "p",
      "",
      `Could not measure prompt overhead${overhead?.error ? `: ${String(overhead.error).replace(/[.\s]+$/, "")}` : ""}. Spend above is unaffected.`,
    ),
  );
  const retryBtn = element("button", "btn sm", "Retry");
  retryBtn.type = "button";
  retryBtn.addEventListener("click", () => {
    retryBtn.disabled = true;
    view.ui.retryOverhead?.();
  });
  errorBox.append(retryBtn);
  overheadEl.append(errorBox);
}

function kindsOf(provs) {
  const kinds = [];
  for (const prov of provs)
    for (const source of prov.sources)
      if (source.bytes > 0 && !kinds.includes(source.kind)) kinds.push(source.kind);
  kinds.sort((left, right) => Object.keys(KINDS).indexOf(left) - Object.keys(KINDS).indexOf(right));
  return kinds;
}

function bytesByKind(prov) {
  const byKind = new Map();
  for (const source of prov.sources)
    if (source.bytes > 0) byKind.set(source.kind, (byKind.get(source.kind) || 0) + source.bytes);
  return byKind;
}

function stackSegment(view, prov, kind, bytes, share) {
  const { el: element, showTip, fmt } = view.ui;
  const seg = element("i");
  seg.style.flex = `${bytes} 1 0`;
  seg.style.background = cssVar(kindMeta(kind)[1]);
  seg.tabIndex = 0;
  seg.setAttribute(
    "aria-label",
    `${prov.label} ${kindMeta(kind)[0]}: ${bytesFmt(bytes)}, ${share}`,
  );
  bindTip(view, seg, (event) =>
    showTip(event, `${prov.label} · ${kindMeta(kind)[0]}`, [
      ["Bytes", bytesFmt(bytes), cssVar(kindMeta(kind)[1])],
      ["~Tokens", fmt(bytes / 4)],
      ["Share", share],
    ]),
  );
  return seg;
}

function stackRow(view, prov, kinds, tableRows) {
  const { el: element, fmt, pct } = view.ui;
  const row = element("div", "tk-stack");
  row.append(element("div", "tk-stack-n", prov.label));
  const barEl = element("div", "tk-bar");
  barEl.setAttribute("role", "img");
  const byKind = bytesByKind(prov);
  const total = [...byKind.values()].reduce((sum, bytes) => sum + bytes, 0) || 1;
  const parts = [];
  for (const kind of kinds) {
    const bytes = byKind.get(kind);
    if (!bytes) continue;
    const share = pct((bytes / total) * 100);
    barEl.append(stackSegment(view, prov, kind, bytes, share));
    parts.push(`${kindMeta(kind)[0]} ${share}`);
    tableRows.push([prov.label, kindMeta(kind)[0], bytesFmt(bytes), fmt(bytes / 4), share]);
  }
  barEl.setAttribute("aria-label", `${prov.label}: ${parts.join(", ")}`);
  row.append(barEl, element("div", "tk-stack-x", `~${fmt(prov.tokensEst)}`));
  return row;
}

function renderStackPanel(view, overheadEl, provs) {
  const { el: element, panel, legend } = view.ui;
  const kinds = kindsOf(provs);
  const barPanel = panel("Share by source type", "Each bar is one provider's total");
  const stack = element("div", "tk-stacks");
  const tableRows = [];
  for (const prov of provs) stack.append(stackRow(view, prov, kinds, tableRows));
  barPanel.append(
    stack,
    legend(kinds.map((kind) => [kindMeta(kind)[0], cssVar(kindMeta(kind)[1])])),
    asTable(view, ["Provider", "Type", "Bytes", "~Tokens", "Share"], tableRows),
  );
  overheadEl.append(barPanel);
}

function cell(view, cls, text) {
  const { el: element } = view.ui;
  const cellEl = text === undefined ? element("div", cls) : element("div", cls, text);
  cellEl.setAttribute("role", "cell");
  return cellEl;
}

function sourceHead(view) {
  const { el: element } = view.ui;
  const head = element("div", "tk-r tk-rh");
  head.setAttribute("role", "row");
  for (const [label, cls] of [
    ["Source", "s"],
    ["Path", "p"],
    ["Bytes", "b"],
    ["~Tokens", "t"],
    ["Flags", "f"],
  ]) {
    const headCell = element("div", cls, label);
    headCell.setAttribute("role", "columnheader");
    head.append(headCell);
  }
  return head;
}

function itemsDetails(view, source) {
  const { el: element } = view.ui;
  const details = element("details", "tk-items");
  details.append(element("summary", "", `Top items (${source.items.length})`));
  const listEl = element("ul");
  for (const item of source.items) {
    const itemEl = element("li");
    itemEl.append(element("span", "", item.name), element("span", "tk-num", bytesFmt(item.bytes)));
    listEl.append(itemEl);
  }
  details.append(listEl);
  return details;
}

function sourceNameCell(view, source) {
  const { el: element } = view.ui;
  const name = cell(view, "s");
  name.append(element("span", "", source.label));
  if (source.count != null) name.append(element("span", "tk-count", ` ${NF.format(source.count)}`));
  if (source.items?.length) name.append(itemsDetails(view, source));
  return name;
}

function sourceFlagsCell(view, source, labels) {
  const { el: element } = view.ui;
  const flagsEl = cell(view, "f");
  const flag = (text, tone) =>
    flagsEl.append(element("span", `tk-flag${tone ? ` ${tone}` : ""}`, text));
  if (source.missing) flag("Missing");
  if (source.dupOf) flag(`Same as ${labels.get(source.dupOf) || source.dupOf}`, "warn");
  if (source.dupSections?.length) {
    const count = source.dupSections.length;
    flag(`${count} duplicate ${count === 1 ? "section" : "sections"}`, "warn");
  }
  if (source.hidden) flag(`${NF.format(source.hidden)} hidden`);
  if (!flagsEl.childNodes.length) flagsEl.append(element("span", "tk-none", "—"));
  return flagsEl;
}

function sourceRow(view, source, labels) {
  const { el: element, fmt } = view.ui;
  const rowEl = element("div", "tk-r");
  rowEl.setAttribute("role", "row");
  const name = sourceNameCell(view, source);
  const path = cell(view, "p", homeRel(source.path) || "—");
  if (source.path) path.title = source.path;
  const bytesEl = cell(view, "b", source.missing ? "—" : bytesFmt(source.bytes));
  const tokensEl = cell(view, "t", source.missing ? "—" : `~${fmt(source.tokensEst)}`);
  rowEl.append(name, path, bytesEl, tokensEl, sourceFlagsCell(view, source, labels));
  return rowEl;
}

function renderSourcesPanel(view, overheadEl, provs) {
  const { el: element, panel } = view.ui;
  const sourcesPanel = panel("Sources", "Largest first");
  for (const prov of provs) {
    const heading = element("h3", "tk-ph", prov.label);
    const list = element("div", "tk-src");
    list.setAttribute("role", "table");
    list.setAttribute("aria-label", `${prov.label} sources`);
    list.append(sourceHead(view));
    const labels = new Map(prov.sources.map((source) => [source.id, source.label]));
    for (const source of [...prov.sources].sort((left, right) => right.bytes - left.bytes))
      list.append(sourceRow(view, source, labels));
    sourcesPanel.append(heading, list);
  }
  overheadEl.append(sourcesPanel);
}

function dupItem(view, dup) {
  const { el: element } = view.ui;
  const providers = view.overhead.providers;
  const labelOf = (prov, itemId) =>
    providers?.find((prov) => prov.id === prov)?.sources.find((source) => source.id === itemId)
      ?.label || itemId;
  const provLabel = (itemId) => providers?.find((prov) => prov.id === itemId)?.label || itemId;
  const itemEl = element("li");
  const top = element("div", "tk-dup-h");
  const badge = element("span", "tk-flag warn");
  badge.innerHTML = WARN_ICON;
  badge.append("Duplicate");
  top.append(badge, element("strong", "", dup.heading || "(untitled)"));
  itemEl.append(
    top,
    element(
      "div",
      "muted tk-dup-d",
      `${provLabel(dup.provider)} · ${bytesFmt(dup.bytes)} · in ${dup.sources.map((source) => labelOf(dup.provider, source)).join(", ")}`,
    ),
  );
  return itemEl;
}

function renderDuplicatesPanel(view, overheadEl) {
  const { el: element, panel } = view.ui;
  const dups = view.overhead.duplicates || [];
  const dupPanel = panel(
    "Duplicates",
    "Sections that appear in more than one file of the same provider",
  );
  if (!dups.length) dupPanel.append(empty(view, "No duplicated sections found."));
  else {
    const listEl = element("ul", "tk-dups");
    for (const dup of dups) listEl.append(dupItem(view, dup));
    dupPanel.append(listEl);
  }
  overheadEl.append(dupPanel);
}

function skippedNote(view, skipped) {
  const reasons = {};
  for (const skip of skipped) reasons[skip.reason] = (reasons[skip.reason] || 0) + 1;
  const list = Object.entries(reasons)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
  return view.ui.el(
    "p",
    "note",
    `Skipped ${skipped.length} ${skipped.length === 1 ? "file" : "files"}: ${list}.`,
  );
}

function renderOverheadBody(view, overheadEl) {
  const { el: element, kpi, fmt } = view.ui;
  const { overhead } = view;
  const provs = (overhead.providers || []).filter((prov) =>
    prov.sources?.some((source) => !source.missing),
  );
  if (!provs.length) {
    const prov = element("div", "panel");
    prov.append(empty(view, "No instruction files found"));
    overheadEl.append(prov);
    return;
  }
  const kpiRow = element("div", "kpis");
  for (const prov of provs)
    kpiRow.append(
      kpi(
        prov.label,
        `~${fmt(prov.tokensEst)}`,
        `${bytesFmt(prov.totalBytes)} before the first prompt`,
      ),
    );
  overheadEl.append(kpiRow);
  renderStackPanel(view, overheadEl, provs);
  renderSourcesPanel(view, overheadEl, provs);
  renderDuplicatesPanel(view, overheadEl);
  if (overhead.skipped?.length) overheadEl.append(skippedNote(view, overhead.skipped));
}

function renderOverheadPanel(view) {
  const { el: element } = view.ui;
  const { overhead } = view;
  const overheadEl = section(view, "Prompt overhead", "Measured now, not range-scoped");
  overheadEl.classList.add("tk-oh");
  view.wrap.append(overheadEl);
  const note = element(
    "p",
    "note",
    "Measured from files; harness built-ins not included, so totals are a lower bound. Tokens are bytes divided by 4.",
  );
  if (overhead?.loading) renderOverheadSkeleton(view, overheadEl);
  else if (!overhead || overhead.error) renderOverheadError(view, overheadEl);
  else renderOverheadBody(view, overheadEl);
  overheadEl.append(note);
}

export function renderTokens(root, cur, overhead, ui) {
  const hideTip =
    ui.hideTip ||
    (() => {
      const tipEl = document.getElementById("tip");
      if (tipEl) tipEl.hidden = true;
    });
  const view = { ui, hideTip, cur, overhead, wrap: ui.el("div", "tk") };
  renderSpend(view);
  renderOverheadPanel(view);
  root.replaceChildren(view.wrap);
}
