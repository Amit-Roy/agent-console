// Codemap assembly (issue #405): turn a floorplan scan into an Architecture (heuristic first pass), validate
// architectures (also used as retry feedback for the describe pass), and assemble the persisted CodeMap.
import { compileGlob } from "../vendor/floorplan/lib/common.mjs";
import type { Architecture, ArchKind, ArchNode, CodeMap, ModuleStats } from "./types.ts";

// Subset of the floorplan scan JSON (server/vendor/floorplan/scan.mjs) that the codemap reads.
export interface ScanFile {
  path: string;
  loc: number;
  category?: string;
  lang?: string | null;
}
export interface Scan {
  rootName?: string;
  files: ScanFile[];
  edges?: Array<{ from: string; to: string }>;
  http?: Array<{ from: string; to: string }>;
  hosts?: Array<{ from: string; host: string }>;
}

type LinkKind = CodeMap["links"][number]["kind"];

export const LABEL_MAX = 40;
export const SUMMARY_MAX = 200;
export const NOTE_MAX = 120;
export const OTHER_ID = "other";
const KINDS: ArchKind[] = ["system", "feature", "service", "data", "external", "tooling", "tests"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_TOP_UNITS = 10; // top-level folders shown before the rest merge into "Other folders"
const MAX_CHILDREN = 9; // modules per split folder before the rest merge into "<folder> core"
const BIG_DIR_FILES = 30;
const BIG_DIR_SHARE = 0.25;
const MIN_CLUSTER = 4; // loose files sharing a name prefix that become their own module
const MAX_EXTERNALS = 6;
const GLOB_UNSAFE = /[*?{}[\],]/;

// ---------- small helpers ----------

const sumLoc = (files: ScanFile[]) => files.reduce((total, file) => total + (file.loc || 0), 0);

export function formatCount(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}…`;
}

const ACRONYMS: Record<string, string> = {
  api: "API",
  ui: "UI",
  cli: "CLI",
  ci: "CI",
  db: "DB",
  sdk: "SDK",
  http: "HTTP",
  github: "GitHub",
  e2e: "E2E",
};

export function humanize(name: string): string {
  const words = name
    .replace(/^[._]+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_.\s/]+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  if (!words.length) return name || "Root";
  const [first, ...rest] = words;
  return clip([first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" "), LABEL_MAX);
}

const slugPart = (name: string) =>
  name
    .replace(/^[._]+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

const KIND_BY_NAME: Array<[ArchKind, string[]]> = [
  [
    "tests",
    ["test", "tests", "__tests__", "spec", "specs", "e2e", "testing", "cypress", "playwright"],
  ],
  [
    "tooling",
    [
      "scripts",
      "script",
      "bin",
      "tools",
      "tool",
      "tooling",
      ".github",
      ".devcontainer",
      ".githooks",
      ".circleci",
      "ci",
      "infra",
      "deploy",
      "ops",
      "docker",
      "hack",
      "devtools",
      "config",
    ],
  ],
  [
    "data",
    [
      "docs",
      "doc",
      "data",
      "fixtures",
      "assets",
      "migrations",
      "db",
      "schema",
      "schemas",
      "examples",
    ],
  ],
  [
    "service",
    ["server", "api", "backend", "services", "service", "worker", "workers", "functions", "cmd"],
  ],
];
const CONTAINER_DIRS = new Set([
  "packages",
  "apps",
  "libs",
  "services",
  "crates",
  "modules",
  "plugins",
]);
const UNSPLIT_KINDS = new Set<ArchKind>(["tests", "tooling", "data"]);

function guessKind(name: string, files: ScanFile[], fallback: ArchKind = "feature"): ArchKind {
  const lower = name.toLowerCase();
  for (const [kind, names] of KIND_BY_NAME) if (names.includes(lower)) return kind;
  const content = files.filter((file) => ["docs", "data", "asset"].includes(file.category ?? ""));
  if (files.length && content.length / files.length > 0.6) return "data";
  return fallback;
}

const LANG_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  ruby: "Ruby",
  php: "PHP",
  swift: "Swift",
  shell: "Shell",
  css: "CSS",
  html: "HTML",
  cpp: "C++",
  c: "C",
};

function mainLanguage(files: ScanFile[]): string | null {
  const byLang = new Map<string, number>();
  for (const file of files)
    if (file.lang) byLang.set(file.lang, (byLang.get(file.lang) ?? 0) + (file.loc || 1));
  const top = [...byLang.entries()].sort((left, right) => right[1] - left[1])[0];
  return top ? (LANG_NAMES[top[0]] ?? humanize(top[0])) : null;
}

function describeFiles(where: string, files: ScanFile[]): string {
  const lang = mainLanguage(files);
  const size = `${files.length} file${files.length === 1 ? "" : "s"}, ${formatCount(sumLoc(files))} lines`;
  return clip(`${where}: ${size}${lang ? ` of mostly ${lang}` : ""}.`, SUMMARY_MAX);
}

/** Glob that matches exactly the listed names under prefix, or prefix/* when a list would be unsafe or long. */
function namesGlob(prefix: string, names: string[]): string {
  if (names.length === 1 && !GLOB_UNSAFE.test(names[0])) return prefix + names[0];
  if (names.length <= 30 && !names.some((name) => GLOB_UNSAFE.test(name)))
    return `${prefix}{${names.join(",")}}`;
  return `${prefix}*`;
}

// ---------- heuristic architecture ----------

interface Unit {
  key: string;
  label: string;
  glob: string;
  where: string;
  files: ScanFile[];
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

const byLocDesc = (left: Unit, right: Unit) => sumLoc(right.files) - sumLoc(left.files);
const nameToken = (name: string) => name.split(/[-_.]/)[0];

/** Shared leading name words of a file cluster ("file-viewer.js", "file-viewer-tree.js" -> "file-viewer"). */
function commonStem(names: string[]): string {
  const split = names.map((name) => name.replace(/\.[^.]*$/, "").split(/[-_.]/));
  const stem: string[] = [];
  for (const [index, word] of split[0].entries()) {
    if (!split.every((words) => words[index] === word)) break;
    stem.push(word);
  }
  return stem.join("-") || split[0][0];
}

/** Split the files under prefix ("" = repo root) into child units: subfolders plus loose files sharing a name prefix. */
function splitUnits(prefix: string, files: ScanFile[], parentLabel: string): Unit[] | null {
  const relOf = (file: ScanFile) => file.path.slice(prefix.length);
  const loose = files.filter((file) => !relOf(file).includes("/"));
  const subdirs = groupBy(
    files.filter((file) => relOf(file).includes("/")),
    (file) => relOf(file).split("/")[0],
  );
  const clusters = groupBy(loose, (file) => nameToken(relOf(file)));
  const units: Unit[] = [];
  const clustered = new Set<ScanFile>();
  for (const [name, inside] of subdirs) {
    const cluster = clusters.get(name) ?? [];
    for (const file of cluster) clustered.add(file);
    const glob = cluster.length
      ? `${prefix}{${name},${name}-*,${name}_*,${name}.*}`
      : prefix + name;
    units.push({
      key: name,
      label: humanize(name),
      glob,
      where: prefix + name,
      files: [...inside, ...cluster],
    });
  }
  for (const [token, cluster] of clusters) {
    if (subdirs.has(token) || cluster.length < MIN_CLUSTER || GLOB_UNSAFE.test(token)) continue;
    for (const file of cluster) clustered.add(file);
    const glob = `${prefix}{${token},${token}-*,${token}_*,${token}.*}`;
    const label = humanize(commonStem(cluster.map(relOf)));
    units.push({ key: token, label, glob, where: `${prefix}${token}*`, files: cluster });
  }
  units.sort(byLocDesc);
  const kept = units.slice(0, MAX_CHILDREN);
  const rest = [
    ...units.slice(MAX_CHILDREN).flatMap((unit) => unit.files),
    ...loose.filter((file) => !clustered.has(file)),
  ];
  if (rest.length) {
    const hasLoose = loose.some((file) => !clustered.has(file));
    const label = clip(
      hasLoose ? `${parentLabel} core` : `Other ${parentLabel.toLowerCase()}`,
      LABEL_MAX,
    );
    kept.push({
      key: "core",
      label,
      glob: `${prefix}*`,
      where: prefix || "repo root",
      files: rest,
    });
  }
  return kept.length >= 2 ? kept : null;
}

class IdPool {
  private used = new Set<string>();
  take(base: string): string {
    let candidate = base;
    for (let suffix = 2; this.used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
    this.used.add(candidate);
    return candidate;
  }
}

interface Builder {
  nodes: ArchNode[];
  ids: IdPool;
  totalLoc: number;
}

function addModule(builder: Builder, unit: Unit, kind: ArchKind, idBase: string, parent?: string) {
  const node: ArchNode = {
    id: builder.ids.take(idBase),
    label: unit.label,
    kind,
    summary: describeFiles(unit.where, unit.files),
    paths: [unit.glob],
  };
  if (parent) node.parent = parent;
  builder.nodes.push(node);
}

function isBigDir(name: string, files: ScanFile[], totalLoc: number): boolean {
  if (CONTAINER_DIRS.has(name.toLowerCase())) return true;
  return (
    files.length >= BIG_DIR_FILES ||
    (sumLoc(files) >= totalLoc * BIG_DIR_SHARE && files.length >= 10)
  );
}

/** One top-level unit: a single module, or a system with child modules when the folder is big. */
function addTopUnit(builder: Builder, unit: Unit, prefix: string | null) {
  const kind = guessKind(unit.key, unit.files);
  const idBase = slugPart(unit.key);
  const split =
    prefix !== null && !UNSPLIT_KINDS.has(kind) && isBigDir(unit.key, unit.files, builder.totalLoc)
      ? splitUnits(prefix, unit.files, unit.label)
      : null;
  if (!split) return addModule(builder, unit, kind, idBase);
  const systemId = builder.ids.take(idBase);
  builder.nodes.push({
    id: systemId,
    label: unit.label,
    kind: "system",
    summary: describeFiles(unit.where, unit.files),
    paths: [],
  });
  for (const child of split)
    addModule(
      builder,
      child,
      guessKind(child.key, child.files, kind),
      `${systemId}.${slugPart(child.key)}`,
      systemId,
    );
}

function topUnits(files: ScanFile[]): { dirs: Unit[]; rest: Unit | null } {
  const dirs = [...groupBy(files, (file) => file.path.split("/")[0])].map(
    ([name, inside]): Unit => ({
      key: name,
      label: humanize(name),
      glob: name,
      where: name,
      files: inside,
    }),
  );
  dirs.sort(byLocDesc);
  if (dirs.length <= MAX_TOP_UNITS) return { dirs, rest: null };
  const tail = dirs.slice(MAX_TOP_UNITS - 1);
  const rest: Unit = {
    key: "other-folders",
    label: "Other folders",
    glob: namesGlob(
      "",
      tail.map((unit) => unit.key),
    ),
    where: tail.map((unit) => unit.key).join(", "),
    files: tail.flatMap((unit) => unit.files),
  };
  return { dirs: dirs.slice(0, MAX_TOP_UNITS - 1), rest };
}

function addRootFiles(builder: Builder, rootFiles: ScanFile[]) {
  if (!rootFiles.length) return;
  const names = rootFiles.map((file) => file.path);
  const unit: Unit = {
    key: "root",
    label: "Project root",
    glob: namesGlob("", names),
    where: "Repo root",
    files: rootFiles,
  };
  const kind = guessKind("root", rootFiles);
  const split = rootFiles.length >= BIG_DIR_FILES ? splitUnits("", rootFiles, "Project") : null;
  if (!split) return addModule(builder, unit, kind, "root");
  const systemId = builder.ids.take("root");
  builder.nodes.push({
    id: systemId,
    label: "Project root",
    kind: "system",
    summary: describeFiles("Repo root", rootFiles),
    paths: [],
  });
  for (const child of split)
    addModule(
      builder,
      child,
      guessKind(child.key, child.files, kind),
      `root.${slugPart(child.key)}`,
      systemId,
    );
}

// ---------- external hosts ----------

const IGNORED_HOST =
  /^(localhost|.*\.(test|local|localhost|internal|invalid|example)|.*\.?example\.(com|org|net)|.*w3\.org|schema\.org|.*ts\.net)$/;

/** Registrable-ish domain: host without port, last two labels (three for co.uk style). */
export function hostDomain(host: string): string | null {
  const bare = host.toLowerCase().replace(/:\d*$/, "").replace(/\.$/, "");
  if (!bare.includes(".") || /^[\d.]+$/.test(bare) || bare.includes("[") || IGNORED_HOST.test(bare))
    return null;
  const labels = bare.split(".");
  const short = labels.at(-2) ?? "";
  const keep =
    labels.length > 2 &&
    short.length <= 3 &&
    ["co", "com", "net", "org", "ac", "gov"].includes(short)
      ? 3
      : 2;
  return labels.slice(-keep).join(".");
}

function addExternals(builder: Builder, scan: Scan, testFiles: Set<string>) {
  const referrers = new Map<string, Set<string>>();
  for (const ref of scan.hosts ?? []) {
    const domain = hostDomain(ref.host);
    if (!domain || testFiles.has(ref.from)) continue;
    if (!referrers.has(domain)) referrers.set(domain, new Set());
    referrers.get(domain)?.add(ref.from);
  }
  const ranked = [...referrers.entries()].sort(
    (left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]),
  );
  for (const [domain, from] of ranked.slice(0, MAX_EXTERNALS))
    builder.nodes.push({
      id: builder.ids.take(`ext.${slugPart(domain)}`),
      label: clip(domain, LABEL_MAX),
      kind: "external",
      summary: clip(
        `External host referenced from ${from.size} file${from.size === 1 ? "" : "s"}.`,
        SUMMARY_MAX,
      ),
      paths: [],
    });
}

/** Quick first pass: folders become systems and modules, external hosts become external nodes. */
export function heuristicArchitecture(scan: Scan, repoName: string): Architecture {
  const files = scan.files ?? [];
  const builder: Builder = { nodes: [], ids: new IdPool(), totalLoc: sumLoc(files) };
  builder.ids.take(OTHER_ID);
  const rootFiles = files.filter((file) => !file.path.includes("/"));
  const { dirs, rest } = topUnits(files.filter((file) => file.path.includes("/")));
  for (const unit of dirs) addTopUnit(builder, unit, `${unit.key}/`);
  if (rest) addTopUnit(builder, rest, null);
  addRootFiles(builder, rootFiles);
  const testFiles = new Set(
    files
      .filter((file) => /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.\w+$/.test(file.path))
      .map((file) => file.path),
  );
  addExternals(builder, scan, testFiles);
  const name = repoName || scan.rootName || "Project";
  const lang = mainLanguage(files);
  return {
    project: {
      name: clip(name, LABEL_MAX),
      summary: clip(
        `${files.length} files and ${formatCount(builder.totalLoc)} lines${lang ? ` of mostly ${lang}` : ""}, mapped from the folder layout.`,
        SUMMARY_MAX,
      ),
    },
    nodes: builder.nodes,
    flows: [],
  };
}

// ---------- validation ----------

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function checkText(value: unknown, max: number, where: string, errors: string[]) {
  if (!isText(value)) errors.push(`${where} must be a non-empty string`);
  else if (value.length > max)
    errors.push(`${where} must be ${max} characters or fewer (got ${value.length})`);
}

function checkPaths(node: ArchNode, where: string, files: string[], errors: string[]) {
  if (!Array.isArray(node.paths)) return errors.push(`${where}: paths must be a list of globs`);
  const leaf = node.kind !== "system" && node.kind !== "external";
  if (!leaf) {
    if (node.paths.length) errors.push(`${where}: ${node.kind} nodes must have empty paths`);
    return;
  }
  if (!node.paths.length) errors.push(`${where}: paths must list at least one glob`);
  for (const glob of node.paths) {
    if (!isText(glob)) {
      errors.push(`${where}: every path must be a non-empty glob string`);
      continue;
    }
    const matcher = compileGlob(glob);
    if (!files.some((file) => matcher.test(file)))
      errors.push(`${where}: glob ${glob} matches no file`);
  }
}

function checkNode(node: ArchNode, byId: Map<string, ArchNode>, files: string[], errors: string[]) {
  const where = `node ${node.id}`;
  if (!KINDS.includes(node.kind)) errors.push(`${where}: kind must be one of ${KINDS.join(", ")}`);
  checkText(node.label, LABEL_MAX, `${where}: label`, errors);
  checkText(node.summary, SUMMARY_MAX, `${where}: summary`, errors);
  if (node.parent !== undefined) {
    const parent = byId.get(node.parent);
    if (!parent) errors.push(`${where}: parent ${node.parent} does not exist`);
    else if (parent.kind !== "system")
      errors.push(`${where}: parent ${node.parent} must be a system node`);
    if (node.kind === "system") errors.push(`${where}: system nodes cannot have a parent`);
  }
  checkPaths(node, where, files, errors);
}

function collectIds(nodes: ArchNode[], errors: string[]): Map<string, ArchNode> {
  const byId = new Map<string, ArchNode>();
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== "object") {
      errors.push(`node ${index + 1}: must be an object`);
      continue;
    }
    if (!isText(node.id) || !ID_PATTERN.test(node.id))
      errors.push(`node ${index + 1}: id must use letters, digits, dot, dash or underscore`);
    else if (byId.has(node.id)) errors.push(`node ${node.id}: duplicate id`);
    else byId.set(node.id, node);
  }
  return byId;
}

function checkSystemsHaveChildren(nodes: ArchNode[], errors: string[]) {
  const parents = new Set(nodes.map((node) => node.parent));
  for (const node of nodes)
    if (node.kind === "system" && !parents.has(node.id))
      errors.push(`node ${node.id}: system has no child nodes`);
}

function checkSteps(
  flow: Architecture["flows"][number],
  where: string,
  byId: Map<string, ArchNode>,
  errors: string[],
) {
  if (!Array.isArray(flow?.steps) || !flow.steps.length) {
    errors.push(`${where}: steps must be a non-empty list`);
    return;
  }
  for (const [index, step] of flow.steps.entries()) {
    if (!byId.has(step?.node))
      errors.push(`${where} step ${index + 1}: node ${step?.node} does not exist`);
    checkText(step?.note, NOTE_MAX, `${where} step ${index + 1}: note`, errors);
  }
}

function checkFlows(arch: Architecture, byId: Map<string, ArchNode>, errors: string[]) {
  if (!Array.isArray(arch.flows)) return errors.push("flows must be a list");
  const seen = new Set<string>();
  for (const flow of arch.flows) {
    const where = `flow ${flow?.id}`;
    if (!isText(flow?.id) || !ID_PATTERN.test(flow.id))
      errors.push(`${where}: id must use letters, digits, dot, dash or underscore`);
    else if (seen.has(flow.id)) errors.push(`${where}: duplicate id`);
    seen.add(flow?.id);
    checkText(flow?.title, LABEL_MAX * 2, `${where}: title`, errors);
    checkSteps(flow, where, byId, errors);
  }
}

/** Error list for an architecture against the repo's files; empty when valid. Feedback for describe-pass retries. */
export function validateArchitecture(arch: Architecture, files: string[]): string[] {
  const errors: string[] = [];
  if (!arch || typeof arch !== "object") return ["architecture must be a JSON object"];
  checkText(arch.project?.name, LABEL_MAX * 2, "project.name", errors);
  if (typeof arch.project?.summary !== "string") errors.push("project.summary must be a string");
  if (!Array.isArray(arch.nodes) || !arch.nodes.length)
    return [...errors, "nodes must be a non-empty list"];
  const byId = collectIds(arch.nodes, errors);
  for (const node of byId.values()) checkNode(node, byId, files, errors);
  checkSystemsHaveChildren([...byId.values()], errors);
  checkFlows(arch, byId, errors);
  return errors;
}

// ---------- assembly ----------

interface Matcher {
  nodeId: string;
  specificity: number;
  order: number;
  test: (path: string) => boolean;
}

function buildMatchers(nodes: ArchNode[]): Matcher[] {
  const matchers: Matcher[] = [];
  for (const [order, node] of nodes.entries()) {
    if (node.kind === "system" || node.kind === "external") continue;
    for (const glob of node.paths ?? []) {
      const compiled = compileGlob(glob);
      matchers.push({
        nodeId: node.id,
        specificity: compiled.specificity,
        order,
        test: compiled.test,
      });
    }
  }
  // Most specific glob wins; ties go to the node declared first.
  return matchers.sort(
    (left, right) => right.specificity - left.specificity || left.order - right.order,
  );
}

function otherNode(arch: Architecture): ArchNode {
  const taken = new Set(arch.nodes.map((node) => node.id));
  let otherId = OTHER_ID;
  for (let suffix = 2; taken.has(otherId); suffix++) otherId = `${OTHER_ID}-${suffix}`;
  return {
    id: otherId,
    label: "Other files",
    kind: "feature",
    summary: "Files that no described module claims.",
    paths: ["**"],
  };
}

/** Assign each file to its leaf node; unmatched files go to an auto-added "Other files" module. */
function assignFiles(
  arch: Architecture,
  files: ScanFile[],
): { fileModule: Record<string, string>; nodes: ArchNode[] } {
  const matchers = buildMatchers(arch.nodes);
  const fileModule: Record<string, string> = {};
  const other = otherNode(arch);
  let unmatched = 0;
  for (const file of files) {
    const hit = matchers.find((matcher) => matcher.test(file.path));
    fileModule[file.path] = hit ? hit.nodeId : other.id;
    if (!hit) unmatched++;
  }
  return { fileModule, nodes: unmatched ? [...arch.nodes, other] : arch.nodes };
}

function linkWords(node: ArchNode): string[] {
  const words = `${node.label} ${node.id}`.toLowerCase().split(/[^a-z0-9]+/);
  return words.filter(
    (word) =>
      word.length >= 4 && !["apis", "www", "ext", "sites", "services", "service"].includes(word),
  );
}

/** External node for a host: label equals its domain, or a distinctive label word is one of the host's labels. */
function externalMatcher(nodes: ArchNode[]): (host: string) => string | null {
  const externals = nodes.filter((node) => node.kind === "external");
  return (host) => {
    const domain = hostDomain(host);
    if (!domain) return null;
    const hostLabels = domain.split(".");
    const exact = externals.find((node) => node.label.toLowerCase() === domain);
    const loose = externals.find((node) =>
      linkWords(node).some((word) => hostLabels.includes(word)),
    );
    return (exact ?? loose)?.id ?? null;
  };
}

function aggregateLinks(
  scan: Scan,
  fileModule: Record<string, string>,
  nodes: ArchNode[],
): CodeMap["links"] {
  const counts = new Map<string, { from: string; to: string; kind: LinkKind; count: number }>();
  const bump = (source: string | undefined, target: string | null | undefined, kind: LinkKind) => {
    if (!source || !target || source === target) return;
    const key = `${source}\u0000${target}\u0000${kind}`;
    const entry = counts.get(key) ?? { from: source, to: target, kind, count: 0 };
    entry.count++;
    counts.set(key, entry);
  };
  for (const edge of scan.edges ?? []) bump(fileModule[edge.from], fileModule[edge.to], "import");
  for (const call of scan.http ?? []) bump(fileModule[call.from], fileModule[call.to], "http");
  const external = externalMatcher(nodes);
  for (const ref of scan.hosts ?? []) bump(fileModule[ref.from], external(ref.host), "external");
  return [...counts.values()].sort(
    (left, right) => right.count - left.count || left.from.localeCompare(right.from),
  );
}

function moduleStats(
  files: ScanFile[],
  fileModule: Record<string, string>,
  nodes: ArchNode[],
): Record<string, ModuleStats> {
  const stats: Record<string, ModuleStats> = {};
  const parentOf = new Map(nodes.map((node) => [node.id, node.parent]));
  const add = (nodeId: string | undefined, loc: number) => {
    if (!nodeId) return;
    stats[nodeId] ??= { files: 0, loc: 0 };
    stats[nodeId].files++;
    stats[nodeId].loc += loc;
  };
  for (const file of files) {
    const moduleId = fileModule[file.path];
    add(moduleId, file.loc || 0);
    add(parentOf.get(moduleId), file.loc || 0);
  }
  return stats;
}

/** Persisted map: file -> module assignment, aggregated module links and per-node stats. */
export function assembleMap(input: {
  slug: string;
  commit: string | null;
  scan: Scan;
  architecture: Architecture;
  described: boolean;
}): CodeMap {
  const files = input.scan.files ?? [];
  const { fileModule, nodes } = assignFiles(input.architecture, files);
  const fileLoc: Record<string, number> = {};
  for (const file of files) fileLoc[file.path] = file.loc || 0;
  return {
    slug: input.slug,
    commit: input.commit,
    described: input.described,
    architecture: { ...input.architecture, nodes },
    fileModule,
    fileLoc,
    links: aggregateLinks(input.scan, fileModule, nodes),
    stats: moduleStats(files, fileModule, nodes),
  };
}
