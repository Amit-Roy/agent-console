// Codemap job queue (issue #405): one build at a time, phases persisted in meta.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../auth.ts";
import { assembleMap, heuristicArchitecture, type Scan, validateArchitecture } from "./assemble.ts";
import { type DescribeInput, describeRepo } from "./describe.ts";
import {
  type CloneOpts,
  type CodemapSource,
  cloneGithub,
  defaultRoot,
  ghLogin,
  headSha,
  refreshGithub,
  resolveLocal,
} from "./source.ts";
import { moduleCount } from "./spec.ts";
import { listMaps, type MapMeta, type MapStatus, mapDir, readMeta, writeMeta } from "./store.ts";
import type { Architecture, CodeMap } from "./types.ts";

const SCANNER = fileURLToPath(new URL("../vendor/floorplan/scan.mjs", import.meta.url));
const SCAN_TIMEOUT_MS = 180_000;
const TERMINAL: MapStatus[] = ["ready", "failed"];

export type JobDeps = {
  base: string;
  reposRoot: string;
  runScan: (root: string, outFile: string) => Promise<void>;
  describe: (input: DescribeInput) => Promise<Architecture>;
  clone: (source: CodemapSource, dest: string, opts?: CloneOpts) => Promise<void>;
  refreshClone: (source: CodemapSource, dir: string, opts?: CloneOpts) => Promise<void>;
  authUser: () => Promise<string | null>;
};

export type JobOpts = { describe?: boolean };

/** Run the vendored floorplan scanner as a child process; never writes into the repo. */
export function runScanProcess(root: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCANNER, root, "--out", outFile], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SCAN_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2048)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const why = signal ? `killed (${signal})` : stderr.trim().split("\n").pop();
      reject(new Error(`scan failed: ${why}`));
    });
  });
}

export function defaultJobDeps(base: string = DATA_DIR): JobDeps {
  return {
    base,
    reposRoot: defaultRoot(),
    runScan: runScanProcess,
    describe: describeRepo,
    clone: cloneGithub,
    refreshClone: refreshGithub,
    authUser: ghLogin,
  };
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function topDirs(scan: Scan | null): string {
  const tops = new Set<string>();
  for (const file of scan?.files ?? []) {
    const slash = file.path.indexOf("/");
    tops.add(slash < 0 ? "." : file.path.slice(0, slash));
  }
  return [...tops].sort().join("\n");
}

export function sourceOf(meta: MapMeta): CodemapSource {
  if (meta.source.kind === "local") return { kind: "local", path: meta.source.ref };
  const [owner, repo] = meta.source.ref.split("/");
  return { kind: "github", owner, repo };
}

export class MapJobs {
  readonly deps: JobDeps;
  private chain: Promise<void> = Promise.resolve();
  private cache = new Map<string, { mtimeMs: number; map: CodeMap }>();

  constructor(deps: Partial<JobDeps> = {}) {
    this.deps = { ...defaultJobDeps(deps.base), ...deps };
  }

  /** On server start: any non-terminal meta cannot be running anymore. */
  recoverInterrupted(): void {
    for (const meta of listMaps(this.deps.base)) {
      if (TERMINAL.includes(meta.status)) continue;
      writeMeta(
        { ...meta, status: "failed", error: "interrupted", updatedAt: Date.now() },
        this.deps.base,
      );
    }
  }

  enqueue(slug: string, opts: JobOpts = {}): void {
    this.chain = this.chain.then(() => this.run(slug, opts));
  }

  /** Resolves when everything queued so far has finished (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  forget(slug: string): void {
    this.cache.delete(slug);
  }

  /** Parsed map.json, cached by slug + mtime. Throws "not found" when absent. */
  loadMap(slug: string): CodeMap {
    const file = path.join(mapDir(slug, this.deps.base), "map.json");
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      throw new Error("not found");
    }
    const hit = this.cache.get(slug);
    if (hit && hit.mtimeMs === mtimeMs) return hit.map;
    const map = readJson<CodeMap>(file);
    if (!map) throw new Error("not found");
    this.cache.set(slug, { mtimeMs, map });
    return map;
  }

  private patch(slug: string, change: Partial<MapMeta>): MapMeta {
    const meta = readMeta(slug, this.deps.base);
    if (!meta) throw new Error("removed");
    const next = { ...meta, ...change, updatedAt: Date.now() };
    if (!("error" in change)) delete next.error;
    writeMeta(next, this.deps.base);
    return next;
  }

  private async run(slug: string, opts: JobOpts): Promise<void> {
    try {
      await this.build(slug, opts);
    } catch (err: any) {
      if (err?.message === "removed" || !readMeta(slug, this.deps.base)) return;
      this.patch(slug, { status: "failed", error: String(err?.message || err).slice(0, 500) });
    }
  }

  private async prepareRoot(meta: MapMeta): Promise<string> {
    const source = sourceOf(meta);
    if (source.kind === "local") return resolveLocal(source, this.deps.reposRoot);
    this.patch(meta.slug, { status: "cloning" });
    const dir = path.join(mapDir(meta.slug, this.deps.base), "clone");
    const cloneOpts = { authUser: await this.deps.authUser() };
    if (fs.existsSync(path.join(dir, ".git"))) {
      await this.deps.refreshClone(source, dir, cloneOpts);
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
      await this.deps.clone(source, dir, cloneOpts);
    }
    return dir;
  }

  private needsDescribe(meta: MapMeta, opts: JobOpts, scan: Scan, prevTops: string): boolean {
    if (opts.describe || !meta.described) return true;
    return topDirs(scan) !== prevTops;
  }

  private async build(slug: string, opts: JobOpts): Promise<void> {
    const meta = readMeta(slug, this.deps.base);
    if (!meta) return;
    const dir = mapDir(slug, this.deps.base);
    const root = await this.prepareRoot(meta);
    const prevTops = topDirs(readJson<Scan>(path.join(dir, "scan.json")));
    this.patch(slug, { status: "scanning" });
    await this.deps.runScan(root, path.join(dir, "scan.json"));
    const scan = readJson<Scan>(path.join(dir, "scan.json"));
    if (!scan) throw new Error("scan produced no output");
    const commit = await headSha(root).catch(() => null);
    const files = scan.files.map((file) => file.path);
    const kept = readJson<Architecture>(path.join(dir, "architecture.json"));
    const reuse =
      !this.needsDescribe(meta, opts, scan, prevTops) &&
      kept &&
      validateArchitecture(kept, files).length === 0;
    if (reuse) {
      this.publish(slug, scan, kept, commit, true);
      return;
    }
    const keepOld = !!meta.described && !!kept;
    const placeholder =
      keepOld && kept ? kept : heuristicArchitecture(scan, scan.rootName || meta.label);
    this.publish(slug, scan, placeholder, commit, keepOld, "describing");
    await this.describeStep(slug, root, scan, files, commit, keepOld);
  }

  private async describeStep(
    slug: string,
    root: string,
    scan: Scan,
    files: string[],
    commit: string | null,
    keptDescribed: boolean,
  ): Promise<void> {
    try {
      const arch = await this.deps.describe({
        scan,
        repoRoot: root,
        files,
        validate: validateArchitecture,
      });
      this.publish(slug, scan, arch, commit, true);
    } catch (err: any) {
      const note = `AI description failed: ${String(err?.message || err).split("\n")[0]}`;
      this.patch(slug, {
        status: "ready",
        error: note.slice(0, 500),
        described: keptDescribed ? 1 : 0,
      });
    }
  }

  private publish(
    slug: string,
    scan: Scan,
    arch: Architecture,
    commit: string | null,
    described: boolean,
    status: MapStatus = "ready",
  ): void {
    const dir = mapDir(slug, this.deps.base);
    const map = assembleMap({ slug, commit, scan, architecture: arch, described });
    writeJson(path.join(dir, "architecture.json"), map.architecture);
    writeJson(path.join(dir, "map.json"), map);
    this.cache.delete(slug);
    this.patch(slug, {
      status,
      files: scan.files.length,
      modules: moduleCount(map),
      loc: Object.values(map.fileLoc).reduce((sum, loc) => sum + loc, 0),
      commit: commit ?? undefined,
      described: described ? 1 : 0,
      error: undefined,
    });
  }
}
