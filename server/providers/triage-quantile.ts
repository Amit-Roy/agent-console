import { requestShape } from "./triage-effort.ts";

/** Deterministic request features shared with the Python trainer; identical regexes and buckets. */
export const QUANTILE_FEATURES = [
  "size",
  "lines",
  "refs",
  "verbs",
  "logChars",
  "logLines",
  "logRefs",
  "logVerbs",
  "fence",
  "logPaths",
  "tests",
  "checklist",
  "bullets",
  "questions",
  "versions",
] as const;
export type QuantileFeature = (typeof QUANTILE_FEATURES)[number];
export const QUANTILE_LEVELS = ["p50", "p75", "p80", "p95", "p99"] as const;
export type QuantileName = (typeof QUANTILE_LEVELS)[number];

/** Flat array encoding of one boosted tree: f=feature, t=threshold, l/r=children, v=leaf value. */
export interface QuantileTree {
  f: number[];
  t: number[];
  l: number[];
  r: number[];
  v: number[];
}
export interface QuantileTreeModel {
  features: readonly QuantileFeature[];
  quantiles: Record<QuantileName, number>;
  baseline: Record<QuantileName, number>;
  trees: Record<QuantileName, QuantileTree[]>;
  offsets: Record<QuantileName, number>;
  ceiling: number | null;
}

const FEATURE_LIMIT = 1e6;
const MAX_OFFSET = 80;
const MAX_TREES = 400;
const MAX_NODES = 500;
const MAX_THRESHOLD = 1e9;
const MAX_LEAF = 1e4;
const MAX_FEATURES = 32;
const MIN_FEATURES = 4;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REFERENCES = /https?:\/\/|[/~][\w.-]+\/[\w.-]+|`[^`]+`/g;
const ACTION_VERBS =
  /\b(fix|add|build|implement|create|make|set ?up|write|support|deploy|restart|audit|review|investigate|research|compare|test|remove|update|change|label|merge|push|commit)\b/gi;
const PATHS = /(?![\w/])(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+/g;
const CHECKLIST = /^\s*[-*] \[[ x]\]/gm;
const BULLETS = /^\s*[-*] /gm;
const TESTS = /\b(test|tests|spec|coverage|e2e)\b/i;
const VERSIONS = /\bv?\d+\.\d+(\.\d+)?\b/;

const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Reserved keys are poisoned input, never data. */
const keysOf = (value: Record<string, unknown>): string[] | null => {
  const keys = Object.keys(value);
  return keys.some((key) => RESERVED_KEYS.has(key)) ? null : keys;
};
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
const capped = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(FEATURE_LIMIT, Math.max(-FEATURE_LIMIT, value));
};

/** Layout features describe how big the request looks; content features describe what it names. */
export interface RequestFeatureOptions {
  shapeFrom?: string;
}

const layoutFeatures = (text: string) => {
  const shape = requestShape(text);
  const lines = text.split("\n").filter((line) => line.trim()).length;
  return {
    size: capped(shape.requestSize.value),
    lines: capped(shape.requestLines.value),
    verbs: capped(shape.requestActions.value),
    logChars: capped(Math.log1p(text.length)),
    logLines: capped(Math.log1p(lines)),
    logVerbs: capped(Math.log1p(count(text, ACTION_VERBS))),
    fence: capped(text.includes("```") ? 1 : 0),
    checklist: capped(Math.log1p(count(text, CHECKLIST))),
    bullets: capped(Math.log1p(count(text, BULLETS))),
    questions: capped(Math.log1p((text.match(/\?/g) ?? []).length)),
  };
};

/** Features are known before any model call, so inference never depends on session outcomes. */
export function requestFeatures(
  text: string,
  options: RequestFeatureOptions = {},
): Record<QuantileFeature, number> {
  const shape = requestShape(text);
  return {
    ...layoutFeatures(options.shapeFrom ?? text),
    refs: capped(shape.requestReferences.value),
    logRefs: capped(Math.log1p(count(text, REFERENCES))),
    logPaths: capped(Math.log1p(count(text, PATHS))),
    tests: capped(TESTS.test(text) ? 1 : 0),
    versions: capped(VERSIONS.test(text) ? 1 : 0),
  };
}

const levelRecord = (
  value: unknown,
  min: number,
  max: number,
): Record<QuantileName, number> | null => {
  if (!isRecord(value)) return null;
  const keys = keysOf(value);
  if (!keys || keys.length !== QUANTILE_LEVELS.length) return null;
  const out = {} as Record<QuantileName, number>;
  for (const level of QUANTILE_LEVELS) {
    if (!Object.hasOwn(value, level)) return null;
    const item = value[level];
    if (!finite(item, min, max)) return null;
    out[level] = item;
  }
  return out;
};

/** Levels must be probabilities and strictly increasing; crossing probabilities are malformed. */
const probabilityRecord = (value: unknown): Record<QuantileName, number> | null => {
  if (!isRecord(value)) return null;
  const keys = keysOf(value);
  if (!keys || keys.length !== QUANTILE_LEVELS.length) return null;
  const out = {} as Record<QuantileName, number>;
  let previous = 0;
  for (const level of QUANTILE_LEVELS) {
    if (!Object.hasOwn(value, level)) return null;
    const item = value[level];
    if (typeof item !== "number" || !Number.isFinite(item) || item <= 0 || item >= 1) return null;
    if (item <= previous) return null;
    previous = item;
    out[level] = item;
  }
  return out;
};

const isInteger = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const treeModel = (value: unknown, features: number): QuantileTree | null => {
  if (!isRecord(value) || !keysOf(value)) return null;
  const { f, t, l, r, v } = value;
  if (!Array.isArray(f) || !Array.isArray(t) || !Array.isArray(l) || !Array.isArray(r)) return null;
  if (!Array.isArray(v)) return null;
  const nodes = f.length;
  if (nodes < 1 || nodes > MAX_NODES) return null;
  if (t.length !== nodes || l.length !== nodes || r.length !== nodes || v.length !== nodes)
    return null;
  const tree: QuantileTree = { f: [], t: [], l: [], r: [], v: [] };
  for (let node = 0; node < nodes; node += 1) {
    if (!isInteger(f[node], 0, features - 1)) return null;
    if (!finite(t[node], -MAX_THRESHOLD, MAX_THRESHOLD)) return null;
    if (!isInteger(l[node], -1, nodes - 1)) return null;
    if (!isInteger(r[node], -1, nodes - 1)) return null;
    if (!finite(v[node], -MAX_LEAF, MAX_LEAF)) return null;
    if (l[node] === -1 && r[node] !== -1) return null;
    tree.f.push(f[node]);
    tree.t.push(t[node]);
    tree.l.push(l[node]);
    tree.r.push(r[node]);
    tree.v.push(v[node]);
  }
  return tree;
};

const treeRecord = (
  value: unknown,
  features: number,
): Record<QuantileName, QuantileTree[]> | null => {
  if (!isRecord(value)) return null;
  const keys = keysOf(value);
  if (!keys || keys.length !== QUANTILE_LEVELS.length) return null;
  const out = {} as Record<QuantileName, QuantileTree[]>;
  for (const level of QUANTILE_LEVELS) {
    if (!Object.hasOwn(value, level)) return null;
    const list = value[level];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_TREES) return null;
    const trees: QuantileTree[] = [];
    for (const item of list) {
      const tree = treeModel(item, features);
      if (!tree) return null;
      trees.push(tree);
    }
    out[level] = trees;
  }
  return out;
};

/** Reject the whole artifact: a partially loaded forest would silently change every prediction. */
export function validateQuantileModel(value: unknown): QuantileTreeModel | null {
  if (!isRecord(value) || !keysOf(value)) return null;
  const names = value.features;
  if (
    !Array.isArray(names) ||
    names.length < MIN_FEATURES ||
    names.length > MAX_FEATURES ||
    new Set(names).size !== names.length ||
    !names.every((name) => QUANTILE_FEATURES.includes(name as QuantileFeature))
  )
    return null;
  const features = names as QuantileFeature[];
  const quantiles = probabilityRecord(value.quantiles);
  if (!quantiles) return null;
  const baseline = levelRecord(value.baseline, -MAX_OFFSET, MAX_OFFSET);
  if (!baseline) return null;
  const offsets = levelRecord(value.offsets, -MAX_OFFSET, MAX_OFFSET);
  if (!offsets) return null;
  const trees = treeRecord(value.trees, features.length);
  if (!trees) return null;
  const { ceiling } = value;
  if (ceiling !== null && !finite(ceiling, 0, Number.MAX_SAFE_INTEGER)) return null;
  return {
    features,
    quantiles,
    baseline,
    trees,
    offsets,
    ceiling: ceiling === null ? null : (ceiling as number),
  };
}

const leafValue = (
  tree: QuantileTree,
  names: readonly QuantileFeature[],
  features: Record<QuantileFeature, number>,
): number => {
  let node = 0;
  for (let step = 0; step < tree.l.length && tree.l[node] !== -1; step += 1) {
    const name = names[tree.f[node]];
    const raw = name === undefined ? 0 : features[name];
    const feature = Number.isFinite(raw) ? raw : 0;
    node = feature <= tree.t[node] ? tree.l[node] : tree.r[node];
    if (node < 0 || node >= tree.l.length) return 0;
  }
  const value = tree.v[node];
  return Number.isFinite(value) ? value : 0;
};

export function predictQuantileLogs(
  model: QuantileTreeModel,
  features: Record<QuantileFeature, number>,
): Record<QuantileName, number> {
  const cap =
    typeof model.ceiling === "number" && Number.isFinite(model.ceiling)
      ? Math.log1p(Math.max(0, model.ceiling))
      : null;
  const out = {} as Record<QuantileName, number>;
  for (const level of QUANTILE_LEVELS) {
    let total = model.baseline[level] + model.offsets[level];
    for (const tree of model.trees[level]) total += leafValue(tree, model.features, features);
    out[level] = cap === null ? total : Math.min(total, cap);
  }
  return out;
}

/** Quantiles are cumulative: a lower quantile may never exceed a higher one. */
export function predictQuantiles(
  model: QuantileTreeModel,
  features: Record<QuantileFeature, number>,
): Record<QuantileName, number> {
  const logs = predictQuantileLogs(model, features);
  const out = {} as Record<QuantileName, number>;
  let previous = 0;
  for (const level of QUANTILE_LEVELS) {
    const tokens = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.ceil(Math.max(0, Math.expm1(logs[level]))),
    );
    previous = Math.max(previous, tokens);
    out[level] = previous;
  }
  return out;
}
