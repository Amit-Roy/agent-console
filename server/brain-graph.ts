import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BRAIN_BIN } from "./providers/brain.ts";

// Searchable view of the shared brain wiki. The `brain` CLI owns the parsing (`brain graph --json`, `brain search --json`); this module only
// runs it without a shell, caches the graph until a page changes, and serves raw page markdown from a fixed set of brain directories.
const run = promisify(execFile);
const LAYER_DIRS = ["wiki", "ops", "tags"] as const;
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const MAX_QUERY = 200;
const LACKS_GRAPH = "brain CLI lacks graph support";

export class BrainGraphError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Graph = {
  v: number;
  pages: unknown[];
  tags: unknown[];
  edges: unknown[];
  generatedAt: string;
};

// Newest mtime across the watched directories and the markdown files in them. A directory mtime alone misses in-place edits.
function treeStamp(root: string): string {
  let newest = 0;
  let files = 0;
  for (const dir of LAYER_DIRS) {
    const base = path.join(root, dir);
    try {
      newest = Math.max(newest, fs.statSync(base).mtimeMs);
      for (const name of fs.readdirSync(base)) {
        if (!name.endsWith(".md")) continue;
        files++;
        newest = Math.max(newest, fs.statSync(path.join(base, name)).mtimeMs);
      }
    } catch {
      // a missing layer directory just contributes nothing
    }
  }
  return `${newest}:${files}`;
}

export class BrainGraph {
  bin: string;
  root: string;
  #cache?: { stamp: string; graph: Graph };
  #inflight?: { stamp: string; promise: Promise<Graph> };

  constructor(opts: { bin?: string; root?: string } = {}) {
    this.bin = opts.bin ?? BRAIN_BIN;
    this.root = opts.root ?? path.dirname(path.dirname(this.bin));
  }

  async #json(args: string[]): Promise<any> {
    let stdout: string;
    try {
      const result = await run(this.bin, args, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, BRAIN_NO_NUDGE: "1" },
      });
      stdout = String(result.stdout);
    } catch {
      throw new BrainGraphError(503, LACKS_GRAPH);
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new BrainGraphError(503, LACKS_GRAPH);
    }
  }

  async graph(): Promise<Graph> {
    const stamp = treeStamp(this.root);
    if (this.#cache?.stamp === stamp) return this.#cache.graph;
    if (this.#inflight?.stamp === stamp) return this.#inflight.promise;
    const promise = this.#json(["graph", "--json"]).then((data) => {
      if (
        !data ||
        typeof data !== "object" ||
        !Array.isArray(data.pages) ||
        !Array.isArray(data.tags) ||
        !Array.isArray(data.edges)
      )
        throw new BrainGraphError(503, LACKS_GRAPH);
      const graph: Graph = { ...data, generatedAt: new Date().toISOString() };
      this.#cache = { stamp, graph };
      return graph;
    });
    const tracked = { stamp, promise };
    this.#inflight = tracked;
    const clear = () => {
      if (this.#inflight === tracked) this.#inflight = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  async search(query: string): Promise<unknown[]> {
    const terms = query
      .slice(0, MAX_QUERY)
      .split(/\s+/)
      .filter((term) => term && !term.startsWith("-"));
    if (!terms.length) throw new BrainGraphError(400, "Type something to search for.");
    const hits = await this.#json(["search", ...terms, "--json"]);
    if (!Array.isArray(hits)) throw new BrainGraphError(503, LACKS_GRAPH);
    return hits;
  }

  page(slug: string): { slug: string; layer: string; markdown: string } {
    if (!SLUG.test(slug)) throw new BrainGraphError(404, "No such brain page.");
    for (const layer of LAYER_DIRS) {
      const file = path.join(this.root, layer, `${slug}.md`);
      try {
        if (!fs.lstatSync(file).isFile()) continue;
        return { slug, layer, markdown: fs.readFileSync(file, "utf8") };
      } catch {
        // not in this layer
      }
    }
    throw new BrainGraphError(404, "No such brain page.");
  }
}
