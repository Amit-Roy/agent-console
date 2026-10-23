import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import { createPasskeys } from "./vault-passkey.ts";

// Vault: write-only management of API tokens (env files, single-value files, GitHub Actions secrets).
// Secret values are never read back out to a client, a log or an error: lists carry metadata only.
const MAX_VALUE = 8 * 1024;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const DEFAULT_GH_REPOS = ["Amit-Roy/harden-vps"];
const GH_TIMEOUT = 20_000;
const DEFAULT_ALERT_TO = ["sunny.amit.roy@gmail.com"], DEFAULT_ALERT_CC = ["nefro.amit.roy@gmail.com"];

const SECRETISH = /(KEY|TOKEN|SECRET|PASS|AUTH|CRED|PRIVATE|DSN|URL)/i; // env keys outside this are settings, not secrets: hidden unless showAllKeys
type Source = { id: string; kind: "env" | "single" | "github" | "virtual"; file?: string; repo?: string; label: string };
type Extra = { store: string; key: string; value: string; viewable: boolean; updatedAt: string };
class VaultError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

const home = () => process.env.VAULT_HOME || os.homedir();
const confDir = () => path.join(home(), ".config", "agent-console");
const ghBin = () => process.env.VAULT_GH_BIN || "gh";
const expand = (p: string) => (p === "~" ? home() : p.startsWith("~/") ? path.join(home(), p.slice(2)) : p);
const sid = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const tail = (p: string) => p.split(path.sep).filter(Boolean).slice(-2).join("/");

/* ---------- source list ---------- */
function expandGlob(p: string): string[] {
  if (!p.includes("*")) return [p];
  const dir = path.dirname(p), re = new RegExp(`^${path.basename(p).replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`);
  try { return fs.readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n)); } catch { return []; }
}

function config(): { sources: any[] | null; extra: any[]; alertTo: string[]; alertCc: string[]; rpId?: string; showAllKeys: boolean } {
  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(confDir(), "vault-sources.json"), "utf8")); } catch {}
  const list = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === "string" && x.includes("@")) && v.length ? (v as string[]) : d);
  return { sources: Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : null, extra: Array.isArray(raw?.extra) ? raw.extra : [], showAllKeys: raw?.showAllKeys === true, alertTo: list(raw?.alertTo, DEFAULT_ALERT_TO), alertCc: list(raw?.alertCc, DEFAULT_ALERT_CC), rpId: typeof raw?.rpId === "string" && /^[\w.-]+$/.test(raw.rpId) ? raw.rpId : undefined };
}

export function sources(): Source[] {
  const cfg = config().sources;
  const c = confDir(), h = home();
  const list: any[] = cfg ?? [
    ...[path.join(c, "env"), path.join(h, ".config", "agentmail", "env"), path.join(h, "openrouter", ".env"), path.join(h, ".omniroute", ".env")].map((p) => ({ type: "env", path: p, only: true })),
    { type: "single", path: path.join(c, "*.key"), only: true }, { type: "single", path: path.join(c, "model-rate-token"), only: true },
    ...DEFAULT_GH_REPOS.map((repo) => ({ type: "github", repo })),
  ];
  list.push(...config().extra); // stores added from the page
  const out: Source[] = [], seen = new Set<string>();
  for (const s of list) {
    if (s?.type === "github" && typeof s.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(s.repo)) {
      const id = sid(`github:${s.repo}`);
      if (!seen.has(id)) { seen.add(id); out.push({ id, kind: "github", repo: s.repo, label: `GitHub · ${s.repo}` }); }
    } else if ((s?.type === "env" || s?.type === "single") && typeof s.path === "string") {
      for (const f of expandGlob(expand(s.path))) {
        // defaults show only files that exist; explicitly configured paths always show so keys can be added
        if ((s.only || f.includes("*")) && !exists(f)) continue;
        const id = sid(`${s.type}:${f}`);
        if (!seen.has(id)) { seen.add(id); out.push({ id, kind: s.type, file: f, label: tail(f) }); }
      }
    }
  }
  return out;
}

/* ---------- env parsing ---------- */
type Parsed = { value: string; quote: string; rest: string };
function parseValue(raw: string): Parsed {
  const s = raw.replace(/^\s+/, "");
  const q = s[0];
  if (q === '"' || q === "'") {
    let v = "", i = 1;
    for (; i < s.length && s[i] !== q; i++) {
      if (q === '"' && s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) i++;
      v += s[i];
    }
    if (i < s.length) return { value: v, quote: q, rest: s.slice(i + 1) };
  }
  const m = /\s+#.*$/.exec(s);
  const body = m ? s.slice(0, m.index) : s;
  return { value: body.replace(/\s+$/, ""), quote: "", rest: m ? m[0] : "" };
}
const SAFE = /^[A-Za-z0-9_@%+=:,.\/-]*$/;
function formatValue(value: string, quote: string): string {
  if (quote === "'" && !value.includes("'")) return `'${value}'`;
  if (quote === '"' || !SAFE.test(value) || quote === "'") return `"${value.replace(/[\\"]/g, "\\$&")}"`;
  return value;
}

/* ---------- ini (seed source) ---------- */
function iniSection(text: string, profile: string): Record<string, string> | null {
  let cur = "", found = false;
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    const h = /^\[([^\]]+)\]$/.exec(t);
    if (h) { cur = h[1].trim(); if (cur === profile) found = true; continue; }
    const m = cur === profile ? /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(t) : null;
    if (m && !t.startsWith("#") && !t.startsWith(";")) out[m[1]] = m[2].trim();
  }
  return found ? out : null;
}
/* ---------- metadata (never the value) ---------- */
function meta(key: string, value: string, mtime: number, extra: object = {}) {
  const length = [...value].length;
  return { key, length, hint: length >= 24 ? value.slice(-4) : null, hash: crypto.createHash("sha256").update(value).digest("hex").slice(0, 8), mtime, ...extra };
}

/* ---------- atomic write ---------- */
function atomicWrite(file: string, data: string) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  let mode = 0o600, uid: number | undefined, gid: number | undefined;
  try { const st = fs.statSync(real); mode = st.mode & 0o777; uid = st.uid; gid = st.gid; } catch {}
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.vault-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, mode);
    if (uid !== undefined) { try { fs.fchownSync(fd, uid, gid!); } catch {} }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, real);
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/* ---------- file sources ---------- */
function readEnv(file: string) {
  const text = fs.readFileSync(file, "utf8"), mtime = fs.statSync(file).mtimeMs;
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    const m = ENV_LINE.exec(line.replace(/\r$/, ""));
    if (m && !line.trimStart().startsWith("#")) entries.push(meta(m[2], parseValue(m[4]).value, mtime, { editable: ENV_KEY.test(m[2]), viewable: false }));
  }
  // later duplicates win, like dotenv
  return [...new Map(entries.map((e) => [e.key, e])).values()];
}

function writeEnv(file: string, key: string, value: string | null) {
  const text = exists(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text === "" ? [] : text.split("\n");
  const out: string[] = [];
  let hit = false;
  for (const line of lines) {
    const m = !line.trimStart().startsWith("#") ? ENV_LINE.exec(line) : null;
    if (m && m[2] === key) {
      hit = true;
      if (value === null) continue;
      const p = parseValue(m[4]);
      out.push(`${m[1]}${m[2]}${m[3]}${formatValue(value, p.quote)}${p.rest}`);
    } else out.push(line);
  }
  if (value === null && !hit) throw new VaultError(404, "No such key.");
  if (value !== null && !hit) {
    if (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${formatValue(value, "")}`, "");
  }
  atomicWrite(file, out.join("\n"));
}

function readSingle(file: string) {
  const text = fs.readFileSync(file, "utf8");
  return [meta(path.basename(file), text.replace(/\r?\n$/, ""), fs.statSync(file).mtimeMs, { editable: true, viewable: false })];
}

/* ---------- github ---------- */
function gh(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The value goes to the child on stdin only; argv (visible in ps) carries names and the repo.
    const child = spawn(ghBin(), args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GH_TIMEOUT);
    child.stdout.on("data", (d) => { if (out.length < 1_000_000) out += d; });
    child.on("error", () => { clearTimeout(timer); reject(new VaultError(502, "Could not run the GitHub CLI.")); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new VaultError(502, "GitHub refused or did not answer.")); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}
async function readGithub(repo: string) {
  const rows = JSON.parse(await gh(["secret", "list", "-R", repo, "--json", "name,updatedAt"]));
  if (!Array.isArray(rows)) throw new VaultError(502, "GitHub sent an unreadable answer.");
  return rows.filter((r) => typeof r?.name === "string").map((r) => ({ key: r.name, length: null, hint: null, hash: null, mtime: Date.parse(r.updatedAt) || null, editable: ENV_KEY.test(r.name), viewable: false, valueHidden: true }));
}

/* ---------- audit + lock ---------- */
function audit(action: string, source: Source | string, key: string) {
  try {
    const f = path.join(confDir(), "vault-audit.jsonl");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), action, source: typeof source === "string" ? source : source.id, key }) + "\n", { mode: 0o600 });
  } catch {}
}
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

/* ---------- extra entries: listed beside the real keys, never written to a real file or to GitHub ---------- */
const extrasFile = () => path.join(confDir(), "vault-decoys.json");
const rand = (n: number, set: string) => Array.from(crypto.randomBytes(n), (b) => set[b % set.length]).join("");
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", B64U = B62 + "-_";
function seedExtras(): Extra[] {
  const srcs = sources(), own = srcs.find(ownEnv) ?? srcs.find((s) => s.kind === "env");
  const spread = srcs.filter((s) => (s.kind === "env" || s.kind === "github") && s !== own);
  const at = new Date().toISOString(), list: Extra[] = [];
  const aws = path.join(home(), ".aws", "credentials");
  const sec = own && exists(aws) ? iniSection(fs.readFileSync(aws, "utf8"), "backup-admin") : null;
  for (const [from, key] of [["aws_access_key_id", "AWS_ACCESS_KEY_ID"], ["aws_secret_access_key", "AWS_SECRET_ACCESS_KEY"], ["region", "AWS_REGION"]] as const) {
    if (own && sec && sec[from]) list.push({ store: own.id, key, value: sec[from], viewable: true, updatedAt: at });
  }
  const hex = () => crypto.randomBytes(4).toString("hex");
  const plain: [string, string][] = [
    ["STRIPE_SECRET_KEY", `sk_live_${rand(32, B62)}`],
    ["ANTHROPIC_API_KEY_OLD", `sk-ant-api03-${rand(93, B64U)}AA`],
    ["DATABASE_URL", `postgres://app:${rand(24, B62)}@db-${hex()}.internal:5432/app`],
    ["SLACK_BOT_TOKEN", `xoxb-${rand(11, "0123456789")}-${rand(12, "0123456789")}-${rand(24, B62)}`],
  ];
  plain.forEach(([key, value], i) => {
    const t = spread.length ? spread[i % spread.length] : own;
    if (t) list.push({ store: t.id, key, value, viewable: false, updatedAt: at });
  });
  try { saveExtras(list); } catch {}
  return list;
}
function loadExtras(): Extra[] {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(extrasFile(), "utf8")); }
  catch (e: any) { return e?.code === "ENOENT" ? seedExtras() : []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((x: any) => x && typeof x.store === "string" && typeof x.key === "string" && typeof x.value === "string" && x.key)
    .map((x: any) => ({ store: x.store, key: x.key, value: x.value, viewable: x.viewable === true, updatedAt: Number.isNaN(Date.parse(x.updatedAt)) ? new Date().toISOString() : new Date(x.updatedAt).toISOString() }));
}
const saveExtras = (l: Extra[]) => atomicWrite(extrasFile(), JSON.stringify(l, null, 2) + "\n");
const virtual = (label: string): Source => ({ id: sid(`label:${label}`), kind: "virtual", label });
const owns = (s: Source, x: Extra) => (s.kind === "virtual" ? x.store === s.label : x.store === s.id);
const extraGroups = (all: Extra[], srcs: Source[]) => {
  const ids = new Set(srcs.map((s) => s.id));
  return [...new Set(all.map((x) => x.store).filter((st) => !ids.has(st) && !/^[0-9a-f]{12}$/.test(st)))].map(virtual);
};

/* ---------- operations ---------- */
const ownEnv = (s: Source) => !!s.file && s.kind === "env" && (() => { try { return fs.realpathSync(s.file!) === fs.realpathSync(path.join(confDir(), "env")); } catch { return s.file === path.join(confDir(), "env"); } })();

async function realEntries(s: Source): Promise<any[]> {
  if (s.kind === "github") return readGithub(s.repo!);
  if (s.kind === "virtual" || !exists(s.file!)) return [];
  return s.kind === "env" ? readEnv(s.file!) : readSingle(s.file!);
}
const shape = (s: Source, x: Extra, mtime: number | null) =>
  s.kind === "github"
    ? { key: x.key, length: null, hint: null, hash: null, mtime: Date.parse(x.updatedAt) || null, editable: ENV_KEY.test(x.key), viewable: x.viewable, valueHidden: true }
    : meta(x.key, x.value, mtime ?? (Date.parse(x.updatedAt) || 0), { editable: ENV_KEY.test(x.key), viewable: x.viewable });

export async function listVault(opts: { mine?: boolean } = {}) {
  const all = loadExtras(), srcs = sources(), showAll = config().showAllKeys;
  const out = await Promise.all([...srcs, ...extraGroups(all, srcs)].map(async (s) => {
    const base = { id: s.id, label: s.label, canAdd: s.kind === "env" || s.kind === "github" };
    try {
      const real = await realEntries(s);
      const have = new Set(real.map((e) => e.key));
      const extra = all.filter((x) => owns(s, x) && !have.has(x.key));
      // every extra in a file group takes the file's mtime, like the real keys; a label group shares its newest time
      const mtime = s.file && exists(s.file) ? fs.statSync(s.file).mtimeMs : s.kind === "virtual" ? Math.max(0, ...extra.map((x) => Date.parse(x.updatedAt) || 0)) : null;
      let entries = [...real.map((e) => ({ ...e, ...(opts.mine ? { mine: true } : {}) })), ...extra.map((x) => ({ ...shape(s, x, mtime), ...(opts.mine ? { mine: false } : {}) }))];
      if ((s.kind === "env" || s.kind === "virtual") && !showAll) entries = entries.filter((e) => SECRETISH.test(e.key));
      entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return { ...base, entries };
    } catch (e) {
      return { ...base, entries: [], error: e instanceof VaultError ? e.message : "This source could not be read." };
    }
  }));
  return { sources: out };
}

function find(id: string): Source {
  const srcs = sources(), s = srcs.find((x) => x.id === id) ?? extraGroups(loadExtras(), srcs).find((x) => x.id === id);
  if (!s) throw new VaultError(404, "No such source.");
  return s;
}
function checkKey(s: Source, key: string) {
  if (!ENV_KEY.test(key) && !(s.kind === "single" && key === path.basename(s.file!))) throw new VaultError(400, "Key names use capital letters, digits and underscores.");
  if (s.kind === "single" && key !== path.basename(s.file!)) throw new VaultError(400, "This file holds one value.");
}
export function checkValue(v: unknown): string {
  if (typeof v !== "string" || v === "") throw new VaultError(400, "Enter a value.");
  if (/[\n\r\0]/.test(v)) throw new VaultError(400, "A value cannot contain a line break or NUL.");
  if (Buffer.byteLength(v) > MAX_VALUE) throw new VaultError(400, "A value can be at most 8 KiB.");
  return v;
}
/* the extra entry behind (source, key), unless a real key of that name exists */
async function extraAt(s: Source, key: string): Promise<Extra | undefined> {
  const x = loadExtras().find((e) => owns(s, e) && e.key === key);
  if (!x || s.kind === "virtual") return x;
  try { if ((await realEntries(s)).some((e) => e.key === key)) return undefined; } catch {}
  return x;
}
type Client = { ip: string; ua: string };
const NOBODY: Client = { ip: "", ua: "" };
function alertExtra(what: string, key: string, c: Client) {
  // fire and forget; failures log a fixed line only. Never carries a value.
  void sendMail(`[Agent Console] ALERT: vault decoy ${what}`, [`Time: ${new Date().toISOString()}`, `Client IP: ${oneLine(c.ip, 80)}`, `User-agent: ${oneLine(c.ua)}`, `Key: ${key}`]).catch((e) => console.warn("vault alert failed:", oneLine(e?.message, 80)));
}

export function setSecret(id: string, key: string, value: unknown, c: Client = NOBODY) {
  const s = find(id); checkKey(s, key);
  const v = checkValue(value);
  return serial(async () => {
    const x = await extraAt(s, key);
    if (x) {
      const all = loadExtras(), at = all.findIndex((e) => owns(s, e) && e.key === key);
      all[at] = { ...all[at], value: v, updatedAt: new Date().toISOString() };
      saveExtras(all);
      audit("set", s, key); alertExtra("changed", key, c);
    } else {
      if (s.kind === "virtual") throw new VaultError(404, "No such key.");
      if (s.kind === "github") await gh(["secret", "set", key, "-R", s.repo!], v);
      else if (s.kind === "env") writeEnv(s.file!, key, v);
      else {
        const had = exists(s.file!) && fs.readFileSync(s.file!, "utf8").endsWith("\n");
        atomicWrite(s.file!, v + (had ? "\n" : ""));
      }
      audit("set", s, key);
    }
    return { ok: true, ...(ownEnv(s) ? { restartNeeded: true } : {}) };
  });
}

export function deleteSecret(id: string, key: string, c: Client = NOBODY) {
  const s = find(id); checkKey(s, key);
  return serial(async () => {
    const x = await extraAt(s, key);
    if (x) {
      saveExtras(loadExtras().filter((e) => !(owns(s, e) && e.key === key)));
      audit("delete", s, key); alertExtra("changed", key, c);
    } else {
      if (s.kind === "virtual") throw new VaultError(404, "No such key.");
      if (s.kind === "github") await gh(["secret", "delete", key, "-R", s.repo!]);
      else if (s.kind === "env") writeEnv(s.file!, key, null);
      else { if (!exists(s.file!)) throw new VaultError(404, "No such key."); fs.unlinkSync(fs.realpathSync(s.file!)); }
      audit("delete", s, key);
    }
    return { ok: true, ...(ownEnv(s) ? { restartNeeded: true } : {}) };
  });
}

/* ---------- add a store (env file under $HOME, or a GitHub repo) ---------- */
const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);
const storeId = (e: any) => sid(e.type === "env" ? `env:${e.path}` : `github:${e.repo}`);
export function addStore(type: unknown, value: unknown) {
  return serial(async () => {
    let entry: any;
    const raw = typeof value === "string" ? value.trim() : "";
    if (type === "env") {
      if (!raw || /[\0\n\r]/.test(raw) || !(raw.startsWith("~/") || path.isAbsolute(raw))) throw new VaultError(400, "Use a path like ~/project/.env.");
      const want = path.resolve(expand(raw));
      let root: string, parent: string;
      try { root = fs.realpathSync(home()); } catch { throw new VaultError(500, "The vault is unavailable."); }
      try { parent = fs.realpathSync(path.dirname(want)); } catch { throw new VaultError(400, "That folder does not exist."); }
      if (!inside(root, parent) || !path.basename(want)) throw new VaultError(400, "The file must be inside your home folder.");
      const file = path.join(parent, path.basename(want));
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(file); } catch {}
      if (st?.isSymbolicLink()) {
        let to = "";
        try { to = fs.realpathSync(file); } catch {}
        if (!to || !inside(root, to)) throw new VaultError(400, "The file must be inside your home folder.");
        st = fs.statSync(file);
      }
      if (st && !st.isFile()) throw new VaultError(400, "That path is not a file.");
      if (!st) { try { fs.closeSync(fs.openSync(file, "wx", 0o600)); } catch { throw new VaultError(400, "Could not create that file."); } }
      entry = { type: "env", path: file };
    } else if (type === "github") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(raw)) throw new VaultError(400, "Use owner/name.");
      try { await gh(["repo", "view", raw, "--json", "name"]); } catch { throw new VaultError(400, "GitHub could not find that repo."); }
      entry = { type: "github", repo: raw };
    } else throw new VaultError(400, "Choose env file or GitHub repo.");
    const id = storeId(entry), known = sources().find((x) => x.id === id);
    if (known) return { ok: true, id, label: known.label };
    const cfgFile = path.join(confDir(), "vault-sources.json");
    let cfg: any = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch {}
    if (Array.isArray(cfg)) cfg = { sources: cfg };
    if (!cfg || typeof cfg !== "object") cfg = {};
    cfg.extra = [...(Array.isArray(cfg.extra) ? cfg.extra : []), entry];
    atomicWrite(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    const added = sources().find((x) => x.id === id);
    if (!added) throw new VaultError(500, "The vault is unavailable.");
    audit("add-store", added, "-");
    return { ok: true, id, label: added.label };
  });
}

/* ---------- reveal (entries marked viewable only) + alert ---------- */
function agentmailEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(home(), ".config", "agentmail", "env"), "utf8").split("\n")) {
      const m = ENV_LINE.exec(line);
      if (m && !line.trimStart().startsWith("#")) out[m[2]] = parseValue(m[4]).value;
    }
  } catch {}
  return out;
}
const oneLine = (v: unknown, n = 200) => String(v ?? "").replace(/[\r\n\0]+/g, " ").slice(0, n);

async function sendMail(subject: string, lines: string[]) {
  const env = agentmailEnv(), inbox = env.AGENTMAIL_INBOX, apiKey = env.AGENTMAIL_API_KEY;
  if (!inbox || !apiKey) throw new Error("no mail credentials");
  const cfg = config(), base = process.env.VAULT_ALERT_BASE || "https://api.agentmail.to";
  const r = await fetch(`${base}/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: cfg.alertTo, cc: cfg.alertCc, subject, text: lines.join("\n") + "\n" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`mail status ${r.status}`);
}

export function revealSecret(id: string, key: string, c: Client) {
  const s = find(id);
  const x = loadExtras().find((e) => owns(s, e) && e.key === key && e.viewable);
  if (!x) throw new VaultError(403, "This value is write-only.");
  audit("reveal", s, key);
  alertExtra("revealed", key, c);
  return { value: x.value };
}

/* ---------- routes ---------- */
const parseJson = express.json({ limit: "16kb" });
export function mountVault(app: express.Express, sameOrigin: express.RequestHandler) {
  // Fixed messages only: a parser error can quote the body, which may hold a secret.
  const body: express.RequestHandler = (req, res, next) =>
    (parseJson(req, res, (err?: any) => (err ? void res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "Request too large." : "Invalid request." }) : next())));
  const guard = (fn: (req: express.Request) => Promise<any>): express.RequestHandler => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await fn(req)); }
    catch (e: any) { res.status(e instanceof VaultError ? e.status : 500).json({ error: e instanceof VaultError ? e.message : "The vault is unavailable." }); }
  };
  const client = (req: express.Request): Client => {
    const fwd = oneLine(req.headers["x-forwarded-for"], 120);
    return { ip: `${req.ip || req.socket.remoteAddress || ""}${fwd ? ` (forwarded ${fwd})` : ""}`, ua: oneLine(req.headers["user-agent"]) };
  };
  const pk = createPasskeys({ confDir, rpId: () => config().rpId, atomicWrite, audit, alert: sendMail });
  pk.mount(app, sameOrigin, body);
  // `mine` marks real vs extra entries, and only goes to a client holding a live grant
  app.get("/api/vault", guard(async (req) => listVault({ mine: pk.granted(req) })));
  app.post("/api/vault/stores", sameOrigin, pk.requireGrant(false), body, guard((req) => addStore(req.body?.type, req.body?.value)));
  app.put("/api/vault/:source/:key", sameOrigin, pk.requireGrant(false), body, guard((req) => setSecret(req.params.source, req.params.key, req.body?.value, client(req))));
  app.post("/api/vault/:source/:key/reveal", sameOrigin, guard(async (req) => revealSecret(req.params.source, req.params.key, client(req))));
  app.delete("/api/vault/:source/:key", sameOrigin, pk.requireGrant(true), guard((req) => deleteSecret(req.params.source, req.params.key, client(req))));
  return { expireGrants: pk.expireGrants, resetAlertLimit: pk.resetAlertLimit }; // test hooks
}
