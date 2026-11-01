// Codemap views (issue #405): CodeMap -> MapView whose spec is a ```arch diagram (public/arch.js validateArch),
// styled like the PR architecture diagrams: groups for systems, icon nodes for modules, few labelled edges.
import { clip, formatCount } from "./assemble.ts";
import type { ArchKind, ArchNode, CodeMap, MapView } from "./types.ts";

export const OVERVIEW_EDGE_CAP = 24;
export const MODULE_NODE_CAP = 40;
export const MODULE_EDGE_CAP = 40;
const NEIGHBOR_CAP = 8;
const COLUMN_AFTER = 4; // groups with more children stack as a column (phone readability)
const DESC_MAX = 56;
const EDGE_LABEL_MAX = 40;
const DETAIL_FILES = 30;
const OVERVIEW_DEGREE_CAP = 5;
const MIN_EDGE_COUNT = 2; // overview drops one-off imports
const MIN_EDGE_SHARE = 0.03; // ...and imports far lighter than the heaviest link

type SpecNode = {
  id: string;
  label: string;
  tech?: string;
  desc?: string;
  icon?: string;
  color?: string;
};
type SpecGroup = {
  id?: string;
  group: string;
  sub?: string;
  icon?: string;
  color?: string;
  border?: "solid" | "dashed" | "none";
  direction?: "row" | "column";
  items: SpecItem[];
};
type SpecItem = SpecNode | SpecGroup;
type SpecEdge = {
  from: string;
  to: string;
  label?: string;
  step?: number;
  both?: boolean;
  dashed?: boolean;
};
type Link = CodeMap["links"][number];

const ICONS: Record<ArchKind, string> = {
  system: "boxes",
  feature: "layout-dashboard",
  service: "server",
  data: "database",
  external: "globe",
  tooling: "wrench",
  tests: "flask-conical",
};
const COLORS: Record<ArchKind, string> = {
  system: "slate",
  feature: "blue",
  service: "indigo",
  data: "teal",
  external: "orange",
  tooling: "slate",
  tests: "purple",
};
// Left-to-right lanes: user-facing code, services, support code, outside world.
const LANES: Record<ArchKind, number> = {
  feature: 0,
  system: 0,
  service: 1,
  data: 2,
  tooling: 2,
  tests: 2,
  external: 3,
};
const LOOSE_GROUPS: Array<{
  id: string;
  label: string;
  icon: string;
  color: string;
  kinds: ArchKind[];
}> = [
  {
    id: "grp:modules",
    label: "Modules",
    icon: "blocks",
    color: "blue",
    kinds: ["feature", "service"],
  },
  {
    id: "grp:support",
    label: "Tooling & tests",
    icon: "wrench",
    color: "slate",
    kinds: ["tooling", "tests"],
  },
  { id: "grp:content", label: "Docs & data", icon: "book-open", color: "teal", kinds: ["data"] },
  { id: "grp:external", label: "External", icon: "globe", color: "orange", kinds: ["external"] },
];

// ---------- shared helpers ----------

const plural = (count: number, word: string) =>
  `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

function sizeText(map: CodeMap, nodeId: string): string | undefined {
  const stats = map.stats[nodeId];
  return stats ? `${plural(stats.files, "file")} · ${plural(stats.loc, "line")}` : undefined;
}

function nodeDesc(map: CodeMap, node: ArchNode): string | undefined {
  if (node.kind === "external") return clip(node.summary, DESC_MAX) || undefined;
  if (!map.described) return undefined; // heuristic summaries repeat the size line
  return clip(node.summary, DESC_MAX) || undefined;
}

function moduleNode(map: CodeMap, node: ArchNode, specId = node.id): SpecNode {
  const item: SpecNode = {
    id: specId,
    label: node.label,
    icon: ICONS[node.kind] ?? "box",
    color: COLORS[node.kind] ?? "blue",
  };
  const tech = sizeText(map, node.id);
  const desc = nodeDesc(map, node);
  if (tech) item.tech = tech;
  if (desc) item.desc = desc;
  return item;
}

function group(label: string, items: SpecItem[], extra: Partial<SpecGroup> = {}): SpecGroup {
  return {
    group: clip(label, 60),
    direction: items.length > COLUMN_AFTER ? "column" : "row",
    items,
    ...extra,
  };
}

const nodeIndex = (map: CodeMap) => new Map(map.architecture.nodes.map((node) => [node.id, node]));
const hasFiles = (map: CodeMap, nodeId: string) => (map.stats[nodeId]?.files ?? 0) > 0;
const flowList = (map: CodeMap) =>
  map.architecture.flows.map((flow) => ({ id: flow.id, title: flow.title }));
const overviewCrumb = (map: CodeMap) => ({ id: null, label: map.architecture.project.name });

function filesOf(map: CodeMap, nodeIds: Set<string>): Array<{ path: string; loc: number }> {
  return Object.entries(map.fileModule)
    .filter(([, moduleId]) => nodeIds.has(moduleId))
    .map(([path]) => ({ path, loc: map.fileLoc[path] ?? 0 }))
    .sort((left, right) => right.loc - left.loc || left.path.localeCompare(right.path));
}

function edgeLabel(kind: Link["kind"], count: number): string {
  if (kind === "http") return count > 1 ? `HTTP ×${count}` : "HTTP";
  if (kind === "external") return "calls";
  return plural(count, "import");
}

interface PairEdge {
  from: string;
  to: string;
  kind: Link["kind"];
  count: number;
  both: boolean;
}

/** Folds links onto displayed ids, merging reverse pairs into one two-way edge per kind. */
function pairEdges(links: Link[], visible: (nodeId: string) => string | null): PairEdge[] {
  const pairs = new Map<string, PairEdge>();
  for (const link of links) {
    const source = visible(link.from);
    const target = visible(link.to);
    if (!source || !target || source === target) continue;
    const forward = pairs.get(`${source}\u0000${target}\u0000${link.kind}`);
    const reverse = pairs.get(`${target}\u0000${source}\u0000${link.kind}`);
    if (forward) forward.count += link.count;
    else if (reverse) {
      reverse.count += link.count;
      reverse.both = true;
    } else
      pairs.set(`${source}\u0000${target}\u0000${link.kind}`, {
        from: source,
        to: target,
        kind: link.kind,
        count: link.count,
        both: false,
      });
  }
  return [...pairs.values()].sort(
    (left, right) => right.count - left.count || left.from.localeCompare(right.from),
  );
}

function toSpecEdge(edge: PairEdge): SpecEdge {
  const spec: SpecEdge = { from: edge.from, to: edge.to, label: edgeLabel(edge.kind, edge.count) };
  if (edge.both) spec.both = true;
  if (edge.kind !== "import") spec.dashed = true;
  return spec;
}

// ---------- overview ----------

function systemGroups(map: CodeMap): Array<{ lane: number; loc: number; item: SpecGroup }> {
  const nodes = map.architecture.nodes;
  const shown = (node: ArchNode) => node.kind === "external" || hasFiles(map, node.id);
  return nodes
    .filter((node) => node.kind === "system")
    .map((system) => {
      const children = nodes.filter((node) => node.parent === system.id && shown(node));
      const lanes = children.map((child) => LANES[child.kind] ?? 0);
      const item = group(
        system.label,
        children.map((child) => moduleNode(map, child)),
        {
          id: system.id,
          sub: sizeText(map, system.id),
          icon: ICONS.system,
          color: COLORS[children[0]?.kind ?? "system"],
          border: "solid",
          direction: "column",
        },
      );
      return { lane: Math.min(...lanes, 3), loc: map.stats[system.id]?.loc ?? 0, item };
    })
    .filter((entry) => entry.item.items.length);
}

function looseGroups(map: CodeMap): Array<{ lane: number; loc: number; item: SpecGroup }> {
  const loose = map.architecture.nodes.filter(
    (node) =>
      !node.parent &&
      node.kind !== "system" &&
      (node.kind === "external" || hasFiles(map, node.id)),
  );
  const byLoc = (left: ArchNode, right: ArchNode) =>
    (map.stats[right.id]?.loc ?? 0) - (map.stats[left.id]?.loc ?? 0);
  return LOOSE_GROUPS.map((spec) => {
    const members = loose.filter((node) => spec.kinds.includes(node.kind)).sort(byLoc);
    const item = group(
      spec.label,
      members.map((node) => moduleNode(map, node)),
      {
        id: spec.id,
        icon: spec.icon,
        color: spec.color,
        border: "dashed",
        direction: "column",
      },
    );
    const loc = members.reduce((total, node) => total + (map.stats[node.id]?.loc ?? 0), 0);
    return { lane: Math.min(...members.map((node) => LANES[node.kind]), 3), loc, item };
  }).filter((entry) => entry.item.items.length);
}

/** Keeps the heaviest edges per node so hub modules do not turn into a fan of wires. */
function capDegree(pairs: PairEdge[], cap: number): PairEdge[] {
  const degree = new Map<string, number>();
  const kept: PairEdge[] = [];
  for (const pair of pairs) {
    const ends = [pair.from, pair.to];
    if (ends.some((end) => (degree.get(end) ?? 0) >= cap)) continue;
    for (const end of ends) degree.set(end, (degree.get(end) ?? 0) + 1);
    kept.push(pair);
  }
  return kept;
}

function overviewEdges(map: CodeMap, shown: Set<string>): SpecEdge[] {
  const nodes = nodeIndex(map);
  // Tests import everything; their edges would drown the overview (module views still show them).
  const visible = (nodeId: string) =>
    shown.has(nodeId) && nodes.get(nodeId)?.kind !== "tests" ? nodeId : null;
  const pairs = pairEdges(map.links, visible);
  const floor = Math.max(MIN_EDGE_COUNT, (pairs[0]?.count ?? 0) * MIN_EDGE_SHARE);
  const kept = pairs.filter((pair) => pair.kind !== "import" || pair.count >= floor);
  return capDegree(kept, OVERVIEW_DEGREE_CAP).slice(0, OVERVIEW_EDGE_CAP).map(toSpecEdge);
}

function collectNodeIds(items: SpecItem[], into = new Set<string>()): Set<string> {
  for (const item of items) {
    if ("group" in item) collectNodeIds(item.items, into);
    else into.add(item.id);
  }
  return into;
}

/** Orders lanes left to right; within a lane, groups that make HTTP calls sit left of the groups serving them. */
function callersFirst(map: CodeMap, lanes: Array<{ lane: number; loc: number; item: SpecGroup }>) {
  const owner = new Map<string, number>();
  for (const [index, entry] of lanes.entries())
    for (const nodeId of collectNodeIds(entry.item.items)) owner.set(nodeId, index);
  const balance = lanes.map(() => 0);
  for (const link of map.links) {
    const [source, target] = [owner.get(link.from), owner.get(link.to)];
    if (link.kind !== "http" || source === undefined || target === undefined || source === target)
      continue;
    balance[source] += link.count;
    balance[target] -= link.count;
  }
  const order = lanes.map((entry, index) => ({ entry, http: balance[index] }));
  order.sort(
    (left, right) =>
      left.entry.lane - right.entry.lane ||
      right.http - left.http ||
      right.entry.loc - left.entry.loc,
  );
  return order.map((ranked) => ranked.entry);
}

/** Whole-repo diagram: systems as groups, modules as nodes, the heaviest module links as edges. */
export function overviewView(map: CodeMap): MapView {
  const { project } = map.architecture;
  const lanes = callersFirst(map, [...systemGroups(map), ...looseGroups(map)]);
  const items = lanes.map((entry) => entry.item);
  const shown = collectNodeIds(items);
  const drill: Record<string, string> = {};
  for (const nodeId of shown) if (hasFiles(map, nodeId)) drill[nodeId] = nodeId;
  const totals = Object.values(map.fileLoc);
  const spec: Record<string, unknown> = {
    title: project.name,
    subtitle: `${plural(totals.length, "file")} · ${plural(
      totals.reduce((sum, loc) => sum + loc, 0),
      "line",
    )} · ${plural(Object.keys(drill).length, "module")}`,
    direction: "row",
    items: items.length ? items : [{ id: "empty", label: "No files", icon: "folder" }],
    edges: overviewEdges(map, shown),
  };
  if (!map.described) spec.note = "Mapped from folders; names improve after describe";
  return {
    spec,
    drill,
    crumbs: [overviewCrumb(map)],
    details: {
      title: project.name,
      summary: project.summary,
      files: filesOf(map, new Set(Object.values(map.fileModule))).slice(0, DETAIL_FILES),
    },
    flows: flowList(map),
  };
}

// ---------- module ----------

function fileIcon(path: string): string {
  if (/\.(md|mdx|rst|txt|adoc)$/i.test(path)) return "file-text";
  if (/\.(png|jpe?g|gif|svg|webp|ico|avif)$/i.test(path)) return "image";
  if (/\.(json|ya?ml|toml|ini|cfg|conf)$/i.test(path)) return "file-cog";
  if (/\.(sh|bash|zsh)$/i.test(path) || !/\.[^/]+$/.test(path)) return "file-terminal";
  return "file-code";
}

function commonDir(paths: string[]): string {
  if (!paths.length) return "";
  const parts = paths.map((path) => path.split("/").slice(0, -1));
  const shared: string[] = [];
  for (const [index, segment] of parts[0].entries()) {
    if (!parts.every((segments) => segments[index] === segment)) break;
    shared.push(segment);
  }
  return shared.join("/");
}

/** Files grouped by the first folder below the module's common directory; loose files keep the common directory. */
function folderGroups(
  files: Array<{ path: string; loc: number }>,
  base: string,
): Map<string, Array<{ path: string; loc: number }>> {
  const groups = new Map<string, Array<{ path: string; loc: number }>>();
  for (const file of files) {
    const rest = base ? file.path.slice(base.length + 1) : file.path;
    const key = rest.includes("/") ? `${rest.split("/")[0]}/` : base ? `${base}/` : "Repo root";
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return groups;
}

function fileNode(file: { path: string; loc: number }): SpecNode {
  const name = file.path.split("/").pop() || file.path;
  return {
    id: `file:${file.path}`,
    label: clip(name, 40),
    tech: plural(file.loc, "line"),
    icon: fileIcon(file.path),
    color: "slate",
  };
}

type FileEntry = { path: string; loc: number };
const COLUMN_FILES = 10; // files per column so a module view reads as a grid, not one long strip

const MIN_NAME_CLUSTER = 3;
const groupLoc = (entries: FileEntry[]) => entries.reduce((sum, file) => sum + file.loc, 0);
const baseName = (path: string) => path.split("/").pop() || path;

/** Splits a long flat folder by shared file-name prefix (codex-*, triage-*); singles stay together. */
function nameClusters(label: string, entries: FileEntry[]): Array<[string, FileEntry[]]> {
  if (entries.length <= COLUMN_FILES) return [[label, entries]];
  const byToken = new Map<string, FileEntry[]>();
  for (const file of entries) {
    const token = baseName(file.path).split(/[-_.]/)[0];
    byToken.set(token, [...(byToken.get(token) ?? []), file]);
  }
  const clusters: Array<[string, FileEntry[]]> = [];
  const singles: FileEntry[] = [];
  for (const [token, members] of byToken)
    if (members.length >= MIN_NAME_CLUSTER) clusters.push([`${token}-*`, members]);
    else singles.push(...members);
  if (singles.length) clusters.push([clusters.length ? "Other files" : label, singles]);
  return clusters;
}

/** Cuts groups taller than one column into numbered parts. */
function columnChunks([label, entries]: [string, FileEntry[]]): Array<[string, FileEntry[]]> {
  if (entries.length <= COLUMN_FILES) return [[label, entries]];
  const parts: Array<[string, FileEntry[]]> = [];
  const count = Math.ceil(entries.length / COLUMN_FILES);
  const size = Math.ceil(entries.length / count); // balanced columns
  for (let index = 0; index < count; index++)
    parts.push([
      `${label} (${index + 1}/${count})`,
      entries.slice(index * size, (index + 1) * size),
    ]);
  return parts;
}

function fileItems(files: FileEntry[]): SpecItem[] {
  const fits = files.length <= MODULE_NODE_CAP;
  const shown = fits ? files : files.slice(0, MODULE_NODE_CAP - 1);
  const folders = [...folderGroups(shown, commonDir(files.map((file) => file.path)))];
  const groups = folders.flatMap(([label, entries]) => nameClusters(label, entries));
  groups.sort((left, right) => groupLoc(right[1]) - groupLoc(left[1]));
  const items: SpecItem[] = groups.flatMap(columnChunks).map(([label, entries]) =>
    group(label, entries.map(fileNode), {
      icon: "folder",
      color: "slate",
      border: "dashed",
      direction: "column",
    }),
  );
  if (!fits)
    items.push({
      id: "more-files",
      label: `+${files.length - shown.length} more files`,
      desc: "See the file list",
      icon: "ellipsis",
      color: "slate",
    });
  return items;
}

function neighbors(map: CodeMap, nodeId: string): PairEdge[] {
  const touching = map.links.filter((link) => link.from === nodeId || link.to === nodeId);
  const nodes = nodeIndex(map);
  return pairEdges(touching, (other) => (nodes.has(other) ? other : null)).slice(0, NEIGHBOR_CAP);
}

function talksTo(
  map: CodeMap,
  nodeId: string,
  links: PairEdge[],
): { items: SpecItem[]; edges: SpecEdge[]; drill: Record<string, string> } {
  const nodes = nodeIndex(map);
  const drill: Record<string, string> = {};
  const seen = new Map<string, SpecNode>();
  for (const link of links) {
    const otherId = link.from === nodeId ? link.to : link.from;
    const other = nodes.get(otherId);
    if (!other || seen.has(otherId)) continue;
    seen.set(otherId, moduleNode(map, other, `mod:${otherId}`));
    if (other.kind !== "external" && hasFiles(map, otherId)) drill[`mod:${otherId}`] = otherId;
  }
  const specId = (archId: string) => (archId === nodeId ? `mod:${nodeId}` : `mod:${archId}`);
  const edges = links
    .slice(0, MODULE_EDGE_CAP)
    .map((link) => toSpecEdge({ ...link, from: specId(link.from), to: specId(link.to) }));
  const items: SpecItem[] = seen.size
    ? [
        group("Talks to", [...seen.values()], {
          id: "talks-to",
          icon: "cable",
          color: "slate",
          border: "dashed",
        }),
      ]
    : [];
  return { items, edges, drill };
}

/** One module: its files grouped by folder (capped), plus the modules it talks to (drillable). */
export function moduleView(map: CodeMap, nodeId: string): MapView {
  const node = nodeIndex(map).get(nodeId);
  if (!node) throw new Error(`unknown codemap node ${nodeId}`);
  const files = filesOf(map, new Set([nodeId]));
  const own = files.length
    ? fileItems(files)
    : [{ id: "no-files", label: "No files", icon: "folder", color: "slate" }];
  const neighborhood = talksTo(map, nodeId, neighbors(map, nodeId));
  const parent = node.parent ? nodeIndex(map).get(node.parent) : undefined;
  const moduleGroup = group(node.label, own, {
    id: `mod:${nodeId}`,
    sub: sizeText(map, nodeId),
    icon: ICONS[node.kind] ?? "box",
    color: COLORS[node.kind] ?? "blue",
    border: "solid",
    direction: own.length > 1 ? "row" : "column",
  });
  const spec: Record<string, unknown> = {
    title: node.label,
    subtitle: parent
      ? `${parent.label} · ${map.architecture.project.name}`
      : map.architecture.project.name,
    direction: "row",
    items: [moduleGroup, ...neighborhood.items],
    edges: neighborhood.edges,
  };
  return {
    spec,
    drill: neighborhood.drill,
    crumbs: [overviewCrumb(map), { id: nodeId, label: node.label }],
    details: { title: node.label, summary: node.summary, files },
    flows: flowList(map),
  };
}

// ---------- flow ----------

function flowItems(map: CodeMap, stepNodes: string[]): SpecItem[] {
  const nodes = nodeIndex(map);
  const bySystem = new Map<string, SpecNode[]>();
  for (const nodeId of new Set(stepNodes)) {
    const node = nodes.get(nodeId);
    if (!node) continue;
    const key = node.kind === "external" ? "grp:external" : (node.parent ?? "grp:modules");
    bySystem.set(key, [...(bySystem.get(key) ?? []), moduleNode(map, node)]);
  }
  return [...bySystem].map(([key, members]) => {
    const system = nodes.get(key);
    const loose = LOOSE_GROUPS.find((spec) => spec.id === key);
    return group(system?.label ?? loose?.label ?? "Modules", members, {
      id: key,
      icon: system ? ICONS.system : loose?.icon,
      color: system ? "slate" : loose?.color,
      border: system ? "solid" : "dashed",
    });
  });
}

/** A described flow: participating modules grouped by system, steps as numbered edges. */
export function flowView(map: CodeMap, flowId: string): MapView {
  const flow = map.architecture.flows.find((entry) => entry.id === flowId);
  if (!flow) throw new Error(`unknown codemap flow ${flowId}`);
  const stepNodes = flow.steps.map((step) => step.node);
  const edges: SpecEdge[] = [];
  for (let index = 1; index < flow.steps.length; index++) {
    const [source, target] = [stepNodes[index - 1], stepNodes[index]];
    if (source === target) continue;
    edges.push({
      from: source,
      to: target,
      step: index,
      label: clip(flow.steps[index].note, EDGE_LABEL_MAX),
    });
  }
  const items = flowItems(map, stepNodes);
  const drill: Record<string, string> = {};
  for (const nodeId of collectNodeIds(items)) if (hasFiles(map, nodeId)) drill[nodeId] = nodeId;
  const summary = flow.steps.map((step, index) => `${index + 1}. ${step.note}`).join(" ");
  return {
    spec: {
      title: flow.title,
      subtitle: map.architecture.project.name,
      direction: "row",
      items,
      edges,
    },
    drill,
    // Flows are not architecture nodes; the flow crumb (current page) opens the overview.
    crumbs: [overviewCrumb(map), { id: null, label: flow.title }],
    details: { title: flow.title, summary, files: [] },
    flows: flowList(map),
  };
}
