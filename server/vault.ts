import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { type IronSpec, presets, SpecError, specHosts, validateSpec } from "./iron-spec.ts";
import { backupStatus, retryBackup, scheduleBackup } from "./vault-backup.ts";
import { refreshEgress } from "./vault-egress.ts";
import {
  type IronMap,
  ironCached,
  ironProviderAdd,
  ironSet,
  ironStatus,
  ironToken,
  KNOWN_MANAGED,
} from "./vault-iron.ts";
import { createPasskeys } from "./vault-passkey.ts";
import {
  beginJob,
  ERR,
  failSave,
  ironJobSnapshot,
  type Job,
  type JobKind,
  jobBusy,
  ndjsonStream,
  resumeJob,
  type Sink,
  startTail,
  stepDone,
  stepStart,
} from "./vault-save-job.ts";

// Vault: write-only management of API tokens (env files, single-value files, GitHub Actions secrets).
// Secret values are never read back out to a client, a log or an error: lists carry metadata only.
const MAX_VALUE = 8 * 1024;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const DEFAULT_GH_REPOS = ["Amit-Roy/harden-vps"];
const GH_TIMEOUT = 20_000;
const DEFAULT_ALERT_TO = ["sunny.amit.roy@gmail.com"],
  DEFAULT_ALERT_CC = ["nefro.amit.roy@gmail.com"];

const SECRETISH = /(KEY|TOKEN|SECRET|PASS|AUTH|CRED|PRIVATE|DSN|URL)/i; // env keys outside this are settings, not secrets: hidden unless showAllKeys
type Source = {
  id: string;
  kind: "env" | "single" | "github" | "virtual";
  file?: string;
  repo?: string;
  label: string;
};
type Extra = {
  store: string;
  key: string;
  value: string;
  viewable: boolean;
  updatedAt: string;
};
class VaultError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const home = () => process.env.VAULT_HOME || os.homedir();
const confDir = () => path.join(home(), ".config", "agent-console");
const ghBin = () => process.env.VAULT_GH_BIN || "gh";
const expand = (p: string) =>
  p === "~" ? home() : p.startsWith("~/") ? path.join(home(), p.slice(2)) : p;
const sid = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const exists = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const tail = (p: string) => p.split(path.sep).filter(Boolean).slice(-2).join("/");

/* ---------- source list ---------- */
function expandGlob(p: string): string[] {
  if (!p.includes("*")) return [p];
  const dir = path.dirname(p),
    re = new RegExp(
      `^${path
        .basename(p)
        .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
        .replace(/\*/g, ".*")}$`,
    );
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function config(): {
  sources: any[] | null;
  extra: any[];
  alertTo: string[];
  alertCc: string[];
  rpId?: string;
  showAllKeys: boolean;
} {
  let raw: any = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(confDir(), "vault-sources.json"), "utf8"));
  } catch {}
  const list = (v: unknown, d: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.includes("@")) && v.length
      ? (v as string[])
      : d;
  return {
    sources: Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : null,
    extra: Array.isArray(raw?.extra) ? raw.extra : [],
    showAllKeys: raw?.showAllKeys === true,
    alertTo: list(raw?.alertTo, DEFAULT_ALERT_TO),
    alertCc: list(raw?.alertCc, DEFAULT_ALERT_CC),
    rpId: typeof raw?.rpId === "string" && /^[\w.-]+$/.test(raw.rpId) ? raw.rpId : undefined,
    origins: Array.isArray(raw?.origins)
      ? raw.origins.filter((o: unknown) => typeof o === "string" && /^https:\/\/[\w.-]+$/.test(o))
      : [],
  };
}

function defaultSourceList(): any[] {
  const c = confDir(),
    h = home();
  return [
    ...[
      path.join(c, "env"),
      path.join(h, ".config", "agentmail", "env"),
      path.join(h, "openrouter", ".env"),
      path.join(h, ".omniroute", ".env"),
    ].map((p) => ({ type: "env", path: p, only: true })),
    { type: "single", path: path.join(c, "*.key"), only: true },
    { type: "single", path: path.join(c, "model-rate-token"), only: true },
    ...DEFAULT_GH_REPOS.map((repo) => ({ type: "github", repo })),
  ];
}

function addGithubSource(spec: any, seen: Set<string>, out: Source[]) {
  const id = sid(`github:${spec.repo}`);
  if (seen.has(id)) return;
  seen.add(id);
  out.push({
    id,
    kind: "github",
    repo: spec.repo,
    label: `GitHub · ${spec.repo}`,
  });
}

function addFileSources(spec: any, seen: Set<string>, out: Source[]) {
  for (const f of expandGlob(expand(spec.path))) {
    // defaults show only files that exist; explicitly configured paths always show so keys can be added
    if ((spec.only || f.includes("*")) && !exists(f)) continue;
    const id = sid(`${spec.type}:${f}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind: spec.type, file: f, label: tail(f) });
  }
}

export function sources(): Source[] {
  const list: any[] = config().sources ?? defaultSourceList();
  list.push(...config().extra); // stores added from the page
  const out: Source[] = [],
    seen = new Set<string>();
  for (const spec of list) {
    if (
      spec?.type === "github" &&
      typeof spec.repo === "string" &&
      /^[\w.-]+\/[\w.-]+$/.test(spec.repo)
    ) {
      addGithubSource(spec, seen, out);
    } else if ((spec?.type === "env" || spec?.type === "single") && typeof spec.path === "string") {
      addFileSources(spec, seen, out);
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
    let v = "",
      i = 1;
    for (; i < s.length && s[i] !== q; i++) {
      if (q === '"' && s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\"))
        i++;
      v += s[i];
    }
    if (i < s.length) return { value: v, quote: q, rest: s.slice(i + 1) };
  }
  const m = /\s+#.*$/.exec(s);
  const body = m ? s.slice(0, m.index) : s;
  return { value: body.replace(/\s+$/, ""), quote: "", rest: m ? m[0] : "" };
}
const SAFE = /^[A-Za-z0-9_@%+=:,./-]*$/;
function formatValue(value: string, quote: string): string {
  if (quote === "'" && !value.includes("'")) return `'${value}'`;
  if (quote === '"' || !SAFE.test(value) || quote === "'")
    return `"${value.replace(/[\\"]/g, "\\$&")}"`;
  return value;
}

/* ---------- ini (seed source) ---------- */
function iniSection(text: string, profile: string): Record<string, string> | null {
  let cur = "",
    found = false;
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    const h = /^\[([^\]]+)\]$/.exec(t);
    if (h) {
      cur = h[1].trim();
      if (cur === profile) found = true;
      continue;
    }
    const m = cur === profile ? /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(t) : null;
    if (m && !t.startsWith("#") && !t.startsWith(";")) out[m[1]] = m[2].trim();
  }
  return found ? out : null;
}
/* ---------- metadata (never the value) ---------- */
function meta(key: string, value: string, mtime: number, extra: object = {}) {
  const length = [...value].length;
  return {
    key,
    length,
    hint: length >= 24 ? value.slice(-4) : null,
    hash: crypto.createHash("sha256").update(value).digest("hex").slice(0, 8),
    mtime,
    ...extra,
  };
}

/* ---------- atomic write ---------- */
function atomicWrite(file: string, data: string) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  let mode = 0o600,
    uid: number | undefined,
    gid: number | undefined;
  try {
    const st = fs.statSync(real);
    mode = st.mode & 0o777;
    uid = st.uid;
    gid = st.gid;
  } catch {}
  const tmp = path.join(
    path.dirname(real),
    `.${path.basename(real)}.vault-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, mode);
    if (uid !== undefined) {
      try {
        fs.fchownSync(fd, uid, gid!);
      } catch {}
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, real);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/* ---------- file sources ---------- */
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
type Proxy = "proxied" | "real-key" | "unproxied";
function classify(key: string, value: string, iron: IronMap | null): Proxy {
  const want = iron?.get(key);
  if (!want) return "unproxied";
  return sha256(value) === want.tokenSha ? "proxied" : "real-key";
}

function readEnv(file: string, iron: IronMap | null = null) {
  const text = fs.readFileSync(file, "utf8"),
    mtime = fs.statSync(file).mtimeMs;
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    const m = ENV_LINE.exec(line.replace(/\r$/, ""));
    if (m && !line.trimStart().startsWith("#"))
      entries.push(
        meta(m[2], parseValue(m[4]).value, mtime, {
          editable: ENV_KEY.test(m[2]),
          viewable: false,
          proxy: classify(m[2], parseValue(m[4]).value, iron),
        }),
      );
  }
  // later duplicates win, like dotenv
  return [...new Map(entries.map((e) => [e.key, e])).values()];
}

function replaceEnvLine(
  line: string,
  key: string,
  value: string | null,
): { hit: boolean; text: string | null } {
  const m = !line.trimStart().startsWith("#") ? ENV_LINE.exec(line) : null;
  if (!m || m[2] !== key) return { hit: false, text: line };
  if (value === null) return { hit: true, text: null };
  const p = parseValue(m[4]);
  return {
    hit: true,
    text: `${m[1]}${m[2]}${m[3]}${formatValue(value, p.quote)}${p.rest}`,
  };
}

function writeEnv(file: string, key: string, value: string | null) {
  const text = exists(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text === "" ? [] : text.split("\n");
  const out: string[] = [];
  let hit = false;
  for (const line of lines) {
    const replaced = replaceEnvLine(line, key, value);
    if (replaced.hit) hit = true;
    if (replaced.text !== null) out.push(replaced.text);
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
  return [
    meta(path.basename(file), text.replace(/\r?\n$/, ""), fs.statSync(file).mtimeMs, {
      editable: true,
      viewable: false,
    }),
  ];
}

/* ---------- github ---------- */
function gh(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The value goes to the child on stdin only; argv (visible in ps) carries names and the repo.
    const child = spawn(ghBin(), args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GH_TIMEOUT);
    child.stdout.on("data", (d) => {
      if (out.length < 1_000_000) out += d;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new VaultError(502, "Could not run the GitHub CLI."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new VaultError(502, "GitHub refused or did not answer."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}
async function readGithub(repo: string) {
  const rows = JSON.parse(await gh(["secret", "list", "-R", repo, "--json", "name,updatedAt"]));
  if (!Array.isArray(rows)) throw new VaultError(502, "GitHub sent an unreadable answer.");
  return rows
    .filter((r) => typeof r?.name === "string")
    .map((r) => ({
      key: r.name,
      length: null,
      hint: null,
      hash: null,
      mtime: Date.parse(r.updatedAt) || null,
      editable: ENV_KEY.test(r.name),
      viewable: false,
      valueHidden: true,
    }));
}

/* ---------- audit + lock ---------- */
function audit(action: string, source: Source | string, key: string) {
  try {
    const f = path.join(confDir(), "vault-audit.jsonl");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(
      f,
      JSON.stringify({
        ts: new Date().toISOString(),
        action,
        source: typeof source === "string" ? source : source.id,
        key,
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {}
}
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const r = chain.then(fn, fn);
  chain = r.catch(() => {});
  return r;
};

/* ---------- extra entries: listed beside the real keys, never written to a real file or to GitHub ---------- */
const extrasFile = () => path.join(confDir(), "vault-decoys.json");
const rand = (n: number, set: string) =>
  Array.from(crypto.randomBytes(n), (b) => set[b % set.length]).join("");
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  B64U = B62 + "-_";
function seedExtras(): Extra[] {
  const srcs = sources(),
    own = srcs.find(ownEnv) ?? srcs.find((s) => s.kind === "env");
  const spread = srcs.filter((s) => (s.kind === "env" || s.kind === "github") && s !== own);
  const at = new Date().toISOString(),
    list: Extra[] = [];
  const aws = path.join(home(), ".aws", "credentials");
  const sec = own && exists(aws) ? iniSection(fs.readFileSync(aws, "utf8"), "backup-admin") : null;
  for (const [from, key] of [
    ["aws_access_key_id", "AWS_ACCESS_KEY_ID"],
    ["aws_secret_access_key", "AWS_SECRET_ACCESS_KEY"],
    ["region", "AWS_REGION"],
  ] as const) {
    if (own && sec && sec[from])
      list.push({
        store: own.id,
        key,
        value: sec[from],
        viewable: true,
        updatedAt: at,
      });
  }
  const hex = () => crypto.randomBytes(4).toString("hex");
  const plain: [string, string][] = [
    ["STRIPE_SECRET_KEY", `sk_live_${rand(32, B62)}`],
    ["ANTHROPIC_API_KEY_OLD", `sk-ant-api03-${rand(93, B64U)}AA`],
    ["DATABASE_URL", `postgres://app:${rand(24, B62)}@db-${hex()}.internal:5432/app`],
    [
      "SLACK_BOT_TOKEN",
      `xoxb-${rand(11, "0123456789")}-${rand(12, "0123456789")}-${rand(24, B62)}`,
    ],
  ];
  plain.forEach(([key, value], i) => {
    const t = spread.length ? spread[i % spread.length] : own;
    if (t) list.push({ store: t.id, key, value, viewable: false, updatedAt: at });
  });
  try {
    saveExtras(list);
  } catch {}
  return list;
}
function loadExtras(): Extra[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(extrasFile(), "utf8"));
  } catch (e: any) {
    return e?.code === "ENOENT" ? seedExtras() : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (x: any) =>
        x &&
        typeof x.store === "string" &&
        typeof x.key === "string" &&
        typeof x.value === "string" &&
        x.key,
    )
    .map((x: any) => ({
      store: x.store,
      key: x.key,
      value: x.value,
      viewable: x.viewable === true,
      updatedAt: Number.isNaN(Date.parse(x.updatedAt))
        ? new Date().toISOString()
        : new Date(x.updatedAt).toISOString(),
    }));
}
const saveExtras = (l: Extra[]) => atomicWrite(extrasFile(), JSON.stringify(l, null, 2) + "\n");
const virtual = (label: string): Source => ({
  id: sid(`label:${label}`),
  kind: "virtual",
  label,
});
const owns = (s: Source, x: Extra) =>
  s.kind === "virtual" ? x.store === s.label : x.store === s.id;
const extraGroups = (all: Extra[], srcs: Source[]) => {
  const ids = new Set(srcs.map((s) => s.id));
  return [
    ...new Set(all.map((x) => x.store).filter((st) => !ids.has(st) && !/^[0-9a-f]{12}$/.test(st))),
  ].map(virtual);
};

/* ---------- operations ---------- */
const ownEnv = (s: Source) =>
  !!s.file &&
  s.kind === "env" &&
  (() => {
    try {
      return fs.realpathSync(s.file!) === fs.realpathSync(path.join(confDir(), "env"));
    } catch {
      return s.file === path.join(confDir(), "env");
    }
  })();

async function realEntries(s: Source, iron: IronMap | null = null): Promise<any[]> {
  if (s.kind === "github") return readGithub(s.repo!);
  if (s.kind === "virtual" || !exists(s.file!)) return [];
  return s.kind === "env" ? readEnv(s.file!, iron) : readSingle(s.file!);
}
const shape = (s: Source, x: Extra, mtime: number | null) =>
  s.kind === "github"
    ? {
        key: x.key,
        length: null,
        hint: null,
        hash: null,
        mtime: Date.parse(x.updatedAt) || null,
        editable: ENV_KEY.test(x.key),
        viewable: x.viewable,
        valueHidden: true,
      }
    : meta(x.key, x.value, mtime ?? (Date.parse(x.updatedAt) || 0), {
        editable: ENV_KEY.test(x.key),
        viewable: x.viewable,
      });

function listMtime(s: Source, extra: Extra[]): number | null {
  if (s.file && exists(s.file)) return fs.statSync(s.file).mtimeMs;
  if (s.kind === "virtual") return Math.max(0, ...extra.map((x) => Date.parse(x.updatedAt) || 0));
  return null;
}

async function listSource(
  s: Source,
  all: Extra[],
  showAll: boolean,
  opts: { mine?: boolean },
  iron: IronMap | null,
) {
  const base = {
    id: s.id,
    label: s.label,
    canAdd: s.kind === "env" || s.kind === "github",
  };
  try {
    const real = await realEntries(s, iron);
    const have = new Set(real.map((e) => e.key));
    const extra = all.filter((x) => owns(s, x) && !have.has(x.key));
    // every extra in a file group takes the file's mtime, like the real keys; a label group shares its newest time
    const mtime = listMtime(s, extra);
    let entries = [
      ...real.map((e) => ({ ...e, ...(opts.mine ? { mine: true } : {}) })),
      ...extra.map((x) => ({
        ...shape(s, x, mtime),
        ...(opts.mine ? { mine: false } : {}),
      })),
    ];
    if (s.kind === "env" || s.kind === "virtual")
      entries = entries.map((e) => ({ ...e, proxy: e.proxy ?? "unproxied" }));
    if ((s.kind === "env" || s.kind === "virtual") && !showAll)
      // iron-managed keys always show, whatever their name
      entries = entries.filter((entry) => SECRETISH.test(entry.key) || entry.proxy !== "unproxied");
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { ...base, entries };
  } catch (e) {
    return {
      ...base,
      entries: [],
      error: e instanceof VaultError ? e.message : "This source could not be read.",
    };
  }
}

export async function listVault(opts: { mine?: boolean } = {}) {
  const all = loadExtras(),
    srcs = sources(),
    showAll = config().showAllKeys;
  const iron = await ironStatus();
  const out = await Promise.all(
    [...srcs, ...extraGroups(all, srcs)].map((s) => listSource(s, all, showAll, opts, iron)),
  );
  return { sources: out, backup: backupStatus(), ironJob: ironJobSnapshot() };
}

function find(id: string): Source {
  const srcs = sources(),
    s = srcs.find((x) => x.id === id) ?? extraGroups(loadExtras(), srcs).find((x) => x.id === id);
  if (!s) throw new VaultError(404, "No such source.");
  return s;
}
function checkKey(s: Source, key: string) {
  if (!ENV_KEY.test(key) && !(s.kind === "single" && key === path.basename(s.file!)))
    throw new VaultError(400, "Key names use capital letters, digits and underscores.");
  if (s.kind === "single" && key !== path.basename(s.file!))
    throw new VaultError(400, "This file holds one value.");
}
export function checkValue(v: unknown): string {
  if (typeof v !== "string" || v === "") throw new VaultError(400, "Enter a value.");
  if (/[\n\r\0]/.test(v)) throw new VaultError(400, "A value cannot contain a line break or NUL.");
  if (Buffer.byteLength(v) > MAX_VALUE) throw new VaultError(400, "A value can be at most 8 KiB.");
  const shas = new Set([...(ironCached()?.values() ?? [])].map((e) => e.tokenSha));
  if (shas.has(sha256(v))) throw new VaultError(400, "That is a proxy token, paste the real key.");
  return v;
}
/* the extra entry behind (source, key), unless a real key of that name exists */
async function extraAt(s: Source, key: string): Promise<Extra | undefined> {
  const x = loadExtras().find((e) => owns(s, e) && e.key === key);
  if (!x || s.kind === "virtual") return x;
  try {
    if ((await realEntries(s)).some((e) => e.key === key)) return undefined;
  } catch {}
  return x;
}
type Client = { ip: string; ua: string };
const NOBODY: Client = { ip: "", ua: "" };
function alertExtra(what: string, key: string, c: Client) {
  // fire and forget; failures log a fixed line only. Never carries a value.
  void sendMail(`[Agent Console] ALERT: vault decoy ${what}`, [
    `Time: ${new Date().toISOString()}`,
    `Client IP: ${oneLine(c.ip, 80)}`,
    `User-agent: ${oneLine(c.ua)}`,
    `Key: ${key}`,
  ]).catch((e) => console.warn("vault alert failed:", oneLine(e?.message, 80)));
}

function setExtra(s: Source, key: string, v: string, c: Client) {
  const all = loadExtras(),
    at = all.findIndex((e) => owns(s, e) && e.key === key);
  all[at] = { ...all[at], value: v, updatedAt: new Date().toISOString() };
  saveExtras(all);
  audit("set", s, key);
  alertExtra("changed", key, c);
}

async function setReal(s: Source, key: string, v: string) {
  if (s.kind === "virtual") throw new VaultError(404, "No such key.");
  if (s.kind === "github") await gh(["secret", "set", key, "-R", s.repo!], v);
  else if (s.kind === "env") writeEnv(s.file!, key, v);
  else {
    const had = exists(s.file!) && fs.readFileSync(s.file!, "utf8").endsWith("\n");
    atomicWrite(s.file!, v + (had ? "\n" : ""));
  }
  audit("set", s, key);
}

/* ---------- iron-managed keys: the real value goes to iron, the file only ever holds the proxy token ---------- */
const isManaged = (iron: IronMap | null, key: string) =>
  iron ? iron.has(key) : KNOWN_MANAGED.has(key);

function envValues(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!exists(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = ENV_LINE.exec(line.replace(/\r$/, ""));
    if (m && !line.trimStart().startsWith("#")) out.set(m[2], parseValue(m[4]).value);
  }
  return out;
}

async function writeIronToken(s: Source, key: string, iron: IronMap) {
  const entry = iron.get(key)!;
  const current = envValues(s.file!).get(key);
  if (current !== undefined && sha256(current) === entry.tokenSha) return;
  const token = await ironToken(entry.name);
  if (!token) throw new VaultError(502, "iron set failed");
  const inFile = envValues(s.file!);
  const aliases = [...iron].filter(
    ([k, e]) => e.name === entry.name && (k === key || inFile.has(k)),
  );
  for (const [alias] of aliases) writeEnv(s.file!, alias, token);
}

function openSave(kind: JobKind, progress: Sink) {
  if (jobBusy()) throw new VaultError(409, "Another key save is still running.");
  return beginJob(kind, progress);
}

async function replaceOnIron(s: Source, key: string, v: string): Promise<string> {
  const iron = await ironStatus();
  if (!iron) throw new VaultError(502, ERR.unreachable);
  const entry = iron.get(key);
  if (!entry || !(await ironSet(entry.name, v))) throw new VaultError(502, ERR.setFailed);
  if (s.kind === "env") await writeIronToken(s, key, iron);
  return entry.name;
}

async function setProxied(s: Source, key: string, v: string, progress?: Sink) {
  const job = progress ? openSave("replace", progress) : null;
  stepStart(job, "set");
  let name: string;
  try {
    name = await replaceOnIron(s, key, v);
  } catch (e) {
    if (!job) throw e;
    failSave(job, e instanceof VaultError ? e.message : ERR.setFailed);
    return { ok: false };
  }
  audit("set", s, key);
  const result = { ok: true, proxied: true, ...(ownEnv(s) ? { restartNeeded: true } : {}) };
  if (!job) {
    scheduleBackup();
    return result;
  }
  job.name = name;
  stepDone(job, "set");
  startTail(job, { restartNeeded: ownEnv(s) });
  return result;
}

function alertProvider(name: string, hosts: string[], c: Client) {
  // fire and forget; names and hosts only, never a value
  void sendMail("[Agent Console] vault: iron provider added", [
    `Time: ${new Date().toISOString()}`,
    `Client IP: ${oneLine(c.ip, 80)}`,
    `User-agent: ${oneLine(c.ua)}`,
    `Provider: ${name}`,
    `Hosts: ${hosts.join(", ")}`,
  ]).catch((e) => console.warn("vault alert failed:", oneLine(e?.message, 80)));
}

function checkProviderSpec(raw: unknown, iron: IronMap | null): IronSpec {
  if (!iron) throw new VaultError(502, "iron unreachable, nothing saved");
  try {
    return validateSpec(raw, iron.keys());
  } catch (e) {
    if (e instanceof SpecError) throw new VaultError(400, e.message);
    throw e;
  }
}

async function storeProvider(s: Source, spec: IronSpec, v: string, job: Job | null) {
  stepStart(job, "provider");
  if (!(await ironProviderAdd(spec))) throw new VaultError(502, ERR.providerFailed);
  stepDone(job, "provider");
  stepStart(job, "set");
  if (!(await ironSet(spec.name, v))) throw new VaultError(502, ERR.setFailed);
  const iron = await ironStatus();
  if (!iron || !spec.envVars.every((k) => iron.has(k))) throw new VaultError(502, ERR.setFailed);
  for (const alias of spec.envVars) await writeIronToken(s, alias, iron);
  stepDone(job, "set");
}

/* add a provider on iron, store its real value there, and put only the proxy token in the env file */
export async function addIronProvider(
  rawSpec: unknown,
  value: unknown,
  c: Client = NOBODY,
  progress?: Sink,
) {
  checkValue(value);
  return serial(async () => {
    const s = sources().find(ownEnv);
    if (!s) throw new VaultError(400, "No env file to hold the proxy token.");
    const v = checkValue(value);
    const spec = checkProviderSpec(rawSpec, await ironStatus());
    const job = progress ? openSave("add", progress) : null;
    try {
      await storeProvider(s, spec, v, job);
    } catch (e) {
      if (!job) throw e;
      failSave(job, e instanceof VaultError ? e.message : ERR.setFailed);
      return { ok: false };
    }
    const hosts = specHosts(spec);
    audit("add-provider", s, `${spec.name} ${hosts.join(",")}`);
    stepStart(job, "pins");
    const warnings = await refreshEgress(hosts);
    alertProvider(spec.name, hosts, c);
    if (job) {
      job.name = spec.name;
      stepDone(job, "pins");
      startTail(job, { restartNeeded: true, warnings });
    } else scheduleBackup();
    return { ok: true, name: spec.name, hosts, warnings, restartNeeded: true };
  });
}

export function setSecret(
  id: string,
  key: string,
  value: unknown,
  c: Client = NOBODY,
  progress?: Sink,
) {
  const s = find(id);
  checkKey(s, key);
  checkValue(value);
  return serial(async () => {
    const iron = await ironStatus();
    const v = checkValue(value); // again, now that the token list is fresh
    if (s.kind === "env" && isManaged(iron, key)) return setProxied(s, key, v, progress);
    const x = await extraAt(s, key);
    if (x) setExtra(s, key, v, c);
    else await setReal(s, key, v);
    return { ok: true, ...(ownEnv(s) ? { restartNeeded: true } : {}) };
  });
}

function deleteExtra(s: Source, key: string, c: Client) {
  saveExtras(loadExtras().filter((e) => !(owns(s, e) && e.key === key)));
  audit("delete", s, key);
  alertExtra("changed", key, c);
}

async function deleteReal(s: Source, key: string) {
  if (s.kind === "virtual") throw new VaultError(404, "No such key.");
  if (s.kind === "github") await gh(["secret", "delete", key, "-R", s.repo!]);
  else if (s.kind === "env") writeEnv(s.file!, key, null);
  else {
    if (!exists(s.file!)) throw new VaultError(404, "No such key.");
    fs.unlinkSync(fs.realpathSync(s.file!));
  }
  audit("delete", s, key);
}

export function deleteSecret(id: string, key: string, c: Client = NOBODY) {
  const s = find(id);
  checkKey(s, key);
  return serial(async () => {
    if (s.kind === "env" && isManaged(await ironStatus(), key))
      throw new VaultError(400, "proxied key: use iron off");
    const x = await extraAt(s, key);
    if (x) deleteExtra(s, key, c);
    else await deleteReal(s, key);
    return { ok: true, ...(ownEnv(s) ? { restartNeeded: true } : {}) };
  });
}

/* ---------- add a store (env file under $HOME, or a GitHub repo) ---------- */
const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);
const storeId = (e: any) => sid(e.type === "env" ? `env:${e.path}` : `github:${e.repo}`);
function envHomeRoot(): string {
  try {
    return fs.realpathSync(home());
  } catch {
    throw new VaultError(500, "The vault is unavailable.");
  }
}

function envParentDir(want: string): string {
  try {
    return fs.realpathSync(path.dirname(want));
  } catch {
    throw new VaultError(400, "That folder does not exist.");
  }
}

function statEnvFile(file: string, root: string): fs.Stats | null {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(file);
  } catch {}
  if (st?.isSymbolicLink()) {
    let to = "";
    try {
      to = fs.realpathSync(file);
    } catch {}
    if (!to || !inside(root, to))
      throw new VaultError(400, "The file must be inside your home folder.");
    st = fs.statSync(file);
  }
  return st;
}

function envStoreEntry(raw: string) {
  if (!raw || /[\0\n\r]/.test(raw) || !(raw.startsWith("~/") || path.isAbsolute(raw)))
    throw new VaultError(400, "Use a path like ~/project/.env.");
  const want = path.resolve(expand(raw));
  const root = envHomeRoot();
  const parent = envParentDir(want);
  if (!inside(root, parent) || !path.basename(want))
    throw new VaultError(400, "The file must be inside your home folder.");
  const file = path.join(parent, path.basename(want));
  const st = statEnvFile(file, root);
  if (st && !st.isFile()) throw new VaultError(400, "That path is not a file.");
  if (!st) {
    try {
      fs.closeSync(fs.openSync(file, "wx", 0o600));
    } catch {
      throw new VaultError(400, "Could not create that file.");
    }
  }
  return { type: "env", path: file };
}

async function githubStoreEntry(raw: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(raw)) throw new VaultError(400, "Use owner/name.");
  try {
    await gh(["repo", "view", raw, "--json", "name"]);
  } catch {
    throw new VaultError(400, "GitHub could not find that repo.");
  }
  return { type: "github", repo: raw };
}

async function newStoreEntry(type: unknown, raw: string) {
  if (type === "env") return envStoreEntry(raw);
  if (type === "github") return githubStoreEntry(raw);
  throw new VaultError(400, "Choose env file or GitHub repo.");
}

function saveStoreEntry(entry: any) {
  const cfgFile = path.join(confDir(), "vault-sources.json");
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {}
  if (Array.isArray(cfg)) cfg = { sources: cfg };
  if (!cfg || typeof cfg !== "object") cfg = {};
  cfg.extra = [...(Array.isArray(cfg.extra) ? cfg.extra : []), entry];
  atomicWrite(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
}

export function addStore(type: unknown, value: unknown) {
  return serial(async () => {
    const raw = typeof value === "string" ? value.trim() : "";
    const entry = await newStoreEntry(type, raw);
    const id = storeId(entry),
      known = sources().find((x) => x.id === id);
    if (known) return { ok: true, id, label: known.label };
    saveStoreEntry(entry);
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
    for (const line of fs
      .readFileSync(path.join(home(), ".config", "agentmail", "env"), "utf8")
      .split("\n")) {
      const m = ENV_LINE.exec(line);
      if (m && !line.trimStart().startsWith("#")) out[m[2]] = parseValue(m[4]).value;
    }
  } catch {}
  return out;
}
const oneLine = (v: unknown, n = 200) =>
  String(v ?? "")
    .replace(/[\r\n\0]+/g, " ")
    .slice(0, n);

async function sendMail(subject: string, lines: string[]) {
  const env = agentmailEnv(),
    inbox = env.AGENTMAIL_INBOX,
    apiKey = env.AGENTMAIL_API_KEY;
  if (!inbox || !apiKey) throw new Error("no mail credentials");
  const cfg = config(),
    base = process.env.VAULT_ALERT_BASE || "https://api.agentmail.to";
  const r = await fetch(`${base}/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: cfg.alertTo,
      cc: cfg.alertCc,
      subject,
      text: lines.join("\n") + "\n",
    }),
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
// Asking for NDJSON streams the save steps; without it the old JSON answer stays as is.
const live =
  (handler: (req: express.Request, sink?: Sink) => Promise<any>): express.RequestHandler =>
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    const wantsLive = String(req.headers.accept).includes("application/x-ndjson");
    const stream = ndjsonStream(res);
    try {
      const out = await handler(req, wantsLive ? stream.sink : undefined);
      if (!stream.started()) res.json(out);
    } catch (caught: any) {
      const known = caught instanceof VaultError;
      if (stream.started())
        stream.sink({ t: "error", error: known ? caught.message : ERR.setFailed });
      else
        res.status(known ? caught.status : 500).json({
          error: known ? caught.message : "The vault is unavailable.",
        });
    }
  };

async function retryJobHandler(_req: express.Request, sink?: Sink) {
  const outcome = resumeJob(sink ?? (() => {}));
  if (outcome === "busy") throw new VaultError(409, "Another key save is still running.");
  if (outcome === "none") throw new VaultError(409, "No key save to retry.");
  return { ok: true, ironJob: ironJobSnapshot() };
}
const parseJson = express.json({ limit: "16kb" });
export function mountVault(app: express.Express, sameOrigin: express.RequestHandler) {
  // Fixed messages only: a parser error can quote the body, which may hold a secret.
  const body: express.RequestHandler = (req, res, next) =>
    parseJson(req, res, (err?: any) =>
      err
        ? void res.status(err.status === 413 ? 413 : 400).json({
            error: err.status === 413 ? "Request too large." : "Invalid request.",
          })
        : next(),
    );
  const guard =
    (fn: (req: express.Request) => Promise<any>): express.RequestHandler =>
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        res.json(await fn(req));
      } catch (e: any) {
        res.status(e instanceof VaultError ? e.status : 500).json({
          error: e instanceof VaultError ? e.message : "The vault is unavailable.",
        });
      }
    };
  const client = (req: express.Request): Client => {
    const fwd = oneLine(req.headers["x-forwarded-for"], 120);
    return {
      ip: `${req.ip || req.socket.remoteAddress || ""}${fwd ? ` (forwarded ${fwd})` : ""}`,
      ua: oneLine(req.headers["user-agent"]),
    };
  };
  const pk = createPasskeys({
    confDir,
    rpId: () => config().rpId,
    origins: () => config().origins,
    atomicWrite,
    audit,
    alert: sendMail,
  });
  pk.mount(app, sameOrigin, body);
  // `mine` marks real vs extra entries, and only goes to a client holding a live grant
  app.get(
    "/api/vault",
    guard(async (req) => listVault({ mine: pk.granted(req) })),
  );
  app.post(
    "/api/vault/stores",
    sameOrigin,
    pk.requireGrant(false),
    body,
    guard((req) => addStore(req.body?.type, req.body?.value)),
  );
  app.get(
    "/api/vault/iron/presets",
    guard(async () => ({ presets: presets() })),
  );
  app.post(
    "/api/vault/iron/providers",
    sameOrigin,
    pk.requireGrant(true),
    body,
    live((req, sink) => addIronProvider(req.body?.spec, req.body?.value, client(req), sink)),
  );
  app.put(
    "/api/vault/:source/:key",
    sameOrigin,
    pk.requireGrant(false),
    body,
    live((req, sink) =>
      setSecret(req.params.source, req.params.key, req.body?.value, client(req), sink),
    ),
  );
  app.post("/api/vault/iron/job/retry", sameOrigin, pk.requireGrant(false), live(retryJobHandler));
  app.post(
    "/api/vault/backup/retry",
    sameOrigin,
    pk.requireGrant(false),
    guard(async () => {
      void retryBackup();
      return { ok: true, backup: backupStatus() };
    }),
  );
  app.post(
    "/api/vault/:source/:key/reveal",
    sameOrigin,
    guard(async (req) => revealSecret(req.params.source, req.params.key, client(req))),
  );
  app.delete(
    "/api/vault/:source/:key",
    sameOrigin,
    pk.requireGrant(true),
    guard((req) => deleteSecret(req.params.source, req.params.key, client(req))),
  );
  return { expireGrants: pk.expireGrants, resetAlertLimit: pk.resetAlertLimit }; // test hooks
}
