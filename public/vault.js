// Vault page: write-only API token management. Renders from /api/vault; the server never returns a stored value.
// Value-changing calls need a passkey grant: a 401 {stepUp:true} runs a passkey assertion and retries once.
// Listeners via addEventListener only: module-scoped functions are not reachable from inline onclick.
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const state = { groups: [], pk: { enrolled: 0, passkeys: [] }, restart: false };
let toastTimer;
function toast(text, tone) {
  const t = $("toast");
  t.textContent = text; t.className = `show ${tone || ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ""; }, 3500);
}
const ago = ms => {
  const s = (Date.now() - ms) / 1000;
  if (!Number.isFinite(s) || !ms) return "";
  if (s < 90) return "just now";
  const m = s / 60; if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const day = iso => { const d = new Date(iso); return Number.isNaN(+d) ? "never" : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); };

class StepUp extends Error {}
async function call(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
const fail = r => Object.assign(new Error(r.j.error || `HTTP ${r.status}`), { res: r });

/* passkey assertion -> 5 minute write grant */
async function stepUp(setWait) {
  const o = await call("POST", "/api/vault/stepup/options");
  if (!o.ok) throw fail(o);
  setWait(true);
  try {
    const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o.j.options });
    const v = await call("POST", "/api/vault/stepup/verify", { cid: o.j.cid, response });
    if (!v.ok) throw fail(v);
  } finally { setWait(false); }
}
/* a write: try, and on 401 prompt the passkey once and retry */
async function write(method, path, body, setWait = () => {}) {
  let r = await call(method, path, body);
  if (r.status === 401 && r.j.stepUp) {
    if (!r.j.enrolled) { openEnroll(); throw new Error("Set up a passkey first."); }
    try { await stepUp(setWait); }
    catch (e) { throw e.name === "NotAllowedError" ? new Error("Passkey cancelled.") : e; }
    r = await call(method, path, body);
  }
  if (!r.ok) throw fail(r);
  return r.j;
}

/* ---------- render ---------- */
const lockIcon = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M4.5 7.25h7v5.5h-7zM6 7.25V5.5a2 2 0 0 1 4 0v1.75");
  s.append(p); return s;
};
function btn(label, cls, fn, aria) {
  const b = el("button", `btn sm ${cls}`, label); b.type = "button";
  if (aria) b.setAttribute("aria-label", aria);
  b.addEventListener("click", fn);
  return b;
}
function row(g, e) {
  const r = el("div", "hrow vrow");
  const n = el("div", "hname");
  const bits = [];
  if (e.length != null) bits.push(e.hint ? `•••• ${e.hint}` : `${e.length} chars`);
  if (e.mtime) bits.push(`updated ${ago(e.mtime)}`);
  const ctx = el("span", "hctx", bits.join(" · "));
  if (!e.viewable) {
    const l = el("span", "lockt"); l.append(lockIcon(), document.createTextNode("write-only"));
    ctx.append(bits.length ? " · " : "", l);
  }
  n.append(el("b", "", e.key), ctx);
  const act = el("div", "vact");
  if (e.viewable) act.append(btn("Reveal", "", () => reveal(g, e, r, n), `Reveal ${e.key}`));
  else if (e.editable) {
    act.append(btn("Replace", "", () => openEdit(g, e), `Replace ${e.key}`), btn("Delete", "danger", () => openDelete(g, e), `Delete ${e.key}`));
  }
  r.append(n, act);
  return r;
}
function renderGroups() {
  const box = $("groups"); box.replaceChildren();
  for (const g of state.groups) {
    const p = el("section", "panel vgroup"); p.setAttribute("aria-label", g.label);
    const head = el("div", "head"); head.append(el("h2", "", g.label));
    if (g.canAdd) head.append(btn("Add key", "", () => openEdit(g, null), `Add key to ${g.label}`));
    p.append(head);
    if (g.error) p.append(el("p", "gerr", g.error));
    if (!g.entries.length && !g.error) p.append(el("p", "gempty", "No keys yet."));
    const rows = el("div", "rows");
    for (const e of g.entries) rows.append(row(g, e));
    p.append(rows);
    box.append(p);
  }
}
function renderPasskeys() {
  const { enrolled, passkeys } = state.pk;
  $("pk-add").textContent = enrolled ? "Add passkey" : "Set up passkey";
  $("pk-note").textContent = enrolled ? "" : "No passkey yet. Changing a key needs one. Setup needs the one-time code from the server log.";
  const rows = $("pk-rows"); rows.replaceChildren();
  for (const k of passkeys) {
    const r = el("div", "hrow prow");
    const n = el("div", "hname");
    n.append(el("b", "", k.name), el("span", "hctx", `added ${day(k.createdAt)} · last used ${k.lastUsedAt ? day(k.lastUsedAt) : "never"}`));
    const act = el("div", "vact"); act.append(btn("Remove", "danger", () => removePasskey(k), `Remove passkey ${k.name}`));
    r.append(n, act); rows.append(r);
  }
}
function showRestart() { $("restart-note").hidden = !state.restart; }

async function load() {
  try {
    const [v, p] = await Promise.all([call("GET", "/api/vault"), call("GET", "/api/vault/passkeys")]);
    if (!v.ok) throw fail(v);
    state.groups = v.j.sources || [];
    if (p.ok) state.pk = { enrolled: p.j.enrolled, passkeys: p.j.passkeys || [] };
    $("vmsg").hidden = true;
  } catch (e) {
    $("vmsg").textContent = `Could not load the vault: ${e.message}`; $("vmsg").className = "vmsg bad"; $("vmsg").hidden = false;
  }
  $("hm").removeAttribute("aria-busy");
  renderGroups(); renderPasskeys(); showRestart();
}

/* ---------- reveal (shown only for rows the server marks viewable) ---------- */
async function reveal(g, e, r, n) {
  const old = r.querySelector(".shown"); if (old) { old.remove(); return; }
  const res = await call("POST", `/api/vault/${encodeURIComponent(g.id)}/${encodeURIComponent(e.key)}/reveal`);
  if (!res.ok) return toast(res.j.error || "Could not show that value.", "bad");
  const s = el("div", "shown", res.j.value);
  n.append(s);
  setTimeout(() => s.remove(), 30000);
}

/* ---------- add / replace ---------- */
let cur = null;
const edit = $("edit"), value = $("value");
function closeEdit() { value.value = ""; value.type = "password"; $("reveal").textContent = "Show"; $("reveal").setAttribute("aria-pressed", "false"); edit.close(); }
function openEdit(g, e) {
  cur = { g, e };
  $("edit-title").textContent = e ? `Replace ${e.key}` : "Add key";
  $("edit-sub").textContent = g.label;
  $("name-wrap").hidden = !!e;
  $("name").value = "";
  value.value = ""; $("edit-err").hidden = true; $("edit-wait").hidden = true; $("edit-save").disabled = false;
  edit.showModal();
  (e ? value : $("name")).focus();
}
$("name").addEventListener("input", ev => { ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"); });
$("reveal").addEventListener("click", () => {
  const show = value.type === "password";
  value.type = show ? "text" : "password";
  $("reveal").textContent = show ? "Hide" : "Show";
  $("reveal").setAttribute("aria-pressed", String(show));
});
$("edit-cancel").addEventListener("click", closeEdit);
edit.addEventListener("cancel", () => { value.value = ""; });
$("edit-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const key = cur.e ? cur.e.key : $("name").value.trim();
  const err = $("edit-err"); err.hidden = true;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) { err.textContent = "Key names use capital letters, digits and underscores."; err.hidden = false; return; }
  $("edit-save").disabled = true;
  try {
    const j = await write("PUT", `/api/vault/${encodeURIComponent(cur.g.id)}/${encodeURIComponent(key)}`, { value: value.value }, w => { $("edit-wait").hidden = !w; });
    closeEdit();
    if (j.restartNeeded) state.restart = true;
    toast(`${key} saved.${j.restartNeeded ? " Restart agent-console to apply." : ""}`, "ok");
    await load();
  } catch (e) {
    err.textContent = e.message; err.hidden = false; $("edit-save").disabled = false;
  }
});

/* ---------- delete: confirm by typing the key name ---------- */
let del = null;
function openDelete(g, e) {
  del = { g, e };
  $("del-title").textContent = `Delete ${e.key}`;
  $("del-sub").textContent = `${g.label}. This cannot be undone.`;
  $("del-prompt").textContent = `Type ${e.key} to confirm`;
  $("del-name").value = ""; $("del-go").disabled = true; $("del-err").hidden = true; $("del-wait").hidden = true;
  $("del").showModal();
  $("del-name").focus();
}
$("del-name").addEventListener("input", () => { $("del-go").disabled = $("del-name").value.trim() !== del.e.key; });
$("del-cancel").addEventListener("click", () => $("del").close());
$("del-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  if ($("del-name").value.trim() !== del.e.key) return;
  $("del-go").disabled = true; $("del-err").hidden = true;
  try {
    const j = await write("DELETE", `/api/vault/${encodeURIComponent(del.g.id)}/${encodeURIComponent(del.e.key)}`, undefined, w => { $("del-wait").hidden = !w; });
    $("del").close();
    if (j.restartNeeded) state.restart = true;
    toast(`${del.e.key} deleted.${j.restartNeeded ? " Restart agent-console to apply." : ""}`, "ok");
    await load();
  } catch (e) {
    $("del-err").textContent = e.message; $("del-err").hidden = false; $("del-go").disabled = false;
  }
});

/* ---------- passkeys ---------- */
const enroll = $("enroll");
function openEnroll() {
  const first = !state.pk.enrolled;
  $("enroll-sub").textContent = first
    ? "Type the one-time code the server printed to its log (or wrote to vault-enroll-code), then confirm with your fingerprint or face."
    : "Confirm with an existing passkey, then register another one.";
  $("code-wrap").hidden = !first;
  $("code").value = ""; $("pk-name").value = ""; $("enroll-err").hidden = true; $("enroll-wait").hidden = true; $("enroll-go").disabled = false;
  enroll.showModal();
  (first ? $("code") : $("pk-name")).focus();
}
$("pk-add").addEventListener("click", openEnroll);
$("enroll-cancel").addEventListener("click", () => enroll.close());
$("enroll-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const err = $("enroll-err"); err.hidden = true; $("enroll-go").disabled = true;
  const wait = w => { $("enroll-wait").hidden = !w; };
  try {
    const first = !state.pk.enrolled;
    const body = first ? { code: $("code").value.trim() } : {};
    let r = await call("POST", "/api/vault/passkeys/register/options", body);
    if (r.status === 401 && r.j.stepUp) { await stepUp(wait); r = await call("POST", "/api/vault/passkeys/register/options", body); }
    if (!r.ok) throw fail(r);
    wait(true);
    let response;
    try { response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: r.j.options }); }
    finally { wait(false); }
    const v = await call("POST", "/api/vault/passkeys/register/verify", { cid: r.j.cid, response, name: $("pk-name").value });
    if (!v.ok) throw fail(v);
    enroll.close();
    toast("Passkey added.", "ok");
    await load();
  } catch (e) {
    err.textContent = e.name === "NotAllowedError" ? "Passkey cancelled." : e.message; err.hidden = false; $("enroll-go").disabled = false;
  }
});
async function removePasskey(k) {
  if (!confirm(`Remove passkey "${k.name}"?`)) return;
  try { await write("DELETE", `/api/vault/passkeys/${encodeURIComponent(k.id)}`); toast("Passkey removed.", "ok"); await load(); }
  catch (e) { toast(e.message, "bad"); }
}

$("refresh").addEventListener("click", () => { void load(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void load(); });
await load();
