import { el, iconButton } from "/render.js";

const RESOURCES = ["cpu", "mem", "disk"];
const LABELS = { cpu: "CPU", mem: "RAM", disk: "Disk" };
const SVG_NS = "http://www.w3.org/2000/svg";
const percent = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : "Unavailable");
function bytes(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  const scale = Math.min(3, Math.max(0, Math.floor(Math.log2(Math.max(1, value)) / 10)));
  return `${(value / 1024 ** scale).toFixed(scale ? 1 : 0)} ${["B", "KiB", "MiB", "GiB"][scale]}`;
}
function summary(metrics, resource) {
  if (resource === "cpu") return `${percent(metrics.cpu.total)} used · ${metrics.cpu.n} cores`;
  if (resource === "mem")
    return `${bytes(metrics.mem.used)} / ${bytes(metrics.mem.total)} · ${percent(metrics.mem.pct)}`;
  const disk = metrics.disk.find((row) => row.target.split(" · ").includes("/")) || metrics.disk[0];
  return disk
    ? `${bytes(disk.used)} / ${bytes(disk.size)} · ${percent(disk.pcent)} used (${disk.target})`
    : "Disk capacity unavailable";
}
function processValue(proc, resource) {
  if (resource === "cpu") return percent(proc.cpu);
  if (resource === "mem") return bytes(proc.rss);
  return proc.readBps == null || proc.writeBps == null
    ? "Unavailable"
    : `${bytes(proc.readBps + proc.writeBps)}/s`;
}
function historyPoints(history, resource) {
  const columns = history.cols;
  const timestamp = columns.indexOf("ts");
  const selected = columns.indexOf(resource === "mem" ? "mem" : "cpu");
  const read = columns.indexOf("rd");
  const write = columns.indexOf("wr");
  return history.points
    .map((point) => [
      point[timestamp],
      resource === "disk" ? point[read] + point[write] : point[selected],
    ])
    .filter(([time, value]) => Number.isFinite(time) && Number.isFinite(value));
}
function chart(history, resource) {
  const figure = el("figure", "host-card-history");
  const points = historyPoints(history, resource);
  figure.append(
    el(
      "figcaption",
      "host-card-caption",
      resource === "disk"
        ? "Disk I/O · read + write · last 5 min"
        : `${LABELS[resource]} usage · last 5 min`,
    ),
  );
  if (points.length < 2) {
    figure.append(el("p", "host-card-muted", "Collecting history. Refresh after the next sample."));
    return figure;
  }
  const maximum = resource === "disk" ? Math.max(1, ...points.map((point) => point[1])) : 100;
  const last = points.at(-1)[0];
  const first = last - 300_000;
  const path = points
    .map(
      ([time, value], index) =>
        `${index && time - points[index - 1][0] <= 15_000 ? "L" : "M"}${((time - first) / 300_000) * 400},${80 - (Math.max(0, value) / maximum) * 80}`,
    )
    .join(" ");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 400 80");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "host-card-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `${LABELS[resource]} history, ${points.length} samples. Latest ${resource === "disk" ? `${bytes(points.at(-1)[1])}/s` : percent(points.at(-1)[1])}. Scale 0 to ${resource === "disk" ? `${bytes(maximum)}/s` : "100%"}.`,
  );
  for (const height of [0, 40, 80]) {
    const gridline = document.createElementNS(SVG_NS, "line");
    for (const [attribute, value] of Object.entries({ x1: 0, x2: 400, y1: height, y2: height }))
      gridline.setAttribute(attribute, value);
    svg.append(gridline);
  }
  const vertical = el("div", "host-card-y-axis");
  vertical.setAttribute("aria-hidden", "true");
  for (const value of [maximum, maximum / 2, 0])
    vertical.append(el("span", "", resource === "disk" ? `${bytes(value)}/s` : `${value}%`));
  const plot = el("div", "host-card-plot");
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("d", path);
  svg.append(line);
  const axis = el("div", "host-card-axis");
  const time = (stamp) =>
    new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  axis.setAttribute("aria-hidden", "true");
  axis.append(el("span", "", time(first)), el("span", "", "Time"), el("span", "", time(last)));
  plot.append(vertical, svg, axis);
  figure.append(plot);
  return figure;
}

export function createHostCard(container) {
  let card = null;
  let panel = null;
  let tabs = [];
  let selected = "cpu";
  let controller = null;
  let generation = 0;
  let loadedAt = "";
  let sections = {};
  const close = () => {
    generation++;
    controller?.abort();
    card?.remove();
    card = null;
  };
  function section(name, render) {
    const state = sections[name];
    if (state?.data) return render(state.data);
    const region = el("div", "host-card-state");
    region.setAttribute("role", "status");
    region.append(
      el(
        "span",
        "host-card-muted",
        state?.error
          ? `${name === "metrics" ? "Current stats" : name === "history" ? "History" : "Processes"} unavailable.`
          : `Loading ${name}…`,
      ),
    );
    if (state?.error) {
      const retry = el("button", "btn ghost sm", "Retry");
      retry.type = "button";
      retry.onclick = () => load();
      region.append(retry);
    }
    return region;
  }
  function processList(data) {
    const group = el("div", "host-card-processes");
    const title = selected === "disk" ? "Top 3 by disk I/O" : `Top 3 by ${LABELS[selected]}`;
    group.append(el("h3", "host-card-caption", title));
    const rows = data.topProcesses?.[selected] || [];
    if (!rows.length)
      group.append(
        el(
          "p",
          "host-card-muted",
          selected === "disk"
            ? "Process I/O unavailable for this sample."
            : "No process samples available.",
        ),
      );
    const list = el("ol");
    for (const proc of rows.slice(0, 3)) {
      const row = el("li");
      const name = el("span", "host-card-process-name", proc.label || proc.name);
      name.title = `${proc.label || proc.name} · PID ${proc.pid}`;
      row.append(
        name,
        el("span", "host-card-muted", `PID ${proc.pid}`),
        el("span", "host-card-process-value", processValue(proc, selected)),
      );
      list.append(row);
    }
    group.append(list);
    return group;
  }
  function renderPanel() {
    if (!card) return;
    tabs.forEach((tab, index) => {
      const active = RESOURCES[index] === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", `host-tab-${selected}`);
    panel.replaceChildren(
      section("metrics", (data) => el("p", "host-card-current", summary(data, selected))),
      section("history", (data) => chart(data, selected)),
      section("processes", processList),
      el(
        "p",
        "host-card-updated host-card-muted",
        loadedAt
          ? `Snapshot at ${loadedAt} · Refresh to update`
          : "Static snapshot · no automatic updates",
      ),
    );
  }
  async function fetchSection(name, url, token, signal) {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error("Host data unavailable");
      const data = await response.json();
      if (token !== generation || !card) return;
      sections[name] = { data };
    } catch (error) {
      if (error.name === "AbortError" || token !== generation || !card) return;
      sections[name] = { error: true };
    }
    renderPanel();
  }
  function load() {
    controller?.abort();
    controller = new AbortController();
    const token = ++generation;
    loadedAt = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    sections = {};
    renderPanel();
    return Promise.all([
      fetchSection("metrics", "/api/host/metrics", token, controller.signal),
      fetchSection("history", "/api/host/history?range=300", token, controller.signal),
      fetchSection("processes", "/api/host/processes", token, controller.signal),
    ]);
  }
  function select(resource, focus = false) {
    selected = resource;
    renderPanel();
    if (focus) tabs[RESOURCES.indexOf(resource)].focus();
  }
  function createTabs() {
    const tablist = el("div", "host-card-tabs");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Host resource");
    tabs = RESOURCES.map((resource) => {
      const tab = el("button", "host-card-tab", LABELS[resource]);
      tab.id = `host-tab-${resource}`;
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "host-card-panel");
      tab.onclick = () => select(resource);
      tab.onkeydown = (event) => {
        const index = RESOURCES.indexOf(resource);
        const next = { ArrowRight: (index + 1) % 3, ArrowLeft: (index + 2) % 3, Home: 0, End: 2 }[
          event.key
        ];
        if (next == null) return;
        event.preventDefault();
        select(RESOURCES[next], true);
      };
      return tab;
    });
    tablist.append(...tabs);
    return tablist;
  }
  function open() {
    close();
    selected = "cpu";
    card = el("section", "host-card");
    card.id = "host-card";
    card.setAttribute("aria-label", "Host stats");
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      document.getElementById("input").focus();
    });
    const header = el("div", "host-card-header");
    const refresh = iconButton("refresh", "Refresh host stats");
    refresh.onclick = load;
    const dismiss = iconButton("x", "Close host stats");
    dismiss.onclick = () => {
      close();
      document.getElementById("input").focus();
    };
    header.append(el("h2", "", "Host"), refresh, dismiss);
    panel = el("div", "host-card-panel");
    panel.id = "host-card-panel";
    panel.setAttribute("role", "tabpanel");
    panel.tabIndex = 0;
    card.append(header, createTabs(), panel);
    container.prepend(card);
    load();
  }
  return { open, close };
}
