// Code maps: dashboard of mapped codebases plus a map view drawn by the shared arch.js renderer.
// Hash routes: "" or "#/" dashboard, "#add" dashboard with the add box focused, "#/<slug>" overview,
// "#/<slug>/<nodeId>" one module, "#/<slug>/flow/<flowId>" one flow. Every repo-derived string goes in via textContent.
import { $, el } from "./render.js";

const RUNNING = new Set(["queued", "cloning", "scanning", "describing"]);
const STATUS_TEXT = {
  queued: "Queued",
  cloning: "Cloning",
  scanning: "Scanning",
  describing: "Describing",
  ready: "Ready",
  failed: "Failed",
};
const POLL_MS = 3000;
let maps = [];
let pollTimer = 0;
let viewToken = 0; // bumps on every navigation so a slow view response cannot overwrite a newer one
let archLib;

const api = async (url, opts) => {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin", ...opts });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
};
const post = (url, data) =>
  api(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data || {}),
  });

function toast(text) {
  const box = $("toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    box.hidden = true;
  }, 3000);
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (!parts[0] || parts[0] === "add") return { page: "list", focus: parts[0] === "add" };
  if (parts[1] === "flow" && parts[2]) return { page: "map", slug: parts[0], flow: parts[2] };
  return { page: "map", slug: parts[0], node: parts[1] || "" };
}
const mapHref = (slug, tail) =>
  `#/${encodeURIComponent(slug)}${tail ? `/${tail.map(encodeURIComponent).join("/")}` : ""}`;

function timeAgo(stamp) {
  const when = new Date(stamp).getTime();
  if (!Number.isFinite(when)) return "";
  const secs = Math.max(0, Math.round((Date.now() - when) / 1000));
  if (secs < 60) return "just now";
  const units = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
  ];
  let best = units[0];
  for (const unit of units) if (secs >= unit[0]) best = unit;
  return `${Math.floor(secs / best[0])}${best[1]} ago`;
}

// ---------- dashboard ----------
function statusChip(map) {
  const chip = el("span", "chip");
  if (map.status === "failed") chip.classList.add("failed");
  else if (map.status === "ready") chip.classList.add("ready");
  else chip.classList.add("run");
  if (RUNNING.has(map.status)) chip.append(el("span", "spin"));
  chip.append(STATUS_TEXT[map.status] || map.status);
  return chip;
}

function statsLine(map) {
  if (map.status !== "ready" && map.files == null) return "";
  const parts = [];
  if (map.files != null) parts.push(`${map.files.toLocaleString()} files`);
  if (map.modules != null) parts.push(`${map.modules.toLocaleString()} modules`);
  if (map.loc != null) parts.push(`${map.loc.toLocaleString()} LOC`);
  return parts.join(" · ");
}

function actionButton(label, cls, onClick) {
  const btn = el("button", `btn ghost ${cls}`.trim(), label);
  btn.type = "button";
  btn.onclick = onClick;
  return btn;
}

async function runAction(task, doneText) {
  try {
    await task();
    if (doneText) toast(doneText);
  } catch (err) {
    toast(err.message);
  }
  await loadMaps();
}

function cardActions(map) {
  const base = `/api/maps/${encodeURIComponent(map.slug)}`;
  const busy = RUNNING.has(map.status);
  const refresh = actionButton("Refresh", "", () =>
    runAction(() => post(`${base}/refresh`, {}), "Refresh started."),
  );
  const describe = actionButton("Re-describe", "", () =>
    runAction(() => post(`${base}/refresh`, { describe: true }), "Re-describe started."),
  );
  const remove = actionButton("Delete", "danger", () => {
    if (!confirm(`Delete the map "${map.label}"?`)) return;
    runAction(() => api(base, { method: "DELETE" }), "Map deleted.");
  });
  refresh.disabled = describe.disabled = busy;
  const row = el("div", "mp-actions");
  row.append(refresh, describe, remove);
  return row;
}

function cardTitle(map) {
  const top = el("div", "mp-top");
  let name;
  if (map.status === "ready") {
    name = el("a", "mp-name", map.label);
    name.href = mapHref(map.slug);
  } else name = el("span", "mp-name", map.label);
  const kind = map.source?.kind === "github" ? "GitHub" : "Local";
  top.append(name, el("span", "chip", kind), statusChip(map));
  return top;
}

function renderCard(map) {
  const card = el("li", "mp-card");
  card.dataset.slug = map.slug;
  card.append(cardTitle(map));
  if (map.source?.ref) card.append(el("p", "mp-hint", map.source.ref));
  if (map.status === "failed") card.append(el("p", "mp-err", map.error || "Mapping failed."));
  const stats = statsLine(map);
  if (stats) card.append(el("p", "mp-meta", stats));
  if (map.status === "ready") {
    const how = map.described ? "AI described" : "Quick map";
    card.append(el("p", "mp-hint", `${how} · updated ${timeAgo(map.updatedAt)}`.trim()));
  }
  card.append(cardActions(map));
  return card;
}

function renderList() {
  $("cards").replaceChildren(...maps.map(renderCard));
  const status = $("status");
  status.hidden = maps.length > 0;
  status.textContent = maps.length
    ? ""
    : "No maps yet. Add a repo above to get its architecture diagram.";
  status.classList.toggle("mp-empty", !maps.length);
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (parseRoute().page !== "list") return;
  if (maps.some((map) => RUNNING.has(map.status))) pollTimer = setTimeout(loadMaps, POLL_MS);
}

async function loadMaps() {
  try {
    maps = (await api("/api/maps")).maps || [];
    if (parseRoute().page === "list") renderList();
  } catch (err) {
    $("status").hidden = false;
    $("status").textContent = err.message;
  }
  $("mp").setAttribute("aria-busy", "false");
  schedulePoll();
}

$("addForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("addBtn");
  button.disabled = true;
  $("addErr").hidden = true;
  try {
    await post("/api/maps", { source: $("source").value.trim() });
    $("addForm").reset();
    toast("Mapping started.");
    await loadMaps();
  } catch (err) {
    $("addErr").textContent = err.message;
    $("addErr").hidden = false;
  }
  button.disabled = false;
});

// ---------- map view ----------
function crumbNode(crumb, slug, last) {
  if (last) return el("span", "", crumb.label);
  const link = el("a", "", crumb.label);
  link.href = crumb.home ? "#/" : crumb.id ? mapHref(slug, [crumb.id]) : mapHref(slug);
  return link;
}

function renderCrumbs(view, slug) {
  const all = [{ id: null, label: "Maps", home: true }, ...view.crumbs];
  const parts = [];
  for (const [index, crumb] of all.entries()) {
    if (index) parts.push(el("span", "sep", "›"));
    parts.push(crumbNode(crumb, slug, index === all.length - 1));
  }
  $("crumbs").replaceChildren(...parts);
}

function renderTabs(view, route) {
  const tabs = [{ label: "Overview", href: mapHref(route.slug), on: !route.flow && !route.node }];
  for (const flow of view.flows) {
    tabs.push({
      label: flow.title,
      href: mapHref(route.slug, ["flow", flow.id]),
      on: route.flow === flow.id,
    });
  }
  $("tabs").replaceChildren(
    ...tabs.map((tab) => {
      const link = el("a", "", tab.label);
      link.href = tab.href;
      link.setAttribute("role", "tab");
      link.setAttribute("aria-selected", String(tab.on));
      return link;
    }),
  );
  $("tabs").hidden = !view.flows.length;
}

function stepList(steps) {
  const list = el("ol", "steps");
  for (const step of steps) {
    const row = el("li");
    row.append(el("strong", "", step.label), document.createTextNode(` ${step.note}`));
    list.append(row);
  }
  return list;
}

function renderDetails(details) {
  const box = $("details");
  box.replaceChildren(el("h2", "", details.title));
  if (details.summary) box.append(el("p", "", details.summary));
  if (details.steps?.length) box.append(stepList(details.steps));
  if (!details.files.length) return;
  const list = el("ul", "files");
  for (const file of details.files) {
    const row = el("li");
    row.append(
      el("span", "path", file.path),
      el("span", "loc", `${file.loc.toLocaleString()} LOC`),
    );
    list.append(row);
  }
  if (details.files.length <= 8) return box.append(list);
  const fold = el("details");
  fold.append(el("summary", "", `${details.files.length} files`), list);
  box.append(fold);
}

function makeDrillable(node, target, slug) {
  node.classList.add("drill");
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  const go = () => {
    location.hash = mapHref(slug, [target]);
  };
  node.addEventListener("click", go);
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    go();
  });
}

function attachDrill(view, slug) {
  for (const holder of $("diagram").querySelectorAll("[data-id]")) {
    const target = view.drill[holder.dataset.id];
    if (!target) continue;
    makeDrillable(holder, target, slug);
    const label = holder.querySelector(".label, .gtitle");
    if (label) holder.setAttribute("aria-label", `Open ${label.textContent}`);
  }
}

async function drawDiagram(view, slug) {
  const box = el("div");
  $("diagram").replaceChildren(box);
  archLib ||= import("./arch.js");
  const lib = await archLib;
  const errors = lib.validateArch(view.spec);
  if (errors.length) throw new Error(errors[0]);
  await lib.buildArch(view.spec, box);
  attachDrill(view, slug);
}

function showMapChrome(show) {
  $("listView").hidden = show;
  $("mapView").hidden = !show;
  $("title").textContent = show ? "Code map" : "Code maps";
  $("backLabel").textContent = show ? "Maps" : "Console";
  $("back").href = show ? "#/" : "/";
}

async function showMap(route) {
  const token = ++viewToken;
  showMapChrome(true);
  const query = new URLSearchParams();
  if (route.node) query.set("node", route.node);
  if (route.flow) query.set("flow", route.flow);
  $("viewStatus").textContent = "Loading map…";
  $("viewStatus").classList.remove("mp-err");
  $("viewStatus").hidden = false;
  try {
    const view = await api(`/api/maps/${encodeURIComponent(route.slug)}/view?${query}`);
    if (token !== viewToken) return;
    renderCrumbs(view, route.slug);
    renderTabs(view, route);
    renderDetails(view.details);
    $("viewStatus").hidden = true;
    await drawDiagram(view, route.slug);
  } catch (err) {
    if (token !== viewToken) return;
    $("viewStatus").hidden = false;
    $("viewStatus").textContent = `Could not show this map: ${err.message}`;
    $("viewStatus").classList.add("mp-err");
  }
}

function showList(route) {
  viewToken++;
  showMapChrome(false);
  $("viewStatus").classList.remove("mp-err");
  renderList();
  schedulePoll();
  if (route.focus) $("source").focus();
}

function onRoute() {
  const route = parseRoute();
  if (route.page === "list") showList(route);
  else showMap(route);
}

window.addEventListener("hashchange", onRoute);
await loadMaps();
onRoute();
