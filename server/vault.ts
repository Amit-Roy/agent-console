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

type Source = { id: string; kind: "env" | "single" | "github" | "viewable"; file?: string; repo?: string; profile?: string; label: string };
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

function config(): { sources: any[] | null; alertTo: string[]; alertCc: string[]; rpId?: string } {
  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(confDir(), "vault-sources.json"), "utf8")); } catch {}
  const list = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === "string" && x.includes("@")) && v.length ? (v as string[]) : d);
  return { sources: Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : null, alertTo: list(raw?.alertTo, DEFAULT_ALERT_TO), alertCc: list(raw?.alertCc, DEFAULT_ALERT_CC), rpId: typeof raw?.rpId === "string" && /^[\w.-]+$/.test(raw.rpId) ? raw.rpId : undefined };
}

export function sources(): Source[] {
  const cfg = config().sources;
  const c = confDir(), h = home();
  const list: any[] = cfg ?? [
    ...[path.join(c, "env"), path.join(h, ".config", "agentmail", "env"), path.join(h, "openrouter", ".env"), path.join(h, ".omniroute", ".env")].map((p) => ({ type: "env", path: p, only: true })),
    { type: "single", path: path.join(c, "*.key"), only: true }, { type: "single", path: path.join(c, "model-rate-token"), only: true },
    ...DEFAULT_GH_REPOS.map((repo) => ({ type: "github", repo })),
    { type: "decoy", path: path.join(h, ".aws", "credentials"), profile: "backup-admin", only: true },
  ];
  const out: Source[] = [], seen = new Set<string>();
  for (const s of list) {
    if (s?.type === "github" && typeof s.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(s.repo)) {
      const id = sid(`github:${s.repo}`);
      if (!seen.has(id)) { seen.add(id); out.push({ id, kind: "github", repo: s.repo, label: `GitHub · ${s.repo}` }); }
    } else if (s?.type === "decoy" && typeof s.path === "string" && typeof s.profile === "string" && /^[\w.-]+$/.test(s.profile)) {
      // server-side marker only: the API and the page treat this as a viewable, read-only group
      const f = expand(s.path), id = sid(`decoy:${f}:${s.profile}`);
      if (s.only && !(exists(f) && iniSection(fs.readFileSync(f, "utf8"), s.profile))) continue;
      if (!seen.has(id)) { seen.add(id); out.push({ id, kind: "viewable", file: f, profile: s.profile, label: `AWS · ${s.profile}` }); }
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

/* ---------- ini (viewable group) ---------- */
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
function readViewable(s: Source) {
  const sec = iniSection(fs.readFileSync(s.file!, "utf8"), s.profile!);
  if (!sec) throw new VaultError(404, "No such key.");
  const mtime = fs.statSync(s.file!).mtimeMs;
  return { sec, entries: Object.entries(sec).map(([k, v]) => meta(k, v, mtime, { editable: false, viewable: true })) };
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
    if (m && !line.trimStart().startsWith("#")) entries.push(meta(m[2], parseValue(m[4]).value, mtime, { editable: ENV_KEY.test(m[2]) }));
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
  return [meta(path.basename(file), text.replace(/\r?\n$/, ""), fs.statSync(file).mtimeMs, { editable: true })];
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
  return rows.filter((r) => typeof r?.name === "string").map((r) => ({ key: r.name, length: null, hint: null, hash: null, mtime: Date.parse(r.updatedAt) || null, editable: ENV_KEY.test(r.name), valueHidden: true }));
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

/* ---------- operations ---------- */
const ownEnv = (s: Source) => !!s.file && s.kind === "env" && (() => { try { return fs.realpathSync(s.file!) === fs.realpathSync(path.join(confDir(), "env")); } catch { return s.file === path.join(confDir(), "env"); } })();

export async function listVault() {
  const out = await Promise.all(sources().map(async (s) => {
    const base = { id: s.id, label: s.label, canAdd: s.kind === "env" || s.kind === "github" };
    try {
      const entries = s.kind === "github" ? await readGithub(s.repo!) : s.kind === "viewable" ? (exists(s.file!) ? readViewable(s).entries : []) : !exists(s.file!) ? [] : s.kind === "env" ? readEnv(s.file!) : readSingle(s.file!);
      return { ...base, entries };
    } catch (e) {
      return { ...base, entries: [], error: e instanceof VaultError ? e.message : "This source could not be read." };
    }
  }));
  return { sources: out };
}

function find(id: string): Source {
  const s = sources().find((x) => x.id === id);
  if (!s) throw new VaultError(404, "No such source.");
  return s;
}
function checkKey(s: Source, key: string) {
  if (s.kind === "viewable") throw new VaultError(403, "This group is read-only.");
  if (!ENV_KEY.test(key) && !(s.kind === "single" && key === path.basename(s.file!))) throw new VaultError(400, "Key names use capital letters, digits and underscores.");
  if (s.kind === "single" && key !== path.basename(s.file!)) throw new VaultError(400, "This file holds one value.");
}
export function checkValue(v: unknown): string {
  if (typeof v !== "string" || v === "") throw new VaultError(400, "Enter a value.");
  if (/[\n\r\0]/.test(v)) throw new VaultError(400, "A value cannot contain a line break or NUL.");
  if (Buffer.byteLength(v) > MAX_VALUE) throw new VaultError(400, "A value can be at most 8 KiB.");
  return v;
}

export function setSecret(id: string, key: string, value: unknown) {
  const s = find(id); checkKey(s, key);
  const v = checkValue(value);
  return serial(async () => {
    if (s.kind === "github") await gh(["secret", "set", key, "-R", s.repo!], v);
    else if (s.kind === "env") writeEnv(s.file!, key, v);
    else {
      const had = exists(s.file!) && fs.readFileSync(s.file!, "utf8").endsWith("\n");
      atomicWrite(s.file!, v + (had ? "\n" : ""));
    }
    audit("set", s, key);
    return { ok: true, ...(ownEnv(s) ? { restartNeeded: true } : {}) };
  });
}

export function deleteSecret(id: string, key: string) {
  const s = find(id); checkKey(s, key);
  return serial(async () => {
    if (s.kind === "github") await gh(["secret", "delete", key, "-R", s.repo!]);
    else if (s.kind === "env") writeEnv(s.file!, key, null);
    else { if (!exists(s.file!)) throw new VaultError(404, "No such key."); fs.unlinkSync(fs.realpathSync(s.file!)); }
    audit("delete", s, key);
    return { ok: true, ...(ownEnv(s) ? { restartNeeded: true } : {}) };
  });
}

/* ---------- reveal (viewable groups only) + alert ---------- */
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

export function revealSecret(id: string, key: string, ip: string, ua: string) {
  const s = find(id);
  if (s.kind !== "viewable") throw new VaultError(403, "This value is write-only.");
  if (!exists(s.file!)) throw new VaultError(404, "No such key.");
  const sec = readViewable(s).sec;
  if (!Object.prototype.hasOwnProperty.call(sec, key)) throw new VaultError(404, "No such key.");
  audit("reveal", s, key);
  // fire and forget: the reveal never waits on the mail; failures log a fixed line only
  void sendMail("[Agent Console] ALERT: vault decoy revealed", [`Time: ${new Date().toISOString()}`, `Client IP: ${oneLine(ip, 80)}`, `User-agent: ${oneLine(ua)}`, `Key: ${key}`]).catch((e) => console.warn("vault alert failed:", oneLine(e?.message, 80)));
  return { value: sec[key] };
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
  const pk = createPasskeys({ confDir, rpId: () => config().rpId, atomicWrite, audit, alert: sendMail });
  pk.mount(app, sameOrigin, body);
  app.get("/api/vault", guard(() => listVault()));
  app.put("/api/vault/:source/:key", sameOrigin, pk.requireGrant(false), body, guard((req) => setSecret(req.params.source, req.params.key, req.body?.value)));
  app.post("/api/vault/:source/:key/reveal", sameOrigin, guard(async (req) => {
    const fwd = oneLine(req.headers["x-forwarded-for"], 120);
    return revealSecret(req.params.source, req.params.key, `${req.ip || req.socket.remoteAddress || ""}${fwd ? ` (forwarded ${fwd})` : ""}`, oneLine(req.headers["user-agent"]));
  }));
  app.delete("/api/vault/:source/:key", sameOrigin, pk.requireGrant(true), guard((req) => deleteSecret(req.params.source, req.params.key)));
  return { expireGrants: pk.expireGrants, resetAlertLimit: pk.resetAlertLimit }; // test hooks
}
