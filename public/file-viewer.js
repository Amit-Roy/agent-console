// Loaded after the conversation is painted and the browser is idle, or when a file link is first opened.

import { handleEditClick, prepareEdit, resetEdit } from "/file-viewer-edit.js";
import {
  applyMeta,
  isStale,
  metricThread,
  paint,
  record,
  renderFile,
  renderImage,
  renderMedia,
  revokeImage,
  scopeParams,
  stopMedia,
  updatePerformance,
} from "/file-viewer-render.js";
import { abortTreeRequests, ensureTree, resetTree, showTree } from "/file-viewer-tree.js";
import { el as createElement, icon, iconButton, parseFileRef, wireCopy } from "/render.js";

let style;
export function prepare() {
  return (style ||= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/file-viewer.css";
    link.onload = resolve;
    link.onerror = () => {
      link.remove();
      style = null;
      reject(new Error("Could not load the file viewer. Try again."));
    };
    document.head.append(link);
  }));
}

function buildDom() {
  const dialog = createElement("dialog", "file-viewer");
  dialog.id = "file-viewer";
  dialog.setAttribute("aria-labelledby", "file-viewer-title");
  const header = createElement("header", "file-viewer-head");
  const heading = createElement("div", "file-viewer-heading");
  const title = createElement("h2");
  title.id = "file-viewer-title";
  const path = createElement("p", "file-viewer-path");
  path.id = "file-viewer-path";
  const copyPath = iconButton("copy", "Copy path");
  const pathRow = createElement("div", "file-viewer-path-row");
  pathRow.style.cssText = "display:flex;align-items:center;gap:var(--sp-2);";
  pathRow.append(path, copyPath);
  const meta = createElement("div", "file-viewer-meta");
  const status = createElement("span");
  status.id = "file-viewer-status";
  status.setAttribute("role", "status");
  meta.append(status);
  heading.append(title, pathRow, meta);
  const close = iconButton("x", "Close file viewer");
  close.autofocus = true;
  header.append(heading, close);
  const toolbar = createElement("div", "file-viewer-toolbar");
  const wrap = createElement("button", "btn sm ghost");
  wrap.type = "button";
  wrap.setAttribute("aria-label", "Wrap lines");
  wrap.setAttribute("aria-pressed", "false");
  wrap.append(icon("wrap"), createElement("span", "", "Wrap"));
  const copy = createElement("button", "btn sm ghost");
  copy.type = "button";
  copy.setAttribute("aria-label", "Copy file");
  copy.title = "Copy file";
  copy.append(icon("copy"), createElement("span", "lab", "Copy file"));
  const position = createElement("span", "file-viewer-position");
  const source = createElement("button", "btn sm ghost", "Source");
  source.type = "button";
  source.hidden = true;
  source.setAttribute("aria-pressed", "false");
  source.title = "Show Markdown source";
  const files = createElement("button", "btn sm ghost", "Files");
  files.type = "button";
  files.setAttribute("aria-label", "Show files");
  files.setAttribute("aria-controls", "file-viewer-tree");
  const timings = createElement("button", "btn sm ghost", "Info");
  timings.type = "button";
  timings.setAttribute("aria-expanded", "false");
  timings.setAttribute("aria-controls", "file-viewer-performance");
  const edit = createElement("a", "btn sm ghost", "Edit");
  edit.id = "file-viewer-edit";
  edit.hidden = true;
  edit.title = "Edit in Acode";
  edit.setAttribute("aria-label", "Edit");
  toolbar.append(files, edit, source, wrap, copy, timings, position);
  const performanceDetails = createElement("div", "file-viewer-performance");
  performanceDetails.id = "file-viewer-performance";
  performanceDetails.hidden = true;
  const infoList = createElement("dl", "file-viewer-info"),
    timingList = createElement("div", "file-viewer-timings");
  performanceDetails.append(infoList, timingList);
  const setup = createElement("a", "", "Set up Acode editing");
  setup.href = "/acode-setup";
  setup.target = "_blank";
  setup.rel = "noopener";
  performanceDetails.append(setup);
  const linkPill = createElement("span", "file-viewer-readonly", "Symlink");
  linkPill.hidden = true;
  const outsidePill = createElement(
    "span",
    "file-viewer-readonly file-viewer-warn",
    "Outside repo",
  );
  outsidePill.hidden = true;
  const extra = createElement("span");
  meta.append(linkPill, outsidePill, extra);
  const workspace = createElement("div", "file-viewer-workspace");
  const sidebar = createElement("nav", "file-viewer-tree");
  sidebar.id = "file-viewer-tree";
  sidebar.setAttribute("aria-label", "Project files");
  const treeTitle = createElement("div", "file-tree-title", "Project files");
  const tree = createElement("div", "file-tree-list");
  sidebar.append(treeTitle, tree);
  const main = createElement("div", "file-viewer-main");
  const body = createElement("div", "file-viewer-code");
  body.id = "file-viewer-code";
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", "File contents");
  const error = createElement("div", "file-viewer-error");
  error.hidden = true;
  const retry = createElement("button", "btn", "Retry");
  retry.type = "button";
  error.append(retry);
  main.append(error, body);
  workspace.append(sidebar, main);
  dialog.append(header, toolbar, performanceDetails, workspace);
  return {
    dialog,
    title,
    path,
    copyPath,
    close,
    wrap,
    copy,
    position,
    source,
    files,
    timings,
    edit,
    status,
    infoList,
    timingList,
    performanceDetails,
    linkPill,
    outsidePill,
    extra,
    sidebar,
    treeTitle,
    tree,
    body,
    error,
    retry,
  };
}

function newViewer(apiFetch, report) {
  return {
    ...buildDom(),
    apiFetch,
    report,
    controller: undefined,
    current: undefined,
    content: "",
    restoreFocus: undefined,
    generation: 0,
    imageObjectUrl: undefined,
    currentTextFile: undefined,
    markdownSource: false,
    editTicket: undefined,
    editTimer: undefined,
    editPending: undefined,
    treeGeneration: 0,
    treeThread: undefined,
    treeRoot: undefined,
    treeEntries: 0,
    treeShown: !matchMedia("(max-width:640px)").matches,
    directories: new Map(),
    treeControllers: new Set(),
    metrics: (window.agentConsoleViewerMetrics ||= []),
    load: undefined,
  };
}

async function toggleSource(viewer) {
  if (!viewer.currentTextFile) return;
  const token = viewer.generation,
    startedAt = performance.now();
  viewer.markdownSource = !viewer.markdownSource;
  viewer.body.scrollTop = 0;
  viewer.body.scrollLeft = 0;
  renderFile(viewer, viewer.currentTextFile.file, viewer.currentTextFile.ref, token);
  await paint();
  if (!isStale(viewer, token))
    record(viewer, {
      kind: "viewer_open",
      thread: metricThread(viewer.current),
      total_ms: performance.now() - startedAt,
      render_ms: performance.now() - startedAt,
      bytes: viewer.currentTextFile.file.bytes || 0,
      events: 1,
    });
}

function openMarkdownLink(viewer, event) {
  if (event.type === "auxclick" && event.button !== 1) return;
  if (!viewer.body.classList.contains("is-markdown")) return;
  const link = event.target.closest?.("a");
  const ref = link && parseFileRef(link.dataset.fileRef || link.getAttribute("href"));
  if (!ref) return;
  event.preventDefault();
  if (!ref.path.startsWith("/") && !ref.path.startsWith("~/"))
    ref.path = decodeURIComponent(
      new URL(ref.path, new URL(viewer.currentTextFile.file.path, location.origin)).pathname,
    );
  viewer.current = { ...viewer.current, ref, openedAt: undefined, module_ms: 0 };
  viewer.load(viewer.current);
}

function setWrapped(viewer, on) {
  viewer.wrap.setAttribute(
    "aria-pressed",
    String(viewer.dialog.classList.toggle("is-wrapped", on)),
  );
  try {
    localStorage.setItem("file-viewer-wrap", on ? "1" : "0");
  } catch {}
}

function trapTab(viewer, event) {
  if (event.key !== "Tab") return;
  const controls = [
    ...viewer.dialog.querySelectorAll("button:not(:disabled), a[href], [tabindex='0']"),
  ].filter((node) => node.getClientRects().length);
  const first = controls[0],
    last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function closeOnBackdrop(viewer, event) {
  const { dialog } = viewer;
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    dialog.close();
}

function onDialogClose(viewer) {
  resetEdit(viewer);
  viewer.controller?.abort();
  viewer.generation++;
  viewer.treeGeneration++;
  abortTreeRequests(viewer);
  revokeImage(viewer);
  stopMedia(viewer);
  if (viewer.restoreFocus?.isConnected) viewer.restoreFocus.focus({ preventScroll: true });
}

function reloadCurrent(viewer, openedAt) {
  viewer.current = { ...viewer.current, openedAt, module_ms: 0 };
  viewer.load(viewer.current);
}

/** Clear the body and header for a new request, returning the generation token and start time. */
function resetForLoad(viewer, request) {
  const { body, path } = viewer;
  resetEdit(viewer);
  viewer.controller?.abort();
  viewer.controller = new AbortController();
  const token = ++viewer.generation,
    startedAt = request.openedAt || performance.now();
  revokeImage(viewer);
  stopMedia(viewer);
  viewer.content = "";
  viewer.currentTextFile = null;
  viewer.source.hidden = true;
  viewer.copy.disabled = true;
  viewer.wrap.disabled = true;
  viewer.title.textContent = request.ref.path.split("/").at(-1) || request.ref.path;
  path.textContent = request.ref.imageUrl ? "Attached image" : request.ref.path;
  path.title = path.textContent;
  viewer.status.textContent = "Loading…";
  viewer.position.textContent = "";
  applyMeta(viewer, null);
  viewer.error.hidden = true;
  body.hidden = false;
  body.replaceChildren();
  body.classList.remove("is-plain", "is-image", "is-markdown");
  body.scrollTop = 0;
  body.scrollLeft = 0;
  viewer.dialog.setAttribute("aria-busy", "true");
  return { token, startedAt };
}

/** Fold a rendered image/media result into the timing stats. */
function absorbImageStats(stats, imageStats) {
  stats.imageStats = imageStats;
  stats.receivedAt = imageStats.receivedAt || stats.receivedAt;
  stats.decodedAt = imageStats.readyAt || performance.now();
  stats.roundtrip_ms += imageStats.imageNetwork || 0;
  stats.decode_ms += imageStats.imageDecode || 0;
}

async function loadAttachedImage(viewer, request, token, stats) {
  const imageStats = await renderImage(
    viewer,
    request.ref.imageUrl,
    viewer.title.textContent,
    token,
    stats.signal,
  );
  stats.imageStats = imageStats;
  stats.receivedAt = imageStats.receivedAt || stats.requestAt;
  stats.decodedAt = imageStats.readyAt || performance.now();
  stats.roundtrip_ms = imageStats.imageNetwork || 0;
  stats.decode_ms = imageStats.imageDecode || 0;
}

async function renderByKind(viewer, request, token, stats) {
  const { file, signal } = stats;
  if (file.kind === "image") {
    const imageStats = await renderImage(viewer, file.url, file.name, token, signal);
    applyMeta(viewer, file);
    absorbImageStats(stats, imageStats);
  } else if (file.kind === "media") {
    const imageStats = await renderMedia(viewer, file, token, signal);
    applyMeta(viewer, file);
    absorbImageStats(stats, imageStats);
  } else {
    if (typeof file.content !== "string") throw new Error("The server returned an invalid file.");
    viewer.currentTextFile = { file, ref: request.ref };
    viewer.markdownSource = !!request.ref.line;
    renderFile(viewer, file, request.ref, token);
    applyMeta(viewer, file);
    viewer.edit.hidden = false;
    prepareEdit(viewer, token).catch(() => {});
  }
}

/** Fetch and show a file; returns false when the viewer moved on before it rendered. */
async function loadFileRef(viewer, request, token, stats) {
  const params = new URLSearchParams({ ...scopeParams(request), path: request.ref.path });
  const response = await viewer.apiFetch(`/api/file?${params}`, {
    signal: stats.signal,
    cache: "no-store",
  });
  const raw = await response.text();
  stats.receivedAt = performance.now();
  const file = JSON.parse(raw);
  stats.file = file;
  stats.decodedAt = performance.now();
  stats.roundtrip_ms = stats.receivedAt - stats.requestAt;
  stats.decode_ms = stats.decodedAt - stats.receivedAt;
  if (!response.ok) throw new Error(file.error || "Could not open this file.");
  if (isStale(viewer, token)) return false;
  if (typeof file.path !== "string") throw new Error("The server returned an invalid file.");
  viewer.current.ref.path = file.path;
  await renderByKind(viewer, request, token, stats);
  return true;
}

async function showLoadError(viewer, request, token, startedAt, failure) {
  if (token !== viewer.generation || failure.name === "AbortError" || !viewer.dialog.open) return;
  viewer.status.textContent = failure.message || "Could not open this file.";
  viewer.body.hidden = true;
  viewer.error.hidden = false;
  record(viewer, {
    kind: "viewer_open",
    thread: metricThread(request),
    total_ms: performance.now() - startedAt,
    events: 0,
  });
  await paint();
  if (!isStale(viewer, token)) ensureTree(viewer);
}

function recordOpen(viewer, request, startedAt, stats) {
  const { file } = stats;
  record(viewer, {
    kind: "viewer_open",
    thread: metricThread(request),
    total_ms: performance.now() - startedAt,
    module_ms: request.module_ms || 0,
    wait_ms: stats.receivedAt - startedAt,
    roundtrip_ms: stats.roundtrip_ms,
    server_ms: file?.read_ms || 0,
    decode_ms: stats.decode_ms,
    render_ms: performance.now() - stats.decodedAt,
    bytes: stats.imageStats.bytes || file?.bytes || 0,
    events: 1,
  });
}

/** Load and render the requested file; returns false when the viewer moved on early. */
async function fetchContent(viewer, request, token, stats) {
  if (!request.ref.imageUrl) return loadFileRef(viewer, request, token, stats);
  await loadAttachedImage(viewer, request, token, stats);
  return true;
}

async function load(viewer, request) {
  const { token, startedAt } = resetForLoad(viewer, request);
  try {
    const now = performance.now();
    const stats = {
      file: undefined,
      receivedAt: now,
      decodedAt: now,
      decode_ms: 0,
      roundtrip_ms: 0,
      imageStats: {},
      signal: viewer.controller.signal,
      requestAt: performance.now(),
    };
    if (!(await fetchContent(viewer, request, token, stats))) return;
    if (isStale(viewer, token)) return;
    await paint();
    if (isStale(viewer, token)) return;
    recordOpen(viewer, request, startedAt, stats);
    ensureTree(viewer);
  } catch (failure) {
    await showLoadError(viewer, request, token, startedAt, failure);
  } finally {
    if (token === viewer.generation) viewer.dialog.setAttribute("aria-busy", "false");
  }
}

function openWorkspace(viewer, { opener, openedAt, module_ms }) {
  const { body, path } = viewer;
  resetEdit(viewer);
  viewer.controller?.abort();
  viewer.generation++;
  resetTree(viewer);
  viewer.treeTitle.textContent = "repos";
  viewer.treeTitle.title = "~/repos";
  revokeImage(viewer);
  viewer.current = { scope: "repos", ref: { path: "" } };
  viewer.content = "";
  viewer.currentTextFile = null;
  viewer.markdownSource = false;
  viewer.title.textContent = "Files";
  path.textContent = "~/repos";
  path.title = "~/repos";
  viewer.status.textContent = "";
  viewer.position.textContent = "";
  viewer.source.hidden = true;
  viewer.copy.disabled = true;
  viewer.wrap.disabled = true;
  viewer.error.hidden = true;
  body.hidden = false;
  body.classList.remove("is-plain", "is-image", "is-markdown");
  body.replaceChildren(createElement("p", "file-tree-note", "Select a file to preview."));
  body.scrollTop = 0;
  body.scrollLeft = 0;
  viewer.performanceDetails.hidden = true;
  viewer.timings.setAttribute("aria-expanded", "false");
  viewer.dialog.setAttribute("aria-busy", "false");
  viewer.restoreFocus = opener || document.activeElement;
  if (!viewer.dialog.open) viewer.dialog.showModal();
  viewer.treeShown = true;
  showTree(viewer);
  ensureTree(viewer);
  record(viewer, {
    kind: "viewer_open",
    thread: "viewer:repos",
    total_ms: performance.now() - openedAt,
    module_ms,
    events: 0,
  });
}

function openFile(viewer, { thread, ref, opener, openedAt, module_ms }) {
  const wasOpen = viewer.dialog.open;
  viewer.current = { thread, ref, openedAt, module_ms };
  if (!wasOpen) {
    viewer.restoreFocus = opener || document.activeElement;
    viewer.dialog.showModal();
    viewer.tree.replaceChildren();
    viewer.directories.clear();
  }
  load(viewer, viewer.current);
}

export function createFileViewer(apiFetch, report = () => {}) {
  const viewer = newViewer(apiFetch, report);
  const { dialog, body } = viewer;
  document.body.append(dialog);
  viewer.load = (request) => load(viewer, request);
  viewer.edit.onclick = (event) => handleEditClick(viewer, event);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !dialog.open || !viewer.currentTextFile) return;
    // Refresh content and access after returning from the native editor.
    viewer.load({ ...viewer.current, openedAt: performance.now(), module_ms: 0 });
  });
  viewer.timings.onclick = () => {
    const details = viewer.performanceDetails;
    details.hidden = !details.hidden;
    viewer.timings.setAttribute("aria-expanded", String(!details.hidden));
    updatePerformance(viewer);
  };
  showTree(viewer);
  viewer.files.onclick = () => {
    viewer.treeShown = !viewer.treeShown;
    showTree(viewer);
    if (viewer.treeShown) ensureTree(viewer);
  };
  wireCopy(viewer.copy, () => viewer.content, "Copy file");
  wireCopy(viewer.copyPath, () => viewer.path.textContent, "Copy path");
  viewer.source.onclick = () => toggleSource(viewer);
  body.addEventListener("click", (event) => openMarkdownLink(viewer, event));
  body.addEventListener("auxclick", (event) => openMarkdownLink(viewer, event));
  viewer.wrap.onclick = () => setWrapped(viewer, !dialog.classList.contains("is-wrapped"));
  try {
    if (localStorage.getItem("file-viewer-wrap") === "1") setWrapped(viewer, true);
  } catch {}
  viewer.close.onclick = () => dialog.close();
  dialog.addEventListener("keydown", (event) => trapTab(viewer, event));
  dialog.addEventListener("click", (event) => closeOnBackdrop(viewer, event));
  dialog.addEventListener("close", () => onDialogClose(viewer));
  viewer.retry.onclick = () => {
    if (viewer.current) reloadCurrent(viewer, performance.now());
  };
  return {
    record: (sample) => record(viewer, sample),
    openWorkspace: (args) => openWorkspace(viewer, args),
    open: (args) => openFile(viewer, args),
  };
}
