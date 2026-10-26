// Vault page: write-only API token management. Renders from /api/vault; the server never returns a stored value.
// Value-changing calls need a passkey grant: a 401 {stepUp:true} runs a passkey assertion and retries once.
// Listeners via addEventListener only: module-scoped functions are not reachable from inline onclick.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const state = { backup: null, groups: [], pk: { known: false, enrolled: 0, passkeys: [] }, restart: false };
const SECRETISH = /(KEY|TOKEN|SECRET|PASS|AUTH|CRED|PRIVATE|DSN|URL)/i;
let toastTimer;
function toast(text, tone) {
  const t = $("toast");
  t.textContent = text;
  t.className = `show ${tone || ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = "";
  }, 3500);
}
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (!Number.isFinite(s) || !ms) return "";
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d)
    ? "never"
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
};

class StepUp extends Error {}
async function call(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
const fail = (r) => Object.assign(new Error(r.j.error || `HTTP ${r.status}`), { res: r });

/* passkey assertion -> 5 minute write grant */
async function stepUp(setWait) {
  const o = await call("POST", "/api/vault/stepup/options");
  if (!o.ok) throw fail(o);
  setWait(true);
  try {
    const response = await window.SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: o.j.options,
    });
    const v = await call("POST", "/api/vault/stepup/verify", { cid: o.j.cid, response });
    if (!v.ok) throw fail(v);
  } finally {
    setWait(false);
  }
}
/* a write: try, and on 401 prompt the passkey once and retry */
async function write(method, path, body, setWait = () => {}) {
  let r = await call(method, path, body);
  if (r.status === 401 && r.j.stepUp) {
    if (!r.j.enrolled) {
      openEnroll();
      throw new Error("Set up a passkey first.");
    }
    try {
      await stepUp(setWait);
    } catch (e) {
      throw e.name === "NotAllowedError" ? new Error("Passkey cancelled.") : e;
    }
    r = await call(method, path, body);
  }
  if (!r.ok) throw fail(r);
  return r.j;
}

/* ---------- render ---------- */
const lockIcon = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M4.5 7.25h7v5.5h-7zM6 7.25V5.5a2 2 0 0 1 4 0v1.75");
  s.append(p);
  return s;
};
function btn(label, cls, fn, aria) {
  const b = el("button", `btn sm ${cls}`, label);
  b.type = "button";
  if (aria) b.setAttribute("aria-label", aria);
  b.addEventListener("click", fn);
  return b;
}
const PROXY_BADGE = {
  proxied: ["Proxied", "ok"],
  "real-key": ["Real key on disk", "bad"],
  unproxied: ["Not proxied", "off"],
};
function renderBackup() {
  const info = state.backup;
  const box = $("backup");
  box.hidden = !info || !info.state;
  if (box.hidden) return;
  const text = {
    ok: `Backup ok · ${ago(info.at) || "just now"}`,
    pending: "Backup pending",
    running: "Backup running",
    failed: info.error === "failed: drive" ? "Backup failed: drive" : "Backup failed",
  }[info.state];
  const label = el("span", `bk-${info.state}`, text);
  box.replaceChildren(label);
  if (info.state === "failed") box.append(btn("Retry", "", retryBackup, "Retry backup"));
}
async function retryBackup() {
  try {
    const reply = await write("POST", "/api/vault/backup/retry");
    state.backup = reply.backup;
    renderBackup();
  } catch (err) {
    toast(err.message, "bad");
  }
}
function row(g, e) {
  const r = el("div", "hrow vrow");
  const n = el("div", "hname");
  const bits = [];
  if (e.length != null) bits.push(e.hint ? `•••• ${e.hint}` : `${e.length} chars`);
  if (e.mtime) bits.push(`updated ${ago(e.mtime)}`);
  const ctx = el("span", "hctx", bits.join(" · "));
  if (!e.viewable) {
    const l = el("span", "lockt");
    l.append(lockIcon(), document.createTextNode("write-only"));
    ctx.append(bits.length ? " · " : "", l);
  }
  n.append(el("b", "", e.key), ctx);
  const badge = PROXY_BADGE[e.proxy];
  if (badge) n.querySelector("b").after(el("span", `pbadge ${badge[1]}`, badge[0]));
  // owner-only hint: the server sends `mine` only to a client holding a passkey grant
  if (e.mine === false) {
    const m = el("span", "hmark", "not live");
    m.title = "Only you see this marker";
    n.querySelector("b").after(m);
  }
  const act = el("div", "vact");
  if (e.viewable) act.append(btn("Reveal", "", () => reveal(g, e, r, n), `Reveal ${e.key}`));
  if (e.editable) {
    act.append(
      btn("Replace", "", () => openEdit(g, e), `Replace ${e.key}`),
      btn("Delete", "danger", () => openDelete(g, e), `Delete ${e.key}`),
    );
  }
  r.append(n, act);
  return r;
}
function renderGroups() {
  const box = $("groups");
  box.replaceChildren();
  for (const g of state.groups) {
    const p = el("section", "panel vgroup");
    p.setAttribute("aria-label", g.label);
    const head = el("div", "head");
    head.append(el("h2", "", g.label));
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
  $("pk-banner").hidden = !state.pk.known || enrolled > 0;
  $("passkeys").hidden = !enrolled;
  const rows = $("pk-rows");
  rows.replaceChildren();
  for (const k of passkeys) {
    const r = el("div", "hrow prow");
    const n = el("div", "hname");
    n.append(
      el("b", "", k.name),
      el(
        "span",
        "hctx",
        `added ${day(k.createdAt)} · last used ${k.lastUsedAt ? day(k.lastUsedAt) : "never"}`,
      ),
    );
    const act = el("div", "vact");
    act.append(btn("Remove", "danger", () => removePasskey(k), `Remove passkey ${k.name}`));
    r.append(n, act);
    rows.append(r);
  }
}
function showRestart() {
  $("restart-note").hidden = !state.restart;
}

async function load() {
  try {
    const [v, p] = await Promise.all([
      call("GET", "/api/vault"),
      call("GET", "/api/vault/passkeys"),
    ]);
    if (!v.ok) throw fail(v);
    state.groups = v.j.sources || [];
    state.backup = v.j.backup || null;
    if (p.ok) state.pk = { known: true, enrolled: p.j.enrolled, passkeys: p.j.passkeys || [] };
    $("vmsg").hidden = true;
  } catch (e) {
    $("vmsg").textContent = `Could not load the vault: ${e.message}`;
    $("vmsg").className = "vmsg bad";
    $("vmsg").hidden = false;
  }
  $("hm").removeAttribute("aria-busy");
  renderBackup();
  renderGroups();
  renderPasskeys();
  showRestart();
}

/* ---------- reveal (shown only for rows the server marks viewable) ---------- */
async function reveal(g, e, r, n) {
  const old = r.querySelector(".shown");
  if (old) {
    old.remove();
    return;
  }
  const res = await call(
    "POST",
    `/api/vault/${encodeURIComponent(g.id)}/${encodeURIComponent(e.key)}/reveal`,
  );
  if (!res.ok) return toast(res.j.error || "Could not show that value.", "bad");
  const s = el("div", "shown", res.j.value);
  n.append(s);
  setTimeout(() => s.remove(), 30000);
}

/* ---------- add / replace ---------- */
let cur = null;
const edit = $("edit"),
  value = $("value");
function closeEdit() {
  value.value = "";
  value.type = "password";
  $("reveal").textContent = "Show";
  $("reveal").setAttribute("aria-pressed", "false");
  edit.close();
}
function openEdit(g, e) {
  cur = { g, e };
  const adding = !e,
    stores = state.groups.filter((x) => x.canAdd);
  $("edit-title").textContent = e ? `Replace ${e.key}` : "Add key";
  $("edit-sub").textContent = e ? g.label : "";
  $("edit-sub").hidden = !e;
  $("where-wrap").hidden = !adding;
  $("where").replaceChildren(
    ...stores.map((x) => Object.assign(el("option", "", x.label), { value: x.id })),
    Object.assign(el("option", "", "New…"), { value: "__new" }),
  );
  $("where").value = stores.length ? stores[0].id : "__new";
  $("new-type").value = "env";
  $("new-val").value = "";
  syncNew();
  $("name-wrap").hidden = !adding;
  $("name").value = "";
  value.value = "";
  $("edit-err").hidden = true;
  $("edit-wait").hidden = true;
  $("edit-save").disabled = false;
  syncHint();
  edit.showModal();
  (adding ? $("name") : value).focus();
}
function syncNew() {
  const isNew = !$("where-wrap").hidden && $("where").value === "__new",
    gh = $("new-type").value === "github";
  $("new-wrap").hidden = !isNew;
  $("new-label").textContent = gh ? "Repo (owner/name)" : "File path";
  $("new-val").placeholder = gh ? "owner/name" : "~/project/.env";
  syncHint();
}
// names the list would hide (env files only) are still saved: say so before the user wonders where the row went
function syncHint() {
  const sel = $("where").value,
    g = state.groups.find((x) => x.id === sel);
  const env = sel === "__new" ? $("new-type").value === "env" : !!g && !/^GitHub/.test(g.label);
  $("name-hint").hidden = !(
    !$("name-wrap").hidden &&
    env &&
    $("name").value &&
    !SECRETISH.test($("name").value)
  );
}
$("where").addEventListener("change", syncNew);
$("new-type").addEventListener("change", syncNew);
$("new-val").addEventListener("input", () => {
  $("edit-err").hidden = true;
});
$("add-key").addEventListener("click", () => openEdit(null, null));
$("name").addEventListener("input", (ev) => {
  ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  syncHint();
});
$("reveal").addEventListener("click", () => {
  const show = value.type === "password";
  value.type = show ? "text" : "password";
  $("reveal").textContent = show ? "Hide" : "Show";
  $("reveal").setAttribute("aria-pressed", String(show));
});
$("edit-cancel").addEventListener("click", closeEdit);
edit.addEventListener("cancel", () => {
  value.value = "";
});
$("edit-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const key = cur.e ? cur.e.key : $("name").value.trim();
  const err = $("edit-err");
  err.hidden = true;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    err.textContent = "Key names use capital letters, digits and underscores.";
    err.hidden = false;
    return;
  }
  const isNew = !cur.e && $("where").value === "__new";
  if (isNew && !$("new-val").value.trim()) {
    err.textContent = "Enter where to store it.";
    err.hidden = false;
    return;
  }
  $("edit-save").disabled = true;
  try {
    const wait = (w) => {
      $("edit-wait").hidden = !w;
    };
    let id = cur.e ? cur.g.id : $("where").value;
    if (isNew)
      id = (
        await write(
          "POST",
          "/api/vault/stores",
          { type: $("new-type").value, value: $("new-val").value.trim() },
          wait,
        )
      ).id;
    const j = await write(
      "PUT",
      `/api/vault/${encodeURIComponent(id)}/${encodeURIComponent(key)}`,
      { value: value.value },
      wait,
    );
    closeEdit();
    if (j.restartNeeded) state.restart = true;
    const note = j.proxied
      ? "Saved to iron-proxy; the env file holds the proxy token"
      : `${key} saved.${j.restartNeeded ? " Restart agent-console to apply." : ""}`;
    toast(note, "ok");
    await load();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    $("edit-save").disabled = false;
  }
});

/* ---------- delete: confirm by typing the key name ---------- */
let del = null;
function openDelete(g, e) {
  del = { g, e };
  $("del-title").textContent = `Delete ${e.key}`;
  $("del-sub").textContent = `${g.label}. This cannot be undone.`;
  $("del-prompt").textContent = `Type ${e.key} to confirm`;
  $("del-name").value = "";
  $("del-go").disabled = true;
  $("del-err").hidden = true;
  $("del-wait").hidden = true;
  $("del").showModal();
  $("del-name").focus();
}
$("del-name").addEventListener("input", () => {
  $("del-go").disabled = $("del-name").value.trim() !== del.e.key;
});
$("del-cancel").addEventListener("click", () => $("del").close());
$("del-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if ($("del-name").value.trim() !== del.e.key) return;
  $("del-go").disabled = true;
  $("del-err").hidden = true;
  try {
    const j = await write(
      "DELETE",
      `/api/vault/${encodeURIComponent(del.g.id)}/${encodeURIComponent(del.e.key)}`,
      undefined,
      (w) => {
        $("del-wait").hidden = !w;
      },
    );
    $("del").close();
    if (j.restartNeeded) state.restart = true;
    toast(
      `${del.e.key} deleted.${j.restartNeeded ? " Restart agent-console to apply." : ""}`,
      "ok",
    );
    await load();
  } catch (e) {
    $("del-err").textContent = e.message;
    $("del-err").hidden = false;
    $("del-go").disabled = false;
  }
});

/* ---------- passkeys ---------- */
const enroll = $("enroll");
function openEnroll() {
  const first = !state.pk.enrolled;
  $("enroll-sub").textContent = first
    ? "Confirm with this device's fingerprint or face. Another phone or a security key will not work."
    : "Confirm with an existing passkey, then register another one on this device.";
  $("pk-name").value = "";
  $("enroll-err").hidden = true;
  $("enroll-wait").hidden = true;
  $("enroll-go").disabled = false;
  enroll.showModal();
  $("pk-name").focus();
}
$("pk-add").addEventListener("click", openEnroll);
$("pk-setup").addEventListener("click", openEnroll);
$("enroll-cancel").addEventListener("click", () => enroll.close());
$("enroll-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("enroll-err");
  err.hidden = true;
  $("enroll-go").disabled = true;
  const wait = (w) => {
    $("enroll-wait").hidden = !w;
  };
  try {
    const body = {};
    let r = await call("POST", "/api/vault/passkeys/register/options", body);
    if (r.status === 401 && r.j.stepUp) {
      await stepUp(wait);
      r = await call("POST", "/api/vault/passkeys/register/options", body);
    }
    if (!r.ok) throw fail(r);
    wait(true);
    let response;
    try {
      response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: r.j.options });
    } finally {
      wait(false);
    }
    const v = await call("POST", "/api/vault/passkeys/register/verify", {
      cid: r.j.cid,
      response,
      name: $("pk-name").value,
    });
    if (!v.ok) throw fail(v);
    enroll.close();
    toast("Passkey added.", "ok");
    await load();
  } catch (e) {
    err.textContent = e.name === "NotAllowedError" ? "Passkey cancelled." : e.message;
    err.hidden = false;
    $("enroll-go").disabled = false;
  }
});
async function removePasskey(k) {
  if (!confirm(`Remove passkey "${k.name}"?`)) return;
  try {
    await write("DELETE", `/api/vault/passkeys/${encodeURIComponent(k.id)}`);
    toast("Passkey removed.", "ok");
    await load();
  } catch (e) {
    toast(e.message, "bad");
  }
}

$("refresh").addEventListener("click", () => {
  void load();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void load();
});
await load();
