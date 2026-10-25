// ```arch blocks: renders a JSON architecture spec (same format as the PR architecture diagrams, see
// brain/skills/pr-evidence) as a styled diagram: title, nested groups, nodes (icon tile, label, tech, desc, status pill,
// step badge) and a legend. Icons come only from the vendored Lucide map (/vendor/lucide/icons.json); anything else
// (d2:, file paths, unknown names) gets a fallback glyph. Nothing is fetched from remote URLs.
// Arrow routing is a separate step: routeArch(container) is a stub; edges live on container.__archEdges.

export const COLORS = {
  blue: "#2563eb",
  indigo: "#4f46e5",
  purple: "#7c3aed",
  pink: "#db2777",
  orange: "#ea580c",
  teal: "#0d9488",
  cyan: "#0891b2",
  slate: "#475569",
};
export const STATUSES = {
  unchanged: "Unchanged",
  added: "Added",
  modified: "Modified",
  removed: "Removed",
};
const BOUNDARIES = ["solid", "dashed", "none"];
const NODE_KEYS = ["id", "label", "tech", "desc", "icon", "color", "status", "step"];
const GROUP_KEYS = [
  "id",
  "group",
  "sub",
  "icon",
  "color",
  "border",
  "direction",
  "status",
  "step",
  "items",
];
const EDGE_KEYS = ["from", "to", "label", "step", "status", "both", "dashed"];
const ROOT_KEYS = ["title", "subtitle", "note", "direction", "items", "edges"];
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";

// ---------- validation ----------
function checkKeys(item, allowed, where, errors) {
  const unknown = Object.keys(item).filter((key) => !allowed.includes(key));
  if (unknown.length) errors.push(`${where}: unknown keys ${unknown.join(", ")}`);
}

function checkChoice(item, field, choices, where, errors) {
  if (item[field] !== undefined && !choices.includes(item[field]))
    errors.push(`${where}: ${field} must be one of ${choices.join(", ")}`);
}

function checkStep(item, where, errors) {
  const step = item.step;
  if (step === undefined) return;
  const ok = (typeof step === "number" || isText(step)) && typeof step !== "boolean";
  if (!ok) errors.push(`${where}: step must be a number or short string`);
}

function checkOptionalText(item, field, where, errors) {
  if (item[field] !== undefined && !isText(item[field]))
    errors.push(`${where}: ${field} must be a non-empty string`);
}

function checkCommon(item, allowed, where, errors) {
  checkKeys(item, allowed, where, errors);
  checkChoice(item, "color", Object.keys(COLORS), where, errors);
  checkChoice(item, "status", Object.keys(STATUSES), where, errors);
  checkStep(item, where, errors);
  checkChoice(item, "direction", ["row", "column"], where, errors);
}

function registerId(item, where, ids, errors) {
  if (!isText(item.id)) return errors.push(`${where}: id must be a non-empty string`);
  if (ids.has(item.id)) errors.push(`${where}: duplicate id ${item.id}`);
  ids.add(item.id);
}

function checkItems(items, where, ids, errors) {
  if (!Array.isArray(items) || !items.length) {
    errors.push(`${where}: items must be a non-empty list`);
    return;
  }
  items.forEach((item, index) => checkItem(item, `${where} item ${index + 1}`, ids, errors));
}

function checkItem(item, where, ids, errors) {
  if (!isObject(item)) return errors.push(`${where}: each item must be an object`);
  if ("group" in item) {
    checkCommon(item, GROUP_KEYS, where, errors);
    checkChoice(item, "border", BOUNDARIES, where, errors);
    if (!isText(item.group)) errors.push(`${where}: group must be a non-empty string`);
    if ("id" in item) registerId(item, where, ids, errors);
    checkItems(item.items, where, ids, errors);
    return;
  }
  checkCommon(item, NODE_KEYS, where, errors);
  registerId(item, where, ids, errors);
  if (!isText(item.label)) errors.push(`${where}: label must be a non-empty string`);
}

function checkEdge(edge, index, ids, errors) {
  const where = `edge ${index + 1}`;
  if (!isObject(edge)) return errors.push(`${where}: must be an object`);
  checkKeys(edge, EDGE_KEYS, where, errors);
  for (const end of ["from", "to"])
    if (!ids.has(edge[end]))
      errors.push(`${where}: ${end} must reference a node or group id, got ${edge[end]}`);
  checkChoice(edge, "status", Object.keys(STATUSES), where, errors);
  checkStep(edge, where, errors);
  checkOptionalText(edge, "label", where, errors);
  if (isText(edge.label) && edge.label.length > 40)
    errors.push(`${where}: label must be 40 characters or fewer`);
}

/** Returns a list of error strings; empty when the spec is valid. */
export function validateArch(spec) {
  const errors = [];
  if (!isObject(spec)) return ["spec must be a JSON object"];
  checkKeys(spec, ROOT_KEYS, "spec", errors);
  if (!isText(spec.title)) errors.push("spec: title must be a non-empty string");
  checkOptionalText(spec, "subtitle", "spec", errors);
  checkOptionalText(spec, "note", "spec", errors);
  checkChoice(spec, "direction", ["row", "column"], "spec", errors);
  const ids = new Set();
  checkItems(spec.items, "spec", ids, errors);
  const edges = spec.edges ?? [];
  if (!Array.isArray(edges)) errors.push("edges must be a list");
  else edges.forEach((edge, index) => checkEdge(edge, index, ids, errors));
  return errors;
}

// ---------- icons ----------
let iconMap = null;
let iconLoad = null;

/** Tests (or callers with their own map) can provide the name -> inner SVG markup map directly. */
export function setArchIcons(map) {
  iconMap = map;
}

function loadIcons() {
  if (iconMap) return Promise.resolve(iconMap);
  iconLoad ||= fetch("/vendor/lucide/icons.json")
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}))
    .then((map) => (iconMap = map));
  return iconLoad;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const FALLBACK_GLYPH = '<rect width="18" height="18" x="3" y="3" rx="2"/>';

function svgGlyph(inner) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "glyph");
  svg.innerHTML = inner; // vendored Lucide markup or the fixed fallback only
  return svg;
}

function fillIcon(holder, map) {
  holder.replaceChildren(svgGlyph(map[holder.dataset.icon] || FALLBACK_GLYPH));
}

function iconHolder(tag, cls, name) {
  const holder = document.createElement(tag);
  holder.className = cls;
  holder.dataset.icon = typeof name === "string" ? name : "box";
  fillIcon(holder, iconMap || {});
  return holder;
}

// ---------- DOM ----------
function div(cls, text) {
  const node = document.createElement("div");
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function span(cls, text) {
  const node = document.createElement("span");
  node.className = cls;
  node.textContent = text;
  return node;
}

const stepBadge = (step) => (step === undefined ? null : span("step", String(step)));
const statusPill = (status) => (status === "unchanged" ? null : span("pill", STATUSES[status]));
const accent = (item, fallback) => COLORS[item.color] || COLORS[fallback];

function buildNode(node) {
  const status = node.status || "unchanged";
  const root = div(`node ${status}`);
  root.dataset.id = node.id;
  root.style.setProperty("--accent", accent(node, "blue"));
  const tile = iconHolder("div", "tile", node.icon || "box");
  const parts = [stepBadge(node.step), statusPill(status), tile, div("label", node.label)];
  if (node.tech) parts.push(div("tech", node.tech));
  if (node.desc) parts.push(div("desc", node.desc));
  root.append(...parts.filter(Boolean));
  return root;
}

function groupHeader(group, status) {
  const header = document.createElement("header");
  const title = span("gtitle", group.group);
  if (group.sub) {
    const small = document.createElement("small");
    small.textContent = group.sub;
    title.append(small);
  }
  const icon = group.icon ? iconHolder("span", "gicon", group.icon) : null;
  header.append(...[stepBadge(group.step), icon, title, statusPill(status)].filter(Boolean));
  return header;
}

function buildGroup(group) {
  const status = group.status || "unchanged";
  const border = group.border || "dashed";
  const quiet = status === "unchanged" ? " quiet" : "";
  const root = document.createElement("section");
  root.className = `group ${border} ${status}${quiet}`;
  if (group.id) root.dataset.id = group.id;
  root.style.setProperty("--accent", accent(group, "slate"));
  root.append(groupHeader(group, status), buildItems(group.items, group.direction || "column"));
  return root;
}

function buildItems(items, direction) {
  const box = div(`items ${direction}`);
  for (const item of items) box.append("group" in item ? buildGroup(item) : buildNode(item));
  return box;
}

function buildLegend(hasSteps) {
  const legend = div("legend");
  legend.append(document.createElement("b"));
  legend.firstChild.textContent = "Legend";
  for (const [name, label] of Object.entries(STATUSES)) {
    const key = span("key", label);
    const swatch = document.createElement("i");
    swatch.className = `${name} ${name}-fill`;
    key.prepend(swatch);
    legend.append(key);
  }
  if (hasSteps) {
    const key = span("key", "Step order");
    key.prepend(span("step", "1"));
    legend.append(key);
  }
  return legend;
}

const hasStep = (items) =>
  items.some((item) => item.step !== undefined || (item.items && hasStep(item.items)));

function normaliseEdge(edge) {
  return {
    from: edge.from,
    to: edge.to,
    label: (edge.label || "").trim(),
    step: edge.step === undefined ? null : String(edge.step),
    status: edge.status || "unchanged",
    both: Boolean(edge.both),
    dashed: Boolean(edge.dashed),
  };
}

function buildHeading(spec) {
  const heading = document.createElement("h1");
  heading.textContent = spec.title;
  const parts = [heading];
  if (spec.subtitle) parts.push(Object.assign(document.createElement("p"), { className: "subtitle", textContent: spec.subtitle }));
  if (spec.note) parts.push(span("note", spec.note));
  return parts;
}

let styled = false;
function ensureStyle() {
  if (styled || document.getElementById("arch-style")) return;
  const style = document.createElement("style");
  style.id = "arch-style";
  style.textContent = ARCH_CSS;
  document.head.append(style);
  styled = true;
}

/**
 * Builds the diagram DOM for a validated spec into `container`. Returns a promise that resolves once the Lucide icons
 * are filled in and routing has run. Throws if the spec is invalid.
 */
export function buildArch(spec, container) {
  const errors = validateArch(spec);
  if (errors.length) throw new Error(errors.join("; "));
  ensureStyle();
  container.classList.add("arch");
  const canvas = div("canvas");
  canvas.append(buildItems(spec.items, spec.direction || "row"));
  container.replaceChildren(
    ...buildHeading(spec),
    canvas,
    buildLegend(hasStep(spec.items) || (spec.edges || []).some((e) => e.step !== undefined)),
  );
  container.__archEdges = (spec.edges || []).map(normaliseEdge);
  container.__archCanvas = canvas;
  return loadIcons().then((map) => {
    for (const holder of container.querySelectorAll("[data-icon]")) fillIcon(holder, map);
    return routeArch(container);
  });
}

/** Stub: a later worker draws the edges (container.__archEdges) over container.__archCanvas. */
export function routeArch(_container) {}

// ---------- styles (ported from brain/bin/pr-architecture, with dark variables) ----------
const ARCH_CSS = `
.arch { --a-surface:#fff; --a-ink:#172033; --a-sub:#526077; --a-muted:#4b5870; --a-line:#e1e6ee; --a-chip:#f1f4f8;
  --a-chip-ink:#44526a; --a-step:#1f2937; --a-rule:#e5e9f0; --a-tint:#fff; --a-box:#fff;
  --a-added:#1f7a3f; --a-added-fill:#e8f6ed; --a-modified:#9a6200; --a-modified-fill:#fff5d9;
  --a-removed:#b42318; --a-removed-fill:#fdecec; --a-unchanged:#66758a; --a-unchanged-fill:#f6f8fb;
  position:relative; margin:12px 0; padding:24px 28px 20px; overflow-x:auto; background:var(--a-surface); color:var(--a-ink);
  border:1px solid var(--a-line); border-radius:16px; font-size:14px; line-height:1.35; }
@media (prefers-color-scheme: dark) {
  .arch { --a-surface:#16161b; --a-ink:#e8eaf0; --a-sub:#a3adc0; --a-muted:#aab4c6; --a-line:#2a2a32; --a-chip:#24242c;
    --a-chip-ink:#c3cada; --a-step:#4b5563; --a-rule:#2a2a32; --a-tint:#16161b; --a-box:#1b1b20;
    --a-added:#4ade80; --a-added-fill:#10261a; --a-modified:#fbbf24; --a-modified-fill:#2a2110;
    --a-removed:#f87171; --a-removed-fill:#2c1416; --a-unchanged:#8b97ab; --a-unchanged-fill:#1d1f26; }
}
:root[data-theme="dark"] .arch, .dark .arch { --a-surface:#16161b; --a-ink:#e8eaf0; --a-sub:#a3adc0; --a-muted:#aab4c6;
  --a-line:#2a2a32; --a-chip:#24242c; --a-chip-ink:#c3cada; --a-step:#4b5563; --a-rule:#2a2a32; --a-tint:#16161b; --a-box:#1b1b20;
  --a-added:#4ade80; --a-added-fill:#10261a; --a-modified:#fbbf24; --a-modified-fill:#2a2110;
  --a-removed:#f87171; --a-removed-fill:#2c1416; --a-unchanged:#8b97ab; --a-unchanged-fill:#1d1f26; }
.arch * { box-sizing:border-box; }
.arch h1 { margin:0; font-size:22px; font-weight:700; letter-spacing:-.02em; }
.arch .subtitle { margin:4px 0 0; color:var(--a-sub); font-size:14px; }
.arch .note { display:inline-block; margin-top:10px; padding:4px 10px; border-radius:999px; background:var(--a-chip); color:var(--a-chip-ink); font-weight:600; font-size:13px; }
.arch .canvas { position:relative; display:inline-block; min-width:100%; margin-top:24px; }
.arch .items { display:flex; gap:72px 40px; align-items:center; justify-content:center; }
.arch .items.row { flex-direction:row; }
.arch .items.column { flex-direction:column; }
.arch .canvas > .items.row, .arch .group > .items.row { column-gap:150px; }
.arch .group { position:relative; border:1.5px solid var(--accent); border-radius:12px; padding:0 22px 22px; background:color-mix(in srgb, var(--accent) 3%, var(--a-tint)); }
.arch .group.dashed { border-style:dashed; }
.arch .group.none { border-color:transparent; background:transparent; }
.arch .group > header { display:flex; align-items:center; gap:8px; min-height:42px; margin:0 -10px 12px; padding-top:4px; font-weight:700; font-size:15px; color:color-mix(in srgb, var(--accent) 75%, var(--a-ink)); }
.arch .gtitle small { display:block; font-weight:500; font-style:italic; font-size:12.5px; color:var(--a-sub); }
.arch .gicon { display:grid; place-items:center; width:28px; height:28px; border-radius:7px; background:var(--accent); color:#fff; flex:none; }
.arch .gicon .glyph { width:17px; height:17px; }
.arch .added { --status:var(--a-added); --status-fill:var(--a-added-fill); }
.arch .modified { --status:var(--a-modified); --status-fill:var(--a-modified-fill); }
.arch .removed { --status:var(--a-removed); --status-fill:var(--a-removed-fill); }
.arch .unchanged { --status:var(--a-unchanged); --status-fill:var(--a-unchanged-fill); }
.arch .group.added, .arch .group.modified, .arch .group.removed { border-color:var(--status); border-width:2.5px; background:color-mix(in srgb, var(--status-fill) 55%, var(--a-tint)); }
.arch .group .step, .arch .node .step { position:static; }
.arch .node { position:relative; display:flex; flex-direction:column; align-items:center; text-align:center; width:168px; padding:14px 10px 12px; border-radius:12px; border:1.5px solid transparent; background:var(--a-box); }
.arch .node.unchanged { border-color:var(--a-line); }
.arch .node.added, .arch .node.modified, .arch .node.removed { border:2.5px solid var(--status); background:var(--status-fill); }
.arch .node.removed { border-style:dashed; }
.arch .node.removed .tile { filter:grayscale(.6); opacity:.75; }
.arch .tile { display:grid; place-items:center; width:58px; height:58px; border-radius:14px; background:linear-gradient(145deg, color-mix(in srgb, var(--accent) 82%, #fff), var(--accent)); color:#fff; box-shadow:0 6px 14px -6px var(--accent); }
.arch .tile .glyph { width:32px; height:32px; stroke-width:1.75; }
.arch .label, .arch .tech, .arch .desc { max-width:100%; overflow-wrap:anywhere; }
.arch .label { margin-top:10px; font-weight:700; font-size:14.5px; line-height:1.25; }
.arch .tech { margin-top:2px; color:var(--a-muted); font-size:12px; font-weight:500; }
.arch .desc { margin-top:5px; color:var(--a-sub); font-size:12px; line-height:1.35; }
.arch .step { display:inline-grid; place-items:center; min-width:24px; height:24px; padding:0 6px; border-radius:999px; background:var(--a-step); color:#fff; font-weight:700; font-size:12.5px; flex:none; }
.arch .node > .step { position:absolute; top:-10px; left:-10px; }
.arch .pill { padding:2px 8px; border-radius:999px; background:var(--status); color:#fff; font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
.arch .node > .pill { position:absolute; top:-10px; right:-8px; }
.arch .group > header .pill { margin-left:auto; }
.arch svg.wires { position:absolute; inset:0; z-index:1; overflow:visible; pointer-events:none; }
.arch .edge-label { position:absolute; z-index:2; display:flex; align-items:center; gap:6px; max-width:132px; padding:3px 8px; border-radius:8px; background:var(--a-box); border:1px solid var(--a-line); font-size:12px; font-weight:600; line-height:1.25; text-align:center; transform:translate(-50%, -50%); }
.arch .legend { display:flex; flex-wrap:wrap; align-items:center; gap:10px 22px; margin-top:28px; padding-top:14px; border-top:1px solid var(--a-rule); color:var(--a-sub); font-size:12.5px; font-weight:500; }
.arch .legend b { font-weight:700; color:var(--a-ink); }
.arch .legend .key { display:inline-flex; align-items:center; gap:8px; }
.arch .legend i { display:inline-block; width:22px; height:14px; border-radius:4px; border:2.5px solid var(--status); background:var(--status-fill); }
.arch .legend i.unchanged { border-width:1.5px; }
.arch .legend i.removed { border-style:dashed; }
`;
