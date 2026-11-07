// Thread graph screen (#421): which threads relate to which, from /api/thread-graph. Desktop opens the Cytoscape graph, a phone opens a
// cluster list (graph behind a toggle). Live: {t:"thread"} updates node data in place; {t:"graph_dirty"} fetches a delta and patches elements.

import { baseNodeStyle, css, ensureCytoscape, store, symbolColor } from "./graph-core.js";
import { $, el } from "./render.js";

const PHONE = matchMedia("(max-width: 700px)");
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
const WINDOWS = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3, all: 0 };
const POS_KEY = "tgraph.pos";
const KINDS = [
  { kind: "peer", label: "Messages", token: "--accent", style: "" },
  { kind: "fork", label: "Forks", token: "--viz-6", style: "dashed" },
  { kind: "file", label: "Shared files", token: "--viz-5", style: "dotted" },
  { kind: "brain", label: "Brain pages", token: "--viz-2", style: "" },
  { kind: "issue", label: "Issues and PRs", token: "--viz-4", style: "dashed" },
  { kind: "repo", label: "Same repo", token: "--t3", style: "dotted" },
  { kind: "schedule", label: "Same task", token: "--viz-3", style: "dotted" },
];
const saved = (() => {
  try {
    return JSON.parse(store.get("tgraph.filters") || "{}");
  } catch {
    return {};
  }
})();
const state = {
  nodes: new Map(),
  edges: new Map(),
  hubs: [],
  cursor: 0,
  dropped: { keys: 0, nodes: 0 },
  window: saved.window || "7d",
  provider: saved.provider || "",
  status: saved.status || "",
  archived: !!saved.archived,
  kinds: new Set(saved.kinds || KINDS.map((item) => item.kind)),
  view: store.get("tgraph.view") || (PHONE.matches ? "list" : "graph"),
  picked: "",
};
let net = null;
let loadSeq = 0;
let deltaTimer = 0;
let positions = {};
try {
  positions = JSON.parse(store.get(POS_KEY) || "{}");
} catch {
  positions = {};
}

const setStatus = (text) => {
  $("status").textContent = text;
  $("status").hidden = !text;
};
const edgeKey = (edge) => `${edge.kind}|${edge.a}|${edge.b}`;
const windowStart = () => (WINDOWS[state.window] ? Date.now() - WINDOWS[state.window] : 0);
const isHub = (id) => id.startsWith("hub:");
const hubLabel = (id) => id.split(":").slice(2).join(":").split("/").pop() || id;

async function api(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

// ---------- data ----------
function saveFilters() {
  store.set(
    "tgraph.filters",
    JSON.stringify({
      window: state.window,
      provider: state.provider,
      status: state.status,
      archived: state.archived,
      kinds: [...state.kinds],
    }),
  );
}
function mergeHubs(incoming) {
  const byName = new Map(state.hubs.map((hub) => [`${hub.kind}|${hub.key}`, hub]));
  for (const hub of incoming) byName.set(`${hub.kind}|${hub.key}`, hub);
  state.hubs = [...byName.values()];
}
function applyFull(data) {
  state.nodes = new Map(data.nodes.map((node) => [node.id, node]));
  state.edges = new Map(data.edges.map((edge) => [edgeKey(edge), edge]));
  state.hubs = data.hubs;
  state.cursor = data.cursor;
  state.dropped = data.dropped;
}
function applyDelta(data) {
  for (const node of data.nodes) state.nodes.set(node.id, node);
  for (const edge of data.edges) state.edges.set(edgeKey(edge), edge);
  mergeHubs(data.hubs);
  const start = windowStart();
  for (const [nodeId, node] of state.nodes)
    if (node.lastActivity < start) state.nodes.delete(nodeId);
  state.cursor = data.cursor;
  state.dropped = data.dropped;
}
async function load() {
  const seq = ++loadSeq;
  setStatus("Loading threads…");
  try {
    const data = await api(`/api/thread-graph?since=${windowStart()}`);
    if (seq !== loadSeq) return;
    applyFull(data);
    setStatus(data.syncing ? "Indexing sessions, links may be incomplete." : "");
    if (data.syncing) setTimeout(load, 4000);
  } catch (failure) {
    setStatus(failure.message);
  }
  $("bm").setAttribute("aria-busy", "false");
  render();
}
async function loadDelta() {
  try {
    applyDelta(await api(`/api/thread-graph?since=${state.cursor}`));
    render();
  } catch {
    // the next graph_dirty or a reload tries again
  }
}
function scheduleDelta() {
  clearTimeout(deltaTimer);
  deltaTimer = setTimeout(loadDelta, 500);
}

// ---------- filtering ----------
function nodePasses(node) {
  if (isHub(node.id)) return true;
  if (!state.archived && node.archived) return false;
  if (state.provider && node.provider !== state.provider) return false;
  const status = state.status;
  if (status === "waiting") return node.waiting;
  return !status || node.status === status;
}
function visible() {
  const nodes = new Map();
  for (const node of state.nodes.values()) if (nodePasses(node)) nodes.set(node.id, node);
  const edges = [...state.edges.values()].filter(
    (edge) =>
      state.kinds.has(edge.kind) && nodes.has(edge.a) && (nodes.has(edge.b) || isHub(edge.b)),
  );
  const hubIds = new Set(edges.filter((edge) => isHub(edge.b)).map((edge) => edge.b));
  for (const hubId of hubIds) nodes.set(hubId, { id: hubId, hub: true, title: hubLabel(hubId) });
  return { nodes, edges };
}

// ---------- cluster list ----------
function clusters(view) {
  const parent = new Map([...view.nodes.keys()].map((id) => [id, id]));
  const root = (id) => (parent.get(id) === id ? id : root(parent.get(id)));
  for (const edge of view.edges) parent.set(root(edge.a), root(edge.b));
  const groups = new Map();
  for (const node of view.nodes.values()) {
    const key = root(node.id);
    groups.set(key, [...(groups.get(key) || []), node]);
  }
  return [...groups.values()]
    .map((members) => members.filter((node) => !node.hub))
    .filter((members) => members.length)
    .sort((first, second) => second.length - first.length);
}
function clusterRow(node) {
  const link = el("a", "row");
  link.href = `/#thread=${encodeURIComponent(node.id)}`;
  const dot = el("i", `prov-dot ${node.provider}${node.status === "running" ? " running" : ""}`);
  const kinds = new Set();
  for (const edge of state.edges.values())
    if (edge.a === node.id || edge.b === node.id) kinds.add(edge.kind);
  const meta = [node.status, node.waiting ? "waiting" : "", ...kinds].filter(Boolean).join(" · ");
  const text = el("span", "txt");
  text.append(el("span", "l", node.title), el("span", "meta", meta));
  link.append(dot, text);
  return link;
}
function renderClusters(view) {
  const box = $("clusters");
  const list = clusters(view);
  const linked = list.filter((members) => members.length > 1);
  const alone = list.filter((members) => members.length === 1).flat();
  const sections = linked.map((members, index) => {
    const card = el("section", "cluster");
    card.append(el("h3", "", `Cluster ${index + 1} · ${members.length} threads`));
    const group = el("ul", "group");
    for (const node of members) {
      const item = el("li");
      item.append(clusterRow(node));
      group.append(item);
    }
    card.append(group);
    return card;
  });
  if (alone.length) {
    const card = el("section", "cluster");
    card.append(el("h3", "", `Not linked · ${alone.length} threads`));
    const group = el("ul", "group");
    for (const node of alone) {
      const item = el("li");
      item.append(clusterRow(node));
      group.append(item);
    }
    card.append(group);
    sections.push(card);
  }
  box.replaceChildren(...sections);
  box.dataset.clusters = String(linked.length);
}

// ---------- graph ----------
function nodeStyles(canvas) {
  const provider = (name) => ({
    selector: `node[provider='${name}']`,
    style: symbolColor(`--prov-${name}`),
  });
  return [
    baseNodeStyle(canvas),
    provider("claude"),
    provider("codex"),
    provider("pi"),
    {
      selector: "node[?hub]",
      style: { shape: "round-rectangle", "background-color": css("--t3") },
    },
    {
      selector: "node[status='running']",
      style: { "border-width": 3, "border-color": css("--accent") },
    },
    {
      selector: "node.pulse",
      style: {
        "border-width": 6,
        "transition-property": "border-width",
        "transition-duration": "800ms",
      },
    },
    {
      selector: "node[?waiting]",
      style: { "border-style": "double", "border-width": 4, "border-color": css("--warn") },
    },
    { selector: "node[?archived]", style: { opacity: 0.35 } },
    { selector: "node.picked", style: { "border-width": 4, "border-color": css("--accent") } },
  ];
}
function edgeStyles() {
  const faded = Number(css("--graph-edge-opacity")) || 0.4;
  const base = {
    selector: "edge",
    style: { width: 1.5, "curve-style": "bezier", opacity: Math.max(faded, 0.55) },
  };
  const perKind = KINDS.map((item) => ({
    selector: `edge[kind='${item.kind}']`,
    style: {
      "line-color": css(item.token),
      "line-style": item.style || "solid",
      ...(item.kind === "peer" || item.kind === "fork"
        ? {
            "target-arrow-shape": "triangle",
            "target-arrow-color": css(item.token),
            "arrow-scale": 0.8,
          }
        : {}),
    },
  }));
  return [base, ...perKind, { selector: ".faded", style: { opacity: 0.15 } }];
}
const graphStyle = () => [...nodeStyles(css("--graph-bg")), ...edgeStyles()];

function nodeData(node) {
  if (node.hub) return { id: node.id, label: node.title, hub: true, kind: "hub" };
  return {
    id: node.id,
    label: node.title,
    provider: node.provider,
    status: node.status,
    waiting: node.waiting,
    archived: node.archived,
    kind: "thread",
  };
}
function edgeData(edge) {
  return { id: edgeKey(edge), source: edge.a, target: edge.b, kind: edge.kind, weight: edge.w };
}
function startPosition(node, view) {
  const known = positions[node.id];
  if (known) return known;
  for (const edge of view.edges) {
    const other = edge.a === node.id ? edge.b : edge.b === node.id ? edge.a : "";
    const anchor = other ? net.getElementById(other) : null;
    if (anchor?.nonempty()) {
      const spot = anchor.position();
      return { x: spot.x + 40 + Math.random() * 40, y: spot.y + 40 + Math.random() * 40 };
    }
  }
  return null;
}
function patchElements(view) {
  const wantNodes = new Set(view.nodes.keys());
  const wantEdges = new Set(view.edges.map(edgeKey));
  const added = [];
  net.batch(() => {
    net
      .edges()
      .filter((edge) => !wantEdges.has(edge.id()))
      .remove();
    net
      .nodes()
      .filter((node) => !wantNodes.has(node.id()))
      .remove();
    for (const node of view.nodes.values()) {
      const existing = net.getElementById(node.id);
      if (existing.nonempty()) existing.data(nodeData(node));
      else
        added.push({
          group: "nodes",
          data: nodeData(node),
          position: startPosition(node, view) || undefined,
        });
    }
    net.add(added);
    const fresh = view.edges.filter((edge) => net.getElementById(edgeKey(edge)).empty());
    net.add(fresh.map((edge) => ({ group: "edges", data: edgeData(edge) })));
  });
  return added;
}
function layoutOnce(added) {
  const unplaced = added.filter((item) => !item.position);
  if (!unplaced.length) return;
  const first = !Object.keys(positions).length;
  const narrow = net.width() < 600;
  net
    .elements()
    .layout({
      name: "cose",
      animate: false,
      fit: false,
      randomize: first,
      nodeRepulsion: () => (narrow ? 6000 : 40000),
      idealEdgeLength: () => (narrow ? 40 : 110),
      numIter: 800,
      boundingBox: first ? undefined : net.extent(),
    })
    .run();
  if (first) fitGraph();
  savePositions();
}
function savePositions() {
  net.nodes().forEach((node) => {
    positions[node.id()] = node.position();
  });
  store.set(POS_KEY, JSON.stringify(positions));
}
function fitGraph() {
  net?.fit(undefined, 30);
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
  net.on("tap", "node", (event) => openNode(event.target.id()));
  net.on("tap", (event) => event.target === net && closeSheet());
  net.on("dragfree", "node", savePositions);
  net.on("mouseover", "node", (event) => showTip(event.target));
  net.on("taphold", "node", (event) => showTip(event.target));
  net.on("mouseout", "node", hideTip);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
    net?.style(graphStyle()),
  );
  setInterval(pulse, 900);
}
function pulse() {
  if (!net || REDUCED.matches || state.view !== "graph") return;
  net.nodes("[status='running']").toggleClass("pulse");
}
let drawSeq = 0;
async function drawGraph(view) {
  const seq = ++drawSeq;
  try {
    if (!net) await makeGraph();
  } catch {
    setStatus("The graph library could not load. Use the clusters view.");
    return;
  }
  if (seq !== drawSeq || state.view !== "graph") return;
  net.resize();
  const added = patchElements(view);
  layoutOnce(added);
  for (const edge of net.edges()) edge.toggleClass("faded", false);
  $("cy").dataset.nodes = String(net.nodes().length);
  $("cy").dataset.edges = String(net.edges().length);
  markPicked();
}
function markPicked() {
  if (!net) return;
  net.nodes().removeClass("picked");
  if (state.picked) net.getElementById(state.picked).addClass("picked");
}

// ---------- tooltip + sheet ----------
function tipText(node) {
  const data = node.data();
  if (data.hub) return `${data.label} (shared)`;
  const flags = [
    data.provider,
    data.status,
    data.waiting ? "waiting" : "",
    data.archived ? "archived" : "",
  ];
  return `${data.label} · ${flags.filter(Boolean).join(" · ")}`;
}
function showTip(node) {
  const tip = $("tip");
  tip.textContent = tipText(node);
  const spot = node.renderedPosition();
  tip.style.left = `${Math.max(4, spot.x + 14)}px`;
  tip.style.top = `${Math.max(4, spot.y - 8)}px`;
  tip.hidden = false;
}
function hideTip() {
  $("tip").hidden = true;
}
function sharedKeys(id) {
  const rows = [];
  for (const hub of state.hubs) {
    if (!hub.threads.includes(id)) continue;
    const others = hub.threads
      .filter((other) => other !== id)
      .map((other) => state.nodes.get(other)?.title || other);
    rows.push(
      `${hub.kind}: ${hub.key}${others.length ? ` (with ${others.slice(0, 3).join(", ")})` : ""}`,
    );
  }
  for (const edge of state.edges.values()) {
    if (edge.kind !== "peer" && edge.kind !== "fork") continue;
    const other = edge.a === id ? edge.b : edge.b === id ? edge.a : "";
    if (other) rows.push(`${edge.kind}: ${state.nodes.get(other)?.title || other}`);
  }
  return rows;
}
function showSheet(title) {
  $("sheetTitle").textContent = title;
  $("sheet").hidden = false;
  $("scrim").hidden = false;
}
function openNode(id) {
  const node = state.nodes.get(id);
  state.picked = id;
  markPicked();
  if (!node) return showSheet(hubLabel(id));
  showSheet(node.title);
  const body = $("sheetBody");
  const flags = [
    node.provider,
    node.status,
    node.waiting ? "waiting" : "",
    node.archived ? "archived" : "",
  ];
  const open = el("a", "btn open", "Open thread");
  open.href = `/#thread=${encodeURIComponent(id)}`;
  const shared = sharedKeys(id);
  const list = el("ul", "shared");
  list.append(...shared.map((row) => el("li", "", row)));
  const section = el("section");
  section.append(
    el("h3", "", "Shared with other threads"),
    shared.length ? list : el("p", "muted", "Nothing shared in this window."),
  );
  body.replaceChildren(el("p", "muted", flags.filter(Boolean).join(" · ")), open, section);
  if (node.subagents)
    body.append(el("p", "muted", `${node.subagents} background subagent(s) running`));
}
function closeSheet() {
  $("sheet").hidden = true;
  $("scrim").hidden = true;
  state.picked = "";
  markPicked();
}

// ---------- render + controls ----------
function render() {
  const view = visible();
  const threads = [...view.nodes.values()].filter((node) => !node.hub);
  $("count").textContent = `${threads.length} threads · ${view.edges.length} links`;
  const dropped = state.dropped.keys + state.dropped.nodes;
  $("stamp").textContent = dropped
    ? `${state.dropped.keys} widely shared keys and ${state.dropped.nodes} older threads left out.`
    : "";
  if (!threads.length && !$("bm").hasAttribute("aria-busy"))
    setStatus("No threads in this window.");
  renderClusters(view);
  if (state.view === "graph") drawGraph(view);
}
function setView(view) {
  state.view = view;
  store.set("tgraph.view", view);
  const graph = view === "graph";
  $("viewList").setAttribute("aria-pressed", String(!graph));
  $("viewGraph").setAttribute("aria-pressed", String(graph));
  $("listView").hidden = graph;
  $("graphView").hidden = !graph;
  render();
}
function buildLegend() {
  const list = $("kindLegend");
  list.replaceChildren(
    ...KINDS.map((item) => {
      const row = el("li");
      const button = el("button", "kind-toggle");
      button.type = "button";
      button.dataset.kind = item.kind;
      button.setAttribute("aria-pressed", String(state.kinds.has(item.kind)));
      const swatch = el("i", item.style);
      swatch.style.setProperty("--kind-color", `var(${item.token})`);
      button.append(swatch, item.label);
      button.onclick = () => toggleKind(item.kind, button);
      row.append(button);
      return row;
    }),
  );
}
function toggleKind(kind, button) {
  if (!state.kinds.delete(kind)) state.kinds.add(kind);
  button.setAttribute("aria-pressed", String(state.kinds.has(kind)));
  saveFilters();
  render();
}
function bindFilters() {
  $("fWindow").value = state.window;
  $("fProvider").value = state.provider;
  $("fStatus").value = state.status;
  $("fArchived").setAttribute("aria-pressed", String(state.archived));
  $("fWindow").onchange = () => {
    state.window = $("fWindow").value;
    saveFilters();
    load();
  };
  $("fProvider").onchange = () => {
    state.provider = $("fProvider").value;
    saveFilters();
    render();
  };
  $("fStatus").onchange = () => {
    state.status = $("fStatus").value;
    saveFilters();
    render();
  };
  $("fArchived").onclick = () => {
    state.archived = !state.archived;
    $("fArchived").setAttribute("aria-pressed", String(state.archived));
    saveFilters();
    render();
  };
}
function setLegend(open) {
  $("legendToggle").setAttribute("aria-expanded", String(open));
  $("legendBody").hidden = !open;
}
function bindChrome() {
  $("viewList").onclick = () => setView("list");
  $("viewGraph").onclick = () => setView("graph");
  $("sheetClose").onclick = closeSheet;
  $("scrim").onclick = closeSheet;
  $("zoomIn").onclick = () =>
    net?.zoom({
      level: net.zoom() * 1.3,
      renderedPosition: { x: net.width() / 2, y: net.height() / 2 },
    });
  $("zoomOut").onclick = () =>
    net?.zoom({
      level: net.zoom() / 1.3,
      renderedPosition: { x: net.width() / 2, y: net.height() / 2 },
    });
  $("fitGraph").onclick = fitGraph;
  $("legendToggle").onclick = () =>
    setLegend($("legendToggle").getAttribute("aria-expanded") !== "true");
  document.addEventListener("keydown", (event) => event.key === "Escape" && closeSheet());
}

// ---------- live ----------
function patchThread(thread) {
  const node = state.nodes.get(thread.id);
  if (!node) return scheduleDelta();
  Object.assign(node, {
    title: thread.title,
    status: thread.status,
    waiting: (thread.waiting ?? 0) > 0,
    archived: !!thread.archived,
    lastActivity: thread.updatedAt ?? node.lastActivity,
    subagents: thread.background ?? 0,
  });
  const live = net?.getElementById(thread.id);
  if (live?.nonempty()) live.data(nodeData(node));
  renderClusters(visible());
  if (!$("sheet").hidden && state.picked === thread.id) openNode(thread.id);
}
function connect() {
  const sock = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  );
  sock.onmessage = (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    if (data.t === "thread" && data.thread) patchThread(data.thread);
    else if (data.t === "graph_dirty") scheduleDelta();
  };
  sock.onclose = () => setTimeout(connect, 3000);
}

buildLegend();
bindFilters();
bindChrome();
setLegend(false);
setView(state.view);
load();
connect();
