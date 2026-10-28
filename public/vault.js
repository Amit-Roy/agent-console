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

import { readNdjsonStream } from "/step-timeline.js";
import { createVaultSteps } from "/vault-steps.js";

const state = {
  backup: null,
  groups: [],
  pk: { known: false, enrolled: 0, passkeys: [] },
  restart: false,
  ironJob: null,
};
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
/* a 401 stepUp reply: prompt the passkey once (caller retries the request) */
async function grantStepUp(setWait) {
  try {
    await stepUp(setWait);
  } catch (e) {
    throw e.name === "NotAllowedError" ? new Error("Passkey cancelled.") : e;
  }
}
function needsEnroll(reply) {
  if (reply.enrolled) return false;
  openEnroll();
  throw new Error("Set up a passkey first.");
}
/* a write: try, and on 401 prompt the passkey once and retry */
async function write(method, path, body, setWait = () => {}) {
  let r = await call(method, path, body);
  if (r.status === 401 && r.j.stepUp) {
    needsEnroll(r.j);
    await grantStepUp(setWait);
    r = await call(method, path, body);
  }
  if (!r.ok) throw fail(r);
  return r.j;
}
const sendNdjson = (method, path, body) =>
  fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
/* a streaming write: same step-up rule; NDJSON goes to onMessage, a plain JSON reply is returned */
async function writeStream(method, path, body, setWait, onMessage) {
  let r = await sendNdjson(method, path, body);
  if (r.status === 401) {
    const j = await r
      .clone()
      .json()
      .catch(() => ({}));
    if (j.stepUp) {
      needsEnroll(j);
      await grantStepUp(setWait);
      r = await sendNdjson(method, path, body);
    }
  }
  if (!r.ok) throw fail({ status: r.status, j: await r.json().catch(() => ({})) });
  if (!(r.headers.get("content-type") || "").includes("ndjson")) return r.json();
  await readNdjsonStream(r, onMessage);
  return undefined;
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
    state.ironJob = v.j.ironJob || null;
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
  reopenIronJob();
}
function reopenIronJob() {
  const job = state.ironJob;
  if (!job || $("vs").open || steps.dismissed() === job.job) return;
  if (!job.done || job.ok === false) steps.showSnapshot(job);
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
const steps = createVaultSteps({
  onSetOk: () => {
    value.value = "";
  },
  onFinished(done) {
    if (edit.open) closeEdit();
    if (done.restartNeeded) state.restart = true;
    const warnings = done.warnings || [];
    toast(
      `Saved to iron-proxy.${warnings.length ? ` ${warnings.join(" ")}` : ""}`,
      warnings.length ? "" : "ok",
    );
    void load();
  },
  onDismiss() {
    $("edit-save").disabled = false;
    $("edit-wait").hidden = true;
  },
  focusForm() {
    if (edit.open) value.focus();
    else toast("Enter the value again to retry.", "bad");
  },
  retryVerify: (onMessage) =>
    writeStream("POST", "/api/vault/iron/job/retry", undefined, () => {}, onMessage),
  async poll() {
    const reply = await call("GET", "/api/vault");
    return reply.ok ? reply.j.ironJob || null : null;
  },
});
const isIronManaged = (entry) =>
  !!entry && (entry.proxy === "proxied" || entry.proxy === "real-key");
function closeEdit() {
  value.value = "";
  $("ir-all").checked = false;
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
  initStorage(adding);
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
$("where").addEventListener("change", () => {
  syncNew();
  syncStorage();
});
$("new-type").addEventListener("change", () => {
  syncNew();
  syncStorage();
});
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
/* ---------- storage choice: Disk | Iron proxy ---------- */
const IRON_HEADERS = ["Authorization", "X-Api-Key", "Api-Key", "X-Auth-Token"];
const MAX_RULES = 3;
const RE_UPPER = /^[A-Z_][A-Z0-9_]*$/;
const RE_HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const iron = { on: false, presets: [], require: undefined };
const ironOn = () => iron.on && !$("iron-wrap").hidden;
const csv = (s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
function setStorage(on) {
  iron.on = on;
  $("st-disk").setAttribute("aria-pressed", String(!on));
  $("st-iron").setAttribute("aria-pressed", String(on));
  syncStorage();
  if (on && !iron.presets.length) void loadPresets();
}
// the toggle only applies to env-file stores; a GitHub target stays on Disk
function syncStorage() {
  const adding = !!cur && !cur.e,
    sel = $("where").value,
    group = state.groups.find((item) => item.id === sel),
    isGithub =
      sel === "__new" ? $("new-type").value === "github" : !!group && /^GitHub/.test(group.label);
  $("store-wrap").hidden = !adding || isGithub;
  const useIron = adding && !isGithub && iron.on;
  $("iron-wrap").hidden = !useIron;
  $("where-wrap").hidden = !adding || useIron;
  $("new-wrap").hidden = useIron || $("where").value !== "__new" || !adding;
  $("name-wrap").hidden = !adding || useIron;
  if (useIron) $("name-hint").hidden = true;
  else syncHint();
  if (useIron) syncSummary();
}
function initStorage(adding) {
  iron.on = false;
  $("st-disk").setAttribute("aria-pressed", "true");
  $("st-iron").setAttribute("aria-pressed", "false");
  $("ir-all").checked = false;
  fillSpec({ name: "", envVars: [], rules: [{ host: "", paths: ["/"] }], header: "Authorization" });
  $("ir-preset").value = "custom";
  if (adding) syncStorage();
  else $("store-wrap").hidden = $("iron-wrap").hidden = true;
}
async function loadPresets() {
  const reply = await call("GET", "/api/vault/iron/presets");
  if (!reply.ok || !Array.isArray(reply.j.presets)) {
    showEditErr(reply.j.error || "Could not load provider presets.");
    return;
  }
  iron.presets = reply.j.presets;
  $("ir-preset").replaceChildren(
    ...iron.presets.map((p) => Object.assign(el("option", "", p.label), { value: p.id })),
  );
  $("ir-preset").value = "custom";
}
function showEditErr(text) {
  $("edit-err").textContent = text;
  $("edit-err").hidden = false;
}
function ruleRow(rule) {
  const wrap = el("div", "vrule");
  const host = el("input", "input");
  const paths = el("input", "input");
  const removeBtn = el("button", "btn sm ghost", "Remove");
  for (const field of [host, paths]) {
    field.type = "text";
    field.autocomplete = "off";
    field.autocapitalize = "off";
    field.spellcheck = false;
    field.maxLength = 300;
    field.addEventListener("input", syncSummary);
  }
  host.placeholder = "api.example.com";
  host.value = rule.host || "";
  host.setAttribute("aria-label", "Host");
  paths.placeholder = "/v1/*, /models";
  paths.value = (rule.paths || []).join(", ");
  paths.setAttribute("aria-label", "Paths (comma list)");
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", "Remove host");
  removeBtn.addEventListener("click", () => {
    wrap.remove();
    syncSummary();
  });
  wrap.append(host, paths, removeBtn);
  return wrap;
}
function readRules() {
  return [...$("ir-rules").children].map((row) => {
    const [hostIn, pathsIn] = row.querySelectorAll("input");
    return { host: hostIn.value.trim(), paths: csv(pathsIn.value) };
  });
}
function fillSpec(spec) {
  $("ir-name").value = spec.name || "";
  $("ir-env").value = (spec.envVars || []).join(", ");
  $("ir-header").value = IRON_HEADERS.includes(spec.header) ? spec.header : "Authorization";
  $("ir-prefix").value = spec.prefix || "";
  iron.require = spec.require;
  const rules = spec.rules?.length ? spec.rules : [{ host: "", paths: ["/"] }];
  $("ir-rules").replaceChildren(...rules.slice(0, MAX_RULES).map(ruleRow));
  syncSummary();
}
const hasAllPaths = () => readRules().some((r) => r.paths.includes("/*"));
function syncSummary() {
  const rules = readRules().filter((r) => r.host);
  $("ir-sum").textContent = rules.length
    ? `Will allow egress to ${rules.map((r) => `${r.host} ${r.paths.join(", ") || "(no paths)"}`).join("; ")}`
    : "Will allow egress to no host yet.";
  const all = hasAllPaths();
  $("ir-warn").hidden = !all;
  $("ir-all-wrap").hidden = !all;
  if (!all) $("ir-all").checked = false;
  $("ir-addrule").disabled = $("ir-rules").children.length >= MAX_RULES;
}
function ironProblem(spec) {
  if (!RE_UPPER.test(spec.name)) return "Name uses capital letters, digits and underscores.";
  if (spec.envVars.some((v) => !RE_UPPER.test(v)))
    return "Env aliases use capital letters, digits and underscores.";
  if (!spec.rules.length) return "Add at least one host.";
  for (const rule of spec.rules) {
    if (!RE_HOST.test(rule.host)) return `Host "${rule.host}" must be a lowercase domain name.`;
    if (!rule.paths.length || rule.paths.some((path) => !path.startsWith("/")))
      return `Paths for ${rule.host} must start with "/".`;
  }
  if (hasAllPaths() && !$("ir-all").checked) return "Tick the box to allow all paths.";
  if (!value.value) return "Enter the key value.";
  return "";
}
function readSpec() {
  const spec = {
    name: $("ir-name").value.trim(),
    envVars: csv($("ir-env").value),
    rules: readRules(),
    header: $("ir-header").value,
    prefix: $("ir-prefix").value,
  };
  if (iron.require !== undefined) spec.require = iron.require;
  return spec;
}
async function submitIron() {
  const spec = readSpec();
  $("edit-err").hidden = true;
  const bad = ironProblem(spec);
  if (bad) return showEditErr(bad);
  $("edit-save").disabled = true;
  try {
    if (hasAllPaths()) spec.allowAllPaths = true;
    const body = { spec, value: value.value };
    const wait = (w) => {
      $("edit-wait").hidden = !w;
    };
    const reply = await steps.run(`Saving ${spec.name}`, (onMessage) =>
      writeStream("POST", "/api/vault/iron/providers", body, wait, onMessage),
    );
    if (!reply) return;
    closeEdit();
    const warnings = reply.warnings || [];
    const warn = warnings.length ? ` ${warnings.join(" ")}` : "";
    toast(`${reply.name || spec.name} saved to iron-proxy.${warn}`, warnings.length ? "" : "ok");
    await load();
  } catch (error) {
    showEditErr(error.message);
    $("edit-save").disabled = false;
  }
}
$("st-disk").addEventListener("click", () => setStorage(false));
$("st-iron").addEventListener("click", () => setStorage(true));
$("ir-preset").addEventListener("change", () => {
  const preset = iron.presets.find((item) => item.id === $("ir-preset").value);
  if (preset) fillSpec(preset.spec);
});
$("ir-name").addEventListener("input", (ev) => {
  ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
});
$("ir-addrule").addEventListener("click", () => {
  if ($("ir-rules").children.length < MAX_RULES) $("ir-rules").append(ruleRow({ paths: ["/"] }));
  syncSummary();
});
$("ir-all").addEventListener("change", () => {
  $("edit-err").hidden = true;
});
$("edit-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (ironOn()) return void submitIron();
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
    const path = `/api/vault/${encodeURIComponent(id)}/${encodeURIComponent(key)}`;
    const j = isIronManaged(cur.e)
      ? await steps.run(`Replacing ${key}`, (onMessage) =>
          writeStream("PUT", path, { value: value.value }, wait, onMessage),
        )
      : await write("PUT", path, { value: value.value }, wait);
    if (!j) return;
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
