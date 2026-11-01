// Time travel: checkpoint History panel (scrubber, per-file diffs), rewind with undo, and fork-from-here.
// The server owns checkpoints; transcript events carry the changed-file list, the HTTP routes carry diffs and rewinds.
import { $, el, highlightInto, icon, iconButton } from "./render.js";

const KIND_LABEL = {
  turn_start: "Turn start",
  tool: "Tool",
  turn_end: "Turn end",
  pre_rewind: "Before rewind",
};
const BIG_KINDS = new Set(["turn_start", "turn_end"]);
const STATUS_KINDS = ["A", "M", "D"];
const TONE = { A: "add", M: "mod", D: "del" };
const STATUS_WORD = { A: "added", M: "modified", D: "deleted" };
const JSON_HEADERS = { "content-type": "application/json" };
const DRAG_DELAY_MS = 120;
const UNDO_MS = 15000;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const phoneMode = () => matchMedia("(pointer: coarse), (max-width: 700px)").matches;
const calmMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Count changed files per status letter. */
export function mixOf(files = []) {
  const mix = { A: 0, M: 0, D: 0 };
  for (const file of files) if (file.s in mix) mix[file.s]++;
  return mix;
}
const mixKinds = (mix) => STATUS_KINDS.filter((kind) => mix[kind] > 0);
/** Colour family of a tick: one status, a mix of statuses, nothing changed, or not loaded yet. */
export function tickTone(mix) {
  if (!mix) return "unknown";
  const kinds = mixKinds(mix);
  if (!kinds.length) return "none";
  return kinds.length === 1 ? TONE[kinds[0]] : "mixed";
}
/** The text label that always accompanies a tick colour. */
export function mixLetter(mix) {
  const kinds = mix ? mixKinds(mix) : [];
  if (!kinds.length) return "";
  return kinds.length === 1 ? kinds[0] : "±";
}
export function mixText(mix) {
  if (!mix) return "changes not loaded";
  const kinds = mixKinds(mix);
  return kinds.length ? kinds.map((kind) => `${mix[kind]} ${kind}`).join(" · ") : "no file changes";
}
/** Split a unified diff into one section per file, keyed by the new path. */
export function splitPatch(patch) {
  const sections = new Map();
  for (const part of String(patch || "").split(/^(?=diff --git )/m)) {
    const head = part.split("\n", 1)[0];
    const marker = head.lastIndexOf(" b/");
    if (marker >= 0) sections.set(head.slice(marker + 3), part);
  }
  return sections;
}

const tickLabel = (info, mix) =>
  `Checkpoint ${info.seq}, ${KIND_LABEL[info.kind] ?? info.kind}, ${mixText(mix)}`;

function rowText(event) {
  const total = event.filesTotal ?? event.files?.length ?? 0;
  const label = KIND_LABEL[event.kind] ?? "Checkpoint";
  const files = total ? ` · ${plural(total, "file")} (${mixText(mixOf(event.files))})` : "";
  return `${label} · #${event.seq}${files}`;
}
/** Thin transcript row that anchors a checkpoint; clicking it opens the History panel there. */
export function checkpointRow(event, onOpen) {
  const row = el("div", `tt-row ${event.kind}`);
  row.dataset.ttSeq = String(event.seq);
  const button = el("button", "tt-row-btn");
  button.type = "button";
  button.append(icon("clock"), el("span", "tt-row-text", rowText(event)));
  button.onclick = () => onOpen(event.seq);
  row.append(button);
  return row;
}
export function rewoundRow(event) {
  const row = el("div", "tt-row rewound");
  row.append(
    icon("refresh"),
    el("span", "tt-row-text", `Files rewound to checkpoint ${event.seq}`),
  );
  return row;
}

function statusBadge(status) {
  const badge = el("span", "tt-badge", status);
  badge.dataset.s = status;
  badge.title = STATUS_WORD[status] ?? status;
  return badge;
}
function countsRow(mix) {
  const row = el("div", "tt-counts");
  for (const kind of STATUS_KINDS) {
    const item = el("span", "tt-count");
    item.dataset.s = kind;
    item.append(el("b", "", kind), ` ${mix[kind]} ${STATUS_WORD[kind]}`);
    row.append(item);
  }
  return row;
}
function fileStats(change) {
  if (!change || (!change.a && !change.d)) return null;
  const stats = el("span", "tt-stats");
  stats.append(el("span", "plus", `+${change.a}`), el("span", "minus", `−${change.d}`));
  return stats;
}
/** Plain list of paths with status badges, used by the rewind confirmation. */
function pathList(files) {
  return files.map((file) => {
    const item = el("li", "tt-plain");
    item.append(statusBadge(file.s), el("span", "tt-path", file.p));
    return item;
  });
}

function makeContext(deps) {
  const undoBox = el("div", "tt-toast");
  undoBox.setAttribute("role", "status");
  undoBox.hidden = true;
  document.body.append(undoBox);
  return {
    deps,
    model: { thread: null, list: [], index: -1, base: "prev", loadId: 0, pending: null },
    filesByThread: new Map(),
    diffCache: new Map(),
    panel: $("tt-panel"),
    track: $("tt-track"),
    range: $("tt-range"),
    timers: {},
    dragging: false,
    opener: null,
    undoSeq: null,
    undoBox,
  };
}
const isOpen = (ctx) => !ctx.panel.hidden;
const currentThread = (ctx) => ctx.deps.current();
const selected = (ctx) => ctx.model.list[ctx.model.index] ?? null;
const latestCommit = (ctx) => ctx.model.list.at(-1)?.commit;
const apiPath = (ctx, path) => `/api/threads/${currentThread(ctx)}/checkpoints${path}`;
function filesMap(ctx, threadId) {
  if (!ctx.filesByThread.has(threadId)) ctx.filesByThread.set(threadId, new Map());
  return ctx.filesByThread.get(threadId);
}
function mixFor(ctx, seq) {
  const files = filesMap(ctx, ctx.model.thread).get(seq);
  return files ? mixOf(files) : null;
}

// ---------- scrubber ----------
function applyTick(ctx, button, info) {
  const mix = mixFor(ctx, info.seq);
  button.dataset.tone = tickTone(mix);
  button.querySelector(".tt-letter").textContent = mixLetter(mix);
  const label = tickLabel(info, mix);
  button.title = label;
  button.setAttribute("aria-label", label);
}
function tickButton(ctx, info, index) {
  const button = el("button", `tt-tick ${BIG_KINDS.has(info.kind) ? "big" : "small"}`);
  button.type = "button";
  button.dataset.index = String(index);
  button.append(el("b", "tt-letter"), el("i", "tt-bar"));
  applyTick(ctx, button, info);
  button.onclick = () => select(ctx, index);
  return button;
}
function renderTrack(ctx) {
  const { model, track, range } = ctx;
  track.replaceChildren(...model.list.map((info, index) => tickButton(ctx, info, index)));
  const empty = model.list.length === 0;
  $("tt-empty").hidden = !empty;
  for (const part of ["tt-scrub", "tt-detail", "tt-actions"]) $(part).hidden = empty;
  range.max = String(Math.max(0, model.list.length - 1));
}
function markSelection(ctx) {
  const { model, track } = ctx;
  for (const tick of track.children) {
    const active = Number(tick.dataset.index) === model.index;
    tick.setAttribute("aria-pressed", String(active));
    tick.tabIndex = active ? 0 : -1;
    if (active) tick.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
  }
  ctx.range.value = String(model.index);
  const info = selected(ctx);
  $("tt-position").textContent = info
    ? `${model.index + 1} of ${model.list.length} · #${info.seq} ${KIND_LABEL[info.kind] ?? info.kind}`
    : "";
  $("tt-prev").disabled = model.index <= 0;
  $("tt-next").disabled = model.index >= model.list.length - 1;
}
function scrollTranscript(ctx, seq) {
  const chat = $("chat");
  chat.querySelector(".tt-row.tt-active")?.classList.remove("tt-active");
  const row = chat.querySelector(`[data-tt-seq="${seq}"]`);
  $("tt-missing").hidden = Boolean(row);
  if (!row) return;
  row.classList.add("tt-active");
  row.scrollIntoView({
    block: phoneMode() ? "start" : "center",
    behavior: calmMotion() || ctx.dragging ? "auto" : "smooth",
  });
}
function select(ctx, index, options = {}) {
  const { model } = ctx;
  if (!model.list.length) return;
  model.index = Math.max(0, Math.min(model.list.length - 1, index));
  markSelection(ctx);
  if (options.focus) ctx.track.children[model.index]?.focus({ preventScroll: true });
  scrollTranscript(ctx, selected(ctx).seq);
  clearTimeout(ctx.timers.detail);
  ctx.timers.detail = setTimeout(() => loadDetail(ctx, model.index), options.delay ?? 0);
}
function tickAt(ctx, event) {
  const box = ctx.track.getBoundingClientRect();
  const hit = document.elementFromPoint(event.clientX, box.top + box.height / 2);
  return hit?.closest?.(".tt-tick");
}
function dragTo(ctx, event) {
  const tick = tickAt(ctx, event);
  if (tick && Number(tick.dataset.index) !== ctx.model.index)
    select(ctx, Number(tick.dataset.index), { delay: DRAG_DELAY_MS });
}
function startDrag(ctx, event) {
  if (event.button !== 0) return;
  ctx.dragging = true;
  ctx.track.setPointerCapture?.(event.pointerId);
  dragTo(ctx, event);
}
function trackKey(ctx, event) {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key];
  const edge = { Home: 0, End: ctx.model.list.length - 1 }[event.key];
  if (step === undefined && edge === undefined) return;
  event.preventDefault();
  select(ctx, edge ?? ctx.model.index + step, { focus: true });
}
function wireScrubber(ctx) {
  const endDrag = () => {
    ctx.dragging = false;
  };
  ctx.track.addEventListener("pointerdown", (event) => startDrag(ctx, event));
  ctx.track.addEventListener("pointermove", (event) => ctx.dragging && dragTo(ctx, event));
  ctx.track.addEventListener("pointerup", endDrag);
  ctx.track.addEventListener("pointercancel", endDrag);
  ctx.track.addEventListener("keydown", (event) => trackKey(ctx, event));
  ctx.range.addEventListener("input", () =>
    select(ctx, Number(ctx.range.value), { delay: DRAG_DELAY_MS }),
  );
  $("tt-prev").onclick = () => select(ctx, ctx.model.index - 1);
  $("tt-next").onclick = () => select(ctx, ctx.model.index + 1);
}

// ---------- detail: counts, files, diffs ----------
async function fetchDiff(ctx, info) {
  const key = `${ctx.model.thread}:${info.seq}:${ctx.model.base}`;
  if (ctx.diffCache.has(key)) return ctx.diffCache.get(key);
  const res = await ctx.deps.apiFetch(apiPath(ctx, `/${info.seq}/diff?base=${ctx.model.base}`), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Could not load this diff.");
  const data = await res.json();
  ctx.diffCache.set(key, data);
  return data;
}
async function loadDetail(ctx, index) {
  const info = ctx.model.list[index];
  if (!info) return;
  const token = ++ctx.model.loadId;
  $("tt-detail").setAttribute("aria-busy", "true");
  try {
    const data = await fetchDiff(ctx, info);
    if (token !== ctx.model.loadId) return;
    learnFiles(ctx, info, data);
    renderDetail(ctx, info, data);
  } catch (error) {
    if (token === ctx.model.loadId) showDetailError(error.message);
  } finally {
    if (token === ctx.model.loadId) $("tt-detail").setAttribute("aria-busy", "false");
  }
}
function learnFiles(ctx, info, data) {
  const known = filesMap(ctx, ctx.model.thread);
  if (ctx.model.base !== "prev" || known.has(info.seq)) return;
  known.set(
    info.seq,
    data.files.map((file) => ({ ...file, a: 0, d: 0 })),
  );
  const tick = ctx.track.children[ctx.model.list.indexOf(info)];
  if (tick) applyTick(ctx, tick, info);
}
function showDetailError(message) {
  $("tt-summary").textContent = message;
  $("tt-files").replaceChildren();
  $("tt-counts").replaceChildren();
}
function renderDetail(ctx, info, data) {
  const recorded = filesMap(ctx, ctx.model.thread).get(info.seq) ?? [];
  const known = new Map(recorded.map((change) => [change.p, change]));
  $("tt-summary").textContent =
    `#${info.seq} ${KIND_LABEL[info.kind] ?? info.kind} · ${plural(data.files.length, "file")} changed`;
  $("tt-counts").replaceChildren(countsRow(mixOf(data.files)));
  $("tt-truncated").hidden = !data.truncated;
  const sections = splitPatch(data.patch);
  $("tt-files").replaceChildren(
    ...data.files.map((file) => fileItem(ctx, file, known.get(file.p), sections.get(file.p))),
  );
  $("tt-files-none").hidden = data.files.length > 0;
}
function openButton(ctx, file) {
  const button = iconButton("eye", `Open ${file.p}`, "btn icon sm ghost tt-open-file");
  button.disabled = file.s === "D";
  if (file.s === "D") button.title = "File was deleted";
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    ctx.deps.openFile(file.p, button);
  };
  return button;
}
function showFullDiff(file, text) {
  $("tt-diff-title").textContent = file.p;
  highlightInto($("tt-diff-code"), text, "diff");
  $("tt-diff-dialog").showModal();
}
function fileSummary(ctx, file, change) {
  const summary = el("summary");
  summary.append(statusBadge(file.s), el("span", "tt-path", file.p));
  const stats = fileStats(change);
  if (stats) summary.append(stats);
  summary.append(openButton(ctx, file));
  return summary;
}
function fileItem(ctx, file, change, text) {
  const item = el("li", "tt-file-item");
  const body = el("details", "tt-file");
  const summary = fileSummary(ctx, file, change);
  const code = el("code");
  const pre = el("pre", "tt-diff");
  pre.append(code);
  const diffText = text || "No text diff (binary file or too large).";
  summary.addEventListener("click", (event) => {
    if (!phoneMode()) return;
    event.preventDefault();
    showFullDiff(file, diffText);
  });
  body.addEventListener("toggle", () => {
    if (!body.open || code.dataset.done) return;
    code.dataset.done = "1";
    highlightInto(code, diffText, "diff");
  });
  body.append(summary, pre);
  item.append(body);
  return item;
}
function wireDetail(ctx) {
  $("tt-diff-close").onclick = () => $("tt-diff-dialog").close();
  $("tt-base").onchange = () => {
    ctx.model.base = $("tt-base").value;
    loadDetail(ctx, ctx.model.index);
  };
}

// ---------- load, open, close ----------
function pickIndex(model, want) {
  const bySeq = model.list.findIndex((entry) => entry.seq === want.seq);
  if (bySeq >= 0) return bySeq;
  const byTool = want.toolUseId
    ? model.list.findIndex((entry) => entry.toolUseId === want.toolUseId)
    : -1;
  return byTool >= 0 ? byTool : model.list.length - 1;
}
async function load(ctx, want = {}) {
  const threadId = currentThread(ctx);
  if (!threadId) return;
  try {
    const res = await ctx.deps.apiFetch(`/api/threads/${threadId}/checkpoints`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Could not load history.");
    const list = await res.json();
    if (threadId !== currentThread(ctx)) return;
    const keep = want.seq || want.toolUseId ? want : { seq: selected(ctx)?.seq };
    Object.assign(ctx.model, { thread: threadId, list });
    renderTrack(ctx);
    if (list.length) select(ctx, pickIndex(ctx.model, keep), { focus: Boolean(want.focus) });
    else ctx.model.index = -1;
  } catch (error) {
    ctx.model.list = [];
    renderTrack(ctx);
    $("tt-empty").textContent = error.message;
  }
}
function openPanel(ctx, target = {}) {
  if (!currentThread(ctx)) return;
  ctx.opener = target.opener ?? $("tt-toggle");
  ctx.panel.hidden = false;
  document.body.classList.add("tt-open");
  $("tt-toggle").setAttribute("aria-expanded", "true");
  $("tt-empty").textContent = "No checkpoints yet. They appear when the agent starts working.";
  load(ctx, { seq: target.seq, toolUseId: target.toolUseId, focus: true });
}
function closePanel(ctx) {
  if (!isOpen(ctx)) return;
  ctx.panel.hidden = true;
  document.body.classList.remove("tt-open");
  $("tt-toggle").setAttribute("aria-expanded", "false");
  $("chat").querySelector(".tt-row.tt-active")?.classList.remove("tt-active");
  if (ctx.opener?.isConnected) ctx.opener.focus({ preventScroll: true });
}
function refreshSoon(ctx) {
  clearTimeout(ctx.timers.refresh);
  ctx.timers.refresh = setTimeout(() => load(ctx, { seq: selected(ctx)?.seq }), 400);
}
function wirePanel(ctx) {
  $("tt-toggle").onclick = () => (isOpen(ctx) ? closePanel(ctx) : openPanel(ctx));
  $("tt-close").onclick = () => closePanel(ctx);
  ctx.panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.querySelector("dialog[open]")) closePanel(ctx);
  });
}

// ---------- rewind ----------
async function post(ctx, path, body) {
  const res = await ctx.deps.apiFetch(apiPath(ctx, path), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
const postRewind = (ctx, seq, extra) =>
  post(ctx, `/${seq}/rewind`, { expectCommit: latestCommit(ctx), ...extra });
function failureText(ctx, data) {
  if (data.error === "busy") {
    const names = (data.threads ?? []).map((threadId) => ctx.deps.titleOf(threadId)).join(", ");
    const verb = data.threads?.length > 1 ? "are" : "is";
    return `Blocked: ${names || "another thread"} ${verb} running in this folder. Wait for it to finish, then try again.`;
  }
  if (data.error === "stale")
    return "A newer checkpoint exists. History was reloaded; review it and try again.";
  if (data.error === "too_big") return "The folder is too big to snapshot, so nothing was changed.";
  return data.error || "Rewind failed.";
}
function resetConfirm(info) {
  $("tt-confirm-sub").textContent = `Restore files to checkpoint #${info.seq}.`;
  $("tt-confirm-warn").hidden = true;
  $("tt-confirm-error").textContent = "";
  $("tt-confirm-counts").replaceChildren();
  $("tt-confirm-files").replaceChildren();
  $("tt-confirm-go").disabled = true;
  $("tt-confirm-go").textContent = "Rewind";
  $("tt-confirm-wait").hidden = false;
}
function outsideText(count) {
  return count === 1
    ? "1 file changed outside this thread; it'll be saved first"
    : `${count} files changed outside this thread; they'll be saved first`;
}
function showPreview(data) {
  const files = data.files ?? [];
  const outside = data.outside ?? [];
  $("tt-confirm-wait").hidden = true;
  $("tt-confirm-counts").replaceChildren(countsRow(mixOf(files)));
  $("tt-confirm-files").replaceChildren(...pathList(files));
  $("tt-confirm-warn-text").textContent = outsideText(outside.length);
  $("tt-confirm-warn").hidden = outside.length === 0;
  if (files.length) $("tt-confirm-go").textContent = `Rewind ${plural(files.length, "file")}`;
  $("tt-confirm-go").disabled = false;
}
function showConfirmFailure(ctx, result) {
  $("tt-confirm-wait").hidden = true;
  $("tt-confirm-error").textContent = failureText(ctx, result.data);
  if (result.data.error === "stale") load(ctx);
}
async function startRewind(ctx) {
  const info = selected(ctx);
  if (!info) return;
  ctx.model.pending = info;
  resetConfirm(info);
  $("tt-confirm").showModal();
  const result = await postRewind(ctx, info.seq, { dryRun: true });
  if (!$("tt-confirm").open) return;
  if (result.ok) showPreview(result.data);
  else showConfirmFailure(ctx, result);
}
async function confirmRewind(ctx) {
  const info = ctx.model.pending;
  $("tt-confirm-go").disabled = true;
  const result = await postRewind(ctx, info.seq, {});
  if (!result.ok) return void showConfirmFailure(ctx, result);
  $("tt-confirm").close();
  showUndo(ctx, result.data.preRewindSeq, info.seq);
  load(ctx, { seq: selected(ctx)?.seq });
}
function wireRewind(ctx) {
  $("tt-rewind").onclick = () => startRewind(ctx);
  $("tt-confirm-go").onclick = () => confirmRewind(ctx);
  $("tt-confirm-cancel").onclick = () => $("tt-confirm").close();
}

// ---------- undo toast ----------
function hideUndo(ctx) {
  clearTimeout(ctx.timers.undo);
  ctx.undoBox.hidden = true;
  ctx.undoSeq = null;
}
function showUndo(ctx, preRewindSeq, fromSeq) {
  if (!ctx.undoBox.hidden && ctx.undoSeq === preRewindSeq) return;
  ctx.undoSeq = preRewindSeq;
  const undo = el("button", "btn sm tt-undo", "Undo rewind");
  undo.type = "button";
  undo.onclick = () => undoRewind(ctx, preRewindSeq);
  ctx.undoBox.replaceChildren(el("span", "", `Files rewound to checkpoint #${fromSeq}.`), undo);
  ctx.undoBox.hidden = false;
  clearTimeout(ctx.timers.undo);
  ctx.timers.undo = setTimeout(() => hideUndo(ctx), UNDO_MS);
}
async function undoRewind(ctx, preRewindSeq) {
  hideUndo(ctx);
  await load(ctx, { seq: selected(ctx)?.seq });
  const result = await postRewind(ctx, preRewindSeq, {});
  if (!result.ok) return void ctx.deps.toast(failureText(ctx, result.data));
  ctx.deps.toast("Rewind undone.");
  load(ctx, { seq: preRewindSeq });
}

// ---------- fork ----------
async function forkHere(ctx) {
  const info = selected(ctx);
  if (!info) return;
  const button = $("tt-fork");
  button.disabled = true;
  try {
    const result = await post(ctx, `/${info.seq}/fork`, {});
    if (!result.ok || !result.data.id) throw new Error(result.data.error || "Could not fork.");
    ctx.deps.toast(`Forked from checkpoint #${info.seq}.`);
    closePanel(ctx);
    ctx.deps.openThread(result.data.id);
  } catch (error) {
    ctx.deps.toast(error.message || "Could not fork.");
  } finally {
    button.disabled = false;
  }
}

function switchThread(ctx, current) {
  Object.assign(ctx.model, { thread: current?.id ?? null, list: [], index: -1 });
  ctx.diffCache.clear();
  hideUndo(ctx);
  if (!isOpen(ctx)) return;
  if (current) load(ctx);
  else closePanel(ctx);
}

/** deps: apiFetch, current(), titleOf(threadId), toast(text), openFile(path, opener), openThread(threadId). */
export function createTimeTravel(deps) {
  const ctx = makeContext(deps);
  wireScrubber(ctx);
  wireDetail(ctx);
  wirePanel(ctx);
  wireRewind(ctx);
  $("tt-fork").onclick = () => forkHere(ctx);
  return {
    open: (target) => openPanel(ctx, target),
    close: () => closePanel(ctx),
    isOpen: () => isOpen(ctx),
    /** A checkpoint event passed by while drawing the transcript. */
    record(event) {
      filesMap(ctx, currentThread(ctx)).set(event.seq, event.files ?? []);
      if (isOpen(ctx) && ctx.model.thread === currentThread(ctx)) refreshSoon(ctx);
    },
    row: (event) => checkpointRow(event, (seq) => openPanel(ctx, { seq })),
    rewoundRow,
    /** Server push: files were rewound (by any client). */
    onRewound(message) {
      if (message.thread !== currentThread(ctx)) return;
      showUndo(ctx, message.preRewindSeq, message.seq);
      if (isOpen(ctx)) refreshSoon(ctx);
    },
    /** Header button state; a different thread drops the loaded list. */
    renderButton(current) {
      $("tt-toggle").disabled = !current;
      if (current?.id !== ctx.model.thread) switchThread(ctx, current);
    },
  };
}
