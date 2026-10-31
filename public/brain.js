// Brain graph screen: searchable list of wiki/ops pages and tags, plus a Cytoscape graph loaded only when the Graph view opens.
// Hash routes: "" nothing open, "#/page/<slug>" page sheet, "#/tag/<name>" tag sheet. Everything comes from /api/brain/*.

import { createMenu } from "./menu.js";
import { $, el, renderMarkdown } from "./render.js";

const PHONE = matchMedia("(max-width: 700px)");
const store = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // private mode: the choice just is not remembered
    }
  },
};
const state = {
  pages: [],
  tags: [],
  edges: [],
  pageMap: new Map(),
  tagMap: new Map(),
  query: "",
  hits: new Map(), // slug -> server BM25 hit, valid for hitsQuery
  hitsQuery: "",
  picked: new Set(),
  view: store.get("brain.view") || (PHONE.matches ? "list" : "graph"),
  tab: "pages",
  links: false,
};
let net = null;
let cytoscapeLib = null;
let sheetSeq = 0;

async function api(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}
const byUpdated = (a, b) =>
  (b.updated || "").localeCompare(a.updated || "") || a.slug.localeCompare(b.slug);
const words = (text) => text.toLowerCase().split(/\s+/).filter(Boolean);
const setStatus = (text) => {
  $("status").textContent = text;
  $("status").hidden = !text;
};

// ---------- data + filtering ----------
function indexGraph(data) {
  state.pages = data.pages;
  state.tags = data.tags;
  state.edges = data.edges;
  state.pageMap = new Map(data.pages.map((p) => [p.slug, p]));
  state.tagMap = new Map(data.tags.map((t) => [t.name, t]));
}
function textMatches(hay, terms) {
  const low = hay.toLowerCase();
  return terms.every((t) => low.includes(t));
}
function pageHay(p) {
  return [p.slug, p.description, p.type, ...(p.tags || [])].join(" ");
}
function visiblePages() {
  const terms = words(state.query);
  const picked = [...state.picked];
  const out = state.pages.filter((p) => {
    if (!picked.every((t) => (p.tags || []).includes(t))) return false;
    return !terms.length || textMatches(pageHay(p), terms) || state.hits.has(p.slug);
  });
  if (!state.hits.size) return out.sort(byUpdated);
  const score = (p) => state.hits.get(p.slug)?.score ?? -1;
  return out.sort((a, b) => score(b) - score(a) || byUpdated(a, b));
}
function visibleTags(pages) {
  const terms = words(state.query);
  const used = new Set(pages.flatMap((p) => p.tags || []));
  const named = (t) => textMatches([t.name, t.description, ...(t.aliases || [])].join(" "), terms);
  const filtering = terms.length || state.picked.size;
  return state.tags
    .filter((t) => !filtering || used.has(t.name) || (terms.length && named(t)))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---------- list view ----------
function tagChips(names) {
  const box = el("span", "tags");
  for (const tagName of names || []) box.append(el("span", "tag", tagName));
  return box;
}
function pageRow(p) {
  const link = el("a", "row");
  link.href = `#/page/${p.slug}`;
  const text = el("span", "txt");
  const name = el("span", "n");
  name.append(el("i", `layer ${p.layer}`), p.slug);
  text.append(name);
  if (p.description) text.append(el("span", "l wrap", p.description));
  const hit = state.hits.get(p.slug);
  if (hit?.snippet) text.append(el("span", "snip", hit.snippet));
  text.append(
    tagChips(p.tags),
    el("span", "meta", `${p.layer} · ${p.type || "page"} · ${p.updated || "undated"}`),
  );
  link.append(text);
  const item = el("li");
  item.append(link);
  return item;
}
function tagRow(t) {
  const link = el("a", "row");
  link.href = `#/tag/${encodeURIComponent(t.name)}`;
  const text = el("span", "txt");
  text.append(el("span", "n", t.name), el("span", "l wrap", t.description || ""));
  text.append(el("span", "meta", `${t.count} ${t.count === 1 ? "page" : "pages"}`));
  link.append(text);
  const item = el("li");
  item.append(link);
  return item;
}

// ---------- tag filter menu ----------
function renderTagFilter() {
  $("tagFilterLabel").textContent = state.picked.size ? `Tags · ${state.picked.size}` : "All tags";
}
function tagFilterItems() {
  return [
    { value: null, label: "Clear tags", keep: true, disabled: !state.picked.size },
    ...[...state.tags]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .map((tag) => ({
        value: tag.name,
        label: `${tag.name} · ${tag.count}`,
        keep: true,
        checked: state.picked.has(tag.name),
      })),
  ];
}
createMenu({
  trigger: $("tagFilter"),
  label: "Filter by tags",
  header: "Pages must match every selected tag",
  getItems: tagFilterItems,
  renderTrigger: renderTagFilter,
  onOpen() {
    document
      .getElementById($("tagFilter").getAttribute("aria-controls"))
      ?.setAttribute("aria-multiselectable", "true");
  },
  onSelect(name) {
    if (name !== null) return togglePick(name);
    state.picked.clear();
    renderTagFilter();
    render();
    if (!$("sheet").hidden) route();
  },
});
function togglePick(name) {
  if (!state.picked.delete(name)) state.picked.add(name);
  renderTagFilter();
  render();
  if (!$("sheet").hidden) route();
}

// ---------- render ----------
function render() {
  const pages = visiblePages();
  const tags = visibleTags(pages);
  const showTags = state.tab === "tags";
  $("pageList").hidden = showTags;
  $("tagList").hidden = !showTags;
  $("pageList").replaceChildren(...pages.map(pageRow));
  $("tagList").replaceChildren(...tags.map(tagRow));
  $("count").textContent = `${pages.length} of ${state.pages.length} pages`;
  $("tabPages").setAttribute("aria-pressed", String(!showTags));
  $("tabTags").setAttribute("aria-pressed", String(showTags));
  const empty = !pages.length && !tags.length;
  setStatus(empty ? "Nothing matches. Clear the search or tag filters." : "");
  if (state.view === "graph") drawGraph(pages, tags);
}
function setView(view) {
  state.view = view;
  store.set("brain.view", view);
  const graph = view === "graph";
  $("viewList").setAttribute("aria-pressed", String(!graph));
  $("viewGraph").setAttribute("aria-pressed", String(graph));
  $("listView").hidden = graph;
  $("graphView").hidden = !graph;
  $("listTabs").hidden = graph;
  render();
}

// ---------- graph view ----------
const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
// Glow is a translucent underlay in the node color; the light palette sets --graph-glow to 0.
function symbolColor(token) {
  const color = css(token);
  const glow = Number(css("--graph-glow")) || 0;
  if (!glow) return { "background-color": color };
  return {
    "background-color": color,
    "underlay-color": color,
    "underlay-padding": glow,
    "underlay-opacity": 0.28,
    "underlay-shape": "ellipse",
  };
}
function nodeStyles(canvas) {
  const ring = { "border-width": 2, "border-color": canvas };
  return [
    {
      selector: "node",
      style: {
        "font-family": css("--font-ui") || "sans-serif",
        color: css("--graph-text"),
        "min-zoomed-font-size": 11,
        label: "data(label)",
        width: 24,
        height: 24,
        ...ring,
        "font-size": 12,
        "font-weight": 500,
        "text-halign": "right",
        "text-valign": "center",
        "text-margin-x": 6,
        "text-wrap": "ellipsis",
        "text-max-width": 110,
        "text-outline-color": canvas,
        "text-outline-width": 3,
        "text-outline-opacity": 1,
      },
    },
    {
      // Page labels wait for closer zoom so tag hubs stay readable in the overview.
      selector: "node[kind='page']",
      style: { shape: "ellipse", ...symbolColor("--wiki"), "min-zoomed-font-size": 16 },
    },
    {
      selector: "node[kind='page'][layer='ops']",
      style: { shape: "diamond", ...symbolColor("--ops") },
    },
    {
      selector: "node[kind='tag']",
      style: { shape: "round-rectangle", ...symbolColor("--tag") },
    },
  ];
}
function graphStyle() {
  const canvas = css("--graph-bg");
  const muted = css("--graph-edge");
  const edgeOpacity = Number(css("--graph-edge-opacity")) || 0.4;
  return [
    ...nodeStyles(canvas),
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": muted,
        "curve-style": "haystack",
        opacity: edgeOpacity,
      },
    },
    {
      selector: "edge[kind='link']",
      style: {
        "line-style": "dashed",
        "curve-style": "bezier",
        "control-point-step-size": 20,
        "target-arrow-shape": "triangle",
        "target-arrow-color": muted,
        "arrow-scale": 0.7,
        opacity: 0.55,
      },
    },
    { selector: "node.neighbor, node.picked", style: { "min-zoomed-font-size": 0 } },
    { selector: "edge.neighbor", style: { opacity: 0.9, width: 2 } },
    { selector: ".faded", style: { opacity: 0.15 } },
    { selector: "node.picked", style: { "border-width": 3, "border-color": css("--accent") } },
  ];
}
function graphElements(pages, tags) {
  const usedTags = new Set(pages.flatMap((p) => p.tags || []));
  const nodes = [
    ...pages.map((p) => ({
      data: { id: `page:${p.slug}`, kind: "page", layer: p.layer, label: p.slug },
    })),
    ...tags
      .filter((t) => usedTags.has(t.name))
      .map((t) => ({
        data: {
          id: `tag:${t.name}`,
          kind: "tag",
          label: t.name,
        },
      })),
  ];
  const ids = new Set(nodes.map((n) => n.data.id));
  const edges = state.edges
    .filter((e) => (e.kind === "tag" || state.links) && ids.has(e.source) && ids.has(e.target))
    .map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, kind: e.kind } }));
  return { elements: [...nodes, ...edges] };
}
async function ensureCytoscape() {
  cytoscapeLib ||= import("./vendor/cytoscape.esm.min.mjs").then((m) => m.default);
  return cytoscapeLib;
}
function openNode(node) {
  const [kind, ...rest] = node.id().split(":");
  const nodeName = rest.join(":");
  location.hash = kind === "tag" ? `#/tag/${encodeURIComponent(nodeName)}` : `#/page/${nodeName}`;
}
async function makeGraph() {
  const cytoscape = await ensureCytoscape();
  net = cytoscape({
    container: $("cy"),
    elements: [],
    style: graphStyle(),
    wheelSensitivity: 0.3,
    minZoom: 0.15,
    maxZoom: 3,
  });
  $("cy").__cy = net; // handle for the browser test, which taps nodes at their rendered positions
  net.on("tap", "node", (e) => openNode(e.target));
  net.on("tap", (e) => {
    if (e.target !== net) return;
    closeSheet();
    collapseLegend();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
    net?.style(graphStyle()),
  );
}
let drawSeq = 0;
async function drawGraph(pages, tags) {
  const seq = ++drawSeq;
  try {
    if (!net) await makeGraph();
  } catch {
    setStatus("The graph library could not load. Use the list view.");
    return;
  }
  if (seq !== drawSeq || state.view !== "graph") return;
  const { elements } = graphElements(pages, tags);
  net.batch(() => {
    net.elements().remove();
    net.add(elements);
  });
  net.resize();
  const narrow = net.width() < 600;
  const layout = net.layout({
    name: "cose",
    animate: false,
    fit: false,
    randomize: true,
    nodeRepulsion: () => (narrow ? 6000 : 40000),
    idealEdgeLength: () => (narrow ? 40 : 110),
    numIter: 800,
  });
  layout.run();
  fitGraph();
  $("cy").dataset.nodes = String(net.nodes().length);
  $("cy").dataset.edges = String(net.edges().length);
  highlightNode();
}
function highlightNode() {
  if (!net) return;
  net.elements().removeClass("faded picked neighbor");
  const nodeId = currentNodeId();
  const node = nodeId && net.getElementById(nodeId);
  if (!node || node.empty()) return;
  net.elements().not(node.closedNeighborhood()).addClass("faded");
  node.closedNeighborhood().addClass("neighbor");
  node.addClass("picked");
}

// ---------- detail sheet ----------
function currentNodeId() {
  const found = /^#\/(page|tag)\/(.+)$/.exec(location.hash);
  return found ? `${found[1]}:${decodeURIComponent(found[2])}` : "";
}
function closeSheet() {
  if (location.hash) history.pushState(null, "", location.pathname + location.search);
  route();
}
function showSheet(title) {
  $("sheetTitle").textContent = title;
  $("sheet").hidden = false;
  $("scrim").hidden = false;
}
function chipLinks(names) {
  const box = el("div", "chips");
  for (const tagName of names || []) {
    const link = el("a", "chip", tagName);
    link.href = `#/tag/${encodeURIComponent(tagName)}`;
    box.append(link);
  }
  return box;
}
function section(title, ...nodes) {
  const box = el("section");
  box.append(el("h3", "", title), ...nodes);
  return box;
}
function pageList(pages, note) {
  const list = el("ul", "group");
  list.append(...pages.map((p) => withNote(pageRow(p), note?.(p))));
  return list;
}
function withNote(li, note) {
  if (note) li.querySelector(".txt").append(el("span", "meta", note));
  return li;
}
function relatedPages(page) {
  const mine = new Set(page.tags || []);
  return state.pages
    .filter((o) => o.slug !== page.slug)
    .map((o) => ({ page: o, shared: (o.tags || []).filter((t) => mine.has(t)) }))
    .filter((r) => r.shared.length)
    .sort((a, b) => b.shared.length - a.shared.length || byUpdated(a.page, b.page))
    .slice(0, 10);
}
function wikiLinks(markdown) {
  return markdown.replace(/\[\[([a-z0-9][a-z0-9-]*)(?:\|[^\]]*)?\]\]/g, (whole, slug) =>
    state.pageMap.has(slug) ? `[${slug}](#/page/${slug})` : whole,
  );
}
async function openPage(slug) {
  const page = state.pageMap.get(slug);
  const seq = ++sheetSeq;
  showSheet(slug);
  const body = $("sheetBody");
  const doc = el("article", "prose", "Loading…");
  const meta = el("p", "muted");
  meta.append(
    el("i", `layer ${page?.layer || "wiki"}`),
    `${page?.layer || ""} · ${page?.type || "page"} · ${page?.updated || "undated"}`,
  );
  body.replaceChildren(meta);
  if (page?.description) body.append(el("p", "", page.description));
  if (page?.tags?.length) body.append(chipLinks(page.tags));
  const related = page ? relatedPages(page) : [];
  if (related.length) {
    const byPage = new Map(related.map((r) => [r.page.slug, r.shared]));
    body.append(
      section(
        "Related via tags",
        pageList(
          related.map((r) => r.page),
          (p) => `shares ${byPage.get(p.slug).join(", ")}`,
        ),
      ),
    );
  }
  body.append(doc);
  try {
    const data = await api(`/api/brain/page/${encodeURIComponent(slug)}`);
    if (seq === sheetSeq) renderMarkdown(wikiLinks(data.markdown), doc);
  } catch (failure) {
    if (seq === sheetSeq) doc.textContent = failure.message;
  }
}
function openTag(name) {
  const tag = state.tagMap.get(name);
  sheetSeq++;
  showSheet(name);
  const members = state.pages.filter((p) => (p.tags || []).includes(name)).sort(byUpdated);
  const body = $("sheetBody");
  body.replaceChildren(el("p", "", tag?.description || "No description."));
  if (tag?.aliases?.length)
    body.append(el("p", "muted", `Also known as ${tag.aliases.join(", ")}`));
  const pick = el(
    "button",
    "chip",
    state.picked.has(name) ? "Remove from filter" : "Filter by this tag",
  );
  pick.type = "button";
  pick.onclick = () => togglePick(name);
  body.append(pick, section(`Pages (${members.length})`, pageList(members)));
}
function route() {
  const found = /^#\/(page|tag)\/(.+)$/.exec(location.hash);
  const open = !!found && state.pages.length > 0;
  $("sheet").hidden = !open;
  $("scrim").hidden = !open;
  if (open && found[1] === "page") openPage(decodeURIComponent(found[2]));
  else if (open) openTag(decodeURIComponent(found[2]));
  highlightNode();
}

// ---------- search ----------
async function serverSearch() {
  const term = state.query.trim();
  if (!term) return;
  try {
    const hits = await api(`/api/brain/search?q=${encodeURIComponent(term)}`);
    if (term !== state.query.trim()) return;
    state.hits = new Map(hits.filter((h) => state.pageMap.has(h.slug)).map((h) => [h.slug, h]));
    state.hitsQuery = term;
    render();
  } catch (failure) {
    setStatus(failure.message);
  }
}
$("q").addEventListener("input", (e) => {
  state.query = e.target.value;
  if (state.query.trim() !== state.hitsQuery) state.hits = new Map();
  render();
});
$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  serverSearch();
});
$("viewList").onclick = () => setView("list");
$("viewGraph").onclick = () => setView("graph");
$("tabPages").onclick = () => {
  state.tab = "pages";
  render();
};
$("tabTags").onclick = () => {
  state.tab = "tags";
  render();
};
$("linksToggle").onclick = () => {
  state.links = !state.links;
  $("linksToggle").setAttribute("aria-pressed", String(state.links));
  render();
};
const LEGEND_PHONE = matchMedia("(max-width: 599px)");
function setLegend(open) {
  $("legendToggle").setAttribute("aria-expanded", String(open));
  $("legendBody").hidden = !open;
}
setLegend(!LEGEND_PHONE.matches);
LEGEND_PHONE.addEventListener("change", () => setLegend(!LEGEND_PHONE.matches));
// On phones the open legend covers the graph, so Escape and taps outside it close it.
function collapseLegend() {
  if (LEGEND_PHONE.matches) setLegend(false);
}
addEventListener("keydown", (e) => e.key === "Escape" && collapseLegend());
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".graph-legend-card")) collapseLegend();
});
$("legendToggle").onclick = () => {
  if (LEGEND_PHONE.matches) setLegend($("legendToggle").getAttribute("aria-expanded") !== "true");
};
function zoomGraph(factor) {
  if (!net) return;
  net.zoom({
    level: Math.max(net.minZoom(), Math.min(net.maxZoom(), net.zoom() * factor)),
    renderedPosition: { x: net.width() / 2, y: net.height() / 2 },
  });
}
$("zoomIn").onclick = () => zoomGraph(1.25);
$("zoomOut").onclick = () => zoomGraph(0.8);
// Fit into the canvas area left clear by the floating toolbar and a collapsed legend.
function fitGraph() {
  if (!net || net.elements().empty()) return;
  const pad = net.width() < 600 ? 12 : 24;
  const canvas = $("cy").getBoundingClientRect();
  const top = Math.max(
    pad,
    document.querySelector(".graph-toolbar").getBoundingClientRect().bottom - canvas.top + 8,
  );
  const legend = document.querySelector(".graph-legend-card").getBoundingClientRect();
  const bottom = $("legendBody").hidden ? Math.max(pad, canvas.bottom - legend.top + 8) : pad;
  const box = net.elements().boundingBox();
  const width = net.width() - 2 * pad;
  const height = net.height() - top - bottom;
  const level = Math.max(net.minZoom(), Math.min(net.maxZoom(), width / box.w, height / box.h));
  net.viewport({
    zoom: level,
    pan: {
      x: pad + (width - box.w * level) / 2 - box.x1 * level,
      y: top + (height - box.h * level) / 2 - box.y1 * level,
    },
  });
}
$("fitGraph").onclick = fitGraph;
$("sheetClose").onclick = closeSheet;
$("scrim").onclick = closeSheet;
addEventListener("keydown", (e) => e.key === "Escape" && !$("sheet").hidden && closeSheet());
addEventListener("hashchange", route);

(async () => {
  try {
    const data = await api("/api/brain/graph");
    indexGraph(data);
    $("stamp").textContent =
      `${data.pages.length} pages, ${data.tags.length} tags · generated ${new Date(data.generatedAt).toLocaleString()}`;
    renderTagFilter();
    setView(state.view);
    route();
  } catch (failure) {
    setStatus(failure.message);
  }
  $("bm").setAttribute("aria-busy", "false");
})();
