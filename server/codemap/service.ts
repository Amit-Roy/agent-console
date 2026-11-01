// MapsService (issue #405): add/refresh/remove maps, views from map.json and compact agent briefs.
import path from "node:path";
import { clip } from "./assemble.ts";
import { type JobDeps, MapJobs } from "./jobs.ts";
import { parseSource, resolveLocal, slugFor } from "./source.ts";
import { flowView, moduleView, overviewView } from "./spec.ts";
import {
  assertCapacity,
  assertSlug,
  deleteMap,
  listMaps,
  type MapMeta,
  readMeta,
  writeMeta,
} from "./store.ts";
import type { ArchNode, CodeMap, MapSummary, MapsService, MapView } from "./types.ts";

export const BRIEF_MAX_LINES = 60;
const MODULE_LINES = 30;
const LINK_LINES = 8;
const FLOW_LINES = 5;
const FILE_LINES = 30;
const NEIGHBOR_LINES = 8;
const ACTIVE = new Set(["queued", "cloning", "scanning", "describing"]);

function toSummary(meta: MapMeta): MapSummary {
  const { described, createdAt: _created, updatedAt, ...rest } = meta;
  return { ...rest, described: !!described, updatedAt: new Date(updatedAt).toISOString() };
}

function label(map: CodeMap, id: string): string {
  return map.architecture.nodes.find((node) => node.id === id)?.label ?? id;
}

function leafLine(map: CodeMap, node: ArchNode): string {
  const stat = map.stats[node.id] ?? { files: 0, loc: 0 };
  const summary = clip(node.summary || "", 90);
  return `  ${node.id} | ${node.label} | ${stat.files} files | ${stat.loc} LOC | ${summary}`;
}

function systemLines(map: CodeMap): string[] {
  const nodes = map.architecture.nodes;
  const systems = nodes.filter((node) => node.kind === "system");
  const lines: string[] = [];
  const emit = (title: string | null, children: ArchNode[]): void => {
    if (!children.length) return;
    if (title) lines.push(title);
    for (const child of children) lines.push(leafLine(map, child));
  };
  for (const system of systems) {
    emit(
      `${system.label} (${system.id})`,
      nodes.filter((node) => node.parent === system.id),
    );
  }
  const known = new Set(systems.map((system) => system.id));
  emit(
    systems.length ? "Other" : null,
    nodes.filter((node) => node.kind !== "system" && !(node.parent && known.has(node.parent))),
  );
  return lines.slice(0, MODULE_LINES);
}

function linkLines(map: CodeMap): string[] {
  return [...map.links]
    .sort((left, right) => right.count - left.count)
    .slice(0, LINK_LINES)
    .map((link) => `  ${link.from} -> ${link.to} ${link.kind}s ×${link.count}`);
}

function flowLines(map: CodeMap): string[] {
  return map.architecture.flows
    .slice(0, FLOW_LINES)
    .map((flow) => `  ${flow.id}: ${flow.steps.map((step) => step.node).join(" > ")}`);
}

function overviewBrief(map: CodeMap): string[] {
  const { project } = map.architecture;
  const totalLoc = Object.values(map.fileLoc).reduce((sum, loc) => sum + loc, 0);
  const lines = [
    `${project.name}: ${clip(project.summary, 160)}`,
    `commit ${map.commit?.slice(0, 12) ?? "unknown"} | described: ${map.described ? "yes" : "no (folder heuristic)"} | ${Object.keys(map.fileLoc).length} files | ${totalLoc} LOC`,
    "Modules (id | label | files | LOC | summary):",
    ...systemLines(map),
  ];
  const links = linkLines(map);
  if (links.length) lines.push("Top links:", ...links);
  const flows = flowLines(map);
  if (flows.length) lines.push("Flows:", ...flows);
  return lines;
}

function neighborLines(map: CodeMap, id: string): string[] {
  const out = map.links.filter((link) => link.from === id);
  const into = map.links.filter((link) => link.to === id);
  const fmt = (text: string, count: number) => `  ${text} ×${count}`;
  const top = <T extends { count: number }>(list: T[]) =>
    [...list].sort((a, b) => b.count - a.count).slice(0, NEIGHBOR_LINES);
  const lines: string[] = [];
  if (out.length) lines.push("Depends on:");
  for (const link of top(out)) lines.push(fmt(`${link.kind} -> ${link.to}`, link.count));
  if (into.length) lines.push("Used by:");
  for (const link of top(into)) lines.push(fmt(`${link.kind} <- ${link.from}`, link.count));
  return lines;
}

function nodeBrief(map: CodeMap, id: string): string[] {
  const node = map.architecture.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error("not found");
  const files = Object.entries(map.fileModule)
    .filter(([, moduleId]) => moduleId === id)
    .map(([file]) => ({ file, loc: map.fileLoc[file] ?? 0 }))
    .sort((a, b) => b.loc - a.loc);
  const stat = map.stats[id] ?? { files: files.length, loc: 0 };
  return [
    `${node.label} (${node.id}) [${node.kind}]: ${node.summary}`,
    `${stat.files} files | ${stat.loc} LOC`,
    `Top files by LOC (${Math.min(files.length, FILE_LINES)} of ${files.length}):`,
    ...files.slice(0, FILE_LINES).map((entry) => `  ${entry.file} ${entry.loc}`),
    ...neighborLines(map, id),
  ];
}

function capLines(lines: string[]): string {
  if (lines.length <= BRIEF_MAX_LINES) return lines.join("\n");
  const extra = lines.length - (BRIEF_MAX_LINES - 1);
  return [...lines.slice(0, BRIEF_MAX_LINES - 1), `... ${extra} more lines`].join("\n");
}

export function renderBrief(map: CodeMap, node?: string): string {
  return capLines(node ? nodeBrief(map, node) : overviewBrief(map));
}

export function createMapsService(
  deps: Partial<JobDeps> = {},
  jobs?: MapJobs,
): MapsService & {
  jobs: MapJobs;
} {
  const queue = jobs ?? new MapJobs(deps);
  const { base, reposRoot } = queue.deps;
  queue.recoverInterrupted();
  const need = (slug: string): MapMeta => {
    assertSlug(slug);
    const meta = readMeta(slug, base);
    if (!meta) throw new Error("not found");
    return meta;
  };
  const queued = (meta: MapMeta, describe?: boolean): MapSummary => {
    const next: MapMeta = { ...meta, status: "queued", updatedAt: Date.now() };
    delete next.error;
    writeMeta(next, base);
    queue.enqueue(meta.slug, { describe });
    return toSummary(next);
  };
  const loaded = (slug: string): CodeMap => {
    const meta = need(slug);
    if (meta.status !== "describing" && meta.status !== "ready") throw new Error("not found");
    return queue.loadMap(slug);
  };
  return {
    jobs: queue,
    async list() {
      return listMaps(base).map(toSummary);
    },
    async status(slug) {
      return toSummary(need(slug));
    },
    async add(input) {
      let source = parseSource(input);
      if (source.kind === "local")
        source = { kind: "local", path: resolveLocal(source, reposRoot) };
      const slug = slugFor(source);
      assertCapacity(slug, base);
      const ref = source.kind === "local" ? source.path : `${source.owner}/${source.repo}`;
      const name = source.kind === "local" ? path.basename(source.path) : source.repo;
      const now = Date.now();
      const old = readMeta(slug, base);
      if (old && ACTIVE.has(old.status)) return toSummary(old);
      const meta: MapMeta = {
        ...(old ?? { slug, label: name, createdAt: now }),
        source: { kind: source.kind, ref },
        status: "queued",
        updatedAt: now,
      } as MapMeta;
      return queued(meta);
    },
    async refresh(slug, opts) {
      const meta = need(slug);
      if (ACTIVE.has(meta.status)) return toSummary(meta);
      return queued(meta, opts?.describe);
    },
    async remove(slug) {
      need(slug);
      deleteMap(slug, base);
      queue.forget(slug);
    },
    async view(slug, opts = {}): Promise<MapView> {
      const map = loaded(slug);
      if (opts.flow) return flowView(map, opts.flow);
      if (opts.node) return moduleView(map, opts.node);
      return overviewView(map);
    },
    async brief(slug, opts = {}) {
      return renderBrief(loaded(slug), opts.node);
    },
  };
}
