// Prompt overhead: how many bytes of instructions, skills and agents each harness sees before the first user turn.
// Measured from files only (harness built-ins are not included), so totals are a lower bound. File text never leaves this module:
// the result carries sizes, source paths, item names and `## ` headings (<=80 chars) only.
import crypto from "node:crypto";
import fs from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sensitive } from "./files.ts";
import { SESSION_INSTRUCTIONS } from "./providers/console-mcp.mjs";
import { brainInstructions, STYLE_FILE, stylePreamble } from "./providers/brain.ts";
import { claudeConfigDir } from "./providers/claude-accounts.ts";

type Kind =
  | "instructions"
  | "import"
  | "brain-index"
  | "style"
  | "session"
  | "brain-contract"
  | "skills"
  | "agents";
type SkipReason = "sensitive" | "outside-home" | "too-large" | "cycle" | "limit";
type DupSection = { heading: string; bytes: number; alsoIn: string[] };
type Source = {
  id: string;
  kind: Kind;
  label: string;
  path: string | null;
  bytes: number;
  tokensEst: number;
  missing?: true;
  count?: number;
  hidden?: number;
  items?: { name: string; bytes: number }[];
  dupSections: DupSection[];
  dupOf?: string;
};
type Provider = {
  id: string;
  label: string;
  totalBytes: number;
  tokensEst: number;
  sources: Source[];
};
type Skipped = { path: string; reason: SkipReason };
export type Overhead = {
  generatedAt: string;
  cwd: string;
  estimate: "bytes/4";
  providers: Provider[];
  duplicates: { provider: string; heading: string; bytes: number; sources: string[] }[];
  skipped: Skipped[];
};

const MAX_FILE = 512 * 1024,
  MAX_DEPTH = 5,
  MAX_FILES = 400,
  HEAD = 4096,
  TTL = 60_000;
const tokens = (bytes: number) => Math.ceil(bytes / 4);
const sha1 = (text: string) => crypto.createHash("sha1").update(text).digest("hex");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const within = (root: string, file: string) => {
  const r = path.relative(root, file);
  return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r));
};

type Def = {
  id: string;
  label: string;
  kind: "claude" | "codex" | "pi";
  config: string;
  instructions: { file: string; label: string }[];
  imports: boolean;
  skillDirs: string[];
  agentsDir?: string;
  agentExt?: ".md" | ".toml";
  overrides?: string;
  harness: ("style" | "contract" | "session" | "index")[];
};

const resolved = (p: string) => realpath(p).catch(() => path.resolve(p));
async function sameSet(a: Def, b: Def): Promise<boolean> {
  const key = async (d: Def) =>
    (
      await Promise.all(
        [
          path.join(d.config, "CLAUDE.md"),
          path.join(d.config, "skills"),
          d.agentsDir ?? path.join(d.config, "agents"),
        ].map(resolved),
      )
    ).join("\0");
  return (await key(a)) === (await key(b));
}

async function layout(home: string, cwd: string): Promise<Def[]> {
  const repos = path.join(home, "repos");
  const extra = (name: string) =>
    path.resolve(cwd) === path.resolve(repos)
      ? []
      : [{ file: path.join(cwd, name), label: `Project ${name}` }];
  const shared = path.join(home, ".agents", "skills");
  const claude = (id: string, label: string, account?: string): Def => {
    const config = claudeConfigDir(account, process.env, home);
    return {
      id,
      label,
      kind: "claude",
      config,
      imports: true,
      harness: ["style", "session", "index"],
      instructions: [
        { file: path.join(config, "CLAUDE.md"), label: "User CLAUDE.md" },
        { file: path.join(repos, "CLAUDE.md"), label: "Workspace CLAUDE.md" },
        ...extra("CLAUDE.md"),
      ],
      skillDirs: [path.join(config, "skills"), shared],
      agentsDir: path.join(config, "agents"),
      agentExt: ".md",
      overrides: path.join(config, "settings.json"),
    };
  };
  const other = (
    id: string,
    label: string,
    kind: "codex" | "pi",
    config: string,
    userFile: string,
  ): Def => ({
    id,
    label,
    kind,
    config,
    imports: false,
    harness: ["style", "contract", "session", "index"],
    instructions: [
      { file: userFile, label: "User AGENTS.md" },
      { file: path.join(repos, "AGENTS.md"), label: "Workspace AGENTS.md" },
      ...extra("AGENTS.md"),
    ],
    skillDirs: [path.join(config, kind === "pi" ? path.join("agent", "skills") : "skills"), shared],
    ...(kind === "codex"
      ? { agentsDir: path.join(config, "agents"), agentExt: ".toml" as const }
      : {}),
  });
  const defs = [claude("claude", "Claude")];
  const nefro = claudeConfigDir("nefro", process.env, home);
  if (fs.existsSync(nefro)) {
    const second = claude("claude:nefro", "Claude (nefro)", "nefro");
    // Same resolved instruction set (CLAUDE.md, skills dir, agents dir): one column naming both accounts.
    if (await sameSet(defs[0], second)) defs[0].label = "Claude (both accounts)";
    else defs.push(second);
  }
  const codex = path.join(home, ".codex"),
    pi = path.join(home, ".pi");
  defs.push(
    other("codex", "Codex", "codex", codex, path.join(codex, "AGENTS.md")),
    other("pi", "Pi", "pi", pi, path.join(pi, "agent", "AGENTS.md")),
  );
  return defs;
}

// Every file the measurement depends on: used to invalidate the cache early when something changes.
async function stampOf(home: string, cwd: string): Promise<string> {
  const files = new Set<string>([
    path.join(home, "repos", "brain", "wiki", "index.md"),
    STYLE_FILE,
  ]);
  for (const d of await layout(home, cwd)) {
    d.instructions.forEach((i) => files.add(i.file));
    d.skillDirs.forEach((s) => files.add(s));
    if (d.agentsDir) files.add(d.agentsDir);
    if (d.overrides) files.add(d.overrides);
  }
  const parts = await Promise.all(
    [...files].map((f) =>
      stat(f).then(
        (s) => `${f}:${s.mtimeMs}:${s.size}`,
        () => `${f}:-`,
      ),
    ),
  );
  return parts.join("|");
}

type Req = {
  home: string;
  realHome: string;
  files: number;
  skipped: Skipped[];
  texts: Map<string, string>;
};

function skip(req: Req, p: string, reason: SkipReason) {
  if (!req.skipped.some((s) => s.path === p && s.reason === reason))
    req.skipped.push({ path: p, reason });
}

// Gate every read: requested name and real target must be non-sensitive, inside home, and a sensible size.
async function gate(
  req: Req,
  p: string,
  maxSize = MAX_FILE,
): Promise<{ real: string; size: number } | "missing" | null> {
  if (sensitive(p)) {
    skip(req, p, "sensitive");
    return null;
  }
  if (!within(req.home, p) && !within(req.realHome, p)) {
    skip(req, p, "outside-home");
    return null;
  }
  let real: string, size: number;
  try {
    real = await realpath(p);
    const s = await stat(real);
    if (!s.isFile()) return "missing";
    size = s.size;
  } catch {
    return "missing";
  }
  if (sensitive(real)) {
    skip(req, p, "sensitive");
    return null;
  }
  if (!within(req.realHome, real) && !within(req.home, real)) {
    skip(req, p, "outside-home");
    return null;
  }
  if (size > maxSize) {
    skip(req, p, "too-large");
    return null;
  }
  if (req.files >= MAX_FILES) {
    skip(req, p, "limit");
    return null;
  }
  req.files++;
  return { real, size };
}

async function text(req: Req, real: string): Promise<string> {
  let t = req.texts.get(real);
  if (t === undefined) {
    t = await readFile(real, "utf8");
    req.texts.set(real, t);
  }
  return t;
}

async function head(real: string): Promise<string> {
  const fh = await open(real, "r");
  try {
    const buf = Buffer.alloc(HEAD);
    const { bytesRead } = await fh.read(buf, 0, HEAD, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

function importsOf(body: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    for (const m of raw.replace(/`[^`]*`/g, "").matchAll(/(?<=^|\s)@(\S+)/g)) {
      const token = m[1].replace(/[.,;:!?)\]]+$/, "");
      if (token) out.push(token);
    }
  }
  return out;
}

function frontmatter(body: string): Record<string, string> {
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const lines = (m ? m[1] : "").split(/\r?\n/),
    out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (!value || /^[>|][+-]?$/.test(value)) {
      const rest: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) rest.push(lines[++i].trim());
      value = rest.join(" ");
    }
    out[kv[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function tomlMeta(body: string): { name?: string; description?: string } {
  const str = (key: string) => {
    const m = body.match(
      new RegExp(`^${key}\\s*=\\s*(?:"""([\\s\\S]*?)"""|"((?:[^"\\\\]|\\\\.)*)")`, "m"),
    );
    return m ? (m[1] ?? m[2]) : undefined;
  };
  return { name: str("name"), description: str("description") };
}

async function build(home: string, cwd: string): Promise<Overhead> {
  const realHome = await realpath(home).catch(() => home);
  const req: Req = { home, realHome, files: 0, skipped: [], texts: new Map() };
  const providers: Provider[] = [],
    duplicates: Overhead["duplicates"] = [];
  const indexFile = path.join(home, "repos", "brain", "wiki", "index.md");
  const display = (p: string) => (within(home, p) ? "~/" + path.relative(home, p) : p);
  const style = stylePreamble(),
    contract = brainInstructions();

  for (const def of await layout(home, cwd)) {
    const sources: Source[] = [],
      bodies = new Map<string, string>(),
      seen = new Set<string>();
    const add = (
      s: Omit<Source, "tokensEst" | "dupSections" | "id"> & { body?: string },
    ): Source => {
      const { body, ...rest } = s;
      const src: Source = {
        id: `${def.id}-${sources.length}`,
        ...rest,
        tokensEst: tokens(s.bytes),
        dupSections: [],
      };
      if (body !== undefined) bodies.set(src.id, body);
      sources.push(src);
      return src;
    };

    const walk = async (
      file: string,
      kind: Kind,
      label: string,
      depth: number,
      stack: string[],
      root: boolean,
    ) => {
      if (depth > MAX_DEPTH) {
        skip(req, file, "limit");
        return;
      }
      const g = await gate(req, file);
      if (g === null) return;
      if (g === "missing") {
        if (root) add({ kind, label, path: file, bytes: 0, missing: true });
        return;
      }
      if (stack.includes(g.real)) {
        skip(req, file, "cycle");
        return;
      }
      if (seen.has(g.real)) return;
      seen.add(g.real);
      const body = await text(req, g.real);
      add({ kind, label, path: file, bytes: Buffer.byteLength(body), body });
      if (!def.imports) return;
      for (const token of importsOf(body)) {
        const target = token.startsWith("~/")
          ? path.join(home, token.slice(2))
          : path.resolve(path.dirname(g.real), token);
        if (sensitive(target)) {
          skip(req, target, "sensitive");
          continue;
        }
        if (!target.endsWith(".md")) continue;
        await walk(target, "import", display(target), depth + 1, [...stack, g.real], false);
      }
    };

    for (const i of def.instructions) await walk(i.file, "instructions", i.label, 0, [], true);

    if (def.harness.includes("style"))
      add({
        kind: "style",
        label: "Style preamble",
        path: STYLE_FILE,
        bytes: Buffer.byteLength(style),
        body: style,
        ...(style ? {} : { missing: true as const }),
      });
    if (def.harness.includes("contract"))
      add({
        kind: "brain-contract",
        label: "Brain save contract",
        path: null,
        bytes: Buffer.byteLength(contract),
        body: contract,
      });
    if (def.harness.includes("session"))
      add({
        kind: "session",
        label: "Session instructions",
        path: null,
        bytes: Buffer.byteLength(SESSION_INSTRUCTIONS),
        body: SESSION_INSTRUCTIONS,
      });
    if (def.harness.includes("index")) {
      const g = await gate(req, indexFile);
      if (g && g !== "missing") {
        const body = (await text(req, g.real)).trim();
        add({
          kind: "brain-index",
          label: "Brain index",
          path: indexFile,
          bytes: Buffer.byteLength(body),
          body,
        });
      } else if (g === "missing")
        add({
          kind: "brain-index",
          label: "Brain index",
          path: indexFile,
          bytes: 0,
          missing: true,
        });
    }

    // skills: only name + description reach the prompt; hidden ones are not listed
    let hiddenOverrides = new Set<string>();
    if (def.overrides) {
      try {
        const g = await gate(req, def.overrides);
        if (g && g !== "missing") {
          const o = JSON.parse(await text(req, g.real))?.skillOverrides ?? {};
          hiddenOverrides = new Set(
            Object.entries(o)
              .filter(([, v]) => v === "user-invocable-only" || v === "off")
              .map(([k]) => k),
          );
        }
      } catch {
        /* unreadable settings: nothing hidden */
      }
    }
    const items: { name: string; bytes: number }[] = [],
      skillSeen = new Set<string>();
    let hidden = 0;
    for (const dir of def.skillDirs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const g = await gate(req, path.join(dir, e.name, "SKILL.md"));
        if (!g || g === "missing" || skillSeen.has(g.real)) continue;
        skillSeen.add(g.real);
        const fm = frontmatter(await head(g.real)),
          name = fm.name || e.name;
        if (
          hiddenOverrides.has(name) ||
          hiddenOverrides.has(e.name) ||
          /^true$/i.test(fm["disable-model-invocation"] ?? "")
        ) {
          hidden++;
          continue;
        }
        items.push({ name, bytes: name.length + (fm.description ?? "").length });
      }
    }
    if (items.length || hidden)
      add({
        kind: "skills",
        label: "Skills",
        path: def.skillDirs[0],
        bytes: items.reduce((n, i) => n + i.bytes, 0),
        count: items.length,
        hidden,
        items: [...items].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
      });

    if (def.agentsDir && def.agentExt) {
      const list: { name: string; bytes: number }[] = [];
      const entries = await readdir(def.agentsDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.name.endsWith(def.agentExt)) continue;
        const g = await gate(req, path.join(def.agentsDir, e.name));
        if (!g || g === "missing") continue;
        const body = await head(g.real),
          meta = def.agentExt === ".toml" ? tomlMeta(body) : frontmatter(body);
        const name = meta.name || e.name.slice(0, -def.agentExt.length);
        list.push({ name, bytes: name.length + (meta.description ?? "").length });
      }
      if (list.length)
        add({
          kind: "agents",
          label: "Agents",
          path: def.agentsDir,
          bytes: list.reduce((n, i) => n + i.bytes, 0),
          count: list.length,
          items: [...list].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
        });
    }

    // duplicates: identical whole files, then identical `## ` sections across different sources
    const wholes = new Map<string, string>(),
      groups = new Map<string, { heading: string; bytes: number; ids: string[] }>();
    for (const src of sources) {
      const body = bodies.get(src.id);
      if (body === undefined || !body.trim()) continue;
      const whole = sha1(squash(body));
      if (wholes.has(whole)) {
        src.dupOf = wholes.get(whole);
        continue;
      }
      wholes.set(whole, src.id);
      const seenHere = new Set<string>();
      for (const chunk of body.split(/^(?=## )/m)) {
        if (!chunk.startsWith("## ")) continue;
        const norm = squash(chunk);
        if (norm.length < 24) continue;
        const h = sha1(norm);
        if (seenHere.has(h)) continue;
        seenHere.add(h);
        const g = groups.get(h) ?? {
          heading: squash(chunk.split("\n")[0].slice(3)).slice(0, 80),
          bytes: Buffer.byteLength(chunk.trimEnd()),
          ids: [],
        };
        g.ids.push(src.id);
        groups.set(h, g);
      }
    }
    for (const g of groups.values()) {
      if (g.ids.length < 2) continue;
      duplicates.push({ provider: def.id, heading: g.heading, bytes: g.bytes, sources: g.ids });
      for (const id of g.ids)
        sources
          .find((s) => s.id === id)!
          .dupSections.push({
            heading: g.heading,
            bytes: g.bytes,
            alsoIn: g.ids.filter((x) => x !== id),
          });
    }

    const totalBytes = sources.reduce((n, s) => n + s.bytes, 0);
    providers.push({
      id: def.id,
      label: def.label,
      totalBytes,
      tokensEst: tokens(totalBytes),
      sources,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    cwd,
    estimate: "bytes/4",
    providers,
    duplicates,
    skipped: req.skipped,
  };
}

const cache = new Map<string, { at: number; stamp: string; value: Overhead }>();
const inflight = new Map<string, { stamp: string; promise: Promise<Overhead> }>();

export async function promptOverhead(
  opts: { home?: string; cwd?: string } = {},
): Promise<Overhead> {
  const home = opts.home ?? os.homedir(),
    cwd = opts.cwd ?? path.join(home, "repos");
  const key = `${home}\0${cwd}`,
    stamp = await stampOf(home, cwd);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < TTL) return hit.value;
  const running = inflight.get(key);
  if (running?.stamp === stamp) return running.promise;
  const promise = build(home, cwd).then(
    (value) => {
      cache.set(key, { at: Date.now(), stamp, value });
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
      return value;
    },
    (err) => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, { stamp, promise });
  return promise;
}
