import { $, el, icon, iconButton, wireCopy, renderMarkdown, highlightInto, langFromPath, parseFileRef, setFileScope } from "/render.js";
import { createMenu } from "/menu.js";
import { toolName, toolSummary } from "/tool-display.js";
import { createLatencyReporter } from "/telemetry.js";
import { createQuestions } from "/questions.js";

const MODE_META = {
  plan: { label: "Plan", desc: "Read-only. Plans without editing.", icon: "eye" },
  acceptEdits: { label: "Accept edits", desc: "Edits files without asking.", icon: "pencil" },
  bypassPermissions: { label: "Bypass", desc: "Runs every tool without asking.", icon: "shield-off", tone: "warn" },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const EFFORT_LABEL = { xhigh: "Extra high", ultracode: "Ultra" };
const EFFORT_DESC = { ultracode: "Claude Code's Ultracode: starts a multi-agent workflow on every task. Slow and costly; keep it for big jobs.", max: "Deepest reasoning the model offers.", xhigh: "More reasoning than High, less than Max." };
const effortLabel = (v) => EFFORT_LABEL[v] || cap(v);
const state = {
  commands: {}, providers: new Map(), threads: new Map(), current: null, ready: false, dirs: [], live: null, cards: new Map(), usage: {}, usageTab: "claude", ctxOpen: false, archiveOpen: !!localStorage.getItem("ac_archive_open"),
  stick: true, // the reader is at the bottom of the chat (kept from scroll events, since layout growth fires none)
  subs: new Map(), // tool_use id of a subagent (or nested subagent) -> the <ol> its activity is listed in
  subTools: new Map(), // tool_use id of a call made inside a subagent -> its row
  queues: {}, features: {}, // thread id -> messages waiting for the running turn to end
  loading: null, loadTimer: 0, renderToken: 0, rendering: false, pendingLive: [], into: null, start: 0,
};
setFileScope(() => state.current); // local image/video refs in markdown resolve against this thread's folder
const views = new Map(); // five most recently visited threads; stale snapshots remain visible during revalidation
let ws, retry = 0;

// ---------- connection ----------
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    signedOut = false;
    questions.setConnected(true);
    banner("");
  };
  ws.onclose = () => {
    questions.setConnected(false);
    if (queueEditor) {
      queueEditor.pending = false;
      $("queue-edit-error").textContent = "Disconnected. Reconnect to save, or reopen this editor after reconnecting.";
      $("queue-cancel").disabled = false;
      $("queue-save").disabled = queueEditor.revision == null;
      $("queue-draft").disabled = queueEditor.revision == null;
    }
    if (!signedOut) banner("Disconnected. Reconnecting…");
    if (retry >= 1) checkSignIn();
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
  };
  ws.onmessage = (m) => {
    const receivedAt = performance.now();
    const message = JSON.parse(m.data);
    if (message.t === "history") {
      message.wire_bytes = new TextEncoder().encode(m.data).byteLength;
      message.receivedAt = receivedAt;
      message.decode_ms = performance.now() - receivedAt;
      message.roundtrip_ms = receivedAt - state.requestSentAt;
    }
    handle(message);
  };
}
const send = (o) => { if (ws?.readyState !== 1) return false; ws.send(JSON.stringify(o)); return true; };
const questions = createQuestions({ send, root: () => $("chat"), changed: () => { renderThreads(); updateWorking(); } });
const latency = createLatencyReporter(samples => {
  if (ws?.readyState !== 1 || !state.features.latency) return false;
  ws.send(JSON.stringify({ t: "telemetry", samples }));
  return true;
}, () => state.features.latency);
function banner(t, action) {
  const b = $("banner");
  b.hidden = !t;
  b.textContent = t;
  if (action) {
    const btn = el("button", "btn sm", action.label);
    btn.type = "button";
    btn.onclick = action.run;
    b.append(" ", btn);
  }
}

// ---------- Coder sign-in ----------
// Behind Coder, an expired (or revoked) app session turns every request into a redirect to Coder's sign-in page on
// another site. fetch() cannot follow that, so it fails as "Failed to fetch". Requests go through apiFetch, which
// notices the redirect; only a top-level reload can sign in again, so offer one and keep the draft across it.
let signedOut = false;
function needSignIn() {
  if (signedOut) return;
  signedOut = true;
  banner("Coder sign-in expired.", { label: "Sign in again", run: signInAgain });
}
function signInAgain() {
  try { if ($("input").value) sessionStorage.setItem("ac_draft", $("input").value); } catch {}
  location.reload();
}
async function apiFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, redirect: "manual" });
  if (r.type === "opaqueredirect") {
    needSignIn();
    throw new Error("Coder sign-in expired. Tap Sign in again, then retry.");
  }
  return r;
}
// The websocket only reports a failed upgrade as a close; ask over plain HTTP whether that is a sign-in problem.
const checkSignIn = () => apiFetch("/manifest.webmanifest", { cache: "no-store" }).then(() => {}, () => {});

// File viewing adds no request to startup. Warm its module and stylesheet only after history has painted, in idle time.
let fileViewer, fileViewerLoad, fileWarmupScheduled = false;
function loadFileViewer(metricThread = state.current) {
  const at = performance.now();
  return fileViewerLoad ||= import("/file-viewer.js").then(async module => {
    await module.prepare();
    const viewer = fileViewer ||= module.createFileViewer(apiFetch, sample => latency.record(sample));
    viewer.record({ kind: "viewer_module", thread: metricThread, total_ms: performance.now() - at, module_ms: performance.now() - at });
    return viewer;
  }).catch(error => { fileViewerLoad = null; throw error; });
}
function warmFileViewer() {
  if (fileWarmupScheduled) return;
  fileWarmupScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const warm = () => { if (!document.hidden) loadFileViewer().catch(() => {}); };
    if ("requestIdleCallback" in window) window.requestIdleCallback(warm);
    else setTimeout(warm, 1500);
  }));
}
function openFileLink(event) {
  if (event.type === "auxclick" && event.button !== 1) return;
  const link = event.target.closest?.("a");
  if (!link || !$("chat").contains(link)) return;
  const image = link.dataset.viewerImage;
  const ref = image ? { path: link.title || link.querySelector("img")?.alt || "Image", imageUrl: link.getAttribute("href") } : parseFileRef(link.dataset.fileRef || link.getAttribute("href"));
  if (!ref || !state.current) return;
  event.preventDefault(); // modified clicks also stay inside the viewer instead of opening a broken app route
  const thread = state.current, openedAt = performance.now();
  link.setAttribute("aria-busy", "true");
  loadFileViewer().then(viewer => {
    if (state.current === thread && link.isConnected) viewer.open({ thread, ref, opener: link, openedAt, module_ms: performance.now() - openedAt });
  }).catch(error => toast(error.message || "Could not load the file viewer. Try again.")).finally(() => link.removeAttribute("aria-busy"));
}
$("files").onclick = async () => {
  const opener = $("files"), openedAt = performance.now();
  opener.setAttribute("aria-busy", "true");
  try {
    const viewer = await loadFileViewer("viewer:repos");
    setNav(false);
    viewer.openWorkspace({ opener, openedAt, module_ms: performance.now() - openedAt });
  } catch (error) { toast(error.message || "Could not load the file viewer. Try again."); }
  finally { opener.removeAttribute("aria-busy"); }
};
$("chat").addEventListener("click", openFileLink);
$("chat").addEventListener("auxclick", openFileLink);

function handle(m) {
  switch (m.t) {
    case "usage":
      state.usage[m.provider] = m.usage;
      renderUsage();
      break;
    case "commands":
      state.commands[m.provider] = m.commands;
      updateSlash();
      break;
    case "hello":
      // the server was swapped for a new build (restart-when-idle): reload to match, unless that would lose a draft
      if (state.build && m.build && m.build !== state.build) {
        if (!$("input").value && !queueEditor) return void location.reload();
        banner("Updated. Send or clear your draft, then reload for the new version.");
        break;
      }
      state.build = m.build || state.build;
      state.features = m.features || {};
      latency.flush();
      for (const view of views.values()) view.stale = true;
      state.commands = m.commands || {};
      state.usage = m.usage || {};
      state.queues = m.queues || {};
      for (const t of m.threads) {
        const events = m.questions?.[t.id] || [];
        questions.sync(t.id, Array.isArray(events) ? events : [events]);
      }
      state.dirs = m.dirs;
      state.providers = new Map(m.providers.map((p) => [p.id, p]));
      menus.model.provider = null; // re-read per-agent model lists below
      state.threads = new Map(m.threads.map((t) => [t.id, t]));
      menus.dProv.setItems(m.providers.map((p) => ({ value: p.id, label: p.label, desc: p.ok ? undefined : p.hint, disabled: !p.ok })), m.providers.find((p) => p.ok)?.id);
      menus.dCwd.setItems(m.dirs.map((d) => ({ value: d, label: d.replace(/^.*\/repos\/?/, "~/repos/") || d, icon: "folder" })), m.dirs[0]);
      fillDialog(menus.dProv.value);
      state.ready = true; // until the first hello there is nothing true to say, so the chat stays blank rather than "No thread"
      renderThreads();
      let last = null;
      try { last = localStorage.getItem("ac_thread"); } catch {}
      if (state.current && state.threads.has(state.current)) openThread(state.current);
      else if (last && state.threads.has(last)) openThread(last); // first load: reopen the thread the reader last had open
      else if (state.threads.size) openThread([...state.threads.values()][0].id);
      else {
        clearChat();
        renderHead();
        warmFileViewer();
      }
      break;
    case "thread":
      state.threads.set(m.thread.id, m.thread);
      renderThreads();
      if (m.thread.id === state.current) renderHead();
      else renderUsage();
      break;
    case "removed":
      state.threads.delete(m.thread);
      views.delete(m.thread);
      if (pending.length && pending[0].thread === m.thread) {
        pending.length = 0; // the server already deleted that thread's uploads
        renderThumbs();
      }
      if (state.current === m.thread) {
        state.current = null;
        clearChat();
        renderHead();
        const first = [...state.threads.values()][0];
        if (first) openThread(first.id);
      }
      renderThreads();
      break;
    case "created":
      openThread(m.thread.id);
      break;
    case "history":
      if (m.thread !== state.current || (m.request != null && m.request !== state.request)) break;
      if (m.before == null && m.questions) questions.sync(m.thread, m.questions);
      void (m.before != null ? showEarlier(m) : m.delta ? showDelta(m) : showHistory(m));
      break;
    case "answer_done":
    case "answer_error":
      questions.reply(m);
      break;
    case "queue":
      state.queues[m.thread] = m.items;
      if (m.thread === state.current) renderQueue();
      break;
    case "queue_edit":
    case "queue_edit_done":
    case "queue_edit_error":
      queuedEditReply(m);
      break;
    case "event":
      if (m.event.type === "question" || m.event.type === "question_answer") {
        questions.receive(m.thread, m.event, true);
        renderThreads(); updateWorking();
      }
      if (views.has(m.thread)) views.get(m.thread).stale = true;
      if (m.event.type === "rate_limit_event") setUsage(m.event, state.threads.get(m.thread)?.provider || "claude");
      if (m.thread !== state.current) break;
      if (state.revalidating && (!state.rendering || state.deferredRefresh)) {
        // Durable events before the history reply are already in its snapshot; deltas are never persisted.
        if (m.event.type === "stream_event") state.waitingLive.push(m.event);
        else if (m.event.type === "assistant" || m.event.type === "result") state.waitingLive = [];
        break;
      }
      if (m.seq) state.end = Math.max(state.end || 0, m.seq);
      if (state.rendering) state.pendingLive.push(m.event); // history is still being drawn: keep order, replay these after
      else onEvent(m.event, true);
      break;
    case "invalidate":
      if (views.has(m.thread)) views.get(m.thread).stale = true;
      break;
    case "error":
      addNote(m.message, "errtxt");
      break;
  }
}

// ---------- menus (model + mode chips in the composer, thread actions, new-thread fields) ----------
// "openrouter/nvidia/nemotron-3-super-120b-a12b:free" -> label "nemotron-3-super-120b-a12b", desc "openrouter · nvidia · free"
function modelMeta(v) {
  if (!v.includes("/")) return { label: v === "default" ? "Default" : cap(v) };
  const [prov, ...rest] = v.split("/");
  const id = rest.pop();
  const free = id.endsWith(":free");
  return { label: id.replace(/:free$/, ""), desc: [prov, rest.join("/"), free && "free"].filter(Boolean).join(" · ") };
}
const ADV = "advisor:";
const ADVISOR_LABEL = { default: "Settings default", off: "Off", opus: "Opus", fable: "Fable" };
// the model list, then (for agents that have an advisor) "Advisor · X" rows: one dropdown covers both choices
const withAdvisors = (items, p, advisor = "default") => !p?.advisors?.length ? items : [...items, ...["default", ...p.advisors].map((a) => ({ value: ADV + a, label: `Advisor · ${ADVISOR_LABEL[a] || cap(a)}`, desc: a === "default" ? "Use the advisor from your Claude settings." : a === "off" ? "No additional advisor model calls." : "A stronger model Claude consults before big decisions (additional usage).", icon: "sparkle", keep: true, checked: a === advisor }))];
const modelItems = (models, p) => models.map((v) => ({ value: v, ...modelMeta(v), ...(p?.modelDetails?.[v] ? { label: p.modelDetails[v].label, desc: p.modelDetails[v].description ?? modelMeta(v).desc } : {}) }));
function fillEffort(menu, p, model, value = "default") {
  const meta = p?.modelDetails?.[model];
  menu.setItems([{ value: "default", label: "Effort · default", desc: `Inherit ${p?.label || "agent"} configuration. ${meta?.defaultEffort ? `Model default: ${meta.defaultEffort}.` : meta?.efforts?.length ? "Choose an effort to override the inherited setting." : "This model does not report effort options."}` }, ...(meta?.efforts || []).map(value => ({ value, label: `Effort · ${effortLabel(value)}`, ...(EFFORT_DESC[value] ? { desc: EFFORT_DESC[value] } : {}) }))], value);
}
function dialogEffort(model = menus.dModel.value, id = menus.dProv.value) {
  const p = prov(id);
  $("effort-field").hidden = !p?.modelDetails;
  fillEffort(menus.dEffort, p, model);
}
const prov = (id) => state.providers.get(id);
const provLabel = (id) => prov(id)?.label || id || "";
function fillDialog(id) {
  const p = prov(id);
  if (!p) return;
  menus.dModel.setItems(modelItems(p.models, p), p.defaultModel);
  dialogEffort(p.defaultModel, id);
  menus.dMode.setItems(modeItems(p.modes), p.defaultMode);
  $("d-warn").hidden = p.defaultMode !== "bypassPermissions";
  $("d-note").hidden = !p.note;
  $("d-note").textContent = p.note || "";
  $("d-ok").disabled = !p.ok;
}
const modeItems = (modes) => modes.map((v) => ({ value: v, label: MODE_META[v]?.label || v, desc: MODE_META[v]?.desc, icon: MODE_META[v]?.icon, tone: MODE_META[v]?.tone }));

function chipTrigger(kind) {
  return (it, b) => {
    const kids = [];
    if (kind === "mode" && it?.icon) kids.push(icon(it.icon));
    kids.push(el("span", "chip-label", it?.label ?? ""));
    if (kind === "effort" || kind === "model") {
      const label = (it?.label ?? "").replace(/^Effort · /, "");
      const short = el("span", "compact-label", label === "CLI default" ? "Default" : label);
      short.setAttribute("aria-hidden", "true");
      kids.push(short);
    }
    kids.push(icon("chev-down", "chev"));
    b.replaceChildren(...kids);
    if (kind === "mode") {
      if (it?.tone) b.dataset.tone = it.tone;
      else delete b.dataset.tone;
    }
    b.setAttribute("aria-label", `${kind === "mode" ? "Permission mode" : kind === "effort" ? "Reasoning effort" : "Model"}: ${it?.label ?? ""}`);
    b.title = b.getAttribute("aria-label");
  };
}
function fieldTrigger(it, b) {
  b.replaceChildren(el("span", "", it?.label ?? ""), icon("chev-down", "chev"));
}
// ---------- thread actions: one list, used by the ⋯ on every row and by the header ⋯ ----------
const threadActions = (id) => {
  const cur = state.threads.get(id)?.provider;
  const others = [...state.providers.values()].filter((p) => p.id !== cur && p.id !== "mock" && p.ok !== false);
  const forks = others.map((p) => ({ value: `fork:${p.id}`, label: `Fork in ${p.label}`, desc: "Replay this conversation in another agent", icon: "fork" }));
  const filed = !!state.threads.get(id)?.archived;
  const thread = state.threads.get(id);
  const items = THREAD_ACTIONS.map((a) => {
    if (a.value === "idle-compaction") {
      const supported = Number.isFinite(thread?.idleCompactionTtlMs) && thread.idleCompactionTtlMs > 30_000;
      return { ...a, disabled: !supported,
        label: !supported ? "Automatic compaction unavailable" : thread.idleCompaction === false ? "Enable automatic compaction" : "Disable automatic compaction",
        desc: supported ? "Substantial idle contexts; 30s before estimated cache expiry" : "Cache lifetime is unknown for this provider" };
    }
    return a.value === "archive" && filed ? { value: "unarchive", label: "Unarchive", desc: "Back to the working list", icon: "archive" } : a;
  });
  const action = (value) => items.find((item) => item.value === value);
  return [
    action("rename"),
    { value: "compaction-menu", label: "Compaction", icon: "sparkle", children: [action("compact"), action("idle-compaction")] },
    action("economy"),
    { value: "fork-menu", label: "Fork", icon: "fork", children: [action("fork"), ...forks, action("fork-recent")] },
    action("download"), action("share"), action("details"),
    { value: "archive-menu", label: "Archive", icon: "archive", children: [action(filed ? "unarchive" : "archive"), action("delete")] },
  ];
};
const THREAD_ACTIONS = [
  { value: "rename", label: "Rename", icon: "pencil" },
  { value: "compact", label: "Compact context", desc: "Reduce context; keep the transcript", icon: "sparkle" },
  { value: "idle-compaction", label: "Automatic compaction", icon: "sparkle" },
  { value: "economy", label: "Economy settings", desc: "Use medium effort and turn the advisor off; keep the selected model", icon: "sparkle" },
  { value: "fork", label: "Fork", desc: "Continue in a new thread", icon: "fork" },
  { value: "fork-recent", label: "Fork with recent context", desc: "Carry a short recent handoff; keep the full transcript available", icon: "fork" },
  { value: "download", label: "Download", desc: "Save as a Markdown file", icon: "download" },
  { value: "share", label: "Share", desc: "Send the conversation as text", icon: "share" },
  { value: "details", label: "Run details", desc: "Model, effort, tokens and load timings", icon: "code" },
  { value: "archive", label: "Archive", desc: "Move out of the working list", icon: "archive" },
  { value: "delete", label: "Delete thread", icon: "trash", tone: "danger" },
];
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
async function runThreadAction(id, action) {
  const t = state.threads.get(id);
  if (!t) return;
  if (action === "rename") {
    setNav(false);
    if (state.current !== id) openThread(id);
    startRename();
  } else if (action === "compact") {
    send({ t: "compact", thread: id });
  } else if (action === "idle-compaction") {
    if (!t.idleCompactionTtlMs) return;
    const enabled = t.idleCompaction === false;
    send({ t: "update", thread: id, idleCompaction: enabled });
    toast(`Automatic compaction ${enabled ? "enabled" : "disabled"} for this thread.`);
  } else if (action === "economy") {
    if (t.status === "running") { toast("Apply economy settings when this turn finishes."); return; }
    const provider = state.providers.get(t.provider);
    const efforts = provider?.modelDetails?.[t.model]?.efforts || [];
    const effort = ["medium", "low"].find(e => efforts.includes(e)) || "default";
    send({ t: "update", thread: id, effort, ...(provider?.advisors?.includes("off") ? { advisor: "off" } : {}) });
    toast("Economy settings applied; selected model kept.");
  } else if (action === "details") {
    setNav(false);
    if (state.current !== id) openThread(id);
    $("run-details").showModal();
    void loadLatencySummary();
  } else if (action === "archive" || action === "unarchive") {
    send({ t: "archive", thread: id, archived: action === "archive" });
  } else if (action === "delete") {
    if (confirm(`Delete "${t.title}" and its history?`)) send({ t: "delete", thread: id });
  } else if (action === "fork-recent") {
    send({ t: "fork", thread: id, context: "recent" });
  } else if (action.startsWith("fork:")) {
    send({ t: "fork", thread: id, provider: action.slice(5) });
  } else if (action === "fork") {
    send({ t: "fork", thread: id }); // the server answers "created" and we open the new thread
  } else if (action === "download") {
    const a = el("a");
    a.href = `/export/${id}`;
    a.download = ""; // the server names the file after the thread
    document.body.append(a);
    a.click();
    a.remove();
  } else if (action === "share") {
    const r = await apiFetch(`/export/${id}`).catch(() => null);
    if (!r?.ok) return toast("Could not read that conversation.");
    const text = await r.text();
    if (navigator.share) {
      try {
        await navigator.share({ title: t.title, text });
        return;
      } catch (e) {
        if (e?.name === "AbortError") return; // the user closed the share sheet
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied the conversation as Markdown.");
    } catch {
      toast("Sharing is not available here. Use Download instead.");
    }
  }
}

const menus = {
  effort: createMenu({ trigger: $("effort"), label: "Reasoning effort", side: "top", renderTrigger: chipTrigger("effort"), onSelect: v => send({ t: "update", thread: state.current, effort: v }) }),
  dEffort: createMenu({ trigger: $("d-effort"), label: "Reasoning effort", renderTrigger: fieldTrigger }),
  model: createMenu({ trigger: $("model"), label: "Model", side: "top", renderTrigger: chipTrigger("model"), onSelect: (v) => send(v.startsWith(ADV) ? { t: "update", thread: state.current, advisor: v.slice(ADV.length) } : { t: "update", thread: state.current, model: v }) }),
  mode: createMenu({
    trigger: $("mode"), label: "Permission mode", side: "top", renderTrigger: chipTrigger("mode"),
    onSelect: (v) => {
      if (v === "bypassPermissions" && !confirm("Bypass mode runs every tool without asking, including shell commands on this machine. Enable for this thread?")) return false;
      send({ t: "update", thread: state.current, mode: v });
    },
  }),
  more: createMenu({
    trigger: $("more"), kind: "menu", label: "Thread actions", align: "end",
    items: THREAD_ACTIONS, getItems: () => threadActions(state.current),
    onSelect: (v) => state.current && runThreadAction(state.current, v),
  }),
  dProv: createMenu({ trigger: $("d-prov"), label: "Agent", renderTrigger: fieldTrigger, onSelect: (v) => fillDialog(v) }),
  dCwd: createMenu({ trigger: $("d-cwd"), label: "Folder", renderTrigger: fieldTrigger }),
  dModel: createMenu({ trigger: $("d-model"), label: "Model", renderTrigger: fieldTrigger, onSelect: v => dialogEffort(v) }),
  dMode: createMenu({ trigger: $("d-mode"), label: "Permission mode", renderTrigger: fieldTrigger, onSelect: (v) => { $("d-warn").hidden = v !== "bypassPermissions"; } }),
};

// ---------- threads UI ----------
const cur = () => state.threads.get(state.current);
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;

let rowMenuOpen = false; // rebuilding the list would pull the trigger out from under an open menu
let renderPending = false;
function renderThreads() {
  if (rowMenuOpen) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const ul = $("threads"), shelf = $("archived");
  ul.replaceChildren();
  shelf.replaceChildren();
  const list = [...state.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  // archived threads sit in their own section below, collapsed unless the user opened it
  const filed = list.filter((t) => t.archived).length;
  $("archive").hidden = !filed;
  $("archive-count").textContent = filed || "";
  $("archive-toggle").setAttribute("aria-expanded", String(state.archiveOpen));
  shelf.hidden = !state.archiveOpen;
  // the folder most threads share says nothing per row; only the odd ones out show theirs
  const dirs = new Map();
  for (const t of list) dirs.set(base(t.cwd), (dirs.get(base(t.cwd)) || 0) + 1);
  const usualDir = [...dirs].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const t of list) {
    const li = el("li", t.id === state.current ? "sel" : "");
    li.tabIndex = 0;
    li.title = `${t.title}\n${t.cwd}\n${provLabel(t.provider)} · ${modelMeta(t.model).label}${t.mode === "bypassPermissions" ? " · Bypass" : ""} · ${t.costMeasured ? `$${t.cost.toFixed(3)} recorded API-equivalent` : "cost not measured"}`;
    if (t.id === state.current) li.setAttribute("aria-current", "true");
    const waiting = questions.count(t.id) || t.waiting;
    const dot = el("span", `dot ${waiting ? "waiting" : t.status}`);
    dot.setAttribute("aria-hidden", "true");
    const meta = el("div", "meta");
    if (base(t.cwd) !== usualDir) meta.append(el("span", "dir", base(t.cwd)));
    meta.append(el("span", "tag", provLabel(t.provider || "claude")));
    if (t.mode === "bypassPermissions") {
      const tag = el("span", "tag warn");
      tag.title = "Bypass permissions";
      tag.append(icon("shield-off"), el("span", "sr-only", "Bypass"));
      meta.append(tag);
    }
    if (waiting) meta.append(el("span", "tag question-tag", "Needs input"));
    const time = el("time", "", ago(t.updatedAt));
    time.dateTime = new Date(t.updatedAt).toISOString();
    meta.append(time);
    const more = el("button", "btn sm icon ghost row-more");
    more.type = "button";
    more.title = "Thread actions";
    more.append(icon("more"));
    more.onclick = (e) => e.stopPropagation(); // the menu opens from its own listener; the row must not also open the thread
    more.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && e.stopPropagation());
    createMenu({
      trigger: more, kind: "menu", label: `Actions for ${t.title}`, align: "end", items: THREAD_ACTIONS, getItems: () => threadActions(t.id),
      onOpen: () => { rowMenuOpen = true; li.classList.add("menu-open"); },
      onClose: () => { rowMenuOpen = false; li.classList.remove("menu-open"); if (renderPending) renderThreads(); },
      onSelect: (v) => runThreadAction(t.id, v),
    });
    more.setAttribute("aria-label", `Actions for ${t.title}`);
    li.append(dot, el("div", "t", t.title), meta, more);
    if (waiting) li.append(el("span", "sr-only", "Needs your input"));
    else if (t.status === "running") li.append(el("span", "sr-only", "Running"));
    const pick = () => {
      setNav(false);
      openThread(t.id);
    };
    li.onclick = pick;
    li.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    };
    (t.archived ? shelf : ul).append(li);
  }
  if (list.length === filed) ul.append(el("li", "empty-list", list.length ? "Everything is archived." : "No threads yet."));
}
setInterval(() => state.threads.size && renderThreads(), 30000);

function setNav(open) {
  document.body.classList.toggle("nav", open);
  $("menu").setAttribute("aria-expanded", String(open));
}

function openThread(id) {
  if (state.measurement) latency.record({ kind: "cancelled", thread: state.measurement.thread, total_ms: performance.now() - state.measurement.at, hidden: state.measurement.hidden });
  state.measurement = null;
  releaseHistoryAnchor();
  const old = cur();
  if (old && (!state.rendering && !state.loading || state.snapshot)) {
    if (state.live?.raf) { cancelAnimationFrame(state.live.raf); state.live.raf = 0; }
    const snapshot = (!state.deferredRefresh && state.snapshot) || { nodes: [...$("chat").childNodes], cards: state.cards, subs: state.subs, subTools: state.subTools, live: state.live, compact: state.compact, start: state.start, latestStart: state.latestStart, end: state.end, scroll: $("chat").scrollTop, stats: $("diagnostics").textContent };
    snapshot.stale ||= !!state.revalidating || !!state.loadingEarlier || old.id === id;
    views.delete(old.id);
    views.set(old.id, snapshot);
    if (views.size > 5) views.delete(views.keys().next().value);
    state.cards = new Map(); state.subs = new Map(); state.subTools = new Map(); state.live = null;
  }
  state.revalidating = false;
  state.loadingEarlier = false;
  state.earlierChain = 0;
  state.deferredRefresh = false;
  state.waitingLive = [];
  state.snapshot = null;
  $("conversation-updating")?.remove();
  state.openAt = performance.now();
  state.request = (state.request || 0) + 1;
  if (pending.length && pending[0].thread !== id) clearPending(); // attachments belong to the thread they were uploaded to
  state.current = id;
  state.usageTab = state.threads.get(id)?.provider || "claude";
  try { localStorage.setItem("ac_thread", id); } catch {}
  state.stick = true;
  state.renderToken++; // any history still being drawn belongs to the thread we are leaving
  state.rendering = false;
  state.pendingLive = [];
  state.into = null;
  renderThreads();
  renderHead();
  clearChat();
  const cached = views.get(id);
  if (cached) {
    if (state.features.selectiveEvents) send({ t: "subscribe", thread: id });
    clearTimeout(state.loadTimer); state.loading = null;
    state.cards = cached.cards; state.subs = cached.subs; state.subTools = cached.subTools; state.start = cached.start; state.latestStart = cached.latestStart; state.end = cached.end; state.live = cached.live; state.compact = cached.compact;
    $("chat").replaceChildren(...cached.nodes);
    questions.ensure(id);
    earlierIdle();
    $("chat").scrollTop = cached.scroll;
    state.lastScrollTop = $("chat").scrollTop;
    state.stick = nearBottom();
    const total_ms = Math.round(performance.now() - state.openAt);
    window.agentConsoleMetrics = { thread: id, cached: true, total_ms };
    latency.record({ kind: "cached", thread: id, total_ms, render_ms: total_ms, wait_ms: 0 });
    showLoad(`Opened from cache in ${fmtMs(total_ms)}`);
    views.delete(id);
    if (cached.stale || cur()?.status === "running") {
      state.snapshot = cached;
      state.revalidating = true;
      state.deferredRefresh = cached.start < cached.latestStart && !state.stick;
      const status = el("div", "loading", state.deferredRefresh ? "Showing saved history. Return to latest to update." : "Updating conversation…");
      status.id = "conversation-updating"; status.setAttribute("role", "status");
      $("chat").before(status);
      if (!state.deferredRefresh) refreshConversation();
    }
    return;
  }
  showLoading(id);
  state.measurement = { thread: id, at: state.openAt, hidden: document.hidden };
  state.requestSentAt = performance.now();
  send({ t: "open", thread: id, request: state.request, foregroundOnly: !!state.features.selectiveEvents, small: SMALL_PAGES });
}

function refreshConversation() {
  if (state.rendering || state.loadingEarlier) return;
  state.deferredRefresh = false;
  $("conversation-updating").textContent = "Updating conversation…";
  state.refreshAt = performance.now();
  state.measurement = { thread: state.current, at: state.refreshAt, hidden: document.hidden };
  state.requestSentAt = performance.now();
  send({ t: "open", thread: state.current, request: state.request, foregroundOnly: !!state.features.selectiveEvents, since: state.end, small: SMALL_PAGES });
}

// ---------- opening a thread: skeleton while it loads, history drawn in slices so the page never freezes ----------
// Phones get smaller pages: building each message costs them about a millisecond, and the link is slower.
const SMALL_PAGES = matchMedia("(pointer: coarse)").matches;
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
// Nothing for the first 150ms (a quick open should not flash a placeholder), then message-shaped bars and a spinner.
function showLoading(id) {
  clearTimeout(state.loadTimer);
  state.loading = id;
  state.loadTimer = setTimeout(() => {
    if (state.loading !== id || state.current !== id) return;
    const status = el("div", "loading");
    status.setAttribute("role", "status");
    status.append(el("i", "spin"), el("span", "", "Loading conversation…"));
    const sk = el("div", "skeleton");
    sk.setAttribute("aria-hidden", "true");
    for (const [who, widths] of [["u", [42]], ["a", [94, 82, 58]], ["u", [30]], ["a", [90, 66]]]) {
      const g = el("div", `sk ${who}`);
      for (const w of widths) {
        const bar = el("i");
        bar.style.width = `${w}%`;
        g.append(bar);
      }
      sk.append(g);
    }
    $("chat").replaceChildren(status, sk);
  }, 150);
}
async function renderEvents(events, token, follow) {
  const STEP = 30;
  for (let i = 0; i < events.length; i += STEP) {
    for (const e of events.slice(i, i + STEP)) onEvent(e, false);
    // Detached rendering avoids a forced layout after every event.
    if (i + STEP < events.length) {
      await frame();
      if (token !== state.renderToken) return false;
    }
  }
  return token === state.renderToken;
}
async function showHistory(m) {
  clearTimeout(state.loadTimer);
  state.loading = null;
  const token = ++state.renderToken;
  state.historyAt = performance.now();
  const refreshing = state.revalidating;
  const cachedMetrics = refreshing ? window.agentConsoleMetrics : null;
  if (refreshing) {
    if (state.live?.raf) cancelAnimationFrame(state.live.raf);
    state.live = null; state.compact = null;
    state.cards = new Map(); state.subs = new Map(); state.subTools = new Map();
  } else clearChat();
  state.rendering = true;
  $("chat").setAttribute("aria-busy", "true");
  state.pendingLive = refreshing ? state.waitingLive.splice(0) : [];
  state.start = m.start || 0;
  state.latestStart = state.start;
  state.end = m.end;
  const more = state.start > 0 ? earlierButton() : null;
  if (more && !refreshing) $("chat").append(more); // tappable while the newest page draws: requestEarlier waits, so two renders never fight over the scroll position
  const host = document.createDocumentFragment();
  if (refreshing && more) host.append(more);
  state.into = host;
  if (!(await renderEvents(m.events, token, true))) return;
  state.into = null;
  const refreshScroll = $("chat").scrollTop;
  const refreshFollow = state.stick && nearBottom();
  const alignHistory = () => refreshing && !refreshFollow ? ($("chat").scrollTop = refreshScroll) : scrollDown(true);
  if (refreshing) $("chat").replaceChildren(host);
  else $("chat").append(host);
  if (!m.events.length) {
    const hint = emptyState();
    hint.querySelector("h2").textContent = "Ready";
    hint.querySelector("p").textContent = "Send a message to start this thread.";
    hint.querySelector("button").remove();
    $("chat").append(hint);
  }
  for (const e of state.pendingLive.splice(0)) onEvent(e, true);
  alignHistory();
  await frame();
  if (token !== state.renderToken) return;
  alignHistory();
  await frame();
  if (token !== state.renderToken) return;
  alignHistory();
  state.rendering = false;
  if (cur()?.operation !== "compact") settleCompact("interrupted");
  $("chat").setAttribute("aria-busy", "false");
  state.lastScrollTop = $("chat").scrollTop;
  for (const e of state.pendingLive.splice(0)) onEvent(e, true);
  historyDone(m, refreshing, cachedMetrics);
}
// A refresh that asked for only what was logged after the cached view: append it in place instead of redrawing the conversation.
function showDelta(m) {
  clearTimeout(state.loadTimer);
  state.loading = null;
  const cachedMetrics = window.agentConsoleMetrics;
  state.historyAt = performance.now();
  const chat = $("chat");
  const follow = state.stick && nearBottom();
  if (m.events.length) chat.querySelector(":scope > .empty")?.remove();
  state.into = document.createDocumentFragment();
  for (const e of m.events) onEvent(e, false); // at most one page, so no slicing across frames
  chat.append(state.into);
  state.into = null;
  for (const e of state.waitingLive.splice(0)) onEvent(e, true);
  if (follow) scrollDown(true);
  state.end = m.end;
  if (cur()?.operation !== "compact") settleCompact("interrupted");
  earlierIdle();
  state.lastScrollTop = chat.scrollTop;
  historyDone(m, true, cachedMetrics);
}
function historyDone(m, refreshing, cachedMetrics) {
  questions.ensure(m.thread);
  updateWorking();
  const metrics = { thread: m.thread, total_ms: Math.round(performance.now() - (refreshing ? state.refreshAt : state.openAt)), server_ms: m.server_ms, render_ms: Math.round(performance.now() - state.historyAt), events: m.events.length, bytes: m.bytes, prepare_ms: Math.max(0, m.receivedAt - m.roundtrip_ms - (refreshing ? state.refreshAt : state.openAt)), roundtrip_ms: m.roundtrip_ms, decode_ms: m.decode_ms, payload_bytes: m.wire_bytes };
  latency.record({ ...metrics, kind: refreshing ? "refresh" : "open", wait_ms: m.receivedAt - (refreshing ? state.refreshAt : state.openAt), wire_bytes: m.wire_bytes, prepare_ms: Math.max(0, m.receivedAt - m.roundtrip_ms - (state.measurement?.at || 0)), roundtrip_ms: m.roundtrip_ms, decode_ms: m.decode_ms, hidden: state.measurement?.hidden });
  state.measurement = null;
  state.revalidating = false;
  state.snapshot = null;
  $("conversation-updating")?.remove();
  window.agentConsoleMetrics = refreshing ? { ...cachedMetrics, refresh: metrics } : metrics;
  const other = Math.max(0, metrics.total_ms - metrics.roundtrip_ms - metrics.render_ms);
  const detail = `Network ${fmtMs(metrics.roundtrip_ms)} · drawing ${fmtMs(metrics.render_ms)} · other ${fmtMs(other)} ${metrics.events ? ` · ${metrics.events} events, ${Math.round(metrics.payload_bytes / 1024)} KB` : ""}`;
  if (refreshing) showLoad(`Opened from cache in ${fmtMs(cachedMetrics.total_ms)}, then updated in ${fmtMs(metrics.total_ms)}`, detail);
  else showLoad(`Loaded in ${fmtMs(metrics.total_ms)}`, detail);
  console.debug("Agent Console history", metrics);
  warmFileViewer();
}
function earlierButton() {
  const b = el("button", "btn earlier", "Show earlier messages");
  b.type = "button";
  b.onclick = () => {
    if (b.disabled) return;
    requestEarlier(state.current);
  };
  if (state.earlierWanted === state.current) earlierLoading(b); // a tap queued before a redraw replaced the button
  return b;
}
function earlierIdle() {
  const b = $("chat").querySelector(":scope > .earlier");
  if (!b || state.loadingEarlier || state.earlierWanted === state.current) return;
  b.disabled = false;
  b.textContent = "Show earlier messages";
}
function earlierLoading(b) {
  if (!b) return;
  b.disabled = true;
  b.textContent = "Loading…";
}
// A tap is kept per thread, not per button or draw: a refresh redraw replaces the button mid-wait and must not swallow it.
function requestEarlier(thread) {
  if (thread !== state.current) return void (state.earlierWanted = null);
  state.earlierWanted = thread;
  earlierLoading($("chat").querySelector(":scope > .earlier"));
  // A refresh or page draw in flight would swallow the click, so wait for it instead of ignoring it.
  if (state.revalidating && !state.deferredRefresh || state.rendering || state.loadingEarlier) return void setTimeout(requestEarlier, 100, thread);
  state.pageAt = performance.now();
  state.measurement = { thread, at: state.pageAt, hidden: document.hidden };
  state.requestSentAt = performance.now();
  // The socket may be down (phone woke up, reconnecting): a dropped request would leave the button dead, so retry until it is sent.
  if (!send({ t: "open", thread, before: state.start, request: state.request, small: SMALL_PAGES })) return void setTimeout(requestEarlier, 300, thread);
  state.earlierWanted = null;
  state.loadingEarlier = true;
}
// Older events are drawn off-screen, then slid in above what is there with the scroll position held, so the page does not jump.
async function showEarlier(m) {
  const pageAt = state.pageAt;
  const chat = $("chat");
  const token = state.renderToken;
  const host = el("div");
  const live = state.live;
  state.live = null;
  state.rendering = true;
  $("chat").setAttribute("aria-busy", "true");
  state.into = host;
  const ok = await renderEvents(m.events, token, false);
  if (!ok) return;
  state.into = null;
  const btn = chat.querySelector(":scope > .earlier");
  const anchor = btn?.nextElementSibling || chat.firstElementChild;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const fromBottom = chat.scrollHeight - chat.scrollTop;
  const heightBefore = chat.scrollHeight;
  if (btn) btn.after(...host.childNodes);
  else chat.prepend(...host.childNodes);
  state.start = m.start;
  // Pages are counted in events, and a run of tool/sub-agent events can fold into existing rows and add nothing visible:
  // keep fetching (button stays "Loading…") until a screenful appears, so one tap always shows something.
  const fetchMore = m.start > 0 && btn && chat.scrollHeight - heightBefore < chat.clientHeight && (state.earlierChain = (state.earlierChain || 0) + 1) < 20;
  if (!fetchMore) state.earlierChain = 0;
  if (m.start > 0 && btn) {
    if (!fetchMore) {
      btn.disabled = false;
      btn.textContent = "Show earlier messages";
    }
  } else btn?.remove();
  chat.scrollTop = chat.scrollHeight - fromBottom;
  if (anchor && anchorTop != null) holdHistoryAnchor(anchor, anchorTop);
  for (let pass = 0; pass < 3; pass++) {
    await frame();
    if (token !== state.renderToken) return;
    if (anchor?.isConnected && anchorTop != null) chat.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }
  state.live = live;
  state.loadingEarlier = false;
  state.rendering = false;
  chat.setAttribute("aria-busy", "false");
  state.lastScrollTop = chat.scrollTop;
  for (const e of state.pendingLive.splice(0)) onEvent(e, true);
  latency.record({ kind: "page", thread: m.thread, total_ms: performance.now() - pageAt, wait_ms: m.receivedAt - pageAt, server_ms: m.server_ms, render_ms: performance.now() - m.receivedAt, events: m.events.length, bytes: m.bytes, wire_bytes: m.wire_bytes, prepare_ms: Math.max(0, m.receivedAt - m.roundtrip_ms - (state.measurement?.at || 0)), roundtrip_ms: m.roundtrip_ms, decode_ms: m.decode_ms, hidden: state.measurement?.hidden });
  state.measurement = null;
  if (fetchMore) return requestEarlier(m.thread);
  if (state.deferredRefresh && nearBottom()) refreshConversation();
}

function renderHead() {
  const t = cur();
  if (!$("ttl-edit")) $("ttl").textContent = t ? t.title : state.ready ? "No thread" : "";
  $("cwd").hidden = !t;
  $("cwd-t").textContent = t ? t.cwd.replace(/^\/home\/[^/]+/, "~") : "";
  $("cwd").title = t ? t.cwd : "";
  if (t) {
    const p = prov(t.provider);
    if (p && menus.model.provider !== t.provider) {
      menus.model.provider = t.provider; // models and modes differ per agent
      menus.model.advisorShown = undefined;
      menus.model.setItems(withAdvisors(modelItems(p.models, p), p, t.advisor || "default"));
      menus.mode.setItems(modeItems(p.modes));
    }
    if (p && menus.model.advisorShown !== (t.advisor || "default")) { // the check mark on the advisor rows follows the thread
      menus.model.advisorShown = t.advisor || "default";
      menus.model.setItems(withAdvisors(modelItems(p.models, p), p, menus.model.advisorShown), t.model);
    }
    menus.model.setValue(t.model);
    $("effort").hidden = !p?.modelDetails;
    fillEffort(menus.effort, p, t.model, t.effort || "default");
    menus.effort.setDisabled(t.status === "running");
    const run = t.lastRun;
    const tok = run && [run.input_tokens, run.cached_input_tokens, run.output_tokens].some((n) => n != null);
    facts([...(run ? [
      ["Model", run.model || t.model],
      ["Effort", effortLabel(run.effort || t.effort || "default"), run.source && run.source !== "thread settings" ? `from ${run.source}` : ""],
      ["Last run", run.duration_ms == null ? "Still running" : fmtMs(run.duration_ms)],
      ...(tok ? [["Tokens", `${run.input_tokens ?? 0} in · ${run.cached_input_tokens ?? 0} from cache · ${run.output_tokens ?? 0} out`, "whole turn, not the context size"]] : []),
    ] : [["Last run", "None yet"]]),
      ["Automatic compaction", !t.idleCompactionTtlMs ? "Unavailable: cache lifetime unknown" : t.idleCompaction === false ? "Off" : "On for substantial idle contexts",
        t.idleCompactionDueAt ? `Scheduled around ${new Date(t.idleCompactionDueAt).toLocaleTimeString()}; cache expiry is estimated.` : "Compaction uses tokens and may shorten details. Full transcript is kept."],
    ]);
    $("diagnostics").title = run ? `Last run: ${run.model || t.model} · effort ${run.effort || t.effort || "default"} (${run.source || "thread settings"})\n${run.duration_ms ?? "?"} ms · input ${run.input_tokens ?? "?"} · cached ${run.cached_input_tokens ?? "?"} · output ${run.output_tokens ?? "?"} tokens` : "No run metrics yet.";
    menus.mode.setValue(t.mode);
  }
  const running = t?.status === "running";
  menus.model.setDisabled(!t || running);
  menus.mode.setDisabled(!t || running);
  $("more").disabled = !t;
  $("state").hidden = !running && !questions.count(state.current);
  $("input").disabled = !t;
  $("attach").disabled = !t;
  // While the agent works the composer stays live: Enter steers it (or queues, for agents that cannot take input mid-turn)
  const canSteer = !t?.operation && !!prov(t?.provider)?.steer;
  renderAction();
  $("cbox").classList.toggle("running", running);
  $("input").placeholder = !t ? "Message the agent" : questions.count(t.id) || t.waiting ? "Reply to the agent, or choose an option above…" : running ? (t?.operation ? "Queue a message to send after compaction…" : "Queue a message for after this turn…") : "Message the agent";
  renderQueue();
  renderCtx();
  renderUsage();
  updateWorking();
  $("head").dataset.status = t?.status || "";
  $("head").dataset.mode = t?.mode || "";
}

// One button does it all: Stop (red) while a turn runs and the composer is empty, otherwise Send (which queues mid-turn).
function renderAction() {
  const t = cur();
  const running = t?.status === "running";
  const waiting = questions.count(t?.id) || t?.waiting;
  const empty = !$("input").value.trim() && !pending.length;
  const stop = running && empty;
  $("stop").hidden = !stop;
  $("send").hidden = stop;
  $("send").disabled = !t || (empty && !running);
  $("send").title = waiting ? "Reply to the agent (Enter)" : running ? "Queue: sent when this turn ends (Enter)" : "Send (Enter)";
  $("send").setAttribute("aria-label", waiting ? "Reply to agent" : running ? "Queue message" : "Send");
}
// ---------- queued messages and the context meter ----------
function renderQueue() {
  const ul = $("queued");
  const items = state.queues[state.current] || [];
  ul.hidden = !items.length;
  ul.replaceChildren(
    ...items.map((q) => {
      const li = el("li");
      const rm = el("button", "btn rm");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove queued message");
      rm.append(icon("x"));
      rm.onclick = () => send({ t: "unqueue", thread: state.current, id: q.id });
      const edit = iconButton("pencil", "Edit queued message", "btn queue-edit");
      edit.hidden = !state.features.queueEditing;
      edit.onclick = () => editQueuedMessage(q.id);
      const steer = el("button", "btn sm steer", "Steer");
      steer.type = "button";
      steer.title = "Give this to the agent now, instead of after the turn";
      steer.hidden = q.editing || cur()?.status !== "running" || !!cur()?.operation || !prov(cur()?.provider)?.steer;
      steer.onclick = () => send({ t: "steer_queued", thread: state.current, id: q.id });
      li.append(el("span", "tag", q.editing ? "Editing" : "Queued"), el("span", "txt", q.text), steer, edit, rm);
      return li;
    }),
  );
}
document.addEventListener("visibilitychange", () => { if (state.measurement && document.hidden) state.measurement.hidden = true; });
let queueEditor, queueRequest = 0;
function editQueuedMessage(id) {
  if (ws?.readyState !== 1) return toast("Reconnect before editing a queued message.");
  queueEditor = { id, thread: state.current, request: ++queueRequest };
  $("queue-draft").value = "";
  $("queue-edit-note").textContent = "Pausing delivery and loading the full message…";
  $("queue-edit-error").textContent = "";
  $("queue-draft").disabled = true; $("queue-save").disabled = true;
  $("queue-cancel").disabled = false;
  $("queue-editor").showModal();
  send({ t: "queue_edit", ...queueEditor });
}
function queuedEditReply(m) {
  if (!queueEditor || m.request !== queueEditor.request) return;
  queueEditor.pending = false;
  if (m.t === "queue_edit_done") {
    $("queue-editor").close(); queueEditor = null; return;
  }
  if (m.t === "queue_edit") {
    queueEditor.revision = m.revision;
    $("queue-draft").value = m.text;
    $("queue-edit-note").textContent = `Delivery is paused until Save or Cancel.${m.attachments ? ` ${m.attachments} attachment(s) will be kept.` : ""}`;
    if (queueEditor.cancelPending) return finishQueuedEdit(true);
  } else {
    $("queue-edit-error").textContent = m.message;
    if (queueEditor.revision == null) queueEditor.failedOpen = true;
  }
  $("queue-draft").disabled = queueEditor.revision == null;
  $("queue-save").disabled = queueEditor.revision == null;
  $("queue-cancel").disabled = false;
  if (m.t === "queue_edit") $("queue-draft").focus();
}
function finishQueuedEdit(cancel) {
  if (!queueEditor || queueEditor.pending) return;
  if (cancel && queueEditor.revision == null && !queueEditor.failedOpen && ws?.readyState === 1) {
    queueEditor.cancelPending = true;
    $("queue-edit-note").textContent = "Cancelling the edit…";
    return;
  }
  if (cancel && (queueEditor.revision == null || ws?.readyState !== 1)) {
    $("queue-editor").close(); queueEditor = null; return;
  }
  if (ws?.readyState !== 1) { $("queue-edit-error").textContent = "Disconnected. Reconnect to save this draft."; return; }
  queueEditor.request = ++queueRequest;
  queueEditor.pending = true;
  $("queue-save").disabled = true; $("queue-cancel").disabled = true; $("queue-draft").disabled = true;
  send({ t: cancel ? "queue_cancel_edit" : "queue_save", ...queueEditor, text: $("queue-draft").value });
}
$("queue-edit-form").onsubmit = e => { e.preventDefault(); finishQueuedEdit(false); };
$("queue-cancel").onclick = () => finishQueuedEdit(true);
$("queue-editor").addEventListener("cancel", e => { e.preventDefault(); finishQueuedEdit(true); });
// Run details, in words: one fact per row, times as "167 ms" or "1.2 s".
const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
function facts(rows) {
  const dl = $("run-metrics");
  dl.replaceChildren(...rows.flatMap(([k, v, note]) => { const dd = el("dd", "", v); if (note) dd.append(el("span", "note", note)); return [el("dt", "", k), dd]; }));
}
function showLoad(main, detail) {
  $("diagnostics").replaceChildren(el("p", "lead", main), ...(detail ? [el("p", "note", detail)] : []));
}
const SPEED = [["open", "Open a thread"], ["cached", "Switch back"], ["refresh", "Check for new"], ["page", "Older messages"]];
const speedWord = (ms) => (ms < 300 ? "fast" : ms < 1000 ? "ok" : "slow");
// Nearest-rank percentile of times sorted fastest first: p% of loads took this long or less.
const pct = (sorted, p) => sorted?.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
const pctWord = (p) => (p === 100 ? "the slowest load" : p === 50 ? "half of loads are faster" : `${p} in 100 loads are faster`);
let speedData = null;
// Which percentiles the table shows and over which time window: the reader's choice, kept between visits.
const speedView = (() => { try { const v = JSON.parse(localStorage.getItem("ac_speed_view")); if (v?.typical && v?.slowest) return { recent: true, ...v }; } catch {} return { typical: 50, slowest: 95, recent: true }; })();
const saveSpeedView = () => { try { localStorage.setItem("ac_speed_view", JSON.stringify(speedView)); } catch {} };
function speedSlider(name, label, min, max) {
  const wrap = el("label", "slider"), out = el("output"), input = el("input");
  Object.assign(input, { type: "range", min, max, step: 1, value: speedView[name] });
  input.dataset.pct = name;
  input.sync = () => { input.value = speedView[name]; out.textContent = `p${speedView[name]} · ${pctWord(speedView[name])}`; };
  input.oninput = () => {
    speedView[name] = Number(input.value);
    // Typical can never be slower than Slowest: dragging one past the other pushes it along.
    if (speedView.slowest < speedView.typical) speedView[name === "typical" ? "slowest" : "typical"] = speedView[name];
    for (const s of $("latency-summary").querySelectorAll("[data-pct]")) s.sync();
    saveSpeedView();
    renderSpeedTable();
  };
  input.sync();
  wrap.append(el("span", "", label), input, out);
  return wrap;
}
function windowPicker(days) {
  const pick = el("div", "window-pick");
  pick.setAttribute("role", "group"); pick.setAttribute("aria-label", "Time window");
  for (const [recent, text] of [[true, "Last 20 loads"], [false, `Last ${days} days`]]) {
    const b = el("button", "", text);
    b.type = "button";
    b.setAttribute("aria-pressed", String(speedView.recent === recent));
    b.onclick = () => {
      speedView.recent = recent;
      for (const other of pick.children) other.setAttribute("aria-pressed", String(other === b));
      saveSpeedView();
      renderSpeedTable();
    };
    pick.append(b);
  }
  return pick;
}
function renderSpeedTable() {
  const { typical, slowest, recent } = speedView;
  const table = el("table", "speed"), head = el("tr");
  table.caption = el("caption", "sr-only", recent ? "Last 20 loads of each kind" : `Every load in the last ${speedData.retention_days} days`);
  for (const text of ["", `Typical p${typical}`, `Slowest p${slowest}`]) head.append(Object.assign(el("th", "", text), { scope: "col" }));
  table.append(el("thead"), el("tbody")); table.tHead.append(head);
  for (const [key, label] of SPEED) {
    const times = speedData.groups[`${key}/visible${recent ? "/recent" : ""}`]?.samples_ms;
    if (!times?.length) continue;
    const tr = el("tr"), name = el("th"), word = speedWord(pct(times, typical));
    name.scope = "row";
    name.append(el("span", `dot ${word}`), label, el("span", "sr-only", ` (${word})`));
    tr.append(name, el("td", "", fmtMs(pct(times, typical))), el("td", "", fmtMs(pct(times, slowest))));
    table.tBodies[0].append(tr);
  }
  $("latency-summary").querySelector("table").replaceWith(table);
}
async function loadLatencySummary() {
  if (!state.features.latency) { $("latency-summary").textContent = "Local measurements will be available after the server reconnects."; return; }
  latency.flush();
  $("latency-summary").textContent = "Loading measurements…";
  try {
    const response = await apiFetch("/api/latency", { cache: "no-store" });
    if (!response.ok) throw Error();
    const data = await response.json();
    if (!data.available) throw Error();
    if (!data.count) { $("latency-summary").textContent = "No measurements yet. Open or switch threads to collect some."; return; }
    speedData = data;
    const sliders = el("div", "sliders");
    sliders.append(speedSlider("typical", "Typical", 50, 95), speedSlider("slowest", "Slowest", 75, 100));
    $("latency-summary").replaceChildren(windowPicker(data.retention_days), sliders, el("table"));
    renderSpeedTable();
    $("latency-summary").append(el("p", "note", "A pN time means N in 100 loads were that fast or faster: p50 is the middle load, p100 the slowest one. Counts only loads while the app was on screen."));
  } catch { $("latency-summary").textContent = "Local measurements are unavailable until the server reconnects."; }
}
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
// A ring that fills with the model's context window, as in other chat UIs. Amber (never red: red means destructive) as it gets full.
function renderCtx() {
  const b = $("ctx");
  const c = cur()?.context;
  if (c?.used == null && cur()?.lastCompactedAt) {
    b.hidden = false;
    b.dataset.level = ""; b.style.color = "";
    b.querySelector(".fill").style.strokeDasharray = "0 100";
    b.querySelector(".pct").textContent = "Compacted";
    b.dataset.tip = "Context compacted. Token usage updates on the next model request.";
    b.setAttribute("aria-label", b.dataset.tip);
    return;
  }
  if (c?.used == null) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  const pct = c.max ? Math.min(100, Math.round((c.used / c.max) * 100)) : null;
  b.style.color = pct == null ? "" : meterColor(pct);
  b.dataset.level = pct == null ? "" : pct >= 95 ? "crit" : pct >= 80 ? "high" : "";
  b.querySelector(".fill").style.strokeDasharray = `${pct ?? 0} 100`;
  b.querySelector(".pct").textContent = pct == null ? fmtTok(c.used) : `${pct}%`;
  const head = pct == null ? "Context in use" : "Context window";
  const body = pct == null ? `${c.used.toLocaleString()} tokens` : `${c.used.toLocaleString()} of ${c.max.toLocaleString()} tokens (${pct}%)`;
  const hint = pct != null && pct >= 80 ? (cur().provider === "claude" ? "Claude compacts automatically as this fills." : "Getting full: a new thread starts clean.") : "";
  b.dataset.tip = [head, body, hint].filter(Boolean).join("\n");
  b.setAttribute("aria-label", [head, body, hint].filter(Boolean).join(". "));
}
// "Working" in the header, plus how many subagents are still going
function updateWorking() {
  $("state").classList.toggle("waiting", !!(questions.count(state.current) || cur()?.waiting));
  const n = [...state.cards.values()].filter((c) => c.classList.contains("agent") && (c.classList.contains("pending") || c.querySelector(".task-chip.running"))).length;
  $("state-t").textContent = questions.count(state.current) || cur()?.waiting ? "Needs your input" : cur()?.operation === "compact" ? "Compacting context" : n ? `Working · ${n} agent${n > 1 ? "s" : ""}` : "Working";
}

function startRename() {
  const t = cur();
  if (!t || $("ttl-edit")) return;
  const h = $("ttl");
  const input = el("input");
  input.id = "ttl-edit";
  input.value = t.title;
  input.maxLength = 80;
  input.setAttribute("aria-label", "Thread title");
  h.hidden = true;
  h.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove();
    h.hidden = false;
    if (commit && v && v !== t.title) send({ t: "update", thread: t.id, title: v });
    h.focus?.();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}
$("ttl").ondblclick = startRename;

// ---------- chat rendering ----------
function emptyState() {
  const box = el("div", "empty");
  box.append(icon("terminal", "glyph"), el("h2", "", "No thread selected"), el("p", "", "Start a thread to run a coding agent in one of your folders."));
  const b = el("button", "btn primary");
  b.type = "button";
  b.append(icon("plus"), el("span", "", "New thread"));
  b.onclick = openNewDialog;
  box.append(b);
  return box;
}
function clearChat() {
  releaseHistoryAnchor();
  if (state.live?.raf) cancelAnimationFrame(state.live.raf);
  state.live = null;
  state.cards.clear();
  state.compact = null;
  state.subs.clear();
  state.subTools.clear();
  $("chat").replaceChildren();
  $("chat").setAttribute("aria-busy", "false");
  if (!state.current && state.ready) $("chat").append(emptyState());
}
let scrollFrame;
function onChatScroll() {
  scrollFrame = 0;
  const chat = $("chat");
  if (state.into || state.rendering || state.loading) return;
  const top = chat.scrollTop;
  const upward = top < (state.lastScrollTop || 0);
  // A finger (or wheel) moving up means the reader is leaving the bottom, even inside the 120px "near bottom" band;
  // otherwise live output would pull them back mid-drag. Virtual rows can grow after paint; growth alone doesn't mean the reader scrolled away.
  if (upward && readerScrolling()) state.stick = false;
  else if (upward || nearBottom()) state.stick = nearBottom();
  state.lastScrollTop = top;
  if (state.deferredRefresh && nearBottom()) refreshConversation();
  if (upward && top < 200) loadEarlierWhenStill();
}
// Coalesce to one pass per frame so scroll bursts don't force layout reads on every event.
$("chat").addEventListener("scroll", () => {
  if (readerScrolling()) gesture.at = performance.now(); // momentum after the finger lifts is still the reader's scroll
  scrollFrame ||= requestAnimationFrame(onChatScroll);
}, { passive: true });
// The reader's own scrolling (finger down, wheel, or the fling that follows). While it lasts nothing re-anchors or
// follows the bottom: on Android a scrollTop write during a drag snaps the list back under the finger.
const gesture = { touching: false, at: 0, idle: 0 };
function readerScrolling() { return gesture.touching || performance.now() - gesture.at < 160; }
function following() { return state.stick && !readerScrolling(); }
function markGesture(touching) {
  if (touching != null) gesture.touching = touching;
  gesture.at = performance.now();
}
$("chat").addEventListener("touchstart", () => markGesture(true), { passive: true });
for (const event of ["touchend", "touchcancel"]) $("chat").addEventListener(event, () => markGesture(false), { passive: true });
$("chat").addEventListener("wheel", () => markGesture(), { passive: true });
// Older pages are fetched and slid in only once the list is still: inserting mid-fling moves content under the finger.
function loadEarlierWhenStill() {
  clearTimeout(gesture.idle);
  if (readerScrolling()) return void (gesture.idle = setTimeout(loadEarlierWhenStill, 120));
  const chat = $("chat");
  if (chat.scrollTop < 200) chat.querySelector(":scope > .earlier:not(:disabled)")?.click();
}
let historyAnchor;
let followFrame;
const followResize = new ResizeObserver(() => {
  cancelAnimationFrame(followFrame);
  followFrame = requestAnimationFrame(() => {
    if (following() && !state.rendering && !state.into && !state.loading && !historyAnchor) {
      scrollDown(true);
      state.lastScrollTop = $("chat").scrollTop;
    }
  });
});
new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.removedNodes) if (node instanceof Element) followResize.unobserve(node);
    for (const node of record.addedNodes) if (node instanceof Element) followResize.observe(node);
  }
}).observe($("chat"), { childList: true });
function releaseHistoryAnchor() {
  historyAnchor?.observer.disconnect();
  historyAnchor = null;
}
function holdHistoryAnchor(node, top) {
  releaseHistoryAnchor();
  const chat = $("chat");
  const observer = new ResizeObserver(() => {
    if (!node.isConnected) return releaseHistoryAnchor();
    const delta = node.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 0.5) { chat.scrollTop += delta; state.lastScrollTop = chat.scrollTop; }
  });
  historyAnchor = { observer };
  // Native virtual rendering resolves intrinsic sizes after paint; retain the visible message until the reader moves.
  for (const child of chat.children) observer.observe(child);
}
for (const event of ["wheel", "touchstart", "pointerdown"]) $("chat").addEventListener(event, releaseHistoryAnchor, { passive: true });
document.addEventListener("keydown", releaseHistoryAnchor, { passive: true });
function nearBottom() {
  const c = $("chat");
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}
function scrollDown(force) {
  const c = $("chat");
  if (force || nearBottom()) c.scrollTop = c.scrollHeight;
}
function push(node, live) {
  if (state.into) return void state.into.append(node); // drawing older history off-screen: no scrolling
  const stick = following() && nearBottom();
  $("chat").querySelector(":scope > .empty")?.remove();
  $("chat").append(node);
  if (live === false || stick) scrollDown(true);
}
// /compact: one card that goes from "Compacting…" to done/failed in place (history replays both events into the same card)
function compactCard(e, live) {
  let card = state.compact;
  if (!card?.isConnected && !(card && state.into)) card = state.compact = null;
  if (!card) {
    card = state.compact = el("div", "msg compact-card running");
    card.setAttribute("role", "status");
    card.append(el("span", "cc-ico"), (() => { const b = el("div", "cc-body"); b.append(el("div", "cc-title"), el("div", "cc-sub"), el("div", "cc-bar")); return b; })());
    push(card, live);
  }
  const done = e.status === "completed", failed = e.status === "failed";
  card.className = `msg compact-card ${failed ? "failed" : done ? "done" : "running"}`;
  card.querySelector(".cc-ico").replaceChildren(done ? icon("check") : failed ? icon("alert") : el("i", "spin"));
  card.querySelector(".cc-title").textContent = failed ? "Compaction failed" : done ? "Context compacted" : "Compacting context";
  card.querySelector(".cc-sub").textContent = failed ? (e.text || "The agent did not compact this thread.") : done ? "Earlier turns were summarised. The transcript above is kept." : "Summarising earlier turns to free up room. You can queue a message meanwhile.";
  if (done || failed) state.compact = null;
}
// a running card whose operation is over (stopped, or the page reloaded after the server gave up) must not spin forever
function settleCompact(outcome = "stopped") {
  for (const c of document.querySelectorAll(".compact-card.running")) {
    c.className = "msg compact-card failed";
    c.querySelector(".cc-ico").replaceChildren(icon("alert"));
    c.querySelector(".cc-title").textContent = outcome === "stopped" ? "Compaction stopped" : "Compaction interrupted";
    c.querySelector(".cc-sub").textContent = "Context was not compacted.";
  }
  state.compact = null;
}
function addNote(text, cls = "note") {
  if (cls === "errtxt") return push(errBlock(text));
  push(el("div", `msg ${cls}`, text));
}
function errBlock(text) {
  const d = el("div", "msg errtxt");
  d.append(icon("alert"), el("span", "", text));
  return d;
}

function summarize(name, input) {
  return toolSummary(name, input || {});
}
// A shell command is cryptic; when the agent said what it is for, show that and keep the command in the card body and on hover.
const describedAs = (name, input) => (name === "Bash" && typeof input?.description === "string" && input.description.trim()) || "";
const TOOL_ICON = { Bash: "terminal", Edit: "pencil", MultiEdit: "pencil", NotebookEdit: "pencil", Write: "file", Read: "file", Grep: "search", Glob: "search", WebFetch: "globe", WebSearch: "globe", WebFind: "globe", WebBrowse: "globe", Task: "sparkle", Agent: "sparkle" };

function codePre(text, lang) {
  const pre = el("pre");
  const code = el("code");
  // Closed tool cards need readable text, but syntax highlighting can wait until opened.
  code.textContent = text;
  code.dataset.highlightPending = lang || "";
  pre.append(code);
  return pre;
}
function toolBody(name, input) {
  const box = el("div", "body");
  input = input || {};
  if (name === "WebSearch" && toolName(name, input) === "WebBrowse") {
    box.append(el("p", "", summarize(name, input)));
  } else if (name === "Edit" && "old_string" in input) {
    const pre = el("pre", "diff");
    for (const l of String(input.old_string).split("\n")) pre.append(el("div", "del", l));
    for (const l of String(input.new_string).split("\n")) pre.append(el("div", "add", l));
    box.append(pre);
  } else if (name === "Write" && "content" in input) {
    box.append(codePre(String(input.content).slice(0, 4000), langFromPath(input.file_path)));
  } else if (name === "Bash" && input.command) {
    // "$ cmd" with a hanging indent so wrapped lines stay under the command, and its own copy button
    const cmd = String(input.command);
    const row = el("div", "tool-cmd");
    const copy = iconButton("copy", "Copy command");
    wireCopy(copy, () => cmd, "Copy command");
    row.append(el("span", "ps1", "$"), codePre(cmd, "bash"), copy);
    row.firstChild.setAttribute("aria-hidden", "true");
    box.append(row);
  } else {
    box.append(codePre(JSON.stringify(input, null, 2), "json"));
  }
  return box;
}

// What a tool returned: a labelled section ("Output" or "Error", line count, wrap + copy), clamped to a
// short preview with a fade and a "Show all" button instead of a scroller nested inside the chat scroller.
const OUT_MAX = 8000;
function toolOutput(text, isError) {
  const sec = el("section", isError ? "tool-result tool-out err" : "tool-result tool-out");
  const lines = text.replace(/\n+$/, "").split("\n").length;
  const head = el("div", "tool-out-head");
  const lab = el("span", "lab");
  if (isError) lab.append(icon("alert"));
  lab.append(isError ? "Error" : "Output");
  const meta = `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}${text.length > OUT_MAX ? " · first 8k chars" : ""}`;
  const wrap = iconButton("wrap", "Wrap lines");
  wrap.setAttribute("aria-pressed", "true");
  wrap.onclick = () => {
    wrap.setAttribute("aria-pressed", String(!sec.classList.toggle("nowrap")));
    fitOutput(sec);
  };
  const copy = iconButton("copy", "Copy output");
  wireCopy(copy, () => text, "Copy output");
  head.append(lab, el("span", "meta", meta), wrap, copy);
  const pre = el("pre", "", text.slice(0, OUT_MAX));
  pre.tabIndex = 0; // keyboard-scrollable when lines do not wrap
  pre.setAttribute("role", "region");
  pre.setAttribute("aria-label", isError ? "Error output" : "Tool output");
  const more = el("button", "btn sm ghost more", `Show all ${lines.toLocaleString()} lines`);
  more.type = "button";
  more.hidden = true;
  more.setAttribute("aria-expanded", "false");
  more.onclick = () => {
    const open = sec.classList.toggle("expanded");
    more.setAttribute("aria-expanded", String(open));
    more.textContent = open ? "Show less" : `Show all ${lines.toLocaleString()} lines`;
    if (!open) sec.scrollIntoView({ block: "nearest" });
  };
  sec.append(head, pre, more);
  return sec;
}
// Clamping needs layout, so it runs when the card is open (a closed <details> has no box to measure).
function fitOutput(sec) {
  if (sec.classList.contains("expanded")) return;
  const pre = sec.querySelector("pre");
  const over = pre.scrollHeight > pre.clientHeight + 4;
  sec.classList.toggle("clamped", over);
  sec.querySelector(".more").hidden = !over;
}
const fitOutputs = (card) => card.querySelectorAll(".tool-out").forEach(fitOutput);

function copyActions(getText, label = "Copy message") {
  const row = el("div", "actions");
  const b = iconButton("copy", label);
  wireCopy(b, getText, label);
  row.append(b);
  return row;
}
// what the user attached to a sent message; the server keeps the bytes, the log only names them
// "[Image #2]" in what the user typed becomes a link to that image, as in the composer
function userText(text, attachments) {
  const frag = document.createDocumentFragment();
  const byN = new Map((attachments ?? []).filter((a) => a.kind === "image" && a.n).map((a) => [a.n, a]));
  let last = 0;
  for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
    const a = byN.get(Number(m[1]));
    if (!a) continue;
    frag.append(text.slice(last, m.index));
    const link = el("a", "imgref", `Image ${m[1]}`);
    link.href = uploadUrl(a);
    link.dataset.viewerImage = "true";
    link.title = a.name;
    frag.append(link);
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}
const uploadUrl = (a) => `/uploads/${state.current}/${a.id}/${encodeURIComponent(a.name)}`;
function attachmentRows(items, live) {
  const rows = [];
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind !== "image");
  if (images.length) {
    const row = el("div", "imgs");
    for (const i of images) {
      const a = el("a");
      a.href = uploadUrl(i);
      a.dataset.viewerImage = "true";
      a.title = i.name;
      const img = el("img");
      img.src = a.href;
      img.alt = i.name;
      img.onload = () => following() && scrollDown(true); // an image loading below the fold must not leave the log mid-way, but must not yank a reader up the page either
      a.append(img);
      row.append(a);
    }
    rows.push(row);
  }
  if (files.length) {
    const row = el("div", "files");
    for (const f of files) {
      const a = el("a", "chip");
      a.href = uploadUrl(f);
      a.download = f.name;
      a.title = f.name;
      a.append(icon("file"), el("span", "nm", f.name), el("span", "sz", fmtSize(f.size)));
      row.append(a);
    }
    rows.push(row);
  }
  return rows;
}
function asstMsg(text, final) {
  const root = el("div", "msg asst");
  const prose = el("div", "prose");
  root.append(prose);
  if (final) {
    renderMarkdown(text, prose);
    root.append(copyActions(() => text));
  }
  return { root, prose };
}

function renderLive(kind) {
  if (!state.live) state.live = {};
  const L = state.live;
  if (!L[kind + "El"]) {
    if (kind === "text") {
      const a = asstMsg("", false);
      L.textEl = a.root;
      L.prose = a.prose;
    } else {
      const d = el("div", "msg think live");
      d.append(icon("sparkle"), el("span", "", "Thinking…"));
      L.thinkingEl = d;
    }
    L[kind] = "";
    push(L[kind + "El"]);
  }
  if (L.raf) return;
  L.raf = requestAnimationFrame(() => {
    L.raf = 0;
    const stick = following() && nearBottom();
    if (L.textEl && L.prose) renderMarkdown(L.text || "", L.prose);
    if (L.thinkingEl) L.thinkingEl.querySelector("span").textContent = "Thinking… " + (L.thinking || "").slice(-200).replace(/\s+/g, " ");
    if (stick) scrollDown(true);
  });
}
function dropLive(kind) {
  const L = state.live;
  if (!L) return;
  L[kind + "El"]?.remove();
  L[kind + "El"] = null;
  L[kind] = "";
}

// ---------- subagents ----------
const isAgent = (name) => name === "Task" || name === "Agent";
function agentCard(b) {
  const card = el("details", "msg card agent pending");
  const sum = el("summary");
  const st = el("span", "st");
  st.append(el("i", "spin"), el("span", "sr-only", "running"));
  const kind = b.input?.subagent_type;
  const chip = el("span", "task-chip");
  chip.hidden = true;
  sum.append(icon("sparkle", "tool"), el("span", "name", kind ? `Agent · ${kind}` : "Agent"), el("span", "sum human", b.input?.description || "Subagent"), el("span", "stats"), chip, st, icon("chev-right", "chev"));
  const body = el("div", "body");
  if (b.input?.prompt) {
    const det = el("details", "sub-prompt");
    det.append(el("summary", "", "Instructions"), el("pre", "", String(b.input.prompt).slice(0, 4000)));
    body.append(det);
  }
  const log = el("ol", "sub-log");
  log.setAttribute("aria-label", "Subagent activity");
  body.append(el("div", "now"), log);
  card.append(sum, body);
  state.subs.set(b.id, log);
  return card;
}
function subRow(kind) {
  const li = el("li", `sub-row ${kind}`);
  return li;
}
// one line per thing the subagent says or does, indented under its card; nested subagents nest again
function subEvent(e, live) {
  if (e.type === "stream_event") return; // partial text of a subagent is not shown live; the finished message is
  const log = state.subs.get(e.parent_tool_use_id);
  if (!log) return;
  if (e.type === "assistant") {
    for (const b of e.message?.content ?? []) {
      if (b.type === "text" && b.text?.trim()) {
        const li = subRow("text");
        li.textContent = b.text.length > 280 ? `${b.text.slice(0, 279)}…` : b.text;
        log.append(li);
      } else if (b.type === "tool_use") {
        const li = subRow("tool pending");
        const st = el("span", "st");
        st.append(el("i", "spin"));
        const why = describedAs(b.name, b.input);
        li.append(icon(TOOL_ICON[b.name] || "code", "tool"), el("span", "name", isAgent(b.name) ? "Agent" : toolName(b.name, b.input)), el("span", why || isAgent(b.name) ? "sum human" : "sum", why || (isAgent(b.name) ? b.input?.description || "Subagent" : summarize(b.name, b.input))), st);
        li.title = summarize(b.name, b.input);
        state.subTools.set(b.id, li);
        if (isAgent(b.name)) {
          const inner = el("ol", "sub-log");
          li.append(inner);
          state.subs.set(b.id, inner);
        }
        log.append(li);
      }
    }
  } else if (e.type === "user") {
    for (const c of e.message?.content ?? []) {
      const li = c.type === "tool_result" ? state.subTools.get(c.tool_use_id) : null;
      if (!li) continue;
      li.classList.remove("pending");
      li.classList.add(c.is_error ? "err" : "done");
      li.querySelector(":scope > .st")?.replaceChildren(icon(c.is_error ? "x" : "check"));
    }
  }
  if (live && following()) scrollDown(false);
}
// task_started / task_progress / task_notification: live stats on the card, and a status chip for work that outlives the call
function taskEvent(e) {
  const card = state.cards.get(e.tool_use_id);
  if (!card) return;
  if (e.subtype === "task_progress" && card.classList.contains("agent")) {
    const u = e.usage || {};
    card.querySelector(".stats").textContent = [u.tool_uses != null && `${u.tool_uses} tool${u.tool_uses === 1 ? "" : "s"}`, u.total_tokens != null && `${fmtTok(u.total_tokens)} tokens`, u.duration_ms != null && fmtDur(u.duration_ms)].filter(Boolean).join(" · ");
    card.querySelector(".now").textContent = e.description ? `Now: ${e.description}` : "";
    return;
  }
  // only work that outlives its tool call gets a status chip (a background subagent); a foreground command already shows its own spinner
  let chip = card.querySelector(".task-chip");
  if (e.subtype === "task_started" && e.is_backgrounded) {
    if (!chip) {
      chip = el("span", "task-chip");
      card.querySelector("summary .st").before(chip);
    }
    chip.hidden = false;
    chip.className = "task-chip running";
    chip.replaceChildren(el("i", "spin"), el("span", "", "in background"));
  } else if (e.subtype === "task_notification" && chip && !chip.hidden) {
    const word = { completed: "finished", failed: "failed", stopped: "stopped" }[e.status] || e.status || "finished";
    chip.className = `task-chip ${e.status === "failed" ? "err" : "done"}`;
    chip.replaceChildren(icon(e.status === "failed" ? "x" : "check"), el("span", "", word));
    if (e.summary) chip.title = e.summary;
    const now = card.querySelector(".now");
    if (now) now.textContent = "";
  }
  updateWorking();
}

function onEvent(e, live) {
  // what a subagent says and does arrives with the id of the call that spawned it: it belongs inside that card, not in the main thread
  if (e.parent_tool_use_id && (e.type === "assistant" || e.type === "user" || e.type === "stream_event")) return subEvent(e, live);
  switch (e.type) {
    case "question":
      push(questions.mount(state.current, e), live);
      break;
    case "question_answer": {
      questions.receive(state.current, e);
      const host = state.into || $("chat");
      const exists = [...host.querySelectorAll(".question-card")].some(card => card.dataset.questionId === e.id);
      if (!exists && ![...$("chat").querySelectorAll(".question-card")].some(card => card.dataset.questionId === e.id)) push(questions.mount(state.current, e), live);
      questions.refresh(host);
      break;
    }
    case "command_status":
      if (e.command === "compact") return void compactCard(e, live);
      addNote(e.text, e.status === "failed" ? "errtxt" : "note command-note");
      break;
    case "user_input": {
      if (e.command) break; // /compact is shown as its progress card, not as a message bubble
      if (e.auto === "brain") {
        push(el("div", "msg note", "Reminder sent: save anything durable to the shared brain."), live);
        break;
      }
      const d = el("div", "msg user");
      if (e.attachments?.length) d.append(...attachmentRows(e.attachments, live));
      if (e.text?.trim()) {
        const bubble = el("div", "bubble");
        bubble.append(userText(e.text, e.attachments));
        d.append(bubble);
        if (e.delivery) d.append(el("div", "delivery", e.delivery === "steer" ? "Sent while the agent was working" : "Was queued"));
        d.append(copyActions(() => e.text));
      }
      push(d, live);
      break;
    }
    case "stream_event": {
      const ev = e.event;
      if (!ev) break;
      if (ev.type === "message_start") state.live = null;
      if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") {
          renderLive("text");
          state.live.text += ev.delta.text;
        } else if (ev.delta?.type === "thinking_delta") {
          renderLive("thinking");
          state.live.thinking += ev.delta.thinking;
        }
      }
      break;
    }
    case "assistant":
      for (const b of e.message?.content ?? []) {
        if (b.type === "thinking" || b.type === "redacted_thinking") dropLive("thinking");
        if (b.type === "text" && b.text?.trim()) {
          dropLive("text");
          dropLive("thinking");
          push(asstMsg(b.text, true).root, live);
        } else if (b.type === "thinking" && b.thinking?.trim()) {
          dropLive("thinking");
          const det = el("details", "msg think");
          const sum = el("summary");
          sum.append(icon("sparkle"), el("span", "", "Reasoning"), icon("chev-right", "chev"));
          det.append(sum, el("div", "think-body", b.thinking));
          push(det, live);
        } else if (b.type === "tool_use") {
          dropLive("text");
          dropLive("thinking");
          if (isAgent(b.name)) {
            const ac = agentCard(b);
            state.cards.set(b.id, ac);
            push(ac, live);
            updateWorking();
            continue;
          }
          const card = el("details", "msg card pending");
          const sum = el("summary");
          const tool = icon(TOOL_ICON[b.name] || "code", "tool");
          const st = el("span", "st");
          st.append(el("i", "spin"), el("span", "sr-only", "running"));
          const why = describedAs(b.name, b.input);
          sum.append(tool, el("span", "name", toolName(b.name, b.input)), el("span", why ? "sum human" : "sum", why || summarize(b.name, b.input)), st, icon("chev-right", "chev"));
          sum.title = summarize(b.name, b.input);
          card.toolInput = { name: b.name, input: b.input };
          card.append(sum, el("div", "body")); // the open row wraps to show the whole label, so it is not repeated below
          card.addEventListener("toggle", () => {
            if (!card.open) return;
            if (card.toolInput) {
              const body = card.querySelector(".body");
              const { name, input } = card.toolInput;
              body.replaceChildren(...toolBody(name, input).childNodes, ...body.querySelectorAll(".tool-result"));
              card.toolInput = null;
            }
            for (const code of card.querySelectorAll("code[data-highlight-pending]")) {
              highlightInto(code, code.textContent, code.dataset.highlightPending);
              delete code.dataset.highlightPending;
            }
            fitOutputs(card);
          });
          state.cards.set(b.id, card);
          push(card, live);
        }
      }
      break;
    case "user":
      for (const c of e.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const card = state.cards.get(c.tool_use_id);
        if (!card) continue;
        card.classList.remove("pending");
        card.classList.add(c.is_error ? "err" : "done");
        const st = card.querySelector(".st");
        st.replaceChildren(icon(c.is_error ? "x" : "check"), el("span", "sr-only", c.is_error ? "error" : "done"));
        const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n");
        if (text) {
          const out = toolOutput(text, !!c.is_error);
          card.querySelector(".body").append(out);
          if (card.open) fitOutput(out);
        }
      }
      updateWorking();
      break;
    case "result": {
      dropLive("text");
      dropLive("thinking");
      state.live = null;
      const bits = [];
      if (e.duration_ms) bits.push(`${(e.duration_ms / 1000).toFixed(1)}s`);
      if (typeof e.total_cost_usd === "number") bits.push(`$${e.total_cost_usd.toFixed(4)}`);
      if (e.is_error || (e.subtype && e.subtype !== "success")) bits.push(e.subtype || "error");
      const last = (state.into || $("chat")).lastElementChild;
      const row = last?.matches(".msg.asst") ? last.querySelector(".actions") : null;
      if (row) row.append(el("span", "foot", bits.join(" · "))); // stats sit on the reply's action row
      else push(el("div", "msg foot", bits.join(" · ")), live);
      break;
    }
    case "system":
      if (e.subtype?.startsWith("task_")) taskEvent(e);
      break;
    case "tool_update": {
      const card = state.cards.get(e.tool_use_id) ?? state.subTools.get(e.tool_use_id);
      if (!card) break;
      card.querySelector(".name").textContent = toolName(e.name, e.input);
      card.querySelector(".sum").textContent = summarize(e.name, e.input);
      const summary = card.querySelector("summary") || card;
      summary.title = summarize(e.name, e.input);
      const body = card.querySelector(".body");
      if (body) {
        card.toolInput = { name: e.name, input: e.input };
        if (card.open) {
          body.replaceChildren(...toolBody(e.name, e.input).childNodes, ...body.querySelectorAll(".tool-result"));
          card.toolInput = null;
        }
      }
      break;
    }
    case "tool_label": {
      // The helper model's plain-English version of a command that came without a description; arrives a few seconds after the card
      const sumEl = (state.cards.get(e.tool_use_id) ?? state.subTools.get(e.tool_use_id))?.querySelector(".sum");
      if (sumEl && !sumEl.classList.contains("human")) {
        sumEl.textContent = e.label;
        sumEl.classList.add("human");
      }
      break;
    }
    case "aborted":
      state.live = null;
      settleCompact("stopped");
      push(el("div", "msg note", "Stopped."), live);
      break;
    case "console_error":
      push(errBlock(e.text), live);
      break;
    case "rate_limit_event":
      if (live) setUsage(e);
      break;
  }
}

function meterColor(pct) { return pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)"; }
function setUsage(e, provider = cur()?.provider || "claude") {
  const w = e.rate_limit_info?.unifiedWindows;
  if (!w) return;
  state.usage[provider] = { updatedAt: Date.now(), windows: [["5-hour", w.five_hour], ["7-day", w.seven_day]].filter(([,x]) => Number.isFinite(x?.utilization)).map(([label,x]) => ({ label, used: x.utilization * 100, limit: 100, unit: "%", ...((x.resetsAt || x.resets_at) ? { resetsAt: (x.resetsAt || x.resets_at) * 1000 } : {}) })) };
  renderUsage();
}
function usageMeter(label, used, limit, unit = "%", resetsAt) {
  const pct = Math.max(0, Math.min(100, used / limit * 100));
  const row = el("div", "u");
  const bar = el("div", "bar");
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-label", label);
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(limit)); bar.setAttribute("aria-valuenow", String(used));
  const text = unit === "%" ? `${Math.round(pct)}%` : unit === "$" ? `$${used.toFixed(2)} / $${limit.toFixed(2)}` : unit === "tokens" ? `${fmtTok(used)} / ${fmtTok(limit)}` : `${used} / ${limit}`;
  bar.setAttribute("aria-valuetext", text);
  row.title = `${label}: ${text}${resetsAt ? ` · resets ${new Date(resetsAt).toLocaleString()}` : ""}`;
  const fill = el("i"); fill.style.width = `${pct}%`; fill.style.background = meterColor(pct); bar.append(fill);
  const value = el("span", "pct", unit === "%" || unit === "tokens" ? `${Math.round(pct)}%` : text); value.style.color = meterColor(pct);
  row.append(el("span", "", label), bar, value);
  return row;
}
function renderUsage() {
  const providers = [...state.providers.values()].filter(p => p.id !== "mock");
  if (!providers.length) return;
  if (!providers.some(p => p.id === state.usageTab)) state.usageTab = providers[0].id;
  const root = $("usage");
  const focusedTab = root.contains(document.activeElement) ? document.activeElement.id : null;
  const tabKey = providers.map(p => p.id).join(",");
  let tabs = root.querySelector(".usage-tabs");
  const rebuildTabs = !tabs || tabs.dataset.providers !== tabKey;
  if (rebuildTabs) { tabs = el("div", "usage-tabs"); tabs.dataset.providers = tabKey; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Provider usage"); }
  const pane = el("div", "usage-pane"); pane.id = "usage-panel"; pane.setAttribute("role", "tabpanel"); pane.setAttribute("aria-labelledby", `usage-tab-${state.usageTab}`);
  if (rebuildTabs) providers.forEach((p, i) => {
    const btn = el("button", "usage-tab", p.id === "claude" ? "Claude" : p.id === "pi" ? "OpenRouter" : p.label);
    btn.id = `usage-tab-${p.id}`; btn.type = "button"; btn.setAttribute("role", "tab"); btn.setAttribute("aria-selected", String(p.id === state.usageTab)); btn.setAttribute("aria-controls", pane.id); btn.tabIndex = p.id === state.usageTab ? 0 : -1;
    btn.onclick = () => { state.usageTab = p.id; renderUsage(); $(btn.id)?.focus(); };
    btn.onkeydown = e => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return; e.preventDefault(); const n = e.key === "Home" ? 0 : e.key === "End" ? providers.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + providers.length) % providers.length; state.usageTab = providers[n].id; renderUsage(); $(`usage-tab-${state.usageTab}`).focus(); };
    tabs.append(btn);
  });
  for (const btn of tabs.children) {
    const selected = btn.id === `usage-tab-${state.usageTab}`;
    btn.setAttribute("aria-selected", String(selected)); btn.tabIndex = selected ? 0 : -1;
  }
  const sample = state.usage[state.usageTab];
  const head = el("div", "usage-head", "");
  const refresh = iconButton("refresh", "Refresh usage", "btn icon sm ghost usage-refresh");
  refresh.onclick = () => { refresh.classList.add("spinning"); refresh.disabled = true; send({ t: "refresh_usage" }); setTimeout(() => { refresh.classList.remove("spinning"); refresh.disabled = false; }, 4000); };
  const stamp = sample?.updatedAt ? el("span", "usage-stamp", new Date(sample.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : null;
  if (stamp) { stamp.title = `Updated ${new Date(sample.updatedAt).toLocaleString()}`; refresh.setAttribute("aria-label", `Refresh usage (updated ${stamp.textContent})`); }
  head.append(el("span", "usage-label", "Allowance"), ...(stamp ? [stamp] : []), refresh);
  pane.append(head);
  if (sample?.windows?.length) {
    for (const w of sample.windows) pane.append(usageMeter(w.label, w.used, w.limit, w.unit || "requests", w.resetsAt));
  } else pane.append(el("div", "usage-note", sample?.note || (state.usageTab === "claude" ? "Claude reports its allowance after each turn." : "No allowance telemetry yet. Tap refresh.")));
  if (sample?.windows?.some(w => w.resetsAt && w.resetsAt < Date.now())) pane.append(el("div", "usage-note", "Last reported usage · reset passed; awaiting refresh."));
  if (sample?.spendToday != null) pane.append(el("div", "usage-note", `$${sample.spendToday.toFixed(4)} spent today`));
  const t = cur()?.provider === state.usageTab ? cur() : [...state.threads.values()].filter(t => t.provider === state.usageTab).sort((a,b) => b.updatedAt-a.updatedAt)[0];
  const hasCtx = t?.context?.used != null && t.context.max;
  const detail = hasCtx ? `${fmtTok(t.context.used)} of ${fmtTok(t.context.max)} tokens`
    : t?.context?.used != null ? `${fmtTok(t.context.used)} tokens · window not reported`
    : t?.lastCompactedAt ? "Compacted · token usage updates on the next request." : "Context not reported yet.";
  const ctxRow = hasCtx ? usageMeter("Context", t.context.used, t.context.max, "tokens") : el("div", "u u-empty", "");
  ctxRow.classList.add("u-ctx");
  if (!hasCtx) ctxRow.append(el("span", "", "Context"), el("span", "bar"), el("span", "pct", "\u2013"));
  const info = iconButton("info", "Context details", "btn icon sm ghost usage-info");
  info.id = "usage-ctx-info"; info.setAttribute("aria-controls", "usage-ctx-detail"); info.setAttribute("aria-expanded", String(state.ctxOpen));
  info.title = "Context details";
  const box = el("div", "usage-ctx-detail"); box.id = "usage-ctx-detail"; box.hidden = !state.ctxOpen;
  box.append(el("div", "", detail));
  if (t) { const title = el("div", "usage-thread", t.title); title.title = t.title; box.append(title); }
  info.onclick = () => { state.ctxOpen = !state.ctxOpen; info.setAttribute("aria-expanded", String(state.ctxOpen)); box.hidden = !state.ctxOpen; };
  const ctxWrap = el("div", "usage-ctx"); ctxWrap.setAttribute("role", "group"); ctxWrap.setAttribute("aria-label", "Thread context");
  const line = el("div", "usage-ctx-line"); line.append(ctxRow, info);
  ctxWrap.append(line, box); pane.append(ctxWrap);
  if (hasCtx && t.context.used / t.context.max >= 0.7) {
    const note = el("div", "usage-note", "Long context increases repeated input. Compact this task, or start a fresh thread for unrelated work.");
    if (t.status === "idle") {
      const compact = el("button", "btn sm ghost", "Compact context");
      compact.type = "button"; compact.onclick = () => send({ t: "compact", thread: t.id });
      note.append(compact);
    }
    pane.append(note);
  }
  if (rebuildTabs) root.replaceChildren(tabs, pane);
  else root.querySelector(".usage-pane").replaceWith(pane);
  if (focusedTab) $(focusedTab)?.focus({ preventScroll: true });
}

// ---------- controls ----------
let submitting = false;
async function submit(mode) {
  const box = $("input");
  if (submitting || !state.current) return;
  if (!box.value.trim() && !pending.length) return;
  submitting = true;
  try {
    await Promise.all(pending.map((p) => p.ready)); // uploads still in flight; failed ones remove themselves
    const text = box.value.trim();
    if (/^\/(model|effort)$/i.test(text)) {
      if (text.toLowerCase() === "/effort" && $("effort").hidden) { toast("This agent does not expose effort settings."); return; }
      if (cur()?.status === "running") { toast("Stop the running operation before changing settings."); return; }
      box.value = ""; closeSlash();
      menus[text.slice(1).toLowerCase()].open();
      return;
    }
    const attachments = pending.filter((p) => p.id).map((p) => ({ id: p.id, ...(p.n ? { n: p.n } : {}) }));
    if (!text && !attachments.length) return;
    if (!mode && !attachments.length && (questions.count(state.current) || cur()?.waiting)) mode = "steer";
    // mid-turn a message queues until the turn ends; mode "steer" (Alt+Enter, or Steer on a queued card) hands it to the agent now
    send({ t: "send", thread: state.current, text, attachments, ...(mode ? { mode } : {}) });
    box.value = "";
    box.style.height = "";
    pending.length = 0;
    imageCount = 0;
    renderThumbs();
    closeSlash();
  } finally {
    submitting = false;
  }
}
$("send").onclick = () => submit();
$("stop").onclick = () => send({ t: "abort", thread: state.current });

// ---------- attachments (paste, drop, or the attach button) ----------
// Each file is uploaded as soon as it is attached (raw bytes over HTTP); a message then just names the uploads.
// Big screenshots are downscaled in the browser first: the model's image limits and the thread log both prefer small.
const MAX_ATTACH = 8;
const MAX_EDGE = 2000;
const KEEP_AS_IS = 1.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const NATIVE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
let imageCount = 0; // the next "[Image #n]" label
// Images get a label the message can refer to ("compare [Image #1] with [Image #2]"), dropped into the text where the cursor is.
function insertToken(token) {
  const box = $("input");
  const a = box.selectionStart ?? box.value.length;
  const b = box.selectionEnd ?? a;
  const before = box.value.slice(0, a);
  const after = box.value.slice(b);
  const ins = `${before && !/\s$/.test(before) ? " " : ""}${token} `;
  box.value = before + ins + after;
  box.setSelectionRange((before + ins).length, (before + ins).length);
  box.dispatchEvent(new Event("input")); // resize, and keep the slash menu in step
}
function removeToken(n) {
  const box = $("input");
  const token = `[Image #${n}]`;
  box.value = box.value.includes(token + " ") ? box.value.replace(token + " ", "") : box.value.replace(token, "");
  box.dispatchEvent(new Event("input"));
}
const pending = []; // { thread, name, kind: "image"|"file", size, url (images: data: URL, so the CSP needs no blob:), id (once uploaded), busy, ready }

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const readDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

// images the browser can decode are checked, downscaled and previewed; anything else is attached as a plain file
async function prepare(file) {
  const label = file.name || "That file";
  const bmp = file.type.startsWith("image/") ? await createImageBitmap(file).catch(() => null) : null;
  if (!bmp) {
    if (!file.size) throw new Error(`${label} is empty (or a folder).`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${label} is over ${MAX_FILE_BYTES >> 20} MB.`);
    return { blob: file, name: file.name || "file", kind: "file" };
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    let blob = file;
    let name = file.name || "image";
    if (scale < 1 || file.size > KEEP_AS_IS || !NATIVE.includes(file.type)) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; // JPEG has no alpha
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
      name = name.replace(/\.[^.]*$/, "") + ".jpg";
    }
    if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error(`${label} is too large.`);
    return { blob, name, kind: "image", url: await readDataUrl(blob) };
  } finally {
    bmp.close?.();
  }
}

async function upload(thread, blob, name) {
  const r = await apiFetch(`/uploads/${thread}`, { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream", "X-Name": encodeURIComponent(name) }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status}).`);
  return j;
}
const discard = (p) => p.ready.then(() => p.id && apiFetch(`/uploads/${p.thread}/${p.id}`, { method: "DELETE" }).catch(() => {}));
function dropPending(p) {
  const i = pending.indexOf(p);
  if (i >= 0) pending.splice(i, 1);
  renderThumbs();
}
function clearPending() {
  for (const p of pending.splice(0)) discard(p);
  imageCount = 0;
  renderThumbs();
}

function renderThumbs() {
  const ul = $("thumbs");
  if (!pending.some((p) => p.kind === "image")) imageCount = 0; // numbering starts again once no image is waiting
  ul.hidden = !pending.length;
  renderAction();
  if (pending.length) $("attach").dataset.count = String(pending.length);
  else delete $("attach").dataset.count;
  ul.replaceChildren(
    ...pending.map((p) => {
      const li = el("li", p.kind === "image" ? "" : "file");
      if (p.busy) li.setAttribute("aria-busy", "true");
      if (p.kind === "image") {
        const img = el("img");
        img.src = p.url;
        img.alt = p.n ? `${p.name} (Image ${p.n})` : p.name;
        li.append(img);
        if (p.n) li.append(el("span", "n", String(p.n)));
      } else {
        li.append(icon("file"), el("span", "nm", p.name), el("span", "sz", fmtSize(p.size)));
      }
      const rm = el("button", "btn rm");
      rm.type = "button";
      rm.setAttribute("aria-label", `Remove ${p.name}`);
      rm.append(icon("x"));
      rm.onclick = () => {
        dropPending(p);
        discard(p);
        if (p.n) removeToken(p.n);
        $("input").focus();
      };
      li.append(rm);
      return li;
    }),
  );
}

// serialised, so two quick pastes cannot both pass the MAX_ATTACH check while their files are still being processed
let adding = Promise.resolve();
const addFiles = (files) => (adding = adding.then(() => addFilesNow(files)));
async function addFilesNow(files) {
  const thread = state.current;
  if (!thread) return;
  for (const f of files) {
    if (pending.length >= MAX_ATTACH) {
      addNote(`At most ${MAX_ATTACH} attachments per message.`, "errtxt");
      break;
    }
    try {
      const prep = await prepare(f);
      if (state.current !== thread) return; // switched threads while processing
      const p = { thread, name: prep.name, kind: prep.kind, size: prep.blob.size, url: prep.url, busy: true, n: prep.kind === "image" ? ++imageCount : 0 };
      if (p.n) insertToken(`[Image #${p.n}]`);
      p.ready = upload(thread, prep.blob, prep.name).then(
        (r) => {
          Object.assign(p, { id: r.id, name: r.name, kind: r.kind });
        },
        (err) => {
          dropPending(p);
          if (p.n) removeToken(p.n);
          addNote(`${prep.name}: ${err.message}`, "errtxt");
        },
      ).finally(() => {
        p.busy = false;
        renderThumbs();
      });
      pending.push(p);
      renderThumbs();
    } catch (err) {
      addNote(err.message, "errtxt");
    }
  }
}

$("input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  const text = e.clipboardData.getData("text/plain").trim();
  // A spreadsheet or rich-text copy carries a rendered picture beside its real text: the text wins.
  // A file copied in a file manager carries its own name as the text, or is not an image at all: that is a file paste.
  const fileCopy = files.some((f) => f.name === text || !f.type.startsWith("image/"));
  if (text && !fileCopy) return;
  e.preventDefault();
  addFiles(files);
});
$("attach").onclick = () => $("file").click();
$("file").onchange = (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
};
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
const dragging = (on) => {
  document.body.classList.toggle("dragging", on);
  $("cbox").classList.toggle("drop", on);
};
document.addEventListener("dragenter", (e) => {
  if (hasFiles(e) && state.current) {
    dragDepth++;
    dragging(true);
  }
});
document.addEventListener("dragleave", (e) => {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0;
    dragging(false);
  }
});
document.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault()); // otherwise the browser navigates to the dropped file
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dragging(false);
  const files = [];
  let folders = 0;
  if (e.dataTransfer.items) {
    for (const it of e.dataTransfer.items) {
      if (it.kind !== "file") continue;
      if (it.webkitGetAsEntry?.()?.isDirectory) folders++;
      else if (it.getAsFile()) files.push(it.getAsFile());
    }
  } else files.push(...e.dataTransfer.files);
  if (folders) addNote("Folders can't be attached. Zip the folder first.", "errtxt");
  addFiles(files);
});

// ---------- slash menu ("/" for commands and skills) ----------
const slash = { items: [], idx: 0, dismissed: false };
const slashEl = $("slash");
function slashQuery() {
  const m = /^\/([^\s]*)$/.exec($("input").value.trimStart());
  return m ? m[1].toLowerCase() : null;
}
function slashMatches(q) {
  const rank = (c) => {
    const n = c.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[:\-_]/).some((p) => p.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    if (c.description.toLowerCase().includes(q)) return 4;
    return 9;
  };
  return (state.commands[cur()?.provider || "claude"] || []).filter((c) => !c.name.startsWith("_")).map((c) => [rank(c), c]).filter(([r]) => r < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, 60).map(([, c]) => c);
}
function closeSlash() {
  slashEl.hidden = true;
  slash.items = [];
  $("input").setAttribute("aria-expanded", "false");
  $("input").removeAttribute("aria-activedescendant");
}
function renderSlash() {
  slashEl.replaceChildren();
  if (!slash.items.length) {
    const li = el("li", "none", (state.commands[cur()?.provider || "claude"] || []).length ? "No matching commands" : "Commands load after your first message.");
    slashEl.append(li);
    return;
  }
  slash.items.forEach((c, i) => {
    const li = el("li");
    li.id = `slash-${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === slash.idx));
    const head = el("span", "cmd", "/" + c.name);
    if (c.argumentHint) head.append(el("span", "arg", c.argumentHint));
    li.append(head, el("span", "desc", c.description));
    li.onmousedown = (e) => e.preventDefault(); // keep focus in the textarea
    li.onclick = () => acceptSlash(c);
    slashEl.append(li);
  });
  $("input").setAttribute("aria-activedescendant", `slash-${slash.idx}`);
}
function updateSlash() {
  const q = slashQuery();
  if (q === null || slash.dismissed || $("input").disabled) return closeSlash();
  slash.items = slashMatches(q);
  slash.idx = Math.min(slash.idx, Math.max(0, slash.items.length - 1));
  slashEl.hidden = false;
  $("input").setAttribute("aria-expanded", "true");
  renderSlash();
}
function moveSlash(d) {
  if (!slash.items.length) return;
  slash.idx = (slash.idx + d + slash.items.length) % slash.items.length;
  [...slashEl.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === slash.idx)));
  slashEl.children[slash.idx]?.scrollIntoView({ block: "nearest" });
  $("input").setAttribute("aria-activedescendant", `slash-${slash.idx}`);
}
function acceptSlash(c) {
  const box = $("input");
  box.value = `/${c.name} `;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  box.dispatchEvent(new Event("input"));
}
$("input").addEventListener("keydown", (e) => {
  const shown = !slashEl.hidden;
  const open = shown && slash.items.length > 0;
  if (shown && e.key === "Escape") {
    e.preventDefault();
    slash.dismissed = true;
    return closeSlash();
  }
  if (open) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      return moveSlash(e.key === "ArrowDown" ? 1 : -1);
    }
    if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && !e.isComposing) {
      const c = slash.items[slash.idx];
      const exact = c.name.toLowerCase() === slashQuery();
      if (e.key === "Enter" && exact) {
        e.preventDefault();
        return submit(e.altKey ? "steer" : undefined);
      } else {
        e.preventDefault();
        return acceptSlash(c);
      }
    }
  }
  const desktop = matchMedia("(pointer:fine)").matches;
  const command = /^\/[a-z][\w:-]*(?:\s[\s\S]*)?$/i.test($("input").value.trim());
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (desktop || command)) {
    e.preventDefault();
    submit(e.altKey ? "steer" : undefined); // Alt+Enter: steer the running turn now instead of queueing
  }
});
function sizeInput() {
  const box = $("input");
  box.style.height = "auto";
  const viewport = window.visualViewport?.height || window.innerHeight;
  const line = parseFloat(getComputedStyle(box).lineHeight);
  const chat = getComputedStyle($("chat"));
  const reserve = $("head").offsetHeight + $("composer").offsetHeight - box.offsetHeight
    + parseFloat(chat.paddingTop) + parseFloat(chat.paddingBottom) + line;
  box.style.height = Math.max(line, Math.min(box.scrollHeight, viewport * 0.35, viewport - reserve)) + "px";
}
$("input").addEventListener("input", () => {
  sizeInput();
  slash.dismissed = false;
  slash.idx = 0;
  updateSlash();
  renderAction();
});
// Safari can resize only its visual viewport when the keyboard opens. Preserve pinch-to-zoom.
let viewportFrame;
function fitViewport() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    const v = window.visualViewport;
    if (v && Math.abs(v.scale - 1) >= 0.01) {
      document.documentElement.style.removeProperty("--viewport-height");
      return;
    }
    if (v) document.documentElement.style.setProperty("--viewport-height", `${v.height}px`);
    sizeInput();
    if (following()) scrollDown(true);
  });
}
window.visualViewport?.addEventListener("resize", fitViewport);
fitViewport();
$("input").addEventListener("blur", () => setTimeout(closeSlash, 120));
$("menu").onclick = () => setNav(!document.body.classList.contains("nav"));
$("scrim").onclick = () => setNav(false);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav")) {
    setNav(false);
    $("menu").focus();
  }
});
function openNewDialog() {
  setNav(false);
  $("dlg").showModal();
}
$("new").onclick = openNewDialog;
$("archive-toggle").onclick = () => {
  state.archiveOpen = !state.archiveOpen;
  localStorage.setItem("ac_archive_open", state.archiveOpen ? "1" : "");
  renderThreads();
};
$("reload").onclick = () => location.reload();
$("restart").onclick = async () => {
  const r = await apiFetch("/restart", { method: "POST" }).catch(() => null);
  toast(r?.ok ? "Restart scheduled. It happens once every thread is idle, then this page reloads." : "Could not schedule a restart.");
};
$("dform").addEventListener("submit", (e) => {
  if (e.submitter?.value === "ok") send({ t: "create", provider: menus.dProv.value, cwd: menus.dCwd.value, model: menus.dModel.value, effort: menus.dEffort.value, mode: menus.dMode.value });
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
try {
  const draft = sessionStorage.getItem("ac_draft");
  sessionStorage.removeItem("ac_draft");
  if (draft && !$("input").value) {
    $("input").value = draft;
    $("input").dispatchEvent(new Event("input")); // resize the composer and enable Send
  }
} catch {}
clearChat();
renderHead();
connect();
