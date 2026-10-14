import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

DOMPurify.addHook("afterSanitizeAttributes", (n) => {
  if (n.tagName === "A") {
    n.setAttribute("target", "_blank");
    n.setAttribute("rel", "noopener noreferrer");
  }
});
const md = (s) => DOMPurify.sanitize(marked.parse(s, { gfm: true, breaks: false }));
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const MODE_LABEL = { plan: "Plan (read-only)", acceptEdits: "Accept edits", bypassPermissions: "⚠ Bypass permissions" };
const state = { threads: new Map(), current: null, dirs: [], modes: [], models: [], live: null, cards: new Map(), usage: null };
let ws, retry = 0;

// ---------- connection ----------
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    banner("");
  };
  ws.onclose = () => {
    banner("Disconnected. Reconnecting…");
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
  };
  ws.onmessage = (m) => handle(JSON.parse(m.data));
}
const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
function banner(t) {
  const b = $("banner");
  b.hidden = !t;
  b.textContent = t;
}

function handle(m) {
  switch (m.t) {
    case "hello":
      state.dirs = m.dirs;
      state.modes = m.modes;
      state.models = m.models;
      state.threads = new Map(m.threads.map((t) => [t.id, t]));
      fillSelect($("model"), m.models, (x) => x);
      fillSelect($("mode"), m.modes, (x) => MODE_LABEL[x] || x);
      fillSelect($("d-cwd"), m.dirs, (x) => x.replace(/^.*\/repos\/?/, "~/repos/") || x);
      fillSelect($("d-model"), m.models, (x) => x);
      fillSelect($("d-mode"), m.modes, (x) => MODE_LABEL[x]);
      $("d-mode").value = "acceptEdits";
      renderThreads();
      if (state.current && state.threads.has(state.current)) openThread(state.current);
      else if (state.threads.size) openThread([...state.threads.values()][0].id);
      break;
    case "thread":
      state.threads.set(m.thread.id, m.thread);
      renderThreads();
      if (m.thread.id === state.current) renderHead();
      break;
    case "removed":
      state.threads.delete(m.thread);
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
      if (m.thread !== state.current) break;
      clearChat();
      for (const e of m.events) onEvent(e, false);
      scrollDown(true);
      break;
    case "event":
      if (m.event.type === "rate_limit_event") setUsage(m.event);
      if (m.thread === state.current) onEvent(m.event, true);
      break;
    case "error":
      addNote(m.message, "errtxt");
      break;
  }
}

// ---------- threads UI ----------
function fillSelect(sel, items, label) {
  sel.replaceChildren(...items.map((v) => Object.assign(el("option", "", label(v)), { value: v })));
}
const cur = () => state.threads.get(state.current);

function renderThreads() {
  const ul = $("threads");
  ul.replaceChildren();
  const list = [...state.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of list) {
    const li = el("li", t.id === state.current ? "sel" : "");
    const body = el("div");
    const title = el("div", "t", t.title);
    const meta = el("div", "meta");
    meta.append(`${t.model} · `);
    const mode = el("span", t.mode === "bypassPermissions" ? "bp" : "", t.mode === "bypassPermissions" ? "bypass" : t.mode);
    meta.append(mode, ` · $${t.cost.toFixed(3)}`);
    body.append(title, meta);
    li.append(el("span", `dot ${t.status}`), body);
    li.onclick = () => {
      document.body.classList.remove("nav");
      openThread(t.id);
    };
    ul.append(li);
  }
}

function openThread(id) {
  state.current = id;
  try { localStorage.setItem("ac_thread", id); } catch {}
  renderThreads();
  renderHead();
  clearChat();
  send({ t: "open", thread: id });
}

function renderHead() {
  const t = cur();
  $("ttl").textContent = t ? t.title : "No thread";
  $("cwd").textContent = t ? t.cwd : "";
  if (t) {
    $("model").value = t.model;
    $("mode").value = t.mode;
  }
  const running = t?.status === "running";
  for (const id of ["model", "mode"]) $(id).disabled = !t || running;
  $("del").disabled = !t;
  $("input").disabled = !t;
  $("send").disabled = !t || running;
  $("send").hidden = running;
  $("stop").hidden = !running;
  $("mode").style.color = t?.mode === "bypassPermissions" ? "var(--bad)" : "";
}

// ---------- chat rendering ----------
function clearChat() {
  state.live = null;
  state.cards.clear();
  $("chat").replaceChildren();
}
function nearBottom() {
  const c = $("chat");
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}
function scrollDown(force) {
  const c = $("chat");
  if (force || nearBottom()) c.scrollTop = c.scrollHeight;
}
function push(node, live) {
  const stick = nearBottom();
  $("chat").append(node);
  if (live === false || stick) scrollDown(true);
}
function addNote(text, cls = "note") {
  push(el("div", `msg ${cls}`, text));
}

function summarize(name, input) {
  input = input || {};
  return input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || JSON.stringify(input).slice(0, 120);
}

function toolBody(name, input) {
  const box = el("div", "body");
  input = input || {};
  if (name === "Edit" && "old_string" in input) {
    const pre = el("pre", "diff");
    for (const l of String(input.old_string).split("\n")) pre.append(el("div", "del", "- " + l));
    for (const l of String(input.new_string).split("\n")) pre.append(el("div", "add", "+ " + l));
    box.append(pre);
  } else if (name === "Write" && "content" in input) {
    box.append(el("pre", "", String(input.content).slice(0, 4000)));
  } else if (name === "Bash" && input.command) {
    box.append(el("pre", "", "$ " + input.command));
  } else {
    box.append(el("pre", "", JSON.stringify(input, null, 2)));
  }
  return box;
}

function renderLive(kind) {
  if (!state.live) state.live = {};
  const L = state.live;
  if (!L[kind + "El"]) {
    L[kind + "El"] = el("div", kind === "text" ? "msg asst" : "msg think");
    L[kind] = "";
    push(L[kind + "El"]);
  }
  if (L.raf) return;
  L.raf = requestAnimationFrame(() => {
    L.raf = 0;
    const stick = nearBottom();
    if (L.textEl) L.textEl.innerHTML = md(L.text || "");
    if (L.thinkingEl) L.thinkingEl.textContent = "Thinking… " + (L.thinking || "").slice(-200);
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

function onEvent(e, live) {
  switch (e.type) {
    case "user_input":
      push(el("div", "msg user", e.text), live);
      break;
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
          const d = el("div", "msg asst");
          d.innerHTML = md(b.text);
          push(d, live);
        } else if (b.type === "thinking" && b.thinking?.trim()) {
          dropLive("thinking");
          const det = el("details", "msg think");
          det.append(el("summary", "", "Thinking"), el("pre", "", b.thinking));
          push(det, live);
        } else if (b.type === "tool_use") {
          dropLive("text");
          dropLive("thinking");
          const card = el("details", "msg card pending");
          const sum = el("summary");
          sum.append(el("span", "name", b.name), el("span", "sum", summarize(b.name, b.input)), el("span", "st"));
          card.append(sum, toolBody(b.name, b.input));
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
        const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n");
        if (text) card.querySelector(".body").append(el("pre", "", text.slice(0, 8000)));
      }
      break;
    case "result": {
      dropLive("text");
      dropLive("thinking");
      state.live = null;
      const bits = [];
      if (e.duration_ms) bits.push(`${(e.duration_ms / 1000).toFixed(1)}s`);
      if (typeof e.total_cost_usd === "number") bits.push(`$${e.total_cost_usd.toFixed(4)}`);
      if (e.is_error || (e.subtype && e.subtype !== "success")) bits.push(e.subtype || "error");
      push(el("div", "msg foot", bits.join(" · ")), live);
      break;
    }
    case "aborted":
      state.live = null;
      push(el("div", "msg note", "Stopped."), live);
      break;
    case "console_error":
      push(el("div", "msg errtxt", e.text), live);
      break;
    case "rate_limit_event":
      setUsage(e);
      break;
  }
}

function setUsage(e) {
  const w = e.rate_limit_info?.unifiedWindows;
  if (!w) return;
  const pct = (x) => (x ? `${Math.round(x.utilization * 100)}%` : "–");
  $("usage").textContent = `Subscription: 5h ${pct(w.five_hour)} · 7d ${pct(w.seven_day)}`;
}

// ---------- controls ----------
function submit() {
  const box = $("input");
  const text = box.value.trim();
  if (!text || !state.current || cur()?.status === "running") return;
  send({ t: "send", thread: state.current, text });
  box.value = "";
  box.style.height = "";
}
$("send").onclick = submit;
$("stop").onclick = () => send({ t: "abort", thread: state.current });
$("input").addEventListener("keydown", (e) => {
  const desktop = matchMedia("(pointer:fine)").matches;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && desktop) {
    e.preventDefault();
    submit();
  }
});
$("input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.4) + "px";
});
$("model").onchange = (e) => send({ t: "update", thread: state.current, model: e.target.value });
$("mode").onchange = (e) => {
  if (e.target.value === "bypassPermissions" && !confirm("Bypass mode runs every tool without asking, including shell commands on this machine. Enable for this thread?")) {
    e.target.value = cur().mode;
    return;
  }
  send({ t: "update", thread: state.current, mode: e.target.value });
};
$("del").onclick = () => cur() && confirm(`Delete "${cur().title}" and its history?`) && send({ t: "delete", thread: state.current });
$("menu").onclick = () => document.body.classList.toggle("nav");
$("scrim").onclick = () => document.body.classList.remove("nav");
$("new").onclick = () => {
  document.body.classList.remove("nav");
  $("dlg").showModal();
};
$("d-mode").onchange = () => ($("d-warn").hidden = $("d-mode").value !== "bypassPermissions");
$("dform").addEventListener("submit", (e) => {
  if (e.submitter?.value === "ok") send({ t: "create", cwd: $("d-cwd").value, model: $("d-model").value, mode: $("d-mode").value });
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
connect();
