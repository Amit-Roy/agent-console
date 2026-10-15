import { $, el, icon, iconButton, wireCopy, renderMarkdown, highlightInto, langFromPath } from "/render.js";
import { createMenu } from "/menu.js";

const MODE_META = {
  plan: { label: "Plan", desc: "Read-only. Plans without editing.", icon: "eye" },
  acceptEdits: { label: "Accept edits", desc: "Edits files without asking.", icon: "pencil" },
  bypassPermissions: { label: "Bypass", desc: "Runs every tool without asking.", icon: "shield-off", tone: "warn" },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const state = { commands: {}, providers: new Map(), threads: new Map(), current: null, dirs: [], live: null, cards: new Map(), usage: null };
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
      state.commands[m.provider] = m.commands;
      updateSlash();
      break;
    case "hello":
      state.commands = m.commands || {};
      state.dirs = m.dirs;
      state.providers = new Map(m.providers.map((p) => [p.id, p]));
      menus.model.provider = null; // re-read per-agent model lists below
      state.threads = new Map(m.threads.map((t) => [t.id, t]));
      menus.dProv.setItems(m.providers.map((p) => ({ value: p.id, label: p.label, desc: p.ok ? undefined : p.hint, disabled: !p.ok })), m.providers.find((p) => p.ok)?.id);
      menus.dCwd.setItems(m.dirs.map((d) => ({ value: d, label: d.replace(/^.*\/repos\/?/, "~/repos/") || d, icon: "folder" })), m.dirs[0]);
      fillDialog(menus.dProv.value);
      renderThreads();
      if (state.current && state.threads.has(state.current)) openThread(state.current);
      else if (state.threads.size) openThread([...state.threads.values()][0].id);
      else renderHead();
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

// ---------- menus (model + mode chips in the composer, thread actions, new-thread fields) ----------
// "openrouter/nvidia/nemotron-3-super-120b-a12b:free" -> label "nemotron-3-super-120b-a12b", desc "openrouter · nvidia · free"
function modelMeta(v) {
  if (!v.includes("/")) return { label: v === "default" ? "Default" : cap(v) };
  const [prov, ...rest] = v.split("/");
  const id = rest.pop();
  const free = id.endsWith(":free");
  return { label: id.replace(/:free$/, ""), desc: [prov, rest.join("/"), free && "free"].filter(Boolean).join(" · ") };
}
const modelItems = (models) => models.map((v) => ({ value: v, ...modelMeta(v) }));
const prov = (id) => state.providers.get(id);
const provLabel = (id) => prov(id)?.label || id || "";
function fillDialog(id) {
  const p = prov(id);
  if (!p) return;
  menus.dModel.setItems(modelItems(p.models), p.defaultModel);
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
    kids.push(el("span", "", it?.label ?? ""), icon("chev-down", "chev"));
    b.replaceChildren(...kids);
    if (kind === "mode") {
      if (it?.tone) b.dataset.tone = it.tone;
      else delete b.dataset.tone;
    }
    b.setAttribute("aria-label", `${kind === "mode" ? "Permission mode" : "Model"}: ${it?.label ?? ""}`);
  };
}
function fieldTrigger(it, b) {
  b.replaceChildren(el("span", "", it?.label ?? ""), icon("chev-down", "chev"));
}
const menus = {
  model: createMenu({ trigger: $("model"), label: "Model", side: "top", renderTrigger: chipTrigger("model"), onSelect: (v) => send({ t: "update", thread: state.current, model: v }) }),
  mode: createMenu({
    trigger: $("mode"), label: "Permission mode", side: "top", renderTrigger: chipTrigger("mode"),
    onSelect: (v) => {
      if (v === "bypassPermissions" && !confirm("Bypass mode runs every tool without asking, including shell commands on this machine. Enable for this thread?")) return false;
      send({ t: "update", thread: state.current, mode: v });
    },
  }),
  more: createMenu({
    trigger: $("more"), kind: "menu", label: "Thread actions", align: "end",
    items: [{ value: "rename", label: "Rename", icon: "pencil" }, { value: "delete", label: "Delete thread", icon: "trash", tone: "danger" }],
    onSelect: (v) => {
      if (v === "rename") startRename();
      else if (v === "delete" && cur() && confirm(`Delete "${cur().title}" and its history?`)) send({ t: "delete", thread: state.current });
    },
  }),
  dProv: createMenu({ trigger: $("d-prov"), label: "Agent", renderTrigger: fieldTrigger, onSelect: (v) => fillDialog(v) }),
  dCwd: createMenu({ trigger: $("d-cwd"), label: "Folder", renderTrigger: fieldTrigger }),
  dModel: createMenu({ trigger: $("d-model"), label: "Model", renderTrigger: fieldTrigger }),
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

function renderThreads() {
  const ul = $("threads");
  ul.replaceChildren();
  const list = [...state.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of list) {
    const li = el("li", t.id === state.current ? "sel" : "");
    li.tabIndex = 0;
    li.title = `${t.title}\n${t.cwd}\n${provLabel(t.provider)} · ${modelMeta(t.model).label} · $${t.cost.toFixed(3)}`;
    if (t.id === state.current) li.setAttribute("aria-current", "true");
    const dot = el("span", `dot ${t.status}`);
    dot.setAttribute("aria-hidden", "true");
    const meta = el("div", "meta");
    meta.append(el("span", "dir", base(t.cwd)));
    const time = el("time", "", ago(t.updatedAt));
    time.dateTime = new Date(t.updatedAt).toISOString();
    meta.append(time);
    if (t.provider && t.provider !== "claude") meta.append(el("span", "tag", provLabel(t.provider)));
    if (t.mode === "bypassPermissions") {
      const tag = el("span", "tag warn");
      tag.append(icon("shield-off"), "Bypass");
      meta.append(tag);
    }
    li.append(el("div", "t", t.title), dot, meta);
    if (t.status === "running") li.append(el("span", "sr-only", "Running"));
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
  if (!list.length) ul.append(el("li", "empty-list", "No threads yet."));
}
setInterval(() => state.threads.size && renderThreads(), 30000);

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
  if (!$("ttl-edit")) $("ttl").textContent = t ? t.title : "No thread";
  $("cwd").hidden = !t;
  $("cwd-t").textContent = t ? t.cwd.replace(/^\/home\/[^/]+/, "~") : "";
  $("cwd").title = t ? t.cwd : "";
  if (t) {
    const p = prov(t.provider);
    if (p && menus.model.provider !== t.provider) {
      menus.model.provider = t.provider; // models and modes differ per agent
      menus.model.setItems(modelItems(p.models));
      menus.mode.setItems(modeItems(p.modes));
    }
    menus.model.setValue(t.model);
    menus.mode.setValue(t.mode);
  }
  const running = t?.status === "running";
  menus.model.setDisabled(!t || running);
  menus.mode.setDisabled(!t || running);
  $("more").disabled = !t;
  $("state").hidden = !running;
  $("input").disabled = !t;
  $("send").disabled = !t || running;
  $("send").hidden = running;
  $("stop").hidden = !running;
  $("head").dataset.status = t?.status || "";
  $("head").dataset.mode = t?.mode || "";
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
  if (cls === "errtxt") return push(errBlock(text));
  push(el("div", `msg ${cls}`, text));
}
function errBlock(text) {
  const d = el("div", "msg errtxt");
  d.append(icon("alert"), el("span", "", text));
  return d;
}

function summarize(name, input) {
  input = input || {};
  return input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || JSON.stringify(input).slice(0, 120);
}
const TOOL_ICON = { Bash: "terminal", Edit: "pencil", MultiEdit: "pencil", NotebookEdit: "pencil", Write: "file", Read: "file", Grep: "search", Glob: "search", WebFetch: "globe", WebSearch: "globe", Task: "sparkle", Agent: "sparkle" };

function codePre(text, lang) {
  const pre = el("pre");
  const code = el("code");
  highlightInto(code, text, lang);
  pre.append(code);
  return pre;
}
function toolBody(name, input) {
  const box = el("div", "body");
  input = input || {};
  if (name === "Edit" && "old_string" in input) {
    const pre = el("pre", "diff");
    for (const l of String(input.old_string).split("\n")) pre.append(el("div", "del", l));
    for (const l of String(input.new_string).split("\n")) pre.append(el("div", "add", l));
    box.append(pre);
  } else if (name === "Write" && "content" in input) {
    box.append(codePre(String(input.content).slice(0, 4000), langFromPath(input.file_path)));
  } else if (name === "Bash" && input.command) {
    box.append(codePre(String(input.command), "bash"));
  } else {
    box.append(codePre(JSON.stringify(input, null, 2), "json"));
  }
  return box;
}

function copyActions(getText, label = "Copy message") {
  const row = el("div", "actions");
  const b = iconButton("copy", label);
  wireCopy(b, getText, label);
  row.append(b);
  return row;
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
    const stick = nearBottom();
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

function onEvent(e, live) {
  switch (e.type) {
    case "user_input": {
      if (e.auto === "brain") {
        push(el("div", "msg note", "Reminder sent: save anything durable to the shared brain."), live);
        break;
      }
      const d = el("div", "msg user");
      d.append(el("div", "bubble", e.text), copyActions(() => e.text));
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
          const card = el("details", "msg card pending");
          const sum = el("summary");
          const tool = icon(TOOL_ICON[b.name] || "code", "tool");
          const st = el("span", "st");
          st.append(el("i", "spin"), el("span", "sr-only", "running"));
          sum.append(tool, el("span", "name", b.name), el("span", "sum", summarize(b.name, b.input)), st, icon("chev-right", "chev"));
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
        const st = card.querySelector(".st");
        st.replaceChildren(icon(c.is_error ? "x" : "check"), el("span", "sr-only", c.is_error ? "error" : "done"));
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
      const last = $("chat").lastElementChild;
      const row = last?.matches(".msg.asst") ? last.querySelector(".actions") : null;
      if (row) row.append(el("span", "foot", bits.join(" · "))); // stats sit on the reply's action row
      else push(el("div", "msg foot", bits.join(" · ")), live);
      break;
    }
    case "aborted":
      state.live = null;
      push(el("div", "msg note", "Stopped."), live);
      break;
    case "console_error":
      push(errBlock(e.text), live);
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
$("dform").addEventListener("submit", (e) => {
  if (e.submitter?.value === "ok") send({ t: "create", provider: menus.dProv.value, cwd: menus.dCwd.value, model: menus.dModel.value, mode: menus.dMode.value });
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
clearChat();
renderHead();
connect();
