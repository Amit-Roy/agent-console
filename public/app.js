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
const state = { commands: [], threads: new Map(), current: null, dirs: [], modes: [], models: [], live: null, cards: new Map(), usage: null };
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
    case "commands":
      state.commands = m.commands;
      updateSlash();
      break;
    case "hello":
      state.commands = m.commands || [];
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
      if (!m.events.length) {
        const hint = emptyState();
        hint.querySelector("h2").textContent = "Ready";
        hint.querySelector("p").textContent = "Send a message to start this thread.";
        hint.querySelector("button").remove();
        $("chat").append(hint);
      }
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
    li.tabIndex = 0;
    if (t.id === state.current) li.setAttribute("aria-current", "true");
    const body = el("div");
    const title = el("div", "t", t.title);
    const meta = el("div", "meta");
    meta.append(`${t.model} · `);
    const mode = el("span", t.mode === "bypassPermissions" ? "bp" : "", t.mode === "bypassPermissions" ? "bypass" : t.mode);
    meta.append(mode, ` · $${t.cost.toFixed(3)}`);
    if (t.status === "running") meta.append(" · ", el("span", "run", "running"));
    body.append(title, meta);
    const dot = el("span", `dot ${t.status}`);
    dot.setAttribute("aria-hidden", "true");
    li.append(dot, body);
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
    ul.append(li);
  }
  if (!list.length) {
    const li = el("li", "empty-list", "No threads yet.");
    ul.append(li);
  }
}

function setNav(open) {
  document.body.classList.toggle("nav", open);
  $("menu").setAttribute("aria-expanded", String(open));
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
  $("head").dataset.status = t?.status || "";
  $("head").dataset.mode = t?.mode || "";
}

// ---------- chat rendering ----------
function emptyState() {
  const box = el("div", "empty");
  box.innerHTML = '<svg class="glyph" viewBox="0 0 64 64" aria-hidden="true"><path d="M16 20l16 12-16 12" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 46h14" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>';
  box.append(el("h2", "", "No thread selected"), el("p", "", "Start a thread to run a coding agent in one of your folders."));
  const b = el("button", "primary", "New thread");
  b.type = "button";
  b.onclick = openNewDialog;
  box.append(b);
  return box;
}
function clearChat() {
  state.live = null;
  state.cards.clear();
  $("chat").replaceChildren();
  if (!state.current) $("chat").append(emptyState());
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
  $("chat").querySelector(":scope > .empty")?.remove();
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
  const rows = [];
  for (const [label, x] of [["5-hour", w.five_hour], ["7-day", w.seven_day]]) {
    const v = x ? Math.max(0, Math.min(1, x.utilization)) : null;
    const row = el("div", v != null && v >= 0.9 ? "u hot" : "u");
    const bar = el("div", "bar");
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", `${label} subscription usage`);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    if (v != null) {
      bar.setAttribute("aria-valuenow", String(Math.round(v * 100)));
      const fill = el("i");
      fill.style.width = `${Math.round(v * 100)}%`;
      bar.append(fill);
    }
    row.append(el("span", "", label), bar, el("span", "pct", v != null ? `${Math.round(v * 100)}%` : "–"));
    rows.push(row);
  }
  $("usage").replaceChildren(...rows);
}

// ---------- controls ----------
function submit() {
  const box = $("input");
  const text = box.value.trim();
  if (!text || !state.current || cur()?.status === "running") return;
  send({ t: "send", thread: state.current, text });
  box.value = "";
  box.style.height = "";
  closeSlash();
}
$("send").onclick = submit;
$("stop").onclick = () => send({ t: "abort", thread: state.current });
// ---------- slash menu ("/" for commands and skills) ----------
const slash = { items: [], idx: 0, dismissed: false };
const slashEl = $("slash");
function slashQuery() {
  const m = /^\/([^\s]*)$/.exec($("input").value);
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
  return state.commands.filter((c) => !c.name.startsWith("_")).map((c) => [rank(c), c]).filter(([r]) => r < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, 60).map(([, c]) => c);
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
    const li = el("li", "none", state.commands.length ? "No matching commands" : "Commands load after your first message.");
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
        // typed in full: let Enter send as usual
      } else {
        e.preventDefault();
        return acceptSlash(c);
      }
    }
  }
  const desktop = matchMedia("(pointer:fine)").matches;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && desktop) {
    e.preventDefault();
    submit();
  }
});
$("input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.4) + "px";
  slash.dismissed = false;
  slash.idx = 0;
  updateSlash();
});
$("input").addEventListener("blur", () => setTimeout(closeSlash, 120));
$("model").onchange = (e) => send({ t: "update", thread: state.current, model: e.target.value });
$("mode").onchange = (e) => {
  if (e.target.value === "bypassPermissions" && !confirm("Bypass mode runs every tool without asking, including shell commands on this machine. Enable for this thread?")) {
    e.target.value = cur().mode;
    return;
  }
  send({ t: "update", thread: state.current, mode: e.target.value });
};
$("del").onclick = () => cur() && confirm(`Delete "${cur().title}" and its history?`) && send({ t: "delete", thread: state.current });
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
$("d-mode").onchange = () => ($("d-warn").hidden = $("d-mode").value !== "bypassPermissions");
$("dform").addEventListener("submit", (e) => {
  if (e.submitter?.value === "ok") send({ t: "create", cwd: $("d-cwd").value, model: $("d-model").value, mode: $("d-mode").value });
});

// Header and composer float over the chat; publish their heights so messages can scroll beneath them.
if ("ResizeObserver" in window) {
  const root = document.documentElement.style;
  new ResizeObserver(() => {
    root.setProperty("--head-h", `${$("head").offsetHeight}px`);
    root.setProperty("--comp-h", `${$("composer").offsetHeight}px`);
  }).observe($("head"));
  new ResizeObserver(() => root.setProperty("--comp-h", `${$("composer").offsetHeight}px`)).observe($("composer"));
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
clearChat();
connect();
