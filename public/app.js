import { showAssignmentProgress } from "/assign-progress.js";
import { attachmentDraftStore } from "/attachment-drafts.js";
import { autoCandidates, autoPick } from "/auto-pick.js";
import { openJobDebug } from "/automation-job-debug.js";
import { createAutoLane } from "/automation-lane.js";
import { createChatSearch } from "/chat-search.js";
import { composerField } from "/composer-field.js";
import { openContextEconomics } from "/context-economics.js";
import { createMenu } from "/menu.js";
import { setupNotifications } from "/notifications.js";
import { createPromptImprove } from "/prompt-improve.js";
import { createQuestions } from "/questions.js";
import {
  $,
  el,
  highlightInto,
  icon,
  iconButton,
  isImageFile,
  langFromPath,
  localImage,
  parseFileRef,
  renderMarkdown,
  setFileScope,
  wireCopy,
} from "/render.js";
import { createSchedules, DAY_ITEMS, REPEAT_ITEMS } from "/schedules.js";
import { createLatencyReporter } from "/telemetry.js";
import { toolName, toolSummary } from "/tool-display.js";
import { closeBreakdown, openBreakdown } from "/turn-breakdown.js";

composerField($("input"));

const MODE_META = {
  plan: { label: "Plan", desc: "Read-only. Plans without editing.", icon: "eye" },
  acceptEdits: { label: "Accept edits", desc: "Edits files without asking.", icon: "pencil" },
  bypassPermissions: {
    label: "Bypass",
    desc: "Runs every tool without asking.",
    icon: "shield-off",
    tone: "warn",
  },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const EFFORT_LABEL = { xhigh: "Extra high", ultracode: "Ultra" };
const EFFORT_DESC = {
  ultracode:
    "Claude Code's Ultracode: starts a multi-agent workflow on every task. Slow and costly; keep it for big jobs.",
  max: "Deepest reasoning the model offers.",
  xhigh: "More reasoning than High, less than Max.",
};
const effortLabel = (v) => EFFORT_LABEL[v] || cap(v);
const state = {
  commands: {},
  providers: new Map(),
  threads: new Map(),
  tasks: new Map(),
  lane: localStorage.getItem("ac_lane") === "tasks" ? "tasks" : "threads",
  current: null,
  ready: false,
  dirs: [],
  live: null,
  cards: new Map(),
  usage: {},
  usageTab: "claude",
  archiveOpen: !!localStorage.getItem("ac_archive_open"),
  stick: true, // the reader is at the bottom of the chat (kept from scroll events, since layout growth fires none)
  subs: new Map(), // tool_use id of a subagent (or nested subagent) -> the <ol> its activity is listed in
  subTools: new Map(), // tool_use id of a call made inside a subagent -> its row
  queues: {},
  features: {}, // thread id -> messages waiting for the running turn to end
  loading: null,
  loadTimer: 0,
  renderToken: 0,
  rendering: false,
  pendingLive: [],
  into: null,
  start: 0,
};
setFileScope(() => state.current); // local image/video refs in markdown resolve against this thread's folder
const views = new Map(); // five most recently visited threads; stale snapshots remain visible during revalidation
const chatSearch = createChatSearch({
  current: () => state.current,
  history: () => ({
    older: state.start > 0,
    busy: !!(
      state.loading ||
      state.rendering ||
      state.loadingEarlier ||
      (state.revalidating && !state.deferredRefresh)
    ),
  }),
  loadEarlier: () => requestEarlier(state.current),
  prepare: () => {
    for (const card of $("chat").querySelectorAll(".card")) materializeTool(card);
  },
  navigate: () => {
    releaseHistoryAnchor();
    state.stick = false;
  },
});
let ws,
  retry = 0,
  reconnectTimer = 0,
  probeTimer = 0;
let draftsLoaded = false;

// ---------- connection ----------
function connect() {
  if (!draftsLoaded) return;
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState <= 1) return; // connecting or open already
  const sock = (ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  ));
  sock.onopen = () => {
    if (sock !== ws) return;
    retry = 0;
    signedOut = false;
    questions.setConnected(true);
    banner("");
  };
  sock.onclose = () => {
    if (sock === ws) closed();
  };
  sock.onmessage = (m) => {
    if (sock !== ws) return;
    clearTimeout(probeTimer);
    probeTimer = 0; // anything from the server proves the socket alive
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
function closed() {
  clearTimeout(probeTimer);
  probeTimer = 0;
  questions.setConnected(false);
  if (queueEditor) {
    queueEditor.pending = false;
    $("queue-edit-error").textContent =
      "Disconnected. Reconnect to save, or reopen this editor after reconnecting.";
    $("queue-cancel").disabled = false;
    $("queue-save").disabled = queueEditor.revision == null;
    $("queue-draft").disabled = queueEditor.revision == null;
  }
  if (!signedOut) banner("Disconnected. Reconnecting…");
  if (retry >= 1) checkSignIn();
  reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
}
// After a phone wakes the socket can look open yet be dead. Ping; no reply within 1.5 s means drop it and reconnect now.
function probe() {
  if (ws?.readyState !== 1) return void reconnectNow();
  if (probeTimer) return;
  ws.send(JSON.stringify({ t: "ping" }));
  probeTimer = setTimeout(() => {
    probeTimer = 0;
    const dead = ws;
    ws = null; // its late close event is ignored
    try {
      dead.close();
    } catch {}
    closed();
    retry = 0;
    connect();
  }, 1500);
}
function reconnectNow() {
  if (ws?.readyState === 1) return probe();
  if (ws?.readyState === 0) return; // already connecting
  retry = 0;
  connect();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    reconnectNow();
    warmSoon();
  }
});
addEventListener("online", reconnectNow);
addEventListener("pageshow", (e) => e.persisted && reconnectNow());
// Messages the user typed or Stop presses: kept until the server acknowledges them, resent after a reconnect (the server drops
// repeats by id), so a dead socket neither loses nor duplicates them.
const outbox = [];
const sendingDrafts = new Map();
let cidSeq = 0;
function sendReliable(msg, draft) {
  const item = {
    ...msg,
    cid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${++cidSeq}`,
  };
  if (draft) {
    draft = { ...draft, createdAt: Date.now(), sequence: cidSeq };
    sendingDrafts.set(item.cid, draft);
    try {
      localStorage.setItem(`ac_sending:${item.cid}`, JSON.stringify(draft));
    } catch {
      toast("Browser storage unavailable. Keep this page open until your message sends.");
    }
  }
  outbox.push(item);
  if (!send(item)) {
    toast("Offline. Your message will send when the connection is back.");
    return false;
  }
  if (!state.features.acks)
    acked(item.cid); // An older server cannot acknowledge: never resend.
  else setTimeout(() => outbox.includes(item) && probe(), 2000);
  return true;
}
function flushOutbox() {
  for (const item of [...outbox]) {
    if (!send(item)) return;
    if (!state.features.acks) acked(item.cid);
  }
}
function acked(cid, accepted = true) {
  const at = outbox.findIndex((x) => x.cid === cid);
  if (at >= 0) outbox.splice(at, 1);
  const draft = sendingDrafts.get(cid);
  sendingDrafts.delete(cid);
  if (!accepted && draft) void recoverSendingDraft(cid, draft);
  else if (draft) void finishSendingDraft(cid, draft);
  else
    try {
      localStorage.removeItem(`ac_sending:${cid}`);
    } catch {}
}
const send = (o) => {
  if (ws?.readyState !== 1) return false;
  ws.send(JSON.stringify(o));
  return true;
};
const questions = createQuestions({
  send,
  root: () => $("chat"),
  changed: () => {
    renderThreads();
    updateWorking();
  },
});
const latency = createLatencyReporter(
  (samples) => {
    if (ws?.readyState !== 1 || !state.features.latency) return false;
    ws.send(JSON.stringify({ t: "telemetry", samples }));
    return true;
  },
  () => state.features.latency,
);
let firstToken = null; // the turn this device just started, until its first token is painted
const firstTokenMs = new Map(); // thread -> last send -> first token painted, shown in Run details
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
  saveDraft();
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
const checkSignIn = () =>
  apiFetch("/manifest.webmanifest", { cache: "no-store" }).then(
    () => {},
    () => {},
  );

// File viewing adds no request to startup. Warm its module and stylesheet only after history has painted, in idle time.
let fileViewer,
  fileViewerLoad,
  fileWarmupScheduled = false;
function loadFileViewer(metricThread = state.current) {
  const at = performance.now();
  return (fileViewerLoad ||= import("/file-viewer.js")
    .then(async (module) => {
      await module.prepare();
      const viewer = (fileViewer ||= module.createFileViewer(apiFetch, (sample) =>
        latency.record(sample),
      ));
      viewer.record({
        kind: "viewer_module",
        thread: metricThread,
        total_ms: performance.now() - at,
        module_ms: performance.now() - at,
      });
      return viewer;
    })
    .catch((error) => {
      fileViewerLoad = null;
      throw error;
    }));
}
function warmFileViewer() {
  if (fileWarmupScheduled) return;
  fileWarmupScheduled = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const warm = () => {
        if (!document.hidden) loadFileViewer().catch(() => {});
      };
      if ("requestIdleCallback" in window) window.requestIdleCallback(warm);
      else setTimeout(warm, 1500);
    }),
  );
}
function openRefLink(event) {
  const link = event.target.closest?.("a[data-gh-ref]");
  if (!link || !$("chat").contains(link)) return;
  event.preventDefault();
  if (!state.current) return;
  const tab = window.open("", "_blank"); // opened synchronously so the popup blocker allows it
  const query = new URLSearchParams({ thread: state.current, n: link.dataset.ghRef });
  fetch(`/api/gh-ref?${query}`)
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(body.error || "Could not resolve this reference.");
      if (tab) {
        tab.opener = null;
        tab.location.href = body.url;
      }
    })
    .catch((error) => {
      tab?.close();
      toast(error.message || "Could not resolve this reference.");
    });
}
function openFileLink(event) {
  if (event.type === "auxclick" && event.button !== 1) return;
  const link = event.target.closest?.("a");
  if (!link || !$("chat").contains(link) || link.dataset.ghRef) return;
  const image = link.dataset.viewerImage;
  const ref = image
    ? {
        path: link.title || link.querySelector("img")?.alt || "Image",
        imageUrl: link.getAttribute("href"),
      }
    : parseFileRef(link.dataset.fileRef || link.getAttribute("href"));
  if (!ref || !state.current) return;
  event.preventDefault(); // modified clicks also stay inside the viewer instead of opening a broken app route
  const thread = state.current,
    openedAt = performance.now();
  link.setAttribute("aria-busy", "true");
  loadFileViewer()
    .then((viewer) => {
      if (state.current === thread && link.isConnected)
        viewer.open({
          thread,
          ref,
          opener: link,
          openedAt,
          module_ms: performance.now() - openedAt,
        });
    })
    .catch((error) => toast(error.message || "Could not load the file viewer. Try again."))
    .finally(() => link.removeAttribute("aria-busy"));
}
$("files").onclick = async () => {
  const opener = $("side-more"),
    openedAt = performance.now();
  opener.setAttribute("aria-busy", "true");
  try {
    const viewer = await loadFileViewer("viewer:repos");
    setNav(false);
    viewer.openWorkspace({ opener, openedAt, module_ms: performance.now() - openedAt });
  } catch (error) {
    toast(error.message || "Could not load the file viewer. Try again.");
  } finally {
    opener.removeAttribute("aria-busy");
  }
};
$("chat").addEventListener("click", openRefLink);
$("chat").addEventListener("click", openFileLink);
$("chat").addEventListener("auxclick", openFileLink);

function onUsageMessage(message) {
  state.usage[message.provider] = message.usage;
  renderUsage();
}

function providerMenuItems(providers) {
  return providers.map((provider) => ({
    value: provider.id,
    label: provider.label,
    desc: provider.ok ? undefined : provider.hint,
    disabled: !provider.ok,
  }));
}

function onProvidersMessage(message) {
  state.providers = new Map(message.providers.map((provider) => [provider.id, provider]));
  menus.model.provider = null;
  menus.dProv.setItems(providerMenuItems(message.providers), menus.dProv.value);
  const provider = prov(menus.dProv.value);
  if (provider) {
    menus.dModel.setItems(
      modelItems(provider.models, provider),
      menus.dModel.value || provider.defaultModel,
    );
    fillEffort(menus.dEffort, provider, menus.dModel.value, menus.dEffort.value);
  }
  renderHead();
}

function onCommandsMessage(message) {
  state.commands[message.provider] = message.commands;
  updateSlash();
}

function syncHelloQuestions(threads, questionMap) {
  for (const thread of threads) {
    const events = questionMap?.[thread.id] || [];
    questions.sync(thread.id, Array.isArray(events) ? events : [events]);
  }
}

function initialThreadId() {
  let last = null;
  try {
    last = localStorage.getItem("ac_thread");
  } catch {}
  const linked = linkedThread();
  if (linked && state.threads.has(linked)) return linked;
  if (state.current && state.threads.has(state.current)) return state.current;
  if (last && state.threads.has(last)) return last; // first load: reopen the thread the reader last had open
  return state.threads.size ? [...state.threads.values()][0].id : null;
}

function openInitialThread() {
  const threadId = initialThreadId();
  if (threadId) return openThread(threadId);
  clearChat();
  renderHead();
  warmFileViewer();
}

function onHelloMessage(message) {
  // the server was swapped for a new build (restart-when-idle): reload to match, unless that would lose a draft
  if (state.build && message.build && message.build !== state.build) {
    if (!$("input").value && !queueEditor && !outbox.length) return void location.reload();
    state.features = message.features || {};
    flushOutbox();
    banner("Updated. Send or clear your draft, then reload for the new version.");
    return;
  }
  state.build = message.build || state.build;
  state.features = message.features || {};
  flushOutbox();
  latency.flush();
  for (const view of views.values()) view.stale = true;
  state.commands = message.commands || {};
  state.usage = message.usage || {};
  state.queues = message.queues || {};
  syncHelloQuestions(message.threads, message.questions);
  state.dirs = message.dirs;
  state.providers = new Map(message.providers.map((provider) => [provider.id, provider]));
  menus.model.provider = null; // re-read per-agent model lists below
  state.threads = new Map(message.threads.map((thread) => [thread.id, thread]));
  state.tasks = new Map((message.tasks || []).map((task) => [task.id, task]));
  menus.dProv.setItems(
    providerMenuItems(message.providers),
    message.providers.find((provider) => provider.ok)?.id,
  );
  menus.dCwd.setItems(
    message.dirs.map((dir) => ({
      value: dir,
      label: dir.replace(/^.*\/repos\/?/, "~/repos/") || dir,
      icon: "folder",
    })),
    message.dirs[0],
  );
  fillDialog(menus.dProv.value);
  state.ready = true; // until the first hello there is nothing true to say, so the chat stays blank rather than "No thread"
  renderThreads();
  openInitialThread();
  maybeOpenWorkflowDialog();
  void maybeShareLink();
}

function onThreadMessage(message) {
  state.threads.set(message.thread.id, message.thread);
  renderThreads();
  if (message.thread.id === state.current) {
    renderHead();
    markRead(message.thread.id);
  } else renderUsage();
}

function onRemovedMessage(message) {
  state.threads.delete(message.thread);
  views.delete(message.thread);
  for (const item of [...outbox]) if (item.thread === message.thread) acked(item.cid);
  writeDraft(message.thread, "");
  for (const path of attachmentDrafts.get(message.thread) || []) forgetAttachment(path);
  attachmentDrafts.delete(message.thread);
  if (state.current === message.thread) {
    pending = [];
    renderThumbs();
  }
  if (state.current === message.thread) {
    state.current = null;
    $("input").value = "";
    sizeInput();
    clearChat();
    renderHead();
    const first = [...state.threads.values()][0];
    if (first) openThread(first.id);
  }
  renderThreads();
}

function onCreatedMessage(message) {
  handleCreated(message.thread.id);
}

function onTasksMessage(message) {
  state.tasks = new Map(message.tasks.map((task) => [task.id, task]));
  renderThreads();
}

function savedTaskText(task) {
  if (task.repeat === "manual") return `Saved “${task.title}”. Run it from ⋯ → Run now.`;
  if (task.enabled && task.nextRunAt) {
    const when = new Date(task.nextRunAt).toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `Saved “${task.title}”. Next run ${when}.`;
  }
  return `Saved “${task.title}”.`;
}

function onTaskSavedMessage(message) {
  toast(savedTaskText(message.task));
}

function onHistoryMessage(message) {
  if (
    message.thread !== state.current ||
    (message.request != null && message.request !== state.request)
  )
    return;
  if (message.before == null && message.questions)
    questions.sync(message.thread, message.questions);
  void (message.before != null
    ? showEarlier(message)
    : message.delta
      ? showDelta(message)
      : showHistory(message));
}

function onAnswerReply(message) {
  questions.reply(message);
}

function onQueueMessage(message) {
  state.queues[message.thread] = message.items;
  if (message.thread === state.current) renderQueue();
}

function onIssueReply(message) {
  issueDraftReply(message);
}

function onQueueEditReply(message) {
  queuedEditReply(message);
}

function noteLiveQuestion(message) {
  if (message.event.type !== "question" && message.event.type !== "question_answer") return;
  questions.receive(message.thread, message.event, true);
  renderThreads();
  updateWorking();
}

function holdLiveEvent(message) {
  if (!state.revalidating || (state.rendering && !state.deferredRefresh)) return false;
  // Durable events before the history reply are already in its snapshot; deltas are never persisted.
  if (message.event.type === "stream_event") state.waitingLive.push(message.event);
  else if (message.event.type === "assistant" || message.event.type === "result")
    state.waitingLive = [];
  return true;
}

function onLiveEventMessage(message) {
  noteLiveQuestion(message);
  if (views.has(message.thread)) views.get(message.thread).stale = true;
  if (message.event.type === "rate_limit_event")
    setUsage(message.event, threadUsageKey(state.threads.get(message.thread)));
  if (message.thread !== state.current) return;
  if (holdLiveEvent(message)) return;
  if (message.seq) state.end = Math.max(state.end || 0, message.seq);
  if (state.rendering)
    state.pendingLive.push(message.event); // history is still being drawn: keep order, replay these after
  else onEvent(message.event, true);
}

function onInvalidateMessage(message) {
  if (views.has(message.thread)) views.get(message.thread).stale = true;
}

function onAckMessage(message) {
  acked(message.cid);
}

function onErrorMessage(message) {
  if (message.cid) acked(message.cid, false);
  addNote(message.message, "errtxt");
}

const MESSAGE_HANDLERS = {
  __proto__: null,
  usage: onUsageMessage,
  providers: onProvidersMessage,
  commands: onCommandsMessage,
  hello: onHelloMessage,
  thread: onThreadMessage,
  removed: onRemovedMessage,
  created: onCreatedMessage,
  tasks: onTasksMessage,
  task_saved: onTaskSavedMessage,
  history: onHistoryMessage,
  answer_done: onAnswerReply,
  answer_error: onAnswerReply,
  queue: onQueueMessage,
  create_issue_done: onIssueReply,
  create_issue_error: onIssueReply,
  queue_edit: onQueueEditReply,
  queue_edit_done: onQueueEditReply,
  queue_edit_error: onQueueEditReply,
  event: onLiveEventMessage,
  invalidate: onInvalidateMessage,
  ack: onAckMessage,
  error: onErrorMessage,
};

function handle(message) {
  return MESSAGE_HANDLERS[message.t]?.(message);
}

// ---------- menus (model + mode chips in the composer, thread actions, new-thread fields) ----------
// "openrouter/nvidia/nemotron-3-super-120b-a12b:free" -> label "nemotron-3-super-120b-a12b", desc "openrouter · nvidia · free"
function modelMeta(v) {
  if (!v.includes("/")) return { label: v === "default" ? "Default" : cap(v) };
  const [prov, ...rest] = v.split("/");
  const id = rest.pop();
  const free = id.endsWith(":free");
  return {
    label: id.replace(/:free$/, ""),
    desc: [prov, rest.join("/"), free && "free"].filter(Boolean).join(" · "),
  };
}
const ADV = "advisor:";
const ADVISOR_LABEL = { default: "Settings default", off: "Off", opus: "Opus", fable: "Fable" };
// the model list, then (for agents that have an advisor) "Advisor · X" rows: one dropdown covers both choices
const withAdvisors = (items, p, advisor = "default") =>
  !p?.advisors?.length
    ? items
    : [
        ...items,
        ...["default", ...p.advisors].map((a) => ({
          value: ADV + a,
          label: `Advisor · ${ADVISOR_LABEL[a] || cap(a)}`,
          desc:
            a === "default"
              ? "Use the advisor from your Claude settings."
              : a === "off"
                ? "No additional advisor model calls."
                : "A stronger model Claude consults before big decisions (additional usage).",
          icon: "sparkle",
          keep: true,
          checked: a === advisor,
        })),
      ];
const modelItems = (models, p) =>
  models.map((v) => ({
    value: v,
    ...modelMeta(v),
    ...(p?.modelDetails?.[v]
      ? { label: p.modelDetails[v].label, desc: p.modelDetails[v].description ?? modelMeta(v).desc }
      : {}),
  }));
function fillEffort(menu, p, model, value = "default") {
  const meta = p?.modelDetails?.[model];
  menu.setItems(
    [
      {
        value: "default",
        label: "Effort · default",
        desc: `Inherit ${p?.label || "agent"} configuration. ${meta?.defaultEffort ? `Model default: ${meta.defaultEffort}.` : meta?.efforts?.length ? "Choose an effort to override the inherited setting." : "This model does not report effort options."}`,
      },
      ...(meta?.efforts || []).map((value) => ({
        value,
        label: `Effort · ${effortLabel(value)}`,
        ...(EFFORT_DESC[value] ? { desc: EFFORT_DESC[value] } : {}),
      })),
    ],
    value,
  );
}
function dialogEffort(model = menus.dModel.value, id = menus.dProv.value) {
  const p = prov(id);
  $("effort-field").hidden = !p?.modelDetails;
  fillEffort(menus.dEffort, p, model);
}
const prov = (id) => state.providers.get(id);
const provLabel = (id) => prov(id)?.label || id || "";
const claudeAccounts = () =>
  prov("claude")?.accounts || [{ id: "sunny", label: "Sunny", ready: !!prov("claude")?.ok }];
const threadUsageKey = (t) =>
  t?.provider === "claude" && t.claudeAccount === "nefro"
    ? "claude:nefro"
    : t?.provider === "pi" && t.model?.startsWith("deepseek/")
      ? "pi:deepseek"
      : t?.provider || "claude";
const claudeAccount = (id = "sunny") =>
  claudeAccounts().find((a) => a.id === id) || { id, label: cap(id) };
function syncDialogAccount() {
  const visible = menus.dProv.value === "claude" && dialogTask === null;
  $("account-field").hidden = !visible;
  const account = claudeAccount(menus.dAccount.value);
  $("d-account-note").textContent = account.ready
    ? "This account supplies the allowance for this thread."
    : "Sign in to this account before creating a thread.";
  $("d-ok").disabled = visible ? !account.ready : !prov(menus.dProv.value)?.ok;
  $("d-signin").hidden = !visible || !!account.ready;
  if (signingIn !== account.id) $("d-signin-code").hidden = true;
  if (dialogFork) syncForkContext();
}
const accountItems = () =>
  claudeAccounts().map((a) => ({
    value: a.id,
    label: a.label,
    desc: a.email || (a.ready ? "Signed in" : "Sign-in required"),
  }));
// Claude sign-in from the dialog: the server runs `claude auth login`; Anthropic's page shows a code the user pastes back here.
let signingIn = null;
async function claudeLogin(account, body) {
  const r = await apiFetch(`/api/claude-login/${account}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Sign-in failed.");
  return data;
}
$("d-signin-go").onclick = async () => {
  const account = menus.dAccount.value,
    note = $("d-account-note");
  const tab = window.open("", "_blank"); // open now, inside the tap, so the browser does not block it as a popup
  $("d-signin-go").disabled = true;
  note.textContent = "Opening Claude sign-in…";
  try {
    const { url } = await claudeLogin(account, {});
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else window.open(url, "_blank", "noopener");
    signingIn = account;
    $("d-code").value = "";
    $("d-signin-code").hidden = false;
    note.textContent = `Sign in as ${claudeAccount(account).email}, then paste the code Claude shows.`;
    $("d-code").focus();
  } catch (e) {
    tab?.close();
    note.textContent = e.message;
  }
  $("d-signin-go").disabled = false;
};
async function finishSignIn() {
  const account = signingIn,
    note = $("d-account-note");
  if (!account) return;
  $("d-signin-finish").disabled = true;
  note.textContent = "Checking the code…";
  try {
    const { providers } = await claudeLogin(account, { code: $("d-code").value });
    state.providers = new Map(providers.map((p) => [p.id, p]));
    signingIn = null;
    menus.dAccount.setItems(accountItems(), account);
    syncDialogAccount();
  } catch (e) {
    note.textContent = e.message;
  }
  $("d-signin-finish").disabled = false;
}
$("d-signin-finish").onclick = finishSignIn;
// An existing thread whose Claude login expired: open the new-thread dialog on that account so its Sign in button shows.
const CLAUDE_AUTH_FAILED =
  /Failed to authenticate|OAuth session expired|Not logged in|Please run \/login/i;
function signInButton(account) {
  const btn = el("button", "btn sm", `Sign in to ${claudeAccount(account).label}`);
  btn.type = "button";
  btn.onclick = () => {
    const a = claudeAccounts().find((x) => x.id === account);
    if (a) a.ready = false; // hello-time readiness is stale once the CLI has rejected the login
    openNewDialog();
    menus.dProv.setValue("claude");
    fillDialog("claude");
    menus.dAccount.setItems(accountItems(), account);
    syncDialogAccount();
  };
  return btn;
}
$("d-code").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    finishSignIn();
  }
};
// Auto: Sonnet or Sol at medium effort, on whichever five-hour window would otherwise leave the most allowance unused.
const autoUsable = (r) =>
  !!prov(r.provider)?.ok &&
  prov(r.provider).models?.includes(r.model) &&
  (!r.account || !!claudeAccount(r.account).ready);
const autoName = (r) =>
  r.provider === "claude" ? `Claude · ${claudeAccount(r.account).label}` : provLabel(r.provider);
const AUTO_HINT = "Sonnet or Sol medium, on the allowance closest to going unused.";
const resetClock = (at) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function renderAutoPanel() {
  const list = autoCandidates(state.usage, Date.now(), autoUsable),
    best = autoPick(list);
  const head = el("div", "auto-line hdr");
  head.append(el("span", "", "5-hour"), el("span", "", "Left"), el("span", "", "Resets"));
  $("d-auto-panel").replaceChildren(
    head,
    ...list.map((c) => {
      const row = el("div", `auto-line${c === best ? " best" : ""}${c.blocked ? " off" : ""}`);
      row.title = c.blocked ? `Skipped: ${c.blocked}` : c === best ? "Auto picks this one" : "";
      row.append(
        el("span", "", autoName(c.route)),
        el("span", "", c.known ? `${Math.round(c.left)}% left` : "Unknown"),
        el(
          "span",
          "",
          c.resetsAt
            ? `${resetClock(c.resetsAt)} · ${resetsText(c.resetsAt).replace(/^Resets in /, "")}`
            : "No reset",
        ),
      );
      return row;
    }),
  );
}
$("d-auto-info").onclick = () => {
  const open = $("d-auto-panel").hidden;
  if (open) renderAutoPanel();
  $("d-auto-panel").hidden = !open;
  $("d-auto-info").setAttribute("aria-expanded", String(open));
};
$("d-auto").onclick = () => {
  const best = autoPick(autoCandidates(state.usage, Date.now(), autoUsable));
  if (!best)
    return void ($("d-auto-note").textContent = "No signed-in agent has five-hour allowance left.");
  const r = best.route;
  menus.dProv.setValue(r.provider);
  fillDialog(r.provider);
  if (r.account) menus.dAccount.setValue(r.account);
  menus.dModel.setValue(r.model);
  dialogEffort(r.model, r.provider);
  menus.dEffort.setValue(r.effort);
  syncDialogAccount();
  $("d-auto-note").textContent =
    `${autoName(r)} · ${menus.dModel.items().find((i) => i.value === r.model)?.label || r.model} · medium. ${best.known ? `${Math.round(best.left)}% left${best.resetsAt ? `, ${resetsText(best.resetsAt).toLowerCase()}` : ""}` : "Usage unknown"}.`;
  if (!$("d-auto-panel").hidden) renderAutoPanel();
};
function fillDialog(id) {
  const p = prov(id);
  if (!p) return;
  menus.dModel.setItems(modelItems(p.models, p), p.defaultModel);
  dialogEffort(p.defaultModel, id);
  menus.dMode.setItems(modeItems(p.modes), p.defaultMode);
  $("d-warn").hidden = p.defaultMode !== "bypassPermissions";
  $("d-note").hidden = !p.note;
  $("d-note").textContent = p.note || "";
  menus.dAccount.setItems(accountItems(), menus.dAccount.value || "sunny");
  syncDialogAccount();
}
const modeItems = (modes) =>
  modes.map((v) => ({
    value: v,
    label: MODE_META[v]?.label || v,
    desc: MODE_META[v]?.desc,
    icon: MODE_META[v]?.icon,
    tone: MODE_META[v]?.tone,
  }));

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
    b.setAttribute(
      "aria-label",
      `${kind === "mode" ? "Permission mode" : kind === "effort" ? "Reasoning effort" : "Model"}: ${it?.label ?? ""}`,
    );
    b.title = b.getAttribute("aria-label");
  };
}
function fieldTrigger(it, b) {
  b.replaceChildren(el("span", "", it?.label ?? ""), icon("chev-down", "chev"));
}
// ---------- thread actions: one list, used by the ⋯ on every row and by the header ⋯ ----------
const threadActions = (id) => {
  const filed = !!state.threads.get(id)?.archived;
  const thread = state.threads.get(id);
  const items = THREAD_ACTIONS.map((a) => {
    if (a.value === "idle-compaction") {
      const lead = thread?.idleCompactionLeadMs ?? 30_000;
      const supported =
        Number.isFinite(thread?.idleCompactionTtlMs) && thread.idleCompactionTtlMs > lead;
      return {
        ...a,
        disabled: !supported,
        label: !supported
          ? "Automatic compaction unavailable"
          : thread.idleCompaction === false
            ? "Enable automatic compaction"
            : "Disable automatic compaction",
        desc: supported
          ? `Substantial idle contexts; ${lead / 1000}s before estimated cache expiry`
          : "Cache lifetime is unknown for this provider",
      };
    }
    return a.value === "archive" && filed
      ? {
          value: "unarchive",
          label: "Unarchive",
          desc: "Back to the working list",
          icon: "archive",
        }
      : a;
  });
  const action = (value) => items.find((item) => item.value === value);
  return [
    action("search"),
    action("rename"),
    {
      value: "compaction-menu",
      label: "Compaction",
      desc: "Reduce context or manage automatic compaction",
      icon: "sparkle",
      children: [action("compact"), action("idle-compaction")],
    },
    action("economy"),
    action("fork"),
    action("create-issue"),
    action("download"),
    action("share"),
    action("details"),
    {
      value: "archive-menu",
      label: "Archive",
      desc: filed
        ? "Restore or permanently delete this thread"
        : "Archive or permanently delete this thread",
      icon: "archive",
      children: [action(filed ? "unarchive" : "archive"), action("delete")],
    },
  ];
};
const THREAD_ACTIONS = [
  { value: "search", label: "Search in chat", icon: "search" },
  { value: "rename", label: "Rename", icon: "pencil" },
  {
    value: "compact",
    label: "Compact context",
    desc: "Reduce context; keep the transcript",
    icon: "sparkle",
  },
  { value: "idle-compaction", label: "Automatic compaction", icon: "sparkle" },
  {
    value: "economy",
    label: "Economy settings",
    desc: "Use medium effort and turn the advisor off; keep the selected model",
    icon: "sparkle",
  },
  {
    value: "fork",
    label: "Fork…",
    desc: "Continue in a new thread; pick agent, model and context",
    icon: "fork",
  },
  {
    value: "create-issue",
    label: "Create GitHub issue",
    desc: "Pi drafts an issue from the composer text; review, then open GitHub",
    icon: "compose",
  },
  { value: "download", label: "Download", desc: "Save as a Markdown file", icon: "download" },
  { value: "share", label: "Share", desc: "Send the conversation as text", icon: "share" },
  {
    value: "details",
    label: "Run details",
    desc: "Model, effort, tokens and load timings",
    icon: "code",
  },
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
function openThreadForAction(id) {
  setNav(false);
  if (state.current !== id) openThread(id);
}
function searchThreadAction(id) {
  openThreadForAction(id);
  chatSearch.open();
}
function renameThreadAction(id) {
  openThreadForAction(id);
  startRename();
}
function compactThreadAction(id) {
  send({ t: "compact", thread: id });
}
function idleCompactionThreadAction(id, thread) {
  if (!thread.idleCompactionTtlMs) return;
  const enabled = thread.idleCompaction === false;
  send({ t: "update", thread: id, idleCompaction: enabled });
  toast(`Automatic compaction ${enabled ? "enabled" : "disabled"} for this thread.`);
}
function economyThreadAction(id, thread) {
  if (thread.status === "running") {
    toast("Apply economy settings when this turn finishes.");
    return;
  }
  const provider = state.providers.get(thread.provider);
  const efforts = provider?.modelDetails?.[thread.model]?.efforts || [];
  const effort = ["medium", "low"].find((level) => efforts.includes(level)) || "default";
  send({
    t: "update",
    thread: id,
    effort,
    ...(provider?.advisors?.includes("off") ? { advisor: "off" } : {}),
  });
  toast("Economy settings applied; selected model kept.");
}
function detailsThreadAction(id) {
  openThreadForAction(id);
  closeBreakdown(false);
  $("run-details").showModal();
  void loadLatencySummary();
}
function archiveThreadAction(id, thread, action) {
  send({ t: "archive", thread: id, archived: action === "archive" });
}
function deleteThreadAction(id, thread) {
  if (confirm(`Delete "${thread.title}" and its history?`)) send({ t: "delete", thread: id });
}
function forkThreadAction(id) {
  openForkDialog(id);
}
function downloadThreadAction(id) {
  const link = el("a");
  link.href = `/export/${id}`;
  link.download = ""; // the server names the file after the thread
  document.body.append(link);
  link.click();
  link.remove();
}
function createIssueThreadAction(id) {
  createIssueDraft(id);
}
// Resolves true when the native share sheet took the text (or the user closed it).
async function nativeShareText(title, text) {
  if (!navigator.share) return false;
  try {
    await navigator.share({ title, text });
    return true;
  } catch (error) {
    return error?.name === "AbortError"; // the user closed the share sheet
  }
}
async function shareThreadAction(id, thread) {
  const response = await apiFetch(`/export/${id}`).catch(() => null);
  if (!response?.ok) return toast("Could not read that conversation.");
  const text = await response.text();
  if (await nativeShareText(thread.title, text)) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied the conversation as Markdown.");
  } catch {
    toast("Sharing is not available here. Use Download instead.");
  }
}
const THREAD_ACTION_HANDLERS = {
  __proto__: null,
  search: searchThreadAction,
  rename: renameThreadAction,
  compact: compactThreadAction,
  "idle-compaction": idleCompactionThreadAction,
  economy: economyThreadAction,
  details: detailsThreadAction,
  archive: archiveThreadAction,
  unarchive: archiveThreadAction,
  delete: deleteThreadAction,
  fork: forkThreadAction,
  download: downloadThreadAction,
  "create-issue": createIssueThreadAction,
  share: shareThreadAction,
};
async function runThreadAction(id, action) {
  const thread = state.threads.get(id);
  if (!thread) return;
  await THREAD_ACTION_HANDLERS[action]?.(id, thread, action);
}

const menus = {
  effort: createMenu({
    trigger: $("effort"),
    label: "Reasoning effort",
    side: "top",
    renderTrigger: chipTrigger("effort"),
    onSelect: (v) => send({ t: "update", thread: state.current, effort: v }),
  }),
  dEffort: createMenu({
    trigger: $("d-effort"),
    label: "Reasoning effort",
    renderTrigger: fieldTrigger,
  }),
  model: createMenu({
    trigger: $("model"),
    label: "Model",
    side: "top",
    renderTrigger: chipTrigger("model"),
    onSelect: (v) =>
      send(
        v.startsWith(ADV)
          ? { t: "update", thread: state.current, advisor: v.slice(ADV.length) }
          : { t: "update", thread: state.current, model: v },
      ),
  }),
  mode: createMenu({
    trigger: $("mode"),
    label: "Permission mode",
    side: "top",
    renderTrigger: chipTrigger("mode"),
    onSelect: (v) => {
      if (
        v === "bypassPermissions" &&
        !confirm(
          "Bypass mode runs every tool without asking, including shell commands on this machine. Enable for this thread?",
        )
      )
        return false;
      send({ t: "update", thread: state.current, mode: v });
    },
  }),
  more: createMenu({
    trigger: $("more"),
    kind: "menu",
    label: "Thread actions",
    header: () => cur()?.title,
    align: "end",
    items: THREAD_ACTIONS,
    getItems: () => threadActions(state.current),
    onSelect: (v) => state.current && runThreadAction(state.current, v),
  }),
  dProv: createMenu({
    trigger: $("d-prov"),
    label: "Agent",
    renderTrigger: fieldTrigger,
    onSelect: (v) => {
      fillDialog(v);
      queueMicrotask(syncDialogAccount);
    },
  }),
  dAccount: createMenu({
    trigger: $("d-account"),
    label: "Claude account",
    renderTrigger: fieldTrigger,
    value: "sunny",
    onSelect: () => queueMicrotask(syncDialogAccount),
  }),
  dContext: createMenu({
    trigger: $("d-context"),
    label: "Context",
    renderTrigger: fieldTrigger,
    value: "full",
  }),
  dCwd: createMenu({ trigger: $("d-cwd"), label: "Folder", renderTrigger: fieldTrigger }),
  dModel: createMenu({
    trigger: $("d-model"),
    label: "Model",
    renderTrigger: fieldTrigger,
    onSelect: (v) => dialogEffort(v),
  }),
  dMode: createMenu({
    trigger: $("d-mode"),
    label: "Permission mode",
    renderTrigger: fieldTrigger,
    onSelect: (v) => {
      $("d-warn").hidden = v !== "bypassPermissions";
    },
  }),
  dRepeat: createMenu({
    trigger: $("d-repeat"),
    label: "Repeat",
    renderTrigger: fieldTrigger,
    items: REPEAT_ITEMS,
    value: "daily",
    onSelect: () => queueMicrotask(syncWhen),
  }),
  dDay: createMenu({
    trigger: $("d-day"),
    label: "Day",
    renderTrigger: fieldTrigger,
    items: DAY_ITEMS,
    value: "1",
  }),
};
const schedules = createSchedules({
  state,
  send,
  openThread: (id) => openThread(id),
  setNav: (open) => setNav(open),
  provLabel: (id) => provLabel(id),
  editTask: (t) => openTaskDialog(t),
  confirmDelete: (t) =>
    confirm(
      `Delete “${t.title}”${t.runs.some((r) => r.thread) ? " and its run threads" : ""}? Reports already saved to git stay there.`,
    ),
});

// ---------- threads UI ----------
const cur = () => state.threads.get(state.current);
const autoLane = createAutoLane({
  state,
  openThread: (id) => openThread(id),
  setNav: (open) => setNav(open),
  provLabel: (id) => provLabel(id),
  ago: (ts) => ago(ts),
  assignPremium: openPremiumDialog,
  debugIssue: (issue) =>
    openJobDebug({
      ...issue,
      openThread: (id) => {
        setNav(false);
        openThread(id);
      },
    }),
});
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
// Pending share-target picker; set while the drawer is in share mode.
let shareResolve = null;
const isUnreadReply = (t) => !!t && (t.replyAt || 0) > (t.readAt ?? 0);
const isUnread = (t) =>
  isUnreadReply(t) &&
  !t.archived &&
  !(t.id === state.current && document.visibilityState === "visible");
function markRead(id) {
  const t = state.threads.get(id);
  if (id && isUnreadReply(t) && document.visibilityState === "visible") send({ t: "read", id });
}
function visibleThreadList() {
  // a scheduled task's runs are listed under the task in the Scheduled lane, not here
  // automation-started runs (issue work, reviews) are listed in the Auto lane
  return [...state.threads.values()]
    .filter(
      (thread) => !(thread.schedule && state.tasks.has(thread.schedule.task)) && !thread.issueRun,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
}
function usualThreadDir(list) {
  // the folder most threads share says nothing per row; only the odd ones out show theirs
  const dirs = new Map();
  for (const thread of list) dirs.set(base(thread.cwd), (dirs.get(base(thread.cwd)) || 0) + 1);
  return [...dirs].sort((left, right) => right[1] - left[1])[0]?.[0];
}
function threadRowTitle(thread) {
  return `${thread.title}\n${thread.cwd}\n${provLabel(thread.provider)} · ${modelMeta(thread.model).label}${thread.mode === "bypassPermissions" ? " · Bypass" : ""} · ${thread.costMeasured ? `$${thread.cost.toFixed(3)} recorded API-equivalent` : "cost not measured"}`;
}
function threadStatusDot(thread, waiting, unread) {
  // background subagents keep working after the turn ends: show the thread as busy until they finish
  const dot = el(
    "span",
    `dot ${waiting ? "waiting" : thread.background ? "running" : thread.status}${unread ? " unread" : ""}`,
  );
  dot.setAttribute("aria-hidden", "true");
  return dot;
}
function usageLimitTag(stop) {
  const limit = el("span", "tag warn limit-tag");
  const resets = stop.resetsAt ? `Resets ${new Date(stop.resetsAt).toLocaleString()}` : "";
  limit.title = [resets, stop.text].filter(Boolean).join("\n");
  limit.append(icon("alert"), el("span", "", "Usage limit"));
  return limit;
}
function threadRowMeta(thread, usualDir, waiting) {
  const meta = el("div", "meta");
  if (base(thread.cwd) !== usualDir) meta.append(el("span", "dir", base(thread.cwd)));
  meta.append(el("span", "tag", provLabel(thread.provider || "claude")));
  if (thread.mode === "bypassPermissions") {
    const tag = el("span", "tag warn");
    tag.title = "Bypass permissions";
    tag.append(icon("shield-off"), el("span", "sr-only", "Bypass"));
    meta.append(tag);
  }
  if (waiting) meta.append(el("span", "tag question-tag", "Needs input"));
  if (thread.usageStop) meta.append(usageLimitTag(thread.usageStop));
  const time = el("time", "", ago(thread.updatedAt));
  time.dateTime = new Date(thread.updatedAt).toISOString();
  meta.append(time);
  return meta;
}
function threadRowMore(thread, row) {
  const more = el("button", "btn sm icon ghost row-more");
  more.type = "button";
  more.title = "Thread actions";
  more.append(icon("more"));
  more.onclick = (event) => event.stopPropagation(); // the menu opens from its own listener; the row must not also open the thread
  more.addEventListener(
    "keydown",
    (event) => (event.key === "Enter" || event.key === " ") && event.stopPropagation(),
  );
  createMenu({
    trigger: more,
    kind: "menu",
    label: `Actions for ${thread.title}`,
    header: () => state.threads.get(thread.id)?.title || thread.title,
    align: "end",
    items: THREAD_ACTIONS,
    getItems: () => threadActions(thread.id),
    onOpen: () => {
      rowMenuOpen = true;
      row.classList.add("menu-open");
    },
    onClose: () => {
      rowMenuOpen = false;
      row.classList.remove("menu-open");
      if (renderPending) renderThreads();
    },
    onSelect: (value) => runThreadAction(thread.id, value),
  });
  more.setAttribute("aria-label", `Actions for ${thread.title}`);
  return more;
}
function threadRowStatusText(thread, waiting, unread) {
  if (waiting) return "Needs your input";
  if (thread.status === "running") return "Running";
  if (thread.background) return "Subagents working";
  if (unread) return "Unread reply";
  return "";
}
function threadRow(thread, usualDir) {
  const unread = isUnread(thread);
  const row = el(
    "li",
    `${thread.id === state.current ? "sel" : ""}${unread ? " unread" : ""}`.trim(),
  );
  row.tabIndex = 0;
  row.title = threadRowTitle(thread);
  if (thread.id === state.current) row.setAttribute("aria-current", "true");
  const waiting = questions.count(thread.id) || thread.waiting;
  const dot = threadStatusDot(thread, waiting, unread);
  const meta = threadRowMeta(thread, usualDir, waiting);
  const more = threadRowMore(thread, row);
  row.append(dot, el("div", "t", thread.title), meta, more);
  const statusText = threadRowStatusText(thread, waiting, unread);
  if (statusText) row.append(el("span", "sr-only", statusText));
  const pick = () => {
    if (shareResolve) finishShare(thread.id);
    setNav(false);
    openThread(thread.id);
  };
  row.onclick = pick;
  row.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick();
    }
  };
  return row;
}
function renderThreads() {
  if (rowMenuOpen) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const ul = $("threads"),
    shelf = $("archived");
  ul.replaceChildren();
  shelf.replaceChildren();
  const list = visibleThreadList();
  // archived threads sit in their own section below, collapsed unless the user opened it
  const filed = list.filter((thread) => thread.archived).length;
  $("archive").hidden = !filed;
  $("archive-count").textContent = filed || "";
  $("archive-toggle").setAttribute("aria-expanded", String(state.archiveOpen));
  shelf.hidden = !state.archiveOpen;
  const usualDir = usualThreadDir(list);
  for (const thread of list) (thread.archived ? shelf : ul).append(threadRow(thread, usualDir));
  if (list.length === filed)
    ul.append(el("li", "empty-list", list.length ? "Everything is archived." : "No threads yet."));
  const busy = list.some(
    (thread) =>
      questions.count(thread.id) ||
      thread.waiting ||
      thread.background ||
      thread.status === "running",
  );
  const laneDot = $("lane-threads-dot");
  laneDot.hidden = !busy && !list.some(isUnread);
  laneDot.classList.toggle("running", busy);
  laneDot.classList.toggle("unread", !busy);
  schedules.render();
  autoLane.render();
}
setInterval(() => state.threads.size && renderThreads(), 30000);

function securityBadText(changed, failed) {
  if (changed) return `Security: ${changed} unsanctioned change${changed > 1 ? "s" : ""}`;
  return `Security: ${failed} failed patch${failed > 1 ? "es" : ""}`;
}
function securityWarnText(open, behind) {
  if (open) return `Security: ${open} patch PR${open > 1 ? "s" : ""} open`;
  return `Security: ${behind} tool${behind > 1 ? "s" : ""} behind`;
}
function securityVerdict(counts) {
  const { changed, failed, failing, open, behind } = counts;
  if (changed || failed) return { tone: "bad", text: securityBadText(changed, failed) };
  if (failing)
    return {
      tone: "bad",
      text: `Security: ${failing} automation${failing > 1 ? "s" : ""} failing`,
    };
  if (behind) return { tone: "warn", text: securityWarnText(open, behind) };
  return { tone: "ok", text: "Security: all clear" };
}
// Security shield in the sidebar: green = nothing to do, amber = a patch PR is open or a tool is behind, red = unsanctioned change, failed patch or a failing security automation.
async function refreshSecurity() {
  const link = $("sec-status");
  let tone = "",
    text = "Security: status unavailable";
  try {
    const r = await apiFetch("/api/security/tools", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const behind = (d.records || []).filter((x) => x.installed !== x.fixed);
    const open = behind.filter((x) => x.pr).length;
    const failed = behind.filter((x) => x.failed).length;
    const auto = await apiFetch("/api/security/automations", { cache: "no-store" })
      .then((a) => (a.ok ? a.json() : null))
      .catch(() => null);
    const failing = auto?.summary?.bad ?? 0;
    const changed = (d.mismatches || []).length;
    ({ tone, text } = securityVerdict({ changed, failed, failing, open, behind: behind.length }));
  } catch {}
  link.dataset.tone = tone;
  link.setAttribute("aria-label", text);
  link.title = text;
}
void refreshSecurity();
setInterval(refreshSecurity, 5 * 60_000);
document.addEventListener("visibilitychange", () => !document.hidden && void refreshSecurity());

function setNav(open) {
  if (!open) finishShare(null);
  document.body.classList.toggle("nav", open);
  $("menu").setAttribute("aria-expanded", String(open));
}

// Write on every edit: mobile app termination need not fire pagehide or beforeunload.
const drafts = new Map();
function writeDraft(id, text) {
  if (!id) return;
  drafts.set(id, text);
  try {
    if (text) localStorage.setItem(`ac_draft:${id}`, text);
    else localStorage.removeItem(`ac_draft:${id}`);
  } catch {
    if (!storageWarning)
      toast("Browser storage unavailable. Drafts are kept only while this page stays open.");
    storageWarning = true;
  }
}
function saveDraft() {
  writeDraft(state.current, $("input").value);
}
async function finishSendingDraft(cid, draft) {
  // A synchronous receipt prevents an interrupted IndexedDB deletion from restoring a sent file.
  try {
    localStorage.setItem(`ac_sending:${cid}`, JSON.stringify({ ...draft, accepted: true }));
  } catch {}
  const keys = new Set(draft.attachments.map((p) => p.key));
  const list = attachmentDrafts.get(draft.thread) || [];
  for (let i = list.length - 1; i >= 0; i--) if (keys.has(list[i].key)) list.splice(i, 1);
  await Promise.all(draft.attachments.map((p) => attachmentStorage.remove(p.key)));
  if (!storageWarning)
    try {
      localStorage.removeItem(`ac_sending:${cid}`);
    } catch {}
}
function mergeSendingAttachment(item, list, labels, saved) {
  const existing = list.find((entry) => entry.key === item.key);
  if (existing) {
    if (item.n && existing.n !== item.n) labels.set(item.n, existing.n);
    return;
  }
  if (item.n && list.some((entry) => entry.n === item.n)) {
    const next = Math.max(0, ...list.map((entry) => entry.n || 0)) + 1;
    labels.set(item.n, next);
    item.n = next;
  }
  list.push(item);
  saved.push(attachmentStorage.save(item));
}
function mergeRecoveredText(text, recovered) {
  if (recovered && text !== recovered && !text.startsWith(`${recovered}\n\n`))
    return recovered + (text ? `\n\n${text}` : "");
  return text;
}
async function recoverSendingDraft(cid, draft) {
  let text = drafts.get(draft.thread) || "";
  try {
    text = localStorage.getItem(`ac_draft:${draft.thread}`) ?? text;
  } catch {}
  const list = attachmentDrafts.get(draft.thread) || [];
  attachmentDrafts.set(draft.thread, list);
  const saved = [];
  const labels = new Map();
  for (const item of draft.attachments) mergeSendingAttachment(item, list, labels, saved);
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  const recovered = draft.text.replace(/\[Image #(\d+)\]/g, (token, n) =>
    labels.has(Number(n)) ? `[Image #${labels.get(Number(n))}]` : token,
  );
  text = mergeRecoveredText(text, recovered);
  writeDraft(draft.thread, text);
  if (state.current === draft.thread) restoreDraft(draft.thread);
  await Promise.all(saved);
  if (!storageWarning)
    try {
      localStorage.removeItem(`ac_sending:${cid}`);
    } catch {}
}
function restoreDraft(id) {
  let text = drafts.get(id) || "";
  try {
    text = localStorage.getItem(`ac_draft:${id}`) ?? text;
  } catch {}
  try {
    const legacy = sessionStorage.getItem("ac_draft");
    if (legacy && !text) {
      text = legacy;
      writeDraft(id, text);
    }
    sessionStorage.removeItem("ac_draft");
  } catch {}
  $("input").value = text;
  pending = attachmentDrafts.get(id) || [];
  attachmentDrafts.set(id, pending);
  imageCount = Math.max(0, ...pending.map((p) => p.n || 0));
  for (const p of pending) {
    if (p.id) {
      p.url = `/uploads/${p.thread}/${p.id}/${encodeURIComponent(p.name)}`;
      p.ready = Promise.resolve();
    } else if (!p.ready) startUpload(p);
  }
  renderThumbs();
  sizeInput();
  closeSlash();
}
addEventListener("pagehide", saveDraft);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveDraft();
  else {
    renderThreads();
    markRead(state.current);
  }
});

function recordCancelledMeasurement() {
  if (state.measurement)
    latency.record({
      kind: "cancelled",
      thread: state.measurement.thread,
      total_ms: performance.now() - state.measurement.at,
      hidden: state.measurement.hidden,
    });
  state.measurement = null;
}
function captureViewSnapshot() {
  return {
    nodes: [...$("chat").childNodes],
    cards: state.cards,
    doneTasks: state.doneTasks,
    subs: state.subs,
    subTools: state.subTools,
    live: state.live,
    compact: state.compact,
    start: state.start,
    latestStart: state.latestStart,
    end: state.end,
    scroll: $("chat").scrollTop,
    anchor: viewAnchor(),
    stats: $("diagnostics").textContent,
  };
}
function resetThreadCollections() {
  state.cards = new Map();
  state.lastTs = null;
  state.subs = new Map();
  state.subTools = new Map();
  state.doneTasks = null;
  state.live = null;
}
function stashOldView(old, id) {
  if (state.live?.raf) {
    cancelAnimationFrame(state.live.raf);
    state.live.raf = 0;
  }
  const snapshot = (!state.deferredRefresh && state.snapshot) || captureViewSnapshot();
  snapshot.stale ||= !!state.revalidating || !!state.loadingEarlier || old.id === id;
  views.delete(old.id);
  views.set(old.id, snapshot);
  if (views.size > 5) views.delete(views.keys().next().value);
  resetThreadCollections();
}
function showCachedView(id, cached) {
  if (state.features.selectiveEvents) send({ t: "subscribe", thread: id });
  clearTimeout(state.loadTimer);
  state.loading = null;
  state.cards = cached.cards;
  state.doneTasks = cached.doneTasks;
  state.subs = cached.subs;
  state.subTools = cached.subTools;
  state.start = cached.start;
  state.latestStart = cached.latestStart;
  state.end = cached.end;
  state.live = cached.live;
  state.compact = cached.compact;
  $("chat").replaceChildren(...cached.nodes);
  questions.ensure(id);
  earlierIdle();
  restoreView(cached);
  const total_ms = Math.round(performance.now() - state.openAt);
  window.agentConsoleMetrics = { thread: id, cached: true, total_ms };
  latency.record({ kind: "cached", thread: id, total_ms, render_ms: total_ms, wait_ms: 0 });
  showLoad(`Opened from cache in ${fmtMs(total_ms)}`);
  views.delete(id);
  if (cached.stale || cur()?.status === "running") revalidateCachedView(cached);
}
function revalidateCachedView(cached) {
  state.snapshot = cached;
  state.revalidating = true;
  state.deferredRefresh = cached.start < cached.latestStart && !state.stick;
  const status = el(
    "div",
    "loading",
    state.deferredRefresh
      ? "Showing saved history. Return to latest to update."
      : "Updating conversation…",
  );
  status.id = "conversation-updating";
  status.setAttribute("role", "status");
  $("chat").before(status);
  if (!state.deferredRefresh) refreshConversation();
}
function openThread(id) {
  const switching = state.current !== id;
  if (switching) chatSearch.close(false);
  if (switching) saveDraft();
  recordCancelledMeasurement();
  releaseHistoryAnchor();
  const old = cur();
  if (old && ((!state.rendering && !state.loading) || state.snapshot)) stashOldView(old, id);
  state.revalidating = false;
  state.loadingEarlier = false;
  state.earlierChain = 0;
  state.deferredRefresh = false;
  state.waitingLive = [];
  state.snapshot = null;
  $("conversation-updating")?.remove();
  state.openAt = performance.now();
  state.request = (state.request || 0) + 1;
  state.current = id;
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}#thread=${encodeURIComponent(id)}`,
  );
  if (switching) restoreDraft(id);
  state.usageTab = threadUsageKey(state.threads.get(id));
  try {
    localStorage.setItem("ac_thread", id);
  } catch {}
  state.stick = true;
  state.renderToken++; // any history still being drawn belongs to the thread we are leaving
  state.rendering = false;
  state.pendingLive = [];
  state.into = null;
  renderThreads();
  markRead(id);
  renderHead();
  clearChat();
  warmSoon();
  const cached = views.get(id);
  if (cached) {
    showCachedView(id, cached);
    return;
  }
  showLoading(id);
  state.measurement = { thread: id, at: state.openAt, hidden: document.hidden };
  state.requestSentAt = performance.now();
  send({
    t: "open",
    thread: id,
    request: state.request,
    foregroundOnly: !!state.features.selectiveEvents,
    small: SMALL_PAGES,
  });
}

// Saved scroll offsets go stale when virtual rows resolve their real height; remember the first visible message (or "at bottom") instead.
function viewAnchor() {
  const chat = $("chat");
  if (nearBottom()) return { bottom: true };
  const top = chat.getBoundingClientRect().top;
  for (const node of chat.children) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > top + 1) return { node, offset: rect.top - top };
  }
  return null;
}
function restoreView(view) {
  const chat = $("chat"),
    anchor = view.anchor;
  if (anchor?.bottom) {
    scrollDown(true);
    state.stick = true;
  } else if (anchor?.node?.isConnected) {
    const top = chat.getBoundingClientRect().top;
    chat.scrollTop += anchor.node.getBoundingClientRect().top - top - anchor.offset;
    holdHistoryAnchor(anchor.node, top + anchor.offset);
    state.stick = nearBottom();
  } else {
    chat.scrollTop = view.scroll;
    state.stick = nearBottom();
  }
  state.lastScrollTop = chat.scrollTop;
}
function refreshConversation() {
  if (state.rendering || state.loadingEarlier) return;
  state.deferredRefresh = false;
  $("conversation-updating").textContent = "Updating conversation…";
  state.refreshAt = performance.now();
  state.measurement = { thread: state.current, at: state.refreshAt, hidden: document.hidden };
  state.requestSentAt = performance.now();
  send({
    t: "open",
    thread: state.current,
    request: state.request,
    foregroundOnly: !!state.features.selectiveEvents,
    since: state.end,
    small: SMALL_PAGES,
  });
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
    for (const [who, widths] of [
      ["u", [42]],
      ["a", [94, 82, 58]],
      ["u", [30]],
      ["a", [90, 66]],
    ]) {
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
function resetRefreshState() {
  if (state.live?.raf) cancelAnimationFrame(state.live.raf);
  state.live = null;
  state.compact = null;
  state.cards = new Map();
  state.lastTs = null;
  state.subs = new Map();
  state.subTools = new Map();
  state.doneTasks = null;
}
function prepareHistoryHost(refreshing) {
  const more = state.start > 0 ? earlierButton() : null;
  if (more && !refreshing) $("chat").append(more); // tappable while the newest page draws: requestEarlier waits, so two renders never fight over the scroll position
  const host = document.createDocumentFragment();
  if (refreshing && more) host.append(more);
  return host;
}
function alignHistoryView(refreshing, followed, savedScroll) {
  if (refreshing && !followed) $("chat").scrollTop = savedScroll;
  else scrollDown(true);
}
function drainPendingLive() {
  for (const pending of state.pendingLive.splice(0)) onEvent(pending, true);
}
function appendReadyHint() {
  const hint = emptyState();
  hint.querySelector("h2").textContent = "Ready";
  hint.querySelector("p").textContent = "Send a message to start this thread.";
  hint.querySelector("button").remove();
  $("chat").append(hint);
}
async function showHistory(m) {
  clearTimeout(state.loadTimer);
  state.loading = null;
  const token = ++state.renderToken;
  state.historyAt = performance.now();
  const refreshing = state.revalidating;
  const cachedMetrics = refreshing ? window.agentConsoleMetrics : null;
  if (refreshing) resetRefreshState();
  else clearChat();
  state.rendering = true;
  $("chat").setAttribute("aria-busy", "true");
  state.pendingLive = refreshing ? state.waitingLive.splice(0) : [];
  state.start = m.start || 0;
  state.latestStart = state.start;
  state.end = m.end;
  const host = prepareHistoryHost(refreshing);
  state.into = host;
  if (!(await renderEvents(m.events, token, true))) return;
  state.into = null;
  const refreshScroll = $("chat").scrollTop;
  const refreshFollow = state.stick && nearBottom();
  const alignHistory = () => alignHistoryView(refreshing, refreshFollow, refreshScroll);
  if (refreshing) $("chat").replaceChildren(host);
  else $("chat").append(host);
  if (!m.events.length) appendReadyHint();
  drainPendingLive();
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
  drainPendingLive();
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
  const metrics = {
    thread: m.thread,
    total_ms: Math.round(performance.now() - (refreshing ? state.refreshAt : state.openAt)),
    server_ms: m.server_ms,
    render_ms: Math.round(performance.now() - state.historyAt),
    events: m.events.length,
    bytes: m.bytes,
    prepare_ms: Math.max(
      0,
      m.receivedAt - m.roundtrip_ms - (refreshing ? state.refreshAt : state.openAt),
    ),
    roundtrip_ms: m.roundtrip_ms,
    decode_ms: m.decode_ms,
    payload_bytes: m.wire_bytes,
  };
  latency.record({
    ...metrics,
    kind: refreshing ? "refresh" : "open",
    wait_ms: m.receivedAt - (refreshing ? state.refreshAt : state.openAt),
    wire_bytes: m.wire_bytes,
    prepare_ms: Math.max(0, m.receivedAt - m.roundtrip_ms - (state.measurement?.at || 0)),
    roundtrip_ms: m.roundtrip_ms,
    decode_ms: m.decode_ms,
    hidden: state.measurement?.hidden,
  });
  state.measurement = null;
  state.revalidating = false;
  state.snapshot = null;
  $("conversation-updating")?.remove();
  window.agentConsoleMetrics = refreshing ? { ...cachedMetrics, refresh: metrics } : metrics;
  const other = Math.max(0, metrics.total_ms - metrics.roundtrip_ms - metrics.render_ms);
  const detail = `Network ${fmtMs(metrics.roundtrip_ms)} · drawing ${fmtMs(metrics.render_ms)} · other ${fmtMs(other)} ${metrics.events ? ` · ${metrics.events} events, ${Math.round(metrics.payload_bytes / 1024)} KB` : ""}`;
  if (refreshing)
    showLoad(
      `Opened from cache in ${fmtMs(cachedMetrics.total_ms)}, then updated in ${fmtMs(metrics.total_ms)}`,
      detail,
    );
  else showLoad(`Loaded in ${fmtMs(metrics.total_ms)}`, detail);
  console.debug("Agent Console history", metrics);
  warmFileViewer();
  chatSearch.refresh();
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
  if ((state.revalidating && !state.deferredRefresh) || state.rendering || state.loadingEarlier)
    return void setTimeout(requestEarlier, 100, thread);
  state.pageAt = performance.now();
  state.measurement = { thread, at: state.pageAt, hidden: document.hidden };
  state.requestSentAt = performance.now();
  // The socket may be down (phone woke up, reconnecting): a dropped request would leave the button dead, so retry until it is sent.
  if (!send({ t: "open", thread, before: state.start, request: state.request, small: SMALL_PAGES }))
    return void setTimeout(requestEarlier, 300, thread);
  state.earlierWanted = null;
  state.loadingEarlier = true;
}
async function waitReaderStill(token) {
  while (readerScrolling()) await new Promise((resolve) => setTimeout(resolve, 120));
  return token === state.renderToken;
}
function settleEarlierButton(btn, start, fetchMore) {
  if (!(start > 0 && btn)) return void btn?.remove();
  if (fetchMore) return;
  btn.disabled = false;
  btn.textContent = "Show earlier messages";
}
// Three frames of re-anchoring while content settles; false when the thread changed under it.
async function settleEarlierAnchor(chat, { anchor, anchorTop, fromBottom }, token) {
  chat.scrollTop = chat.scrollHeight - fromBottom;
  if (anchor && anchorTop != null) holdHistoryAnchor(anchor, anchorTop);
  for (let pass = 0; pass < 3; pass++) {
    await frame();
    if (token !== state.renderToken) return false;
    if (readerScrolling()) break; // the finger owns the scroll position now
    if (anchor?.isConnected && anchorTop != null)
      chat.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }
  return true;
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
  // The reply can land mid-drag: inserting then fights the finger, so hold the page until the reader is still (live events queue in pendingLive).
  if (!(await waitReaderStill(token))) return;
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
  const fetchMore =
    m.start > 0 &&
    btn &&
    chat.scrollHeight - heightBefore < chat.clientHeight &&
    (state.earlierChain = (state.earlierChain || 0) + 1) < 20;
  if (!fetchMore) state.earlierChain = 0;
  settleEarlierButton(btn, m.start, fetchMore);
  if (!(await settleEarlierAnchor(chat, { anchor, anchorTop, fromBottom }, token))) return;
  state.live = live;
  state.loadingEarlier = false;
  state.rendering = false;
  chat.setAttribute("aria-busy", "false");
  state.lastScrollTop = chat.scrollTop;
  for (const e of state.pendingLive.splice(0)) onEvent(e, true);
  latency.record({
    kind: "page",
    thread: m.thread,
    total_ms: performance.now() - pageAt,
    wait_ms: m.receivedAt - pageAt,
    server_ms: m.server_ms,
    render_ms: performance.now() - m.receivedAt,
    events: m.events.length,
    bytes: m.bytes,
    wire_bytes: m.wire_bytes,
    prepare_ms: Math.max(0, m.receivedAt - m.roundtrip_ms - (state.measurement?.at || 0)),
    roundtrip_ms: m.roundtrip_ms,
    decode_ms: m.decode_ms,
    hidden: state.measurement?.hidden,
  });
  state.measurement = null;
  chatSearch.refresh();
  if (fetchMore) return requestEarlier(m.thread);
  if (state.deferredRefresh && nearBottom()) refreshConversation();
}

function renderHeadTitle(thread) {
  if (!$("ttl-edit")) $("ttl").textContent = thread ? thread.title : state.ready ? "No thread" : "";
  $("cwd").hidden = !thread;
  $("ttl-archived").hidden = !thread?.archived;
  $("thread-account").hidden = thread?.provider !== "claude";
  $("thread-account").textContent =
    thread?.provider === "claude" ? `${claudeAccount(thread.claudeAccount).label} ·` : "";
  $("thread-account").title =
    thread?.provider === "claude"
      ? `Claude account: ${claudeAccount(thread.claudeAccount).email || claudeAccount(thread.claudeAccount).label}`
      : "";
  $("cwd-t").textContent = thread ? thread.cwd.replace(/^\/home\/[^/]+/, "~") : "";
  $("cwd").title = thread ? thread.cwd : "";
}
function syncHeadModelMenu(thread, provider) {
  if (provider && menus.model.provider !== thread.provider) {
    menus.model.provider = thread.provider; // models and modes differ per agent
    menus.model.advisorShown = undefined;
    menus.model.setItems(
      withAdvisors(modelItems(provider.models, provider), provider, thread.advisor || "default"),
    );
    menus.mode.setItems(modeItems(provider.modes));
  }
  if (provider && menus.model.advisorShown !== (thread.advisor || "default")) {
    // the check mark on the advisor rows follows the thread
    menus.model.advisorShown = thread.advisor || "default";
    menus.model.setItems(
      withAdvisors(modelItems(provider.models, provider), provider, menus.model.advisorShown),
      thread.model,
    );
  }
}
function lastRunFacts(run, thread) {
  if (!run) return [["Last run", "None yet"]];
  const hasTokens = [run.input_tokens, run.cached_input_tokens, run.output_tokens].some(
    (count) => count != null,
  );
  return [
    ["Model", run.timing?.model || run.model || thread.model],
    [
      "Effort",
      effortLabel(run.effort || thread.effort || "default"),
      run.source && run.source !== "thread settings" ? `from ${run.source}` : "",
    ],
    ["Last run", run.duration_ms == null ? "Still running" : fmtMs(run.duration_ms)],
    ...(hasTokens
      ? [
          [
            "Tokens",
            `${run.input_tokens ?? 0} in · ${run.cached_input_tokens ?? 0} from cache · ${run.output_tokens ?? 0} out`,
            "whole turn, not the context size",
          ],
        ]
      : []),
  ];
}
function idleCompactionState(thread) {
  if (!thread.idleCompactionTtlMs) return "Unavailable: cache lifetime unknown";
  return thread.idleCompaction === false ? "Off" : "On for substantial idle contexts";
}
function idleCompactionNote(thread) {
  return thread.idleCompactionDueAt
    ? `Scheduled around ${new Date(thread.idleCompactionDueAt).toLocaleTimeString()}; cache expiry is estimated.`
    : "Compaction uses tokens and may shorten details. Full transcript is kept.";
}
function diagnosticsTitle(run, thread) {
  return run
    ? `Last run: ${run.model || thread.model} · effort ${run.effort || thread.effort || "default"} (${run.source || "thread settings"})\n${run.duration_ms ?? "?"} ms · input ${run.input_tokens ?? "?"} · cached ${run.cached_input_tokens ?? "?"} · output ${run.output_tokens ?? "?"} tokens`
    : "No run metrics yet.";
}
function renderHeadThread(thread) {
  const provider = prov(thread.provider);
  syncHeadModelMenu(thread, provider);
  menus.model.setValue(thread.model);
  $("effort").hidden = !provider?.modelDetails;
  fillEffort(menus.effort, provider, thread.model, thread.effort || "default");
  menus.effort.setDisabled(thread.status === "running");
  const run = thread.lastRun;
  facts([
    ...lastRunFacts(run, thread),
    ["Automatic compaction", idleCompactionState(thread), idleCompactionNote(thread)],
  ]);
  renderThreadId(thread.id);
  renderTurnTiming(run?.timing, firstTokenMs.get(thread.id));
  $("diagnostics").title = diagnosticsTitle(run, thread);
  menus.mode.setValue(thread.mode);
}
function composerPlaceholder(thread) {
  if (!thread) return "Message the agent";
  if (questions.count(thread.id) || thread.waiting)
    return "Reply to the agent, or choose an option above…";
  if (thread.status !== "running") return "Message the agent";
  return thread.operation
    ? "Queue a message to send after compaction…"
    : "Queue a message for after this turn…";
}
function renderHead() {
  const thread = cur();
  renderHeadTitle(thread);
  if (thread) renderHeadThread(thread);
  const running = thread?.status === "running";
  menus.model.setDisabled(!thread || running);
  menus.mode.setDisabled(!thread || running);
  $("more").disabled = !thread;
  $("chat-search-toggle").disabled = !thread;
  $("state").hidden = !running && !thread?.background && !questions.count(state.current);
  $("input").disabled = !thread;
  $("attach").disabled = !thread;
  // While the agent works the composer stays live: Enter steers it (or queues, for agents that cannot take input mid-turn)
  renderAction();
  $("cbox").classList.toggle("running", running);
  $("input").placeholder = composerPlaceholder(thread);
  renderQueue();
  renderCtx();
  renderUsage();
  updateWorking();
  $("head").dataset.status = thread?.status || "";
  $("head").dataset.mode = thread?.mode || "";
}

// One button does it all: Stop (red) while a turn runs and the composer is empty, otherwise Send (which queues mid-turn).
function renderAction() {
  const t = cur();
  const running = t?.status === "running";
  const waiting = questions.count(t?.id) || t?.waiting;
  const empty = !$("input").value.trim() && !pending.length;
  const busy = running || !!t?.background; // background subagents outlive the turn; Stop still ends them
  const stop = busy && empty;
  $("stop").hidden = !stop;
  $("send").hidden = stop;
  $("improve").disabled = !t || !$("input").value.trim();
  $("send").disabled = !t || (empty && !busy);
  $("send").title = waiting
    ? "Reply to the agent (Enter)"
    : running
      ? "Queue: sent when this turn ends (Enter)"
      : "Send (Enter)";
  $("send").setAttribute(
    "aria-label",
    waiting ? "Reply to agent" : running ? "Queue message" : "Send",
  );
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
      const steer = iconButton("steer", "Steer", "btn steer");
      steer.title = "Steer: give this to the agent now, instead of after the turn";
      steer.hidden =
        q.editing ||
        cur()?.status !== "running" ||
        !!cur()?.operation ||
        !prov(cur()?.provider)?.steer;
      steer.onclick = () => send({ t: "steer_queued", thread: state.current, id: q.id });
      const tag = el("span", "tag");
      tag.title = q.editing ? "Editing: delivery paused" : "Queued: sent after this turn";
      tag.append(
        icon(q.editing ? "pencil" : "queued"),
        el("span", "sr-only", q.editing ? "Editing" : "Queued"),
      );
      const actions = el("span", "q-actions");
      actions.append(steer, edit, rm);
      li.append(tag, el("span", "txt", q.text), actions);
      return li;
    }),
  );
}
document.addEventListener("visibilitychange", () => {
  if (state.measurement && document.hidden) state.measurement.hidden = true;
});
// Quick issue creator: pi drafts title and body from the composer text; the owner reviews them before GitHub opens.
const MAX_ISSUE_DRAFT = 2000; // keep in sync with server/issue-draft.ts
let issueDraft = null,
  issueRequest = 0;
function createIssueDraft(thread) {
  const draft = $("input").value.trim();
  if (!draft) return toast("Type the issue in the composer first.");
  if (draft.length > MAX_ISSUE_DRAFT)
    return toast(`Issue text is over ${MAX_ISSUE_DRAFT} characters. Shorten it.`);
  if (ws?.readyState !== 1) return toast("Reconnect before creating an issue.");
  issueDraft = { cid: `issue-${++issueRequest}` };
  $("issue-note").textContent = "Pi is drafting the title and body…";
  $("issue-error").textContent = "";
  $("issue-title").value = "";
  $("issue-body").value = "";
  $("issue-title").disabled = $("issue-body").disabled = $("issue-open").disabled = true;
  $("issue-review").showModal();
  send({ t: "create_issue", thread, draft, cid: issueDraft.cid });
}
function issueDraftReply(m) {
  if (!issueDraft || m.cid !== issueDraft.cid) return;
  if (m.t === "create_issue_error") {
    $("issue-note").textContent = "";
    $("issue-error").textContent = m.message;
    return;
  }
  Object.assign(issueDraft, { owner: m.owner, repo: m.repo });
  $("issue-note").textContent = `Review the draft for ${m.owner}/${m.repo}, then open GitHub.`;
  $("issue-title").value = m.title;
  $("issue-body").value = m.body;
  $("issue-title").disabled = $("issue-body").disabled = $("issue-open").disabled = false;
  $("issue-title").focus();
}
$("issue-form").onsubmit = (e) => {
  e.preventDefault();
  if (!issueDraft?.repo) return;
  const url = new URL(
    `https://github.com/${encodeURIComponent(issueDraft.owner)}/${encodeURIComponent(issueDraft.repo)}/issues/new`,
  );
  url.searchParams.set("title", $("issue-title").value.trim());
  url.searchParams.set("body", $("issue-body").value);
  window.open(url, "_blank", "noopener");
  issueDraft = null;
  $("issue-review").close();
};
$("issue-cancel").onclick = () => {
  issueDraft = null;
  $("issue-review").close();
};
$("issue-review").addEventListener("cancel", () => {
  issueDraft = null;
});

let queueEditor,
  queueRequest = 0;
function editQueuedMessage(id) {
  if (ws?.readyState !== 1) return toast("Reconnect before editing a queued message.");
  queueEditor = { id, thread: state.current, request: ++queueRequest };
  $("queue-draft").value = "";
  $("queue-edit-note").textContent = "Pausing delivery and loading the full message…";
  $("queue-edit-error").textContent = "";
  $("queue-draft").disabled = true;
  $("queue-save").disabled = true;
  $("queue-cancel").disabled = false;
  $("queue-editor").showModal();
  send({ t: "queue_edit", ...queueEditor });
}
function queuedEditReply(m) {
  if (!queueEditor || m.request !== queueEditor.request) return;
  queueEditor.pending = false;
  if (m.t === "queue_edit_done") {
    $("queue-editor").close();
    queueEditor = null;
    return;
  }
  if (m.t === "queue_edit") {
    queueEditor.revision = m.revision;
    $("queue-draft").value = m.text;
    $("queue-edit-note").textContent =
      `Delivery is paused until Save or Cancel.${m.attachments ? ` ${m.attachments} attachment(s) will be kept.` : ""}`;
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
    $("queue-editor").close();
    queueEditor = null;
    return;
  }
  if (ws?.readyState !== 1) {
    $("queue-edit-error").textContent = "Disconnected. Reconnect to save this draft.";
    return;
  }
  queueEditor.request = ++queueRequest;
  queueEditor.pending = true;
  $("queue-save").disabled = true;
  $("queue-cancel").disabled = true;
  $("queue-draft").disabled = true;
  send({
    t: cancel ? "queue_cancel_edit" : "queue_save",
    ...queueEditor,
    text: $("queue-draft").value,
  });
}
$("queue-edit-form").onsubmit = (e) => {
  e.preventDefault();
  finishQueuedEdit(false);
};
$("queue-cancel").onclick = () => finishQueuedEdit(true);
$("queue-editor").addEventListener("cancel", (e) => {
  e.preventDefault();
  finishQueuedEdit(true);
});
// Run details, in words: one fact per row, times as "167 ms" or "1.2 s".
const fmtMs = (ms) =>
  ms == null
    ? "—"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
function facts(rows) {
  const dl = $("run-metrics");
  dl.replaceChildren(
    ...rows.flatMap(([k, v, note]) => {
      const dd = el("dd", "", v);
      if (note) dd.append(el("span", "note", note));
      return [el("dt", "", k), dd];
    }),
  );
}
// The thread's id, so the user can name it to an agent ("thread c3c67b96") instead of pasting content. Copy takes the full id.
function renderThreadId(id) {
  const box = $("run-thread");
  if (box.dataset.id === id) return;
  box.dataset.id = id;
  const label = el("span", "tid-label", "Thread");
  const code = el("code", "tid");
  code.append(el("b", "", id.slice(0, 8)), el("span", "tid-rest", id.slice(8)));
  code.title = id;
  const copy = el("button", "btn sm tid-copy");
  copy.type = "button";
  copy.append(icon("copy"), el("span", "lab", "Copy id"));
  copy.setAttribute("aria-label", `Copy thread id ${id.slice(0, 8)}`);
  wireCopy(copy, () => id, "Copy id");
  box.replaceChildren(label, code, copy);
}
// Where the last turn's time went, measured by the server from the agent's own events: one headline number (first token),
// one stacked bar (model / tools / other) with its values in words, then the slowest tools. Nothing is said by color alone.
function timingHead(x) {
  const head = el("div", "tt-head");
  const big = el("span", "tt-big", x.first_ms == null ? "No output" : fmtMs(x.first_ms));
  head.append(
    big,
    el("span", "tt-cap", x.first_ms == null ? "" : "to first token"),
    el("span", `tt-tag${x.cold ? " cold" : ""}`, x.cold ? "Cold start" : "Warm"),
  );
  return head;
}
function timingBarAndLegend(parts, total) {
  const stackBar = el("div", "tt-bar");
  stackBar.setAttribute("role", "img");
  stackBar.setAttribute(
    "aria-label",
    `Of ${fmtMs(total)}: ${parts.map(([, name, ms]) => `${name.toLowerCase()} ${fmtMs(ms)}`).join(", ")}`,
  );
  const legend = el("ul", "tt-legend");
  for (const [key, name, ms] of parts) {
    if (total && ms > 0) {
      const seg = el("i", key);
      seg.style.flexGrow = String(ms);
      stackBar.append(seg);
    }
    const item = el("li");
    item.append(
      el("i", `sw ${key}`),
      el("span", "", name),
      el("b", "", fmtMs(ms)),
      el("span", "pct", total ? `${Math.round((ms / total) * 100)}%` : ""),
    );
    legend.append(item);
  }
  legend.setAttribute("aria-hidden", "true"); // the bar's label already reads the same numbers
  return { stackBar, legend };
}
function timingSlowTools(slow) {
  const list = el("ol", "tt-tools");
  list.setAttribute("aria-label", "Slowest tools");
  for (const tool of slow) {
    const item = el("li");
    item.append(
      el("span", "n", tool.name),
      el("span", "ms", `${fmtMs(tool.ms)}${tool.error ? " · failed" : ""}`),
    );
    list.append(item);
  }
  return [el("h4", "", "Slowest tools"), list];
}
function timingRetryNote(retries) {
  return el(
    "p",
    "tt-retry",
    `${retries} API retr${retries === 1 ? "y" : "ies"} or rate-limit warning${retries === 1 ? "" : "s"} slowed this turn`,
  );
}
function timingFullButton() {
  const full = el("button", "btn block tb-open");
  full.type = "button";
  full.append(el("span", "", "Full breakdown"), icon("chev-right"));
  full.onclick = () => state.current && openBreakdown(state.current, full);
  return full;
}
function renderTurnTiming(x, phoneMs) {
  const section = $("turn-timing");
  section.hidden = !x;
  if (!x) return;
  const head = timingHead(x);
  const start = x.cold
    ? `New agent process${x.spawn_ms != null ? `, ready in ${fmtMs(x.spawn_ms)}` : ""}`
    : "Agent process was already running";
  const parts = [
    ["model", "Model", x.model_ms],
    ["tools", "Tools", x.tool_ms],
    ["other", "Other", x.other_ms],
  ];
  const total = parts.reduce((sum, part) => sum + part[2], 0);
  const { stackBar, legend } = timingBarAndLegend(parts, total);
  const kids = [
    head,
    el("p", "note", `${start}${phoneMs != null ? ` · ${fmtMs(phoneMs)} until shown here` : ""}`),
    stackBar,
    legend,
    el(
      "p",
      "note",
      `${x.steps} model step${x.steps === 1 ? "" : "s"} · ${x.tool_calls} tool call${x.tool_calls === 1 ? "" : "s"} · Other is startup and waiting for you`,
    ),
  ];
  if (x.slow?.length) kids.push(...timingSlowTools(x.slow));
  if (x.retries) kids.push(timingRetryNote(x.retries));
  kids.push(timingFullButton());
  $("turn-timing-body").replaceChildren(...kids);
}
// Escape in the breakdown goes back to the summary; closing the sheet always resets it.
$("run-details").addEventListener("cancel", (e) => {
  if ($("run-details").dataset.view === "breakdown") {
    e.preventDefault();
    closeBreakdown();
  }
});
$("run-details").addEventListener("close", () => closeBreakdown(false));
function showLoad(main, detail) {
  $("diagnostics").replaceChildren(
    el("p", "lead", main),
    ...(detail ? [el("p", "note", detail)] : []),
  );
}
const SPEED = [
  ["open", "Open a thread"],
  ["cached", "Switch back"],
  ["refresh", "Check for new"],
  ["page", "Older messages"],
];
const speedWord = (ms) => (ms < 300 ? "fast" : ms < 1000 ? "ok" : "slow");
// Nearest-rank percentile of times sorted fastest first: p% of loads took this long or less.
const pct = (sorted, p) =>
  sorted?.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
const pctWord = (p) =>
  p === 100
    ? "the slowest load"
    : p === 50
      ? "half of loads are faster"
      : `${p} in 100 loads are faster`;
let speedData = null;
// Which percentiles the table shows and over which time window: the reader's choice, kept between visits.
const speedView = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("ac_speed_view"));
    if (v?.typical && v?.slowest) return { recent: true, ...v };
  } catch {}
  return { typical: 50, slowest: 95, recent: true };
})();
const saveSpeedView = () => {
  try {
    localStorage.setItem("ac_speed_view", JSON.stringify(speedView));
  } catch {}
};
function speedSlider(name, label, min, max) {
  const wrap = el("label", "slider"),
    out = el("output"),
    input = el("input");
  Object.assign(input, { type: "range", min, max, step: 1, value: speedView[name] });
  input.dataset.pct = name;
  input.sync = () => {
    input.value = speedView[name];
    out.textContent = `p${speedView[name]} · ${pctWord(speedView[name])}`;
  };
  input.oninput = () => {
    speedView[name] = Number(input.value);
    // Typical can never be slower than Slowest: dragging one past the other pushes it along.
    if (speedView.slowest < speedView.typical)
      speedView[name === "typical" ? "slowest" : "typical"] = speedView[name];
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
  pick.setAttribute("role", "group");
  pick.setAttribute("aria-label", "Time window");
  for (const [recent, text] of [
    [true, "Last 20 loads"],
    [false, `Last ${days} days`],
  ]) {
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
  const table = el("table", "speed"),
    head = el("tr");
  table.caption = el(
    "caption",
    "sr-only",
    recent
      ? "Last 20 loads of each kind"
      : `Every load in the last ${speedData.retention_days} days`,
  );
  for (const text of ["", `Typical p${typical}`, `Slowest p${slowest}`])
    head.append(Object.assign(el("th", "", text), { scope: "col" }));
  table.append(el("thead"), el("tbody"));
  table.tHead.append(head);
  for (const [key, label] of SPEED) {
    const times = speedData.groups[`${key}/visible${recent ? "/recent" : ""}`]?.samples_ms;
    if (!times?.length) continue;
    const tr = el("tr"),
      name = el("th"),
      word = speedWord(pct(times, typical));
    name.scope = "row";
    name.append(el("span", `dot ${word}`), label, el("span", "sr-only", ` (${word})`));
    tr.append(
      name,
      el("td", "", fmtMs(pct(times, typical))),
      el("td", "", fmtMs(pct(times, slowest))),
    );
    table.tBodies[0].append(tr);
  }
  $("latency-summary").querySelector("table").replaceWith(table);
}
async function loadLatencySummary() {
  if (!state.features.latency) {
    $("latency-summary").textContent =
      "Local measurements will be available after the server reconnects.";
    return;
  }
  latency.flush();
  $("latency-summary").textContent = "Loading measurements…";
  try {
    const response = await apiFetch("/api/latency", { cache: "no-store" });
    if (!response.ok) throw Error();
    const data = await response.json();
    if (!data.available) throw Error();
    if (!data.count) {
      $("latency-summary").textContent =
        "No measurements yet. Open or switch threads to collect some.";
      return;
    }
    speedData = data;
    const sliders = el("div", "sliders");
    sliders.append(
      speedSlider("typical", "Typical", 50, 95),
      speedSlider("slowest", "Slowest", 75, 100),
    );
    $("latency-summary").replaceChildren(windowPicker(data.retention_days), sliders, el("table"));
    renderSpeedTable();
    $("latency-summary").append(
      el(
        "p",
        "note",
        "A pN time means N in 100 loads were that fast or faster: p50 is the middle load, p100 the slowest one. Counts only loads while the app was on screen.",
      ),
    );
  } catch {
    $("latency-summary").textContent =
      "Local measurements are unavailable until the server reconnects.";
  }
}
const fmtTok = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(n);
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
// Step timing from server receive times (`ts`), so live and replayed rows both show durations.
const stepDur = (ms) =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : fmtDur(ms);
const durChip = (ms) => el("span", "dur", stepDur(ms));
// A ring that fills with the model's context window, as in other chat UIs. Amber (never red: red means destructive) as it gets full.
function renderCtx() {
  const b = $("ctx");
  const threadId = state.current;
  b.onclick = () =>
    openContextEconomics({ getThread: () => state.threads.get(threadId), send, trigger: b });
  const c = cur()?.context;
  if (c?.used == null && cur()?.lastCompactedAt) {
    b.hidden = false;
    b.dataset.level = "";
    b.style.color = "";
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
  const body =
    pct == null
      ? `${c.used.toLocaleString()} tokens`
      : `${c.used.toLocaleString()} of ${c.max.toLocaleString()} tokens (${pct}%)`;
  const hint =
    pct != null && pct >= 80
      ? cur().provider === "claude"
        ? "Claude compacts automatically as this fills."
        : "Getting full: a new thread starts clean."
      : "";
  b.dataset.tip = [head, body, hint].filter(Boolean).join("\n");
  b.setAttribute("aria-label", [head, body, hint].filter(Boolean).join(". "));
}
// "Working" in the header, plus how many subagents are still going
function updateWorking() {
  $("state").classList.toggle("waiting", !!(questions.count(state.current) || cur()?.waiting));
  const n = Math.max(
    cur()?.background || 0,
    [...state.cards.values()].filter(
      (c) =>
        c.classList.contains("agent") &&
        (c.classList.contains("pending") || c.querySelector(".task-chip.running")),
    ).length,
  );
  $("state-t").textContent =
    questions.count(state.current) || cur()?.waiting
      ? "Needs your input"
      : cur()?.operation === "compact"
        ? "Compacting context"
        : n
          ? `Working · ${n} agent${n > 1 ? "s" : ""}`
          : "Working";
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
  box.append(
    icon("terminal", "glyph"),
    el("h2", "", "No thread selected"),
    el("p", "", "Start a thread to run a coding agent in one of your folders."),
  );
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
  state.doneTasks = null;
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
$("chat").addEventListener(
  "scroll",
  () => {
    if (readerScrolling()) gesture.at = performance.now(); // momentum after the finger lifts is still the reader's scroll
    scrollFrame ||= requestAnimationFrame(onChatScroll);
  },
  { passive: true },
);
// The reader's own scrolling (finger down, wheel, or the fling that follows). While it lasts nothing re-anchors or
// follows the bottom: on Android a scrollTop write during a drag snaps the list back under the finger.
const gesture = { touching: false, at: 0, idle: 0 };
function readerScrolling() {
  return gesture.touching || performance.now() - gesture.at < 160;
}
function following() {
  return state.stick && !readerScrolling() && !chatSearch.isOpen();
}
function markGesture(touching) {
  if (touching != null) gesture.touching = touching;
  gesture.at = performance.now();
}
$("chat").addEventListener("touchstart", () => markGesture(true), { passive: true });
for (const event of ["touchend", "touchcancel"])
  $("chat").addEventListener(event, () => markGesture(false), { passive: true });
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
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.removedNodes)
      if (node instanceof Element) followResize.unobserve(node);
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
    if (readerScrolling()) return releaseHistoryAnchor();
    if (!node.isConnected) return releaseHistoryAnchor();
    const delta = node.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 0.5) {
      chat.scrollTop += delta;
      state.lastScrollTop = chat.scrollTop;
    }
  });
  historyAnchor = { observer };
  // Native virtual rendering resolves intrinsic sizes after paint; retain the visible message until the reader moves.
  for (const child of chat.children) observer.observe(child);
}
for (const event of ["wheel", "touchstart", "pointerdown"])
  $("chat").addEventListener(event, releaseHistoryAnchor, { passive: true });
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
    card.append(
      el("span", "cc-ico"),
      (() => {
        const b = el("div", "cc-body");
        b.append(el("div", "cc-title"), el("div", "cc-sub"), el("div", "cc-bar"));
        return b;
      })(),
    );
    push(card, live);
  }
  const done = e.status === "completed",
    failed = e.status === "failed";
  card.className = `msg compact-card ${failed ? "failed" : done ? "done" : "running"}`;
  card
    .querySelector(".cc-ico")
    .replaceChildren(done ? icon("check") : failed ? icon("alert") : el("i", "spin"));
  card.querySelector(".cc-title").textContent = failed
    ? "Compaction failed"
    : done
      ? "Context compacted"
      : "Compacting context";
  card.querySelector(".cc-sub").textContent = failed
    ? e.text || "The agent did not compact this thread."
    : done
      ? "Earlier turns were summarised. The transcript above is kept."
      : "Summarising earlier turns to free up room. You can queue a message meanwhile.";
  if (done || failed) state.compact = null;
}
// a running card whose operation is over (stopped, or the page reloaded after the server gave up) must not spin forever
function settleCompact(outcome = "stopped") {
  for (const c of document.querySelectorAll(".compact-card.running")) {
    c.className = "msg compact-card failed";
    c.querySelector(".cc-ico").replaceChildren(icon("alert"));
    c.querySelector(".cc-title").textContent =
      outcome === "stopped" ? "Compaction stopped" : "Compaction interrupted";
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
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
// File tools get an eye link next to the label that opens the file viewer. It is a sibling of .sum, so relabelling the text never removes it.
function fileView(name, input) {
  const path = FILE_TOOLS.has(name) && (input?.file_path || input?.notebook_path);
  if (!path || typeof path !== "string" || !parseFileRef(path)) return [];
  const a = el("a", "file-view");
  a.href = "#";
  a.dataset.fileRef = path;
  a.title = "Open file";
  a.setAttribute("aria-label", `Open ${path}`);
  a.append(icon("eye"));
  return [a];
}
// A shell command is cryptic; when the agent said what it is for, show that and keep the command in the card body and on hover.
const describedAs = (name, input) =>
  (name === "Bash" && typeof input?.description === "string" && input.description.trim()) || "";
const TOOL_ICON = {
  Bash: "terminal",
  Edit: "pencil",
  MultiEdit: "pencil",
  NotebookEdit: "pencil",
  Write: "file",
  Read: "file",
  Grep: "search",
  Glob: "search",
  WebFetch: "globe",
  WebSearch: "globe",
  WebFind: "globe",
  WebBrowse: "globe",
  Task: "sparkle",
  Agent: "sparkle",
};

function codePre(text, lang) {
  const pre = el("pre");
  const code = el("code");
  // Closed tool cards need readable text, but syntax highlighting can wait until opened.
  code.textContent = text;
  code.dataset.highlightPending = lang || "";
  pre.append(code);
  return pre;
}
function toolBodyBrowse(box, input, name) {
  box.append(el("p", "", summarize(name, input)));
}
function toolBodyEdit(box, input) {
  const pre = el("pre", "diff");
  for (const line of String(input.old_string).split("\n")) pre.append(el("div", "del", line));
  for (const line of String(input.new_string).split("\n")) pre.append(el("div", "add", line));
  box.append(pre);
}
function toolBodyImage(box, input) {
  const preview = el("div", "prose tool-preview");
  preview.append(localImage(input.file_path));
  box.append(preview, codePre(JSON.stringify(input, null, 2), "json"));
}
function toolBodyWrite(box, input) {
  box.append(codePre(String(input.content).slice(0, 4000), langFromPath(input.file_path)));
}
function toolBodyBash(box, input) {
  // "$ cmd" with a hanging indent so wrapped lines stay under the command, and its own copy button
  const cmd = String(input.command);
  const row = el("div", "tool-cmd");
  const copy = iconButton("copy", "Copy command");
  wireCopy(copy, () => cmd, "Copy command");
  row.append(el("span", "ps1", "$"), codePre(cmd, "bash"), copy);
  row.firstChild.setAttribute("aria-hidden", "true");
  box.append(row);
}
function toolBodyJson(box, input) {
  box.append(codePre(JSON.stringify(input, null, 2), "json"));
}
// First matching rule wins; same order as the original if/else chain.
const TOOL_BODY_RULES = [
  [(name, input) => name === "WebSearch" && toolName(name, input) === "WebBrowse", toolBodyBrowse],
  [(name, input) => name === "Edit" && "old_string" in input, toolBodyEdit],
  [(name, input) => name === "Read" && isImageFile(input.file_path), toolBodyImage],
  [(name, input) => name === "Write" && "content" in input, toolBodyWrite],
  [(name, input) => name === "Bash" && input.command, toolBodyBash],
];
function toolBody(name, input) {
  const box = el("div", "body");
  input = input || {};
  const rule = TOOL_BODY_RULES.find(([matches]) => matches(name, input));
  (rule ? rule[1] : toolBodyJson)(box, input, name);
  return box;
}

function materializeTool(card) {
  if (!card.toolInput) return;
  const body = card.querySelector(".body");
  const { name, input } = card.toolInput;
  body.replaceChildren(
    ...toolBody(name, input).childNodes,
    ...body.querySelectorAll(".tool-result"),
  );
  card.toolInput = null;
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
  const byN = new Map(
    (attachments ?? []).filter((a) => a.kind === "image" && a.n).map((a) => [a.n, a]),
  );
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
    createLiveElement(L, kind);
    L[kind] = "";
    push(L[kind + "El"]);
  }
  if (L.raf) return;
  L.raf = requestAnimationFrame(() => {
    L.raf = 0;
    const stick = following() && nearBottom();
    paintLive(L);
    if (stick) scrollDown(true);
  });
}
function createLiveElement(live, kind) {
  if (kind === "text") {
    const msg = asstMsg("", false);
    live.textEl = msg.root;
    live.prose = msg.prose;
    return;
  }
  const box = el("div", "msg think live");
  box.append(icon("sparkle"), el("span", "", "Thinking…"));
  live.thinkingEl = box;
}
function paintLive(live) {
  if (live.textEl && live.prose) renderMarkdown(live.text || "", live.prose);
  if (live.thinkingEl)
    live.thinkingEl.querySelector("span").textContent =
      "Thinking… " + (live.thinking || "").slice(-200).replace(/\s+/g, " ");
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
  sum.append(
    icon("sparkle", "tool"),
    el("span", "name", kind ? `Agent · ${kind}` : "Agent"),
    el("span", "sum human", b.input?.description || "Subagent"),
    el("span", "stats"),
    chip,
    st,
    icon("chev-right", "chev"),
  );
  const body = el("div", "body");
  if (b.input?.prompt) {
    const det = el("details", "sub-prompt");
    const label = el("summary");
    label.append(icon("chev-right", "chev"), el("span", "", "Instructions"));
    det.append(label, el("pre", "", String(b.input.prompt).slice(0, 4000)));
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
function subToolRow(block) {
  const row = subRow("tool pending");
  const status = el("span", "st");
  status.append(el("i", "spin"));
  const why = describedAs(block.name, block.input);
  const subagent = isAgent(block.name);
  const fallback = subagent
    ? block.input?.description || "Subagent"
    : summarize(block.name, block.input);
  row.append(
    icon(TOOL_ICON[block.name] || "code", "tool"),
    el("span", "name", subagent ? "Agent" : toolName(block.name, block.input)),
    el("span", why || subagent ? "sum human" : "sum", why || fallback),
    ...fileView(block.name, block.input),
    status,
  );
  row.title = summarize(block.name, block.input);
  state.subTools.set(block.id, row);
  if (subagent) {
    const inner = el("ol", "sub-log");
    row.append(inner);
    state.subs.set(block.id, inner);
  }
  return row;
}
function subAssistant(log, blocks) {
  for (const block of blocks) {
    if (block.type === "text" && block.text?.trim()) {
      const row = subRow("text");
      row.textContent = block.text;
      log.append(row);
    } else if (block.type === "tool_use") log.append(subToolRow(block));
  }
}
function subToolResults(blocks) {
  for (const block of blocks) {
    const row = block.type === "tool_result" ? state.subTools.get(block.tool_use_id) : null;
    if (!row) continue;
    row.classList.remove("pending");
    row.classList.add(block.is_error ? "err" : "done");
    row.querySelector(":scope > .st")?.replaceChildren(icon(block.is_error ? "x" : "check"));
  }
}
function subEvent(e, live) {
  if (e.type === "stream_event") return; // partial text of a subagent is not shown live; the finished message is
  const log = state.subs.get(e.parent_tool_use_id);
  if (!log) return;
  const blocks = e.message?.content ?? [];
  if (e.type === "assistant") subAssistant(log, blocks);
  else if (e.type === "user") subToolResults(blocks);
  if (live && following()) scrollDown(false);
}
// task_started / task_progress / task_notification: live stats on the card, and a status chip for work that outlives the call
function finishChip(card, chip, e) {
  const word =
    { completed: "finished", failed: "failed", stopped: "stopped" }[e.status] ||
    e.status ||
    "finished";
  chip.className = `task-chip ${e.status === "failed" ? "err" : "done"}`;
  chip.replaceChildren(icon(e.status === "failed" ? "x" : "check"), el("span", "", word));
  if (e.summary) chip.title = e.summary;
  const now = card.querySelector(".now");
  if (now) now.textContent = "";
}
function paintTaskProgress(card, e) {
  const usage = e.usage || {};
  card.querySelector(".stats").textContent = [
    usage.tool_uses != null && `${usage.tool_uses} tool${usage.tool_uses === 1 ? "" : "s"}`,
    usage.total_tokens != null && `${fmtTok(usage.total_tokens)} tokens`,
    usage.duration_ms != null && fmtDur(usage.duration_ms),
  ]
    .filter(Boolean)
    .join(" · ");
  card.querySelector(".now").textContent = e.description ? `Now: ${e.description}` : "";
}
function startBackgroundChip(card, existing, e) {
  let chip = existing;
  if (!chip) {
    chip = el("span", "task-chip");
    card.querySelector("summary .st").before(chip);
  }
  chip.hidden = false;
  chip.className = "task-chip running";
  chip.replaceChildren(el("i", "spin"), el("span", "", "in background"));
  const done = state.doneTasks?.get(e.tool_use_id);
  if (done) {
    state.doneTasks.delete(e.tool_use_id);
    finishChip(card, chip, done);
  }
}
function taskEvent(e) {
  const card = state.cards.get(e.tool_use_id);
  if (!card) {
    // history is paged newest-first: the notification can arrive before the older page that holds its card and task_started
    if (e.subtype === "task_notification") (state.doneTasks ||= new Map()).set(e.tool_use_id, e);
    return;
  }
  if (e.subtype === "task_progress" && card.classList.contains("agent")) {
    paintTaskProgress(card, e);
    return;
  }
  // only work that outlives its tool call gets a status chip (a background subagent); a foreground command already shows its own spinner
  const chip = card.querySelector(".task-chip");
  if (e.subtype === "task_started" && e.is_backgrounded) startBackgroundChip(card, chip, e);
  else if (e.subtype === "task_notification" && chip && !chip.hidden) finishChip(card, chip, e);
  updateWorking();
}

// Client-perceived latency: send tap -> first reply token painted, for the turn this device started (latency kind first_token).
function watchFirstToken(e) {
  if (firstToken.thread !== state.current || e.type === "result" || e.type === "aborted") {
    firstToken = null;
    return;
  }
  if (e.parent_tool_use_id) return;
  const output =
    e.type === "stream_event"
      ? e.event?.type === "content_block_delta"
      : e.type === "assistant" &&
        e.message?.content?.some((b) => ["text", "thinking", "tool_use"].includes(b?.type));
  if (!output) return;
  const { thread, at, wait_ms } = firstToken,
    hidden = document.visibilityState !== "visible";
  firstToken = null;
  requestAnimationFrame(() => {
    const total_ms = performance.now() - at;
    firstTokenMs.set(thread, total_ms);
    latency.record({ kind: "first_token", thread, total_ms, wait_ms, hidden });
  });
}

const AUTO_NOTES = {
  brain: "Reminder sent: save anything durable to the shared brain.",
  continue: "Auto-continued: the agent announced a next step without doing it.",
  subagent: "Background subagent finished. Its result was sent to the agent.",
};

function hasQuestionCard(host, id) {
  return [...host.querySelectorAll(".question-card")].some(
    (card) => card.dataset.questionId === id,
  );
}

function onQuestionEvent(event, ctx) {
  push(questions.mount(state.current, event), ctx.live);
}

function onQuestionAnswer(event, ctx) {
  questions.receive(state.current, event);
  const host = state.into || $("chat");
  const exists = hasQuestionCard(host, event.id);
  if (!exists && !hasQuestionCard($("chat"), event.id))
    push(questions.mount(state.current, event), ctx.live);
  questions.refresh(host);
}

function onCommandStatus(event, ctx) {
  if (event.command === "compact") return void compactCard(event, ctx.live);
  addNote(event.text, event.status === "failed" ? "errtxt" : "note command-note");
}

function scheduledLabel(scheduled) {
  if (scheduled === "catch-up") return "Scheduled run · catch-up for a missed time";
  if (scheduled === "manual") return "Scheduled task · run now";
  return "Scheduled run";
}

function userBubbleRow(event) {
  const rows = [];
  const bubble = el("div", "bubble");
  bubble.append(userText(event.text, event.attachments));
  rows.push(bubble);
  if (event.delivery)
    rows.push(
      el(
        "div",
        "delivery",
        event.delivery === "steer" ? "Sent while the agent was working" : "Was queued",
      ),
    );
  if (event.scheduled) rows.push(el("div", "delivery", scheduledLabel(event.scheduled)));
  rows.push(copyActions(() => event.text));
  return rows;
}

function onUserInput(event, ctx) {
  const { live } = ctx;
  if (event.questionAnswer) return; // The inline answered card already shows this async reply.
  if (event.command) return; // /compact is shown as its progress card, not as a message bubble
  if (Object.hasOwn(AUTO_NOTES, event.auto))
    return void push(el("div", "msg note", AUTO_NOTES[event.auto]), live);
  const row = el("div", "msg user");
  if (event.attachments?.length) row.append(...attachmentRows(event.attachments, live));
  if (event.text?.trim()) row.append(...userBubbleRow(event));
  push(row, live);
}

function onMessageStart() {
  state.live = null;
  state.thinkAt = null;
}

function onContentDelta(streamEvent) {
  if (streamEvent.delta?.type === "text_delta") {
    renderLive("text");
    state.live.text += streamEvent.delta.text;
  } else if (streamEvent.delta?.type === "thinking_delta") {
    renderLive("thinking");
    state.thinkAt ??= performance.now();
    state.live.thinking += streamEvent.delta.thinking;
  }
}

function onStreamEvent(event) {
  const streamEvent = event.event;
  if (!streamEvent) return;
  if (streamEvent.type === "message_start") onMessageStart();
  if (streamEvent.type === "content_block_delta") onContentDelta(streamEvent);
}

function onAssistantText(block, ctx) {
  dropLive("text");
  dropLive("thinking");
  push(asstMsg(block.text, true).root, ctx.live);
}

function onAssistantThinking(block, event, ctx) {
  const { live, prevTs } = ctx;
  dropLive("thinking");
  const det = el("details", "msg think");
  const sum = el("summary");
  sum.append(icon("sparkle"), el("span", "", "Reasoning"));
  if (live && state.thinkAt != null) sum.append(durChip(performance.now() - state.thinkAt));
  else if (typeof event.ts === "number" && prevTs != null && event.ts >= prevTs)
    sum.append(durChip(event.ts - prevTs));
  state.thinkAt = null;
  sum.append(icon("chev-right", "chev"));
  det.append(sum, el("div", "think-body", block.thinking));
  push(det, live);
}

function toolCardSummary(block) {
  const sum = el("summary");
  const tool = icon(TOOL_ICON[block.name] || "code", "tool");
  const status = el("span", "st");
  status.append(el("i", "spin"), el("span", "sr-only", "running"));
  const why = describedAs(block.name, block.input);
  sum.append(
    tool,
    el("span", "name", toolName(block.name, block.input)),
    el("span", why ? "sum human" : "sum", why || summarize(block.name, block.input)),
    ...fileView(block.name, block.input),
    status,
    icon("chev-right", "chev"),
  );
  sum.title = summarize(block.name, block.input);
  return sum;
}

function onToolCardToggle(card) {
  if (!card.open) return;
  materializeTool(card);
  for (const code of card.querySelectorAll("code[data-highlight-pending]")) {
    highlightInto(code, code.textContent, code.dataset.highlightPending);
    delete code.dataset.highlightPending;
  }
  fitOutputs(card);
}

function onAssistantToolUse(block, event, ctx) {
  const { live } = ctx;
  dropLive("text");
  dropLive("thinking");
  if (isAgent(block.name)) {
    const agentEl = agentCard(block);
    state.cards.set(block.id, agentEl);
    push(agentEl, live);
    updateWorking();
    return;
  }
  const card = el("details", "msg card pending");
  const sum = toolCardSummary(block);
  card.toolInput = { name: block.name, input: block.input };
  if (live) card.startedAt = performance.now();
  else if (typeof event.ts === "number") card.startedTs = event.ts;
  card.append(sum, el("div", "body")); // the open row wraps to show the whole label, so it is not repeated below
  card.addEventListener("toggle", () => onToolCardToggle(card));
  state.cards.set(block.id, card);
  push(card, live);
}

function onAssistantBlock(block, event, ctx) {
  if (block.type === "thinking" || block.type === "redacted_thinking") dropLive("thinking");
  if (block.type === "text" && block.text?.trim()) onAssistantText(block, ctx);
  else if (block.type === "thinking" && block.thinking?.trim())
    onAssistantThinking(block, event, ctx);
  else if (block.type === "tool_use") onAssistantToolUse(block, event, ctx);
}

function onAssistant(event, ctx) {
  for (const block of event.message?.content ?? []) onAssistantBlock(block, event, ctx);
}

function toolResultText(part) {
  if (typeof part.content === "string") return part.content;
  return (part.content ?? []).map((piece) => piece.text ?? "").join("\n");
}

function settleToolResult(card, part, event) {
  card.classList.remove("pending");
  card.classList.add(part.is_error ? "err" : "done");
  const status = card.querySelector(".st");
  if (card.startedAt != null) status.before(durChip(performance.now() - card.startedAt));
  else if (card.startedTs != null && typeof event.ts === "number" && event.ts >= card.startedTs)
    status.before(durChip(event.ts - card.startedTs));
  status.replaceChildren(
    icon(part.is_error ? "x" : "check"),
    el("span", "sr-only", part.is_error ? "error" : "done"),
  );
  const text = toolResultText(part);
  // a background subagent's launch receipt is harness bookkeeping; its status chip and activity say the same
  const launched =
    card.classList.contains("agent") &&
    (card.querySelector(".task-chip:not([hidden])") || /^Async agent launched/.test(text));
  if (text && !launched) {
    const out = toolOutput(text, !!part.is_error);
    card.querySelector(".body").append(out);
    if (card.open) fitOutput(out);
  }
}

function onUserEvent(event) {
  for (const part of event.message?.content ?? []) {
    if (part.type !== "tool_result") continue;
    const card = state.cards.get(part.tool_use_id);
    if (!card) continue;
    settleToolResult(card, part, event);
  }
  updateWorking();
}

function resultStats(event) {
  const bits = [];
  const stamp = new Date(event.ts || Date.now());
  const clock = stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  bits.push(
    stamp.toDateString() === new Date().toDateString()
      ? clock
      : `${stamp.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`,
  );
  if (event.duration_ms) bits.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
  if (typeof event.total_cost_usd === "number") bits.push(`$${event.total_cost_usd.toFixed(4)}`);
  // Claude CLI reports failed turns (expired login, API errors) as subtype "success" with is_error set.
  if (event.is_error || (event.subtype && event.subtype !== "success"))
    bits.push(event.subtype && event.subtype !== "success" ? event.subtype : "error");
  return bits;
}

function onResult(event, ctx) {
  dropLive("text");
  dropLive("thinking");
  state.live = null;
  const bits = resultStats(event);
  const last = (state.into || $("chat")).lastElementChild;
  const row = last?.matches(".msg.asst") ? last.querySelector(".actions") : null;
  const foot = el("span", "foot", bits.join(" · "));
  if (row)
    row.append(foot); // stats sit on the reply's action row
  else push(el("div", "msg foot", bits.join(" · ")), ctx.live);
  const thread = cur();
  if (
    event.is_error &&
    thread?.provider === "claude" &&
    CLAUDE_AUTH_FAILED.test(event.result || "")
  )
    (row ? foot : (state.into || $("chat")).lastElementChild).append(
      " ",
      signInButton(thread.claudeAccount || "sunny"),
    );
}

function onSystemEvent(event) {
  if (event.subtype?.startsWith("task_")) taskEvent(event);
}

function onToolUpdate(event) {
  const card = state.cards.get(event.tool_use_id) ?? state.subTools.get(event.tool_use_id);
  if (!card) return;
  card.querySelector(".name").textContent = toolName(event.name, event.input);
  const sumEl = card.querySelector(".sum");
  sumEl.textContent = summarize(event.name, event.input);
  if (!card.querySelector(".file-view")) sumEl.after(...fileView(event.name, event.input));
  const summary = card.querySelector("summary") || card;
  summary.title = summarize(event.name, event.input);
  const body = card.querySelector(".body");
  if (!body) return;
  card.toolInput = { name: event.name, input: event.input };
  if (!card.open) return;
  body.replaceChildren(
    ...toolBody(event.name, event.input).childNodes,
    ...body.querySelectorAll(".tool-result"),
  );
  card.toolInput = null;
}

function onToolLabel(event) {
  // The helper model's plain-English version of a command that came without a description; arrives a few seconds after the card
  const sumEl = (
    state.cards.get(event.tool_use_id) ?? state.subTools.get(event.tool_use_id)
  )?.querySelector(".sum");
  if (sumEl && !sumEl.classList.contains("human")) {
    sumEl.textContent = event.label;
    sumEl.classList.add("human");
  }
}

function onAborted(_evt, ctx) {
  state.live = null;
  settleCompact("stopped");
  push(el("div", "msg note", "Stopped."), ctx.live);
}

function onConsoleError(event, ctx) {
  push(errBlock(event.text), ctx.live);
}

function onScheduleReport(event, ctx) {
  push(schedules.reportCard(event), ctx.live);
}

function onRateLimitEvent(event, ctx) {
  if (ctx.live) setUsage(event);
}

const EVENT_HANDLERS = {
  __proto__: null,
  question: onQuestionEvent,
  question_answer: onQuestionAnswer,
  command_status: onCommandStatus,
  user_input: onUserInput,
  stream_event: onStreamEvent,
  assistant: onAssistant,
  user: onUserEvent,
  result: onResult,
  system: onSystemEvent,
  tool_update: onToolUpdate,
  tool_label: onToolLabel,
  aborted: onAborted,
  console_error: onConsoleError,
  schedule_report: onScheduleReport,
  rate_limit_event: onRateLimitEvent,
};

function onEvent(event, live) {
  const prevTs = state.lastTs;
  if (typeof event.ts === "number" && !event.parent_tool_use_id) state.lastTs = event.ts;
  if (live && firstToken) watchFirstToken(event);
  // what a subagent says and does arrives with the id of the call that spawned it: it belongs inside that card, not in the main thread
  if (
    event.parent_tool_use_id &&
    (event.type === "assistant" || event.type === "user" || event.type === "stream_event")
  )
    return subEvent(event, live);
  return EVENT_HANDLERS[event.type]?.(event, { live, prevTs });
}

function meterColor(pct) {
  return pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
}
function setUsage(e, provider = threadUsageKey(cur())) {
  const w = e.rate_limit_info?.unifiedWindows;
  if (!w) return;
  state.usage[provider] = {
    updatedAt: Date.now(),
    windows: [
      ["5-hour", w.five_hour],
      ["7-day", w.seven_day],
    ]
      .filter(([, x]) => Number.isFinite(x?.utilization))
      .map(([label, x]) => ({
        label,
        used: x.utilization * 100,
        limit: 100,
        unit: "%",
        ...(x.resetsAt || x.resets_at ? { resetsAt: (x.resetsAt || x.resets_at) * 1000 } : {}),
      })),
  };
  renderUsage();
}
function resetsText(at) {
  const ms = at - Date.now();
  if (ms <= 0) return "Reset passed";
  const m = Math.round(ms / 60000),
    d = Math.floor(m / 1440),
    h = Math.floor((m % 1440) / 60);
  return `Resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`}`;
}
function usageMeter(label, used, limit, unit = "%", resetsAt) {
  const pct = Math.max(0, Math.min(100, (used / limit) * 100));
  const row = el("div", "u");
  const bar = el("div", "bar");
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-label", label);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(limit));
  bar.setAttribute("aria-valuenow", String(used));
  const text =
    unit === "%"
      ? `${Math.round(pct)}%`
      : unit === "$"
        ? `$${used.toFixed(2)} / $${limit.toFixed(2)}`
        : unit === "tokens"
          ? `${fmtTok(used)} / ${fmtTok(limit)}`
          : `${used} / ${limit}`;
  bar.setAttribute("aria-valuetext", text);
  row.title = `${label}: ${text}${resetsAt ? ` · resets ${new Date(resetsAt).toLocaleString()}` : ""}`;
  const fill = el("i");
  fill.style.width = `${pct}%`;
  fill.style.background = meterColor(pct);
  bar.append(fill);
  const value = el("span", "pct", unit === "%" || unit === "tokens" ? `${Math.round(pct)}%` : text);
  value.style.color = meterColor(pct);
  row.append(el("span", "", label), bar, value);
  if (resetsAt) row.append(el("span", "u-reset", resetsText(resetsAt)));
  return row;
}
const usageName = (p) =>
  p?.id === "claude"
    ? "Claude"
    : p?.id === "pi"
      ? "OpenRouter"
      : p?.id === "pi:deepseek"
        ? "DeepSeek"
        : p?.label || "";
let usagePicker;
function usageProviderEntries(provider) {
  if (provider.id === "claude")
    return claudeAccounts().map((account) => ({
      id: account.id === "sunny" ? "claude" : `claude:${account.id}`,
      label: account.label,
      email: account.email,
      claude: true,
      ready: account.ready,
    }));
  const hasDeepseek =
    provider.models?.some((model) => model.startsWith("deepseek/")) || state.usage["pi:deepseek"];
  if (provider.id === "pi" && hasDeepseek)
    return [provider, { id: "pi:deepseek", label: "DeepSeek" }];
  return [provider];
}
function usageProviderList() {
  const providers = [...state.providers.values()]
    .filter((provider) => provider.id !== "mock")
    .flatMap(usageProviderEntries);
  if (state.usage["pi:deepseek"] && !providers.some((entry) => entry.id === "pi:deepseek")) {
    const codex = providers.findIndex((entry) => entry.id === "codex");
    providers.splice(codex < 0 ? providers.length : codex, 0, {
      id: "pi:deepseek",
      label: "DeepSeek",
    });
  }
  return providers;
}
function ensureUsagePicker(root) {
  let picker = root.querySelector("#usage-provider");
  if (picker) return picker;
  picker = el("button", "btn field usage-picker");
  picker.id = "usage-provider";
  picker.type = "button";
  usagePicker = createMenu({
    trigger: picker,
    label: "Usage account",
    side: "top",
    renderTrigger: (item, button) => {
      fieldTrigger(item, button);
      button.setAttribute("aria-label", `Usage account: ${item?.label || ""}`);
    },
    onSelect: (value) => {
      state.usageTab = value;
      renderUsage();
    },
  });
  return picker;
}
function usageHead(sample, deepseek) {
  const head = el("div", "usage-head", "");
  const refresh = iconButton("refresh", "Refresh usage", "btn icon sm ghost usage-refresh");
  refresh.onclick = () => {
    refresh.classList.add("spinning");
    refresh.disabled = true;
    send({ t: "refresh_usage" });
    setTimeout(() => {
      refresh.classList.remove("spinning");
      refresh.disabled = false;
    }, 4000);
  };
  const stamp = sample?.updatedAt
    ? el(
        "span",
        "usage-stamp",
        new Date(sample.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      )
    : null;
  if (stamp) {
    stamp.title = `Updated ${new Date(sample.updatedAt).toLocaleString()}`;
    refresh.setAttribute("aria-label", `Refresh usage (updated ${stamp.textContent})`);
  }
  head.append(
    el("span", "usage-label", deepseek ? "Balance" : "Allowance"),
    ...(stamp ? [stamp] : []),
    refresh,
  );
  return head;
}
function usageEmptyNote(sample, deepseek, selectedAccount) {
  if (sample?.note) return sample.note;
  if (deepseek) return "DeepSeek balance not loaded yet. Tap refresh.";
  if (!selectedAccount?.claude) return "No allowance telemetry yet. Tap refresh.";
  return selectedAccount.ready
    ? "Claude reports this account’s allowance after each turn."
    : "Sign in to this account on the server to see its allowance.";
}
function appendDeepseekBalances(pane, sample) {
  for (const balance of sample.balances) {
    const money = (amount) => `${balance.currency} ${amount.toFixed(2)}`;
    pane.append(
      el("div", "usage-label", `${money(balance.total)} total balance`),
      el(
        "div",
        "usage-note",
        `${money(balance.granted)} granted · ${money(balance.toppedUp)} topped up`,
      ),
    );
  }
  if (sample.available === false)
    pane.append(el("div", "usage-note", "Insufficient balance for API requests."));
}
function appendUsageAllowance(pane, sample, deepseek, selectedAccount) {
  if (deepseek && sample?.balances?.length) {
    appendDeepseekBalances(pane, sample);
  } else if (sample?.windows?.length) {
    for (const window of sample.windows)
      pane.append(
        usageMeter(
          window.label,
          window.used,
          window.limit,
          window.unit || "requests",
          window.resetsAt,
        ),
      );
  } else pane.append(el("div", "usage-note", usageEmptyNote(sample, deepseek, selectedAccount)));
  if (sample?.windows?.some((window) => window.resetsAt && window.resetsAt < Date.now()))
    pane.append(el("div", "usage-note", "Last reported usage · reset passed; awaiting refresh."));
  if (sample?.spendToday != null)
    pane.append(el("div", "usage-note", `$${sample.spendToday.toFixed(4)} spent today`));
}
function usageContextThread() {
  const current = cur();
  if (current && threadUsageKey(current) === state.usageTab) return current;
  return [...state.threads.values()]
    .filter((thread) => threadUsageKey(thread) === state.usageTab)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}
function usageContextDetail(thread, hasCtx) {
  if (hasCtx) return `${fmtTok(thread.context.used)} of ${fmtTok(thread.context.max)} tokens`;
  if (thread?.context?.used != null)
    return `${fmtTok(thread.context.used)} tokens · window not reported`;
  return thread?.lastCompactedAt
    ? "Compacted · token usage updates on the next request."
    : "Context not reported yet.";
}
function usageContextGroup(thread) {
  const hasCtx = thread?.context?.used != null && thread.context.max;
  const detail = usageContextDetail(thread, hasCtx);
  const ctxRow = hasCtx
    ? usageMeter("Context", thread.context.used, thread.context.max, "tokens")
    : el("div", "u u-empty", "");
  ctxRow.classList.add("u-ctx");
  if (!hasCtx)
    ctxRow.append(el("span", "", "Context"), el("span", "bar"), el("span", "pct", "\u2013"));
  const info = iconButton("info", "Context details", "btn icon sm ghost usage-info");
  info.id = "usage-ctx-info";
  info.setAttribute("aria-haspopup", "dialog");
  info.title = "Compare continuing versus compacting";
  const openForecast = (trigger) =>
    openContextEconomics({ getThread: () => state.threads.get(thread?.id), send, trigger });
  info.onclick = () => openForecast(info);
  ctxRow.setAttribute("role", "button");
  ctxRow.tabIndex = 0;
  ctxRow.setAttribute("aria-label", `Context forecast: ${detail}`);
  ctxRow.setAttribute("aria-haspopup", "dialog");
  ctxRow.onclick = () => openForecast(ctxRow);
  ctxRow.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openForecast(ctxRow);
    }
  };
  const ctxWrap = el("div", "usage-ctx");
  ctxWrap.setAttribute("role", "group");
  ctxWrap.setAttribute("aria-label", "Thread context");
  const line = el("div", "usage-ctx-line");
  line.append(ctxRow, info);
  ctxWrap.append(line);
  return ctxWrap;
}
function usageLongContextNote(thread) {
  const note = el(
    "div",
    "usage-note",
    "Long context increases repeated input. Compact this task, or start a fresh thread for unrelated work.",
  );
  if (thread.status === "idle") {
    const compact = el("button", "btn sm ghost", "Compact context");
    compact.type = "button";
    compact.onclick = () => send({ t: "compact", thread: thread.id });
    note.append(compact);
  }
  return note;
}
function renderUsage() {
  const providers = usageProviderList();
  if (!providers.length) return;
  if (!providers.some((entry) => entry.id === state.usageTab)) state.usageTab = providers[0].id;
  const root = $("usage");
  const focusedControl = root.contains(document.activeElement) ? document.activeElement.id : null;
  const picker = ensureUsagePicker(root);
  usagePicker.setItems(
    providers.map((entry) => ({
      value: entry.id,
      label: entry.claude ? `Claude · ${entry.label}` : usageName(entry),
      ...(entry.email ? { desc: entry.email } : {}),
    })),
    state.usageTab,
  );
  const pane = el("div", "usage-pane");
  pane.id = "usage-panel";
  pane.setAttribute("role", "region");
  pane.setAttribute("aria-labelledby", picker.id);
  const sample = state.usage[state.usageTab];
  const selectedAccount = providers.find((entry) => entry.id === state.usageTab);
  const deepseek = state.usageTab === "pi:deepseek";
  pane.append(usageHead(sample, deepseek));
  appendUsageAllowance(pane, sample, deepseek, selectedAccount);
  const thread = usageContextThread();
  pane.append(usageContextGroup(thread));
  if (
    thread?.context?.used != null &&
    thread.context.max &&
    thread.context.used / thread.context.max >= 0.7
  )
    pane.append(usageLongContextNote(thread));
  if (!picker.isConnected) root.replaceChildren(picker, pane);
  else root.querySelector(".usage-pane").replaceWith(pane);
  if (focusedControl) $(focusedControl)?.focus({ preventScroll: true });
}

// ---------- controls ----------
let submitting = false;
function runSettingsCommand(text, box) {
  if (text.toLowerCase() === "/effort" && $("effort").hidden) {
    toast("This agent does not expose effort settings.");
    return;
  }
  if (cur()?.status === "running") {
    toast("Stop the running operation before changing settings.");
    return;
  }
  box.value = "";
  saveDraft();
  closeSlash();
  menus[text.slice(1).toLowerCase()].open();
}
function defaultSendMode(mode, attachments) {
  if (!mode && !attachments.length && (questions.count(state.current) || cur()?.waiting))
    return "steer";
  return mode;
}
function attachmentSnapshot(item) {
  return {
    key: item.key,
    thread: item.thread,
    name: item.name,
    kind: item.kind,
    size: item.size,
    n: item.n,
    id: item.id,
    order: item.order,
  };
}
async function submit(mode) {
  const box = $("input");
  if (submitting || !state.current) return;
  if (!box.value.trim() && !pending.length) return;
  submitting = true;
  const tapAt = performance.now();
  const thread = state.current;
  try {
    await Promise.all(pending.map((p) => p.ready));
    if (state.current !== thread) return; // Upload completion must not submit another thread's draft.
    if (pending.some((p) => !p.id)) {
      toast("Retry or remove failed attachments before sending.");
      return;
    }
    const text = box.value.trim();
    if (/^\/(model|effort)$/i.test(text)) {
      runSettingsCommand(text, box);
      return;
    }
    const attachments = pending
      .filter((p) => p.id)
      .map((p) => ({ id: p.id, ...(p.n ? { n: p.n } : {}) }));
    if (!text && !attachments.length) return;
    mode = defaultSendMode(mode, attachments);
    // mid-turn a message queues until the turn ends; mode "steer" (Alt+Enter, or Steer on a queued card) hands it to the agent now
    const startsTurn = !mode && cur()?.status !== "running";
    const draft = { thread, text: box.value, attachments: pending.map(attachmentSnapshot) };
    if (
      sendReliable(
        { t: "send", thread: state.current, text, attachments, ...(mode ? { mode } : {}) },
        draft,
      ) &&
      startsTurn
    )
      firstToken = { thread: state.current, at: tapAt, wait_ms: performance.now() - tapAt };
    box.value = "";
    saveDraft();
    box.style.height = "";
    for (const p of pending) forgetAttachment(p);
    pending.length = 0;
    imageCount = 0;
    renderThumbs();
    closeSlash();
  } finally {
    submitting = false;
  }
}
$("send").onclick = () => submit();
// Pre-warm: ask the server to start the open thread's agent before the first send (no prompt, no tokens). Debounced so flicking
// through threads starts nothing; repeated for the same thread at most once a minute (the server ignores live agents anyway).
let warmTimer = 0,
  lastWarm = { id: null, at: 0 };
function warmSoon(delay = 600) {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const t = cur();
    if (!t || t.archived || t.status !== "idle" || document.hidden) return;
    if (lastWarm.id === t.id && performance.now() - lastWarm.at < 60_000) return;
    if (send({ t: "warm", thread: t.id })) lastWarm = { id: t.id, at: performance.now() };
  }, delay);
}
$("input").addEventListener("focus", () => warmSoon(0));
$("input").addEventListener("input", () => warmSoon(0));
$("stop").onclick = () => sendReliable({ t: "abort", thread: state.current });

// ---------- attachments (paste, drop, or the attach button) ----------
// Each file is uploaded as soon as it is attached (raw bytes over HTTP); a message then just names the uploads.
// Big screenshots are downscaled in the browser first: the model's image limits and the thread log both prefer small.
const MAX_ATTACH = 20;
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
  box.value = box.value.includes(token + " ")
    ? box.value.replace(token + " ", "")
    : box.value.replace(token, "");
  box.dispatchEvent(new Event("input"));
}
const attachmentDrafts = new Map();
let attachmentOrder = Date.now();
let pending = [];
let storageWarning = false;
const attachmentStorage = attachmentDraftStore(() => {
  if (!storageWarning)
    toast("Browser storage unavailable. Attachments are kept only while this page stays open.");
  storageWarning = true;
});

const fmtSize = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
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
  // Keyboard image insertion on Android (Gboard clipboard, stickers) hands over raw bytes, possibly with no type: try decoding.
  const bmp =
    !file.type || file.type.startsWith("image/")
      ? await createImageBitmap(file).catch(() => null)
      : null;
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
  const r = await apiFetch(`/uploads/${thread}`, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "X-Name": encodeURIComponent(name),
    },
    body: blob,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status}).`);
  return j;
}
const discard = (p) =>
  Promise.resolve(p.ready).then(
    () => p.id && apiFetch(`/uploads/${p.thread}/${p.id}`, { method: "DELETE" }).catch(() => {}),
  );
function forgetAttachment(p) {
  p.removed = true;
  attachmentStorage.remove(p.key);
}
function dropPending(p) {
  const list = attachmentDrafts.get(p.thread) || [];
  const i = list.indexOf(p);
  if (i >= 0) list.splice(i, 1);
  forgetAttachment(p);
  if (state.current === p.thread) renderThumbs();
}
async function prepareUploadFile(pending) {
  if (pending.prepared) {
    if (pending.kind === "image") pending.url = await readDataUrl(pending.blob);
    return;
  }
  const prep = await prepare(pending.blob);
  if (pending.removed) return;
  Object.assign(pending, prep, { size: prep.blob.size, prepared: true });
  if (pending.kind === "image" && !pending.n) {
    const siblings = attachmentDrafts.get(pending.thread) || [];
    pending.n = Math.max(0, ...siblings.map((item) => item.n || 0)) + 1;
    pending.labelPending = true;
  }
  await attachmentStorage.save(pending);
}
async function insertUploadLabel(pending) {
  const token = `[Image #${pending.n}]`;
  if (state.current === pending.thread) {
    imageCount = pending.n;
    if (!$("input").value.includes(token)) insertToken(token);
  } else {
    const text = drafts.get(pending.thread) || "";
    if (!text.includes(token))
      writeDraft(pending.thread, `${text}${text && !/\s$/.test(text) ? " " : ""}${token} `);
  }
  pending.labelPending = false;
  await attachmentStorage.save(pending);
}
async function runPendingUpload(pending) {
  // Persist the original file before image decoding, resizing, or networking.
  await attachmentStorage.save(pending);
  if (pending.removed) return;
  await prepareUploadFile(pending);
  if (pending.removed) return;
  if (pending.labelPending) await insertUploadLabel(pending);
  if (pending.removed) return;
  if (state.current === pending.thread) renderThumbs();
  const result = await upload(pending.thread, pending.blob, pending.name);
  Object.assign(pending, { id: result.id, name: result.name, kind: result.kind });
  if (!pending.removed) await attachmentStorage.save(pending);
  delete pending.blob;
}
function startUpload(pending) {
  pending.busy = true;
  pending.error = false;
  pending.ready = runPendingUpload(pending)
    .catch((error) => {
      pending.error = true;
      if (!pending.removed && state.current === pending.thread)
        toast(`${pending.name}: ${error.message}`);
    })
    .finally(() => {
      pending.busy = false;
      if (state.current === pending.thread) renderThumbs();
    });
}

function appendThumbPreview(row, item) {
  if (item.kind !== "image") {
    row.append(icon("file"), el("span", "nm", item.name), el("span", "sz", fmtSize(item.size)));
    return;
  }
  const img = el("img");
  if (item.url) img.src = item.url;
  img.alt = item.n ? `${item.name} (Image ${item.n})` : item.name;
  row.append(img);
  if (item.n) row.append(el("span", "n", String(item.n)));
}
function thumbRetryButton(item) {
  const retry = el("button", "btn", "Retry");
  retry.type = "button";
  retry.setAttribute("aria-label", `Retry ${item.name}`);
  retry.onclick = () => {
    startUpload(item);
    renderThumbs();
  };
  return retry;
}
function thumbRemoveButton(item) {
  const remove = el("button", "btn rm");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${item.name}`);
  remove.append(icon("x"));
  remove.onclick = () => {
    dropPending(item);
    discard(item);
    if (item.n) removeToken(item.n);
    $("input").focus();
  };
  return remove;
}
function thumbRow(item) {
  const row = el("li", item.kind === "image" ? "" : "file");
  if (item.busy) row.setAttribute("aria-busy", "true");
  appendThumbPreview(row, item);
  if (item.error) row.append(thumbRetryButton(item));
  row.append(thumbRemoveButton(item));
  return row;
}
function renderThumbs() {
  const ul = $("thumbs");
  if (!pending.some((p) => p.kind === "image")) imageCount = 0; // numbering starts again once no image is waiting
  ul.hidden = !pending.length;
  renderAction();
  if (pending.length) $("attach").dataset.count = String(pending.length);
  else delete $("attach").dataset.count;
  ul.replaceChildren(...pending.map(thumbRow));
}

// serialised, so two quick pastes cannot both pass the MAX_ATTACH check while their files are still being processed
let adding = Promise.resolve();
const addFiles = (files) => {
  const thread = state.current;
  return (adding = adding.then(() => addFilesNow(files, thread)));
};
function assertAttachable(file) {
  if (!file.size) throw new Error(`${file.name || "That file"} is empty (or a folder).`);
  if (file.size > MAX_FILE_BYTES && file.type && !file.type.startsWith("image/"))
    throw new Error(`${file.name || "That file"} is over ${MAX_FILE_BYTES >> 20} MB.`);
}
async function addFilesNow(files, thread) {
  if (!thread) return;
  const list = attachmentDrafts.get(thread) || [];
  attachmentDrafts.set(thread, list);
  for (const f of files) {
    if (list.length >= MAX_ATTACH) {
      addNote(`At most ${MAX_ATTACH} attachments per message.`, "errtxt");
      break;
    }
    try {
      assertAttachable(f);
      const p = {
        key: crypto.randomUUID(),
        thread,
        name: f.name || "file",
        kind: "file",
        size: f.size,
        blob: f,
        n: 0,
        order: (attachmentOrder = Math.max(Date.now(), attachmentOrder + 1)),
      };
      list.push(p);
      startUpload(p);
      if (state.current === thread) renderThumbs();
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
const promptImprove = createPromptImprove({
  getText: () => $("input").value,
  apply(text) {
    $("input").value = text;
    saveDraft();
    sizeInput();
    renderAction();
    $("input").focus();
  },
});
$("improve").onclick = () => promptImprove.open();
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
  return (state.commands[cur()?.provider || "claude"] || [])
    .filter((c) => !c.name.startsWith("_"))
    .map((c) => [rank(c), c])
    .filter(([r]) => r < 9)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .slice(0, 60)
    .map(([, c]) => c);
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
    const li = el(
      "li",
      "none",
      (state.commands[cur()?.provider || "claude"] || []).length
        ? "No matching commands"
        : "Commands load after your first message.",
    );
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
  [...slashEl.children].forEach((li, i) => {
    li.setAttribute("aria-selected", String(i === slash.idx));
  });
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
  const scrollTop = box.scrollTop;
  box.style.height = "auto";
  const viewport = window.visualViewport?.height || window.innerHeight;
  const line = parseFloat(getComputedStyle(box).lineHeight);
  const chat = getComputedStyle($("chat"));
  const reserve =
    $("head").offsetHeight +
    $("composer").offsetHeight -
    box.offsetHeight +
    parseFloat(chat.paddingTop) +
    parseFloat(chat.paddingBottom) +
    line;
  box.style.height =
    Math.max(line, Math.min(box.scrollHeight, viewport * 0.35, viewport - reserve)) + "px";
  // Measuring at full height clears the editable's scroll position. Restore it before revealing the caret.
  box.scrollTop = scrollTop;
  const selection = getSelection();
  if (document.activeElement !== box || !selection?.focusNode || !box.contains(selection.focusNode))
    return;
  const caret = document.createRange();
  caret.setStart(selection.focusNode, selection.focusOffset);
  caret.collapse(true);
  let rect = caret.getBoundingClientRect();
  // Blank lines need their newline or placeholder <br> to supply the range's bounds.
  if (
    !rect.height &&
    selection.focusNode.nodeType === Node.TEXT_NODE &&
    selection.focusNode.textContent[selection.focusOffset] === "\n"
  ) {
    caret.setEnd(selection.focusNode, selection.focusOffset + 1);
    rect = caret.getBoundingClientRect();
  }
  const next =
    selection.focusNode.nodeType === Node.TEXT_NODE
      ? selection.focusNode.nextSibling
      : selection.focusNode.childNodes[selection.focusOffset];
  if (!rect.height && next?.nodeName === "BR") {
    caret.selectNode(next);
    rect = caret.getBoundingClientRect();
  }
  if (!rect.height) return;
  const bounds = box.getBoundingClientRect();
  if (rect.bottom > bounds.bottom) box.scrollTop += rect.bottom - bounds.bottom;
  else if (rect.top < bounds.top) box.scrollTop -= bounds.top - rect.top;
}
$("input").addEventListener("input", () => {
  saveDraft();
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
// The new-thread dialog doubles as the scheduled-task editor: same agent, folder, model, effort and permission fields, plus the task's
// name, instructions and schedule.
let dialogTask = null; // "new" or the task being edited; null for a new thread
let dialogAssignment = null;
let assignmentPending = false;
$("dlg").addEventListener("cancel", (event) => {
  if (assignmentPending) event.preventDefault();
  workflowBrief = null;
});
function dialogTitleText(editing, isTask) {
  if (editing) return "Edit scheduled task";
  return isTask ? "New scheduled task" : "New thread";
}
function dialogOkText(editing, isTask) {
  if (editing) return "Save task";
  return isTask ? "Schedule task" : "Create thread";
}
function fillEditingTask(task, providerId) {
  if (!menus.dCwd.items().some((item) => item.value === task.cwd))
    menus.dCwd.setItems([
      ...menus.dCwd.items(),
      { value: task.cwd, label: task.cwd.replace(/^.*\/repos\/?/, "~/repos/"), icon: "folder" },
    ]);
  menus.dCwd.setValue(task.cwd);
  if (menus.dModel.items().some((item) => item.value === task.model)) {
    menus.dModel.setValue(task.model);
    dialogEffort(task.model, providerId);
  }
  menus.dEffort.setValue(task.effort || "default");
  menus.dMode.setValue(task.mode);
  $("d-warn").hidden = task.mode !== "bypassPermissions";
}
function fillTaskDialog(task, editing) {
  const providerId = editing ? task.provider : prov("pi")?.ok ? "pi" : menus.dProv.value;
  menus.dProv.setValue(providerId);
  fillDialog(providerId);
  if (editing) fillEditingTask(task, providerId);
  $("d-title").value = editing ? task.title : "";
  $("d-prompt").value = editing ? task.prompt : "";
  menus.dRepeat.setValue(editing ? task.repeat : "daily");
  menus.dDay.setValue(String(editing ? task.day : 1));
  $("d-time").value = editing ? task.time : "09:00";
  $("d-save").checked = editing ? task.saveOutput : true;
  syncWhen();
}
function selectFirstOkProvider() {
  const first = [...state.providers.values()].find((prov) => prov.ok)?.id;
  if (first) {
    menus.dProv.setValue(first);
    fillDialog(first);
  }
}
function setDialogKind(task) {
  dialogAssignment = null;
  $("d-assignment-error").hidden = true;
  menus.dProv.setItems(
    [...state.providers.values()].map((p) => ({ value: p.id, label: p.label, disabled: !p.ok })),
    menus.dProv.value,
  );
  const wasTask = dialogTask !== null;
  dialogTask = task;
  $("d-auto-panel").hidden = true;
  $("d-auto-info").setAttribute("aria-expanded", "false");
  $("d-auto-note").textContent = AUTO_HINT;
  const isTask = task !== null,
    editing = isTask && task !== "new";
  $("task-fields").hidden = $("save-field").hidden = !isTask;
  $("dlg-title").textContent = dialogTitleText(editing, isTask);
  $("dlg-sub").textContent = isTask
    ? "Runs on this server with nobody watching. Each run opens a thread you can reply to."
    : "Run a coding agent in one of your folders.";
  $("d-title").required = $("d-prompt").required = isTask;
  if (isTask) fillTaskDialog(task, editing);
  else if (wasTask) selectFirstOkProvider();
  $("d-ok").textContent = dialogOkText(editing, isTask);
  dialogFork = null;
  $("context-field").hidden = true;
  $("cwd-field").hidden = false;
  syncDialogAccount();
}
// Fork reuses the dialog: prefilled from the source thread, folder fixed, plus how much of the conversation to carry.
let dialogFork = null; // the thread being forked
function syncForkContext() {
  const t = state.threads.get(dialogFork);
  const native =
    t &&
    menus.dProv.value === t.provider &&
    (t.provider !== "claude" || menus.dAccount.value === (t.claudeAccount || "sunny"));
  menus.dContext.setItems(
    [
      {
        value: "full",
        label: "Full conversation",
        desc: native
          ? "Continue the same session; nothing is lost."
          : "Replay the whole conversation as text.",
      },
      {
        value: "recent",
        label: "Recent context only",
        desc: "Carry a short handoff; the full transcript stays available.",
      },
    ],
    menus.dContext.value || "full",
  );
}
function openForkDialog(id) {
  const t = state.threads.get(id);
  if (!t) return;
  if (t.status === "running")
    return void toast("Wait for the current turn to finish before forking.");
  setNav(false);
  setDialogKind(null);
  dialogFork = id;
  const pid =
    prov(t.provider)?.ok !== false
      ? t.provider
      : [...state.providers.values()].find((p) => p.ok)?.id;
  menus.dProv.setValue(pid);
  fillDialog(pid);
  if (pid === t.provider) {
    menus.dAccount.setValue(t.claudeAccount || "sunny");
    if (menus.dModel.items().some((i) => i.value === t.model)) {
      menus.dModel.setValue(t.model);
      dialogEffort(t.model, pid);
    }
    if (menus.dEffort.items().some((i) => i.value === t.effort)) menus.dEffort.setValue(t.effort);
    if (menus.dMode.items().some((i) => i.value === t.mode)) menus.dMode.setValue(t.mode);
    $("d-warn").hidden = menus.dMode.value !== "bypassPermissions";
  }
  $("dlg-title").textContent = "Fork thread";
  $("dlg-sub").textContent =
    `Continue “${t.title}” in a new thread, in ${t.cwd.replace(/^.*\/repos\/?/, "~/repos/")}.`;
  $("context-field").hidden = false;
  $("cwd-field").hidden = true;
  menus.dContext.setValue("full");
  $("d-ok").textContent = "Fork thread";
  syncDialogAccount();
  $("dlg").showModal();
}
function openPremiumDialog(issue) {
  setNav(false);
  setDialogKind(null);
  const providers = [...state.providers.values()].filter((p) => ["claude", "codex"].includes(p.id));
  const chosen = providers.find((p) => p.ok);
  if (!chosen) return void toast("No premium agent is ready. Sign in to Claude or Codex first.");
  dialogAssignment = issue;
  menus.dProv.setItems(
    providers.map((p) => ({ value: p.id, label: p.label, disabled: !p.ok })),
    chosen.id,
  );
  fillDialog(chosen.id);
  const related = [...state.threads.values()].filter(
    (t) =>
      t.issueRun?.repo?.toLowerCase() === issue.repo.toLowerCase() &&
      t.issueRun.number === issue.number,
  );
  $("dlg-title").textContent = "Assign to premium";
  $("dlg-sub").textContent =
    `${issue.repo}#${issue.number} · ${related.length} related runs. The new session receives remaining work, current state, failed thread IDs and linked PRs.`;
  $("cwd-field").hidden = true;
  $("d-ok").textContent = "Start premium session";
  $("dlg").showModal();
}
async function submitPremiumAssignment(settings, account) {
  if (assignmentPending) return;
  assignmentPending = true;
  const issue = dialogAssignment;
  const cancel = $("dform").querySelector('button[value="cancel"]');
  cancel.disabled = true;
  $("d-ok").disabled = true;
  $("d-ok").textContent = "Starting…";
  $("d-assignment-error").hidden = true;
  const reset = () => {
    assignmentPending = false;
    cancel.disabled = false;
    $("d-ok").textContent = "Start premium session";
    syncDialogAccount();
  };
  let response;
  try {
    const { cwd, ...choice } = settings;
    response = await apiFetch("/api/automation/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ v: 1, ...issue, ...choice, ...account }),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("ndjson")) {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not start a premium session.");
      $("dlg").close();
      dialogAssignment = null;
      return void openThread(result.thread);
    }
  } catch (error) {
    $("d-assignment-error").textContent = error.message;
    $("d-assignment-error").hidden = false;
    return void reset();
  }
  // Checkout preparation takes up to a minute: the settings dialog gives way to a live timeline of its steps.
  $("dlg").close();
  reset();
  const back = (message) => {
    if (dialogAssignment !== issue) openPremiumDialog(issue);
    else {
      setNav(false);
      $("dlg").showModal();
    }
    $("d-assignment-error").textContent = message;
    $("d-assignment-error").hidden = false;
  };
  try {
    await showAssignmentProgress(response, {
      title: `${issue.repo}#${issue.number}`,
      onBack: () => back($("ap-error").textContent),
      onOpen: (id) => {
        if (dialogAssignment === issue) dialogAssignment = null;
        openThread(id);
      },
    });
    if (!$("ap").open) toast("Premium session started.");
  } catch (error) {
    if (!$("ap").open) toast(error.message);
  }
}
function syncWhen() {
  const r = menus.dRepeat.value;
  $("d-day").hidden = r !== "weekly";
  $("d-time").hidden = r === "manual";
  $("d-time").required = r !== "manual";
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("d-next").textContent =
    r === "manual"
      ? "Runs only when you press Run now."
      : r === "hourly"
        ? `Every hour at the minute shown (${zone}).`
        : `Your time zone: ${zone}.`;
}
function openNewDialog() {
  setNav(false);
  workflowBrief = null;
  setDialogKind(null);
  menus.dAccount.setValue("sunny");
  syncDialogAccount();
  $("dlg").showModal();
}
// + New workflow on /automation lands here: the same new-thread dialog, titled for a workflow, and the thread starts with
// the drawing, step and alert rules already written into the composer. The brief is editable and never sent by itself.
const WORKFLOW_BRIEF = `Add a new workflow to the Automation page (/automation) end to end.

Read first: server/automation/contracts.ts, server/automation/snapshot.ts, server/automation/events.ts, public/automation.js, public/automation.css, docs/automation.md and docs/monitoring.md.

1. Data before pixels. Add the workflow as a Pipeline in FLOW (contracts.ts) with group, icon, phases and ordered StepId steps; add each FlowNode and every FlowEdge with the condition that takes it. One step = one atomic action with a real trigger, state and event; never a decorative box.
2. Real steps only. Every step writes start/ok/fail/info events to the automation log (or reads a real unit/status source), has a disabled state, and can be enabled or disabled independently. The sidebar entry and detail view must come from FLOW, not bespoke HTML.
3. Draw it with the existing system: hand-drawn ICONS in public/automation.js (one stroke, no emoji, no icon library), console tokens and CSS classes. Phases run left to right, arrows carry their condition, loops are boxed with their label, and the phone layout is one vertical column. No new dependency.
4. Alerts. Phone web push is the default and only channel for non-security alerts. AgentMail only for security alerts, used minimally: batch into a daily digest, never one mail per event, and stay within the 3,000 messages per month allowance. Never put secrets, tokens or raw advisory text in a mail.
5. Guard rails. Keep the existing steps, tests, API shapes and version checks working. Add a failing test first, then fix it. Update test/automation-ui.ts (and test/sec-automations-ui.ts when security) for the new sidebar entry, its steps and its states, plus docs/automation.md.
6. Follow the pr-standards skill; end the PR body with ## Self-review and evidence screenshots at phone and desktop width.`;
let workflowBrief = null;
function maybeOpenWorkflowDialog() {
  const params = new URLSearchParams(location.search);
  if (params.get("new") !== "workflow" || !state.ready) return;
  params.delete("new");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  openNewDialog();
  workflowBrief = WORKFLOW_BRIEF;
  $("dlg-title").textContent = "New workflow";
  $("dlg-sub").textContent =
    "The brief already covers the drawing, atomic steps and alert limits. Choose an agent and folder.";
  $("d-ok").textContent = "Create thread";
}
// Android share sheet -> manifest share_target -> /?share_text=...&share_url=... . Strip the params first so a reload never re-shares.
let sharingLink = false;
async function maybeShareLink() {
  const params = new URLSearchParams(location.search);
  const text = params.get("share_text") || "";
  const url = params.get("share_url") || "";
  const title = params.get("share_title") || "";
  if (!text && !url) return;
  if (sharingLink) return;
  sharingLink = true;
  for (const key of ["share_text", "share_url", "share_title"]) params.delete(key);
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  try {
    let choice = await pickShareTarget();
    if (choice === "") choice = await createShareThread();
    if (choice === null) return void toast("Share cancelled");
    toast("Fetching link…");
    const response = await apiFetch("/api/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, url, title, thread: choice }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.thread) return void toast(body.error || "Could not fetch that link.");
    await fillShareDraft(body);
  } catch (error) {
    toast(error.message || "Could not fetch that link.");
  } finally {
    sharingLink = false;
  }
}
function handleCreated(threadId) {
  if (shareCreate?.submitted) return resolveShareCreate(threadId);
  openThread(threadId);
  if (!workflowBrief) return;
  writeDraft(threadId, workflowBrief);
  $("input").value = workflowBrief;
  sizeInput();
  workflowBrief = null;
  $("input").focus();
  toast("Workflow brief ready. Edit it, then send.");
}
// Share + compose: the normal New thread dialog picks provider, account, model and folder. Only the `created` that follows this
// dialog's own submit resolves the share (flag set on submit, consumed once); cancelling the dialog resolves null.
let shareCreate = null;
function resolveShareCreate(value) {
  const pendingShare = shareCreate;
  if (!pendingShare) return;
  shareCreate = null;
  clearTimeout(pendingShare.timer);
  pendingShare.resolve(value);
}
function createShareThread() {
  return new Promise((resolve) => {
    shareCreate = { submitted: false, resolve, timer: 0 };
    openNewDialog();
    $("dlg-sub").textContent += " The shared post will be attached to the new thread as a draft.";
  });
}
$("dlg").addEventListener("close", () => {
  if (shareCreate && !shareCreate.submitted) resolveShareCreate(null);
});
$("dform").addEventListener("submit", (e) => {
  if (!shareCreate || e.submitter?.value !== "ok" || dialogTask !== null) return;
  if (dialogAssignment || dialogFork) return;
  shareCreate.submitted = true;
  shareCreate.timer = setTimeout(() => resolveShareCreate(null), 30_000);
});
// The thread can reach the client over the WebSocket slightly after the POST resolves.
async function waitForThread(id) {
  for (let tries = 0; tries < 50 && !state.threads.has(id); tries++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  return state.threads.has(id);
}
// Put the share prompt and its already-uploaded files into the composer as a draft; the user edits and sends.
async function fillShareDraft(body) {
  const thread = body.thread;
  if (!(await waitForThread(thread))) return void toast("Shared, but the thread did not load.");
  openThread(thread);
  const box = $("input");
  box.value = box.value.trim() ? `${box.value}\n${body.prompt || ""}` : body.prompt || "";
  const list = attachmentDrafts.get(thread) || [];
  attachmentDrafts.set(thread, list);
  const saved = [];
  for (const file of body.attachments || []) {
    const p = {
      key: crypto.randomUUID(),
      thread,
      id: file.id,
      name: file.name,
      kind: file.kind,
      size: file.size,
      n: 0,
      prepared: true,
      order: (attachmentOrder = Math.max(Date.now(), attachmentOrder + 1)),
      url: `/uploads/${thread}/${file.id}/${encodeURIComponent(file.name)}`,
      ready: Promise.resolve(),
    };
    list.push(p);
    saved.push(attachmentStorage.save(p));
  }
  if (state.current === thread) {
    pending = list;
    renderThumbs();
  }
  saveDraft();
  sizeInput();
  box.focus();
  await Promise.all(saved);
}
// Share mode: the left drawer doubles as the target picker. Resolves "" for a new thread, a thread id, or null when cancelled.
function finishShare(value) {
  const resolve = shareResolve;
  if (!resolve) return;
  shareResolve = null;
  document.body.classList.remove("sharing");
  $("share-banner").hidden = true;
  resolve(value);
}
function pickShareTarget() {
  finishShare(null);
  return new Promise((resolve) => {
    shareResolve = resolve;
    setLane("threads");
    document.body.classList.add("sharing");
    $("share-banner").hidden = false;
    setNav(true);
  });
}
$("share-cancel").onclick = () => setNav(false);
function openTaskDialog(task) {
  setNav(false);
  setDialogKind(task || "new");
  $("dlg").showModal();
  $(task ? "d-prompt" : "d-title").focus();
}
$("new-task").onclick = () => openTaskDialog();
// Threads | Scheduled: two views of the same sidebar place, remembered per device
function setLane(lane, focus = false) {
  state.lane = lane;
  try {
    localStorage.setItem("ac_lane", lane);
  } catch {}
  for (const [name, tab, pane] of [
    ["threads", "lane-threads", "pane-threads"],
    ["tasks", "lane-tasks", "pane-tasks"],
    ["auto", "lane-auto", "pane-auto"],
  ]) {
    $(tab).setAttribute("aria-selected", String(lane === name));
    $(tab).tabIndex = lane === name ? 0 : -1;
    $(pane).hidden = lane !== name;
  }
  if (focus) $(`lane-${lane}`).focus();
}
$("lane-threads").onclick = () => setLane("threads");
$("lane-tasks").onclick = () => setLane("tasks");
$("lane-auto").onclick = () => setLane("auto");
$("lanes").addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const order = ["threads", "tasks", "auto"],
    at = order.indexOf(state.lane);
  setLane(
    e.key === "Home"
      ? order[0]
      : e.key === "End"
        ? order.at(-1)
        : order[(at + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length],
    true,
  );
});
setLane(state.lane);
$("new").onclick = () => {
  if (!shareResolve) return openNewDialog();
  finishShare("");
};
$("archive-toggle").onclick = () => {
  state.archiveOpen = !state.archiveOpen;
  localStorage.setItem("ac_archive_open", state.archiveOpen ? "1" : "");
  renderThreads();
};
$("reload").onclick = () => location.reload();
// sidebar More: rare console actions behind one button; each item drives the element that owns its behaviour
createMenu({
  trigger: $("side-more"),
  kind: "menu",
  label: "Console",
  align: "end",
  getItems: () => [
    { value: "new", label: "New thread", icon: "plus" },
    { value: "task", label: "New scheduled task", icon: "clock" },
    { value: "files", label: "Files", desc: "Browse ~/repos", icon: "folder" },
    {
      value: "notifications",
      label: "Notifications",
      desc: /: on$/.test($("notifications").getAttribute("aria-label") || "")
        ? "On for this device"
        : "Off",
      icon: "bell",
    },
    { value: "dashboard", label: "Usage dashboard", icon: "chart" },
    { value: "benchmarks", label: "Model benchmarks", icon: "chart" },
    { value: "automation", label: "Automation dashboard", icon: "play" },
    { value: "host", label: "Host dashboard", icon: "terminal" },
    { value: "vault", label: "Vault", desc: "API tokens, write-only", icon: "key" },
    { value: "doctor", label: "Doctor", desc: "Check and repair the setup", icon: "alert" },
    { value: "ideas", label: "App ideas", icon: "sparkle" },
    { value: "brain", label: "Brain", desc: "Search the shared memory", icon: "search" },
    { value: "reload", label: "Reload page", icon: "refresh" },
    {
      value: "restart",
      label: "Restart server…",
      desc: "Once every thread is idle",
      icon: "power",
    },
  ],
  onSelect: (v) => {
    if (v === "dashboard") location.href = $("dash-link").href;
    else if (v === "benchmarks") location.href = $("benchmarks-link").href;
    else if (v === "automation") location.href = $("auto-link").href;
    else if (v === "host") location.href = $("host-link").href;
    else if (v === "vault") location.href = $("vault-link").href;
    else if (v === "doctor") location.href = "/doctor";
    else if (v === "ideas") location.href = $("ideas-link").href;
    else if (v === "brain") location.href = $("brain-link").href;
    else if (v === "task") {
      setLane("tasks");
      openTaskDialog();
    } else (v === "new" ? $("new") : $(v)).click();
  },
});
$("restart").onclick = async () => {
  const r = await apiFetch("/restart", { method: "POST" }).catch(() => null);
  toast(
    r?.ok
      ? "Restart scheduled. It happens once every thread is idle, then this page reloads."
      : "Could not schedule a restart.",
  );
};
$("dform").addEventListener("submit", (e) => {
  if (e.submitter?.value !== "ok") {
    workflowBrief = null;
    return;
  }
  const settings = {
    provider: menus.dProv.value,
    cwd: menus.dCwd.value,
    model: menus.dModel.value,
    effort: menus.dEffort.value,
    mode: menus.dMode.value,
  };
  const account =
    settings.provider === "claude" ? { claudeAccount: menus.dAccount.value || "sunny" } : {};
  if (dialogAssignment) {
    e.preventDefault();
    return void submitPremiumAssignment(settings, account);
  }
  if (dialogFork) {
    const { cwd, ...pick } = settings;
    return void send({
      t: "fork",
      thread: dialogFork,
      ...pick,
      ...account,
      context: menus.dContext.value,
    });
  }
  if (dialogTask === null)
    return void send({
      t: "create",
      ...settings,
      ...(settings.provider === "claude" ? { claudeAccount: menus.dAccount.value || "sunny" } : {}),
    });
  send({
    t: "task_save",
    ...(dialogTask !== "new" ? { id: dialogTask.id } : {}),
    ...settings,
    title: $("d-title").value,
    prompt: $("d-prompt").value,
    repeat: menus.dRepeat.value,
    day: Number(menus.dDay.value),
    time: $("d-time").value || "09:00",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    saveOutput: $("d-save").checked,
  });
  setLane("tasks");
});

function linkedThread() {
  return new URLSearchParams(location.hash.slice(1)).get("thread");
}
addEventListener("hashchange", () => {
  const id = linkedThread();
  if (id && state.ready && state.threads.has(id)) openThread(id);
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "notification-open") return;
    let url;
    try {
      url = new URL(event.data.url, location.origin);
    } catch {
      return;
    }
    if (url.origin !== location.origin || url.pathname !== "/") return;
    const id = new URLSearchParams(url.hash.slice(1)).get("thread");
    if (id && state.ready && state.threads.has(id)) openThread(id);
    location.hash = url.hash;
  });
}
setupNotifications({ apiFetch });
clearChat();
renderHead();
for (const p of await attachmentStorage.load()) {
  attachmentOrder = Math.max(attachmentOrder, p.order || 0);
  const list = attachmentDrafts.get(p.thread) || [];
  list.push(p);
  attachmentDrafts.set(p.thread, list);
}
try {
  const recovered = Object.keys(localStorage)
    .filter((key) => key.startsWith("ac_sending:"))
    .map((key) => ({ key, draft: JSON.parse(localStorage.getItem(key)) }));
  recovered.sort(
    (a, b) => b.draft.createdAt - a.draft.createdAt || b.draft.sequence - a.draft.sequence,
  );
  for (const { key, draft } of recovered) {
    if (draft?.thread && typeof draft.text === "string" && Array.isArray(draft.attachments)) {
      const cid = key.slice("ac_sending:".length);
      if (draft.accepted) await finishSendingDraft(cid, draft);
      else await recoverSendingDraft(cid, draft);
    }
  }
} catch {
  toast("A message recovery copy could not be loaded.");
}
draftsLoaded = true;
connect();
