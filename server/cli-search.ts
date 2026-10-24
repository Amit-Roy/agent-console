import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFESTS = [
  "/home/coder/repos/brain/tools.json",
  "/home/coder/repos/dotfiles/tools.json",
  path.join(ROOT, "tools.json"),
].join(":");

interface CliEntry {
  name: string;
  location: string;
  description: string;
  usage: string[];
}

const textList = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, max)
    : [];

function resolveLocation(manifestDir: string, raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  if (raw.includes("/")) return path.resolve(manifestDir, raw);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, raw);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return raw;
}

function manifestPaths(): string[] {
  const raw = process.env.AGENT_CONSOLE_TOOL_MANIFESTS || DEFAULT_MANIFESTS;
  return raw.split(":").filter(Boolean);
}

const mtimeOf = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
};

/** BM25 search over CLI manifests. Tags are indexed but never printed. */
export class CliSearch {
  private db?: DatabaseSync;
  private signature = "";
  private entries: CliEntry[] = [];
  private footer: string[] = [];

  private load() {
    const files = manifestPaths();
    const signature = files.map((f) => `${f}@${mtimeOf(f)}`).join("|");
    if (this.db && signature === this.signature) return;
    this.signature = signature;
    this.db?.close();
    this.db = new DatabaseSync(":memory:");
    this.db.exec("CREATE VIRTUAL TABLE cli_fts USING fts5(name, tags, description, idx UNINDEXED)");
    this.entries = [];
    this.footer = [];
    const insert = this.db.prepare(
      "INSERT INTO cli_fts(name,tags,description,idx) VALUES (?,?,?,?)",
    );
    for (const file of files) this.loadManifest(file, insert);
  }

  private loadManifest(file: string, insert: ReturnType<DatabaseSync["prepare"]>) {
    let doc: any;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!doc || !Array.isArray(doc.tools)) throw new Error("no tools array");
    } catch (e: any) {
      this.footer.push(`manifest unavailable: ${file} (${e?.code || e?.message || "invalid"})`);
      return;
    }
    const internal = new Set(textList(doc.internal, 10_000));
    const dir = path.dirname(file);
    for (const tool of doc.tools) {
      if (typeof tool?.name !== "string" || !tool.name || internal.has(tool.name)) continue;
      const entry: CliEntry = {
        name: tool.name,
        location: resolveLocation(dir, tool.path),
        description: typeof tool.description === "string" ? tool.description : "",
        usage: textList(tool.usage, 3),
      };
      insert.run(
        entry.name,
        textList(tool.tags, 50).join(" "),
        entry.description,
        this.entries.length,
      );
      this.entries.push(entry);
    }
  }

  search(input: { terms?: unknown; limit?: unknown }): string {
    const terms = Array.isArray(input?.terms)
      ? input.terms.filter((t): t is string => typeof t === "string")
      : [];
    if (!terms.length || terms.length > 10)
      throw new Error("terms must be an array of 1-10 strings.");
    const limit = Math.min(20, Math.max(1, Math.trunc(Number(input.limit)) || 5));
    const tokens = [
      ...new Set(
        terms.flatMap((t) => [...t.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => m[0])),
      ),
    ].slice(0, 40);
    if (!tokens.length) throw new Error("terms need words or numbers.");
    this.load();
    const label = `[${terms.join(", ")}]`;
    const total = this.entries.length;
    const match = tokens.map((t) => `"${t}"*`).join(" OR ");
    const rows = total
      ? (this.db!.prepare(
          "SELECT idx FROM cli_fts WHERE cli_fts MATCH ? ORDER BY bm25(cli_fts,5.0,3.0,2.0), name LIMIT ?",
        ).all(match, limit) as { idx: number | string }[])
      : [];
    const lines = rows.length
      ? [`${rows.length} of ${total} CLIs for ${label}:`]
      : [`0 of ${total} CLIs for ${label}; try broader terms`];
    for (const row of rows) {
      const e = this.entries[Number(row.idx)];
      lines.push(`${e.name}: ${e.description} ${e.location}`.trimEnd());
      for (const u of e.usage) lines.push(`  ${u}`);
    }
    return [...lines, ...this.footer].join("\n");
  }
}
