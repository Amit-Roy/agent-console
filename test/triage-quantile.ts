import assert from "node:assert/strict";
import test from "node:test";
import {
  predictQuantileLogs,
  predictQuantiles,
  QUANTILE_FEATURES,
  type QuantileTree,
  requestFeatures,
  validateQuantileModel,
} from "../server/providers/triage-quantile.ts";

const features = ["size", "lines", "fence", "questions"] as const;
const levels = (p50: number, p75: number, p80: number, p95: number, p99: number) => ({
  p50,
  p75,
  p80,
  p95,
  p99,
});
const leaf = (value: number): QuantileTree => ({
  f: [0],
  t: [0],
  l: [-1],
  r: [-1],
  v: [value],
});
const forest = (value: number) => ({
  p50: [leaf(value)],
  p75: [leaf(value)],
  p80: [leaf(value)],
  p95: [leaf(value)],
  p99: [leaf(value)],
});
/** Hand-built 3-node tree: root splits on size at 1.5, leaves at 10 and 5000 tokens. */
const split: QuantileTree = {
  f: [0, 0, 0],
  t: [0.5, 0, 0],
  l: [1, -1, -1],
  r: [2, -1, -1],
  v: [0, Math.log1p(10), Math.log1p(5000)],
};
const base = () => ({
  features: [...features],
  quantiles: levels(0.5, 0.75, 0.8, 0.95, 0.99),
  baseline: levels(0, 0, 0, 0, 0),
  trees: { p50: [split], p75: [split], p80: [split], p95: [split], p99: [split] },
  offsets: levels(0, 0, 0, 0, 0),
  ceiling: null as number | null,
});

const shape = (text: string) => requestFeatures(text);

test("requestFeatures buckets follow request shape", () => {
  const terse = shape("fix typo");
  assert.equal(terse.size, 0);
  assert.equal(terse.lines, 0);
  assert.equal(terse.refs, 0);
  assert.equal(terse.verbs, 1);
  assert.equal(terse.fence, 0);
  assert.equal(terse.tests, 0);
  assert.equal(terse.versions, 0);

  const long = shape(
    [
      "## Plan",
      "Investigate the ~/repos/agent-console/server/index.ts failure.",
      "Compare ./server/providers/triage-effort.ts against ../docs/effort.md.",
      "It affects `server/providers/triage-effort.ts` and https://example.com/runbooks/build.",
      "```",
      "node test/triage-effort.ts",
      "```",
      "- [ ] reproduce the version 2.4.1 failure",
      "- [x] audit the test spec coverage for e2e",
      "* update the checklist",
      "* restart the worker",
      "Why does it fail? Which commit changed it? Was it the merge?",
      "",
    ].join("\n"),
  );
  assert.ok(long.size > terse.size);
  assert.ok(long.lines > terse.lines);
  assert.ok(long.refs > terse.refs);
  assert.ok(long.verbs > terse.verbs);
  assert.ok(long.logChars > terse.logChars);
  assert.ok(long.logLines > terse.logLines);
  assert.ok(long.logRefs > terse.logRefs);
  assert.ok(long.logVerbs > terse.logVerbs);
  assert.equal(long.fence, 1);
  assert.ok(long.logPaths > 0);
  assert.equal(long.tests, 1);
  assert.ok(long.checklist > 0);
  assert.ok(long.bullets > 0);
  assert.ok(long.questions > 0);
  assert.equal(long.versions, 1);
  for (const name of QUANTILE_FEATURES) {
    assert.ok(Number.isFinite(long[name]), name);
  }
});

test("requestFeatures stays finite on empty and pathological text", () => {
  for (const text of ["", "\n\n\n", "\u0000", "`".repeat(50), "a/b/c ".repeat(2000)]) {
    const values = shape(text);
    for (const name of QUANTILE_FEATURES) {
      assert.ok(Number.isFinite(values[name]), `${name} finite`);
      assert.ok(Math.abs(values[name]) <= 1e6, `${name} capped`);
    }
  }
});

test("tree walk takes the split branch and predicts tokens", () => {
  const model = validateQuantileModel(base());
  assert.ok(model);
  const small = shape("fix typo");
  const large = shape("audit /a/b/c then /d/e/f and `x` and https://example.com/z");
  const smallLogs = predictQuantileLogs(model, small);
  const largeLogs = predictQuantileLogs(model, large);
  assert.equal(smallLogs.p50, Math.log1p(10));
  assert.equal(largeLogs.p50, Math.log1p(5000));
  assert.equal(predictQuantiles(model, small).p50, Math.ceil(Math.expm1(Math.log1p(10))));
  assert.equal(predictQuantiles(model, large).p50, Math.ceil(Math.expm1(Math.log1p(5000))));
});

test("offsets shift every head in log space before the cap and the rearrangement", () => {
  const model = validateQuantileModel({
    ...base(),
    baseline: levels(1, 1, 1, 1, 1),
    offsets: levels(-0.25, 0.5, 0.75, -2, 0.125),
    ceiling: 1000,
  });
  assert.ok(model);
  const logs = predictQuantileLogs(model, shape("fix typo"));
  const leafLog = Math.log1p(10);
  assert.equal(logs.p50, 1 - 0.25 + leafLog);
  assert.equal(logs.p75, 1 + 0.5 + leafLog);
  assert.equal(logs.p80, 1 + 0.75 + leafLog);
  assert.equal(logs.p95, 1 - 2 + leafLog);
  assert.equal(logs.p99, 1 + 0.125 + leafLog);
  const tokens = predictQuantiles(model, shape("fix typo"));
  assert.equal(tokens.p95, tokens.p80);
  assert.equal(tokens.p99, Math.ceil(Math.expm1(logs.p80)));
});

test("validation rejects split indices outside the feature list", () => {
  const model = base();
  const value = Math.log1p(42);
  assert.ok(validateQuantileModel({ ...model, trees: forest(value) }));
  // Descending thresholds stay valid: branch order is a property of the forest, not the schema.
  const descending: QuantileTree = {
    f: [0, 0, 0],
    t: [5, 4, 3],
    l: [1, 2, -1],
    r: [1, 2, -1],
    v: [0, 0, value],
  };
  assert.ok(validateQuantileModel({ ...model, trees: { ...model.trees, p50: [descending] } }));
  for (const f of [
    [0, 4, 4],
    [0, -1, -1],
    [0, 0.5, 0],
  ]) {
    const broken = { ...model, trees: { ...model.trees, p50: [{ ...descending, f }] } };
    assert.equal(validateQuantileModel(broken), null, JSON.stringify(f));
  }
});

test("predictQuantiles enforces non-crossing quantiles", () => {
  const model = validateQuantileModel({
    ...base(),
    baseline: levels(5, 4, 3, 2, 1),
    trees: forest(0),
  });
  assert.ok(model);
  const tokens = predictQuantiles(model, shape("fix typo"));
  assert.ok(tokens.p50 <= tokens.p75);
  assert.ok(tokens.p75 <= tokens.p80);
  assert.ok(tokens.p80 <= tokens.p95);
  assert.ok(tokens.p95 <= tokens.p99);
  assert.equal(tokens.p99, Math.ceil(Math.expm1(5)));
});

test("ceiling caps every quantile", () => {
  const model = validateQuantileModel({
    ...base(),
    baseline: levels(9, 9.5, 10, 11, 12),
    trees: forest(0),
    ceiling: 1000,
  });
  assert.ok(model);
  const cap = Math.log1p(1000);
  const logs = predictQuantileLogs(model, shape("fix typo"));
  for (const level of ["p50", "p75", "p80", "p95", "p99"] as const) {
    assert.equal(logs[level], cap);
  }
  const tokens = predictQuantiles(model, shape("fix typo"));
  const ceilingTokens = Math.ceil(Math.expm1(cap));
  for (const level of ["p50", "p75", "p80", "p95", "p99"] as const) {
    assert.equal(tokens[level], ceilingTokens);
  }
});

test("validation accepts the quantile block and ignores unrelated tags", () => {
  const model = base();
  assert.ok(validateQuantileModel(model));
  assert.ok(validateQuantileModel({ ...model, method: "quantile-gbm-v0", version: 7 }));
  assert.ok(validateQuantileModel({ ...model, ceiling: 0 }));
  assert.equal(validateQuantileModel({ ...model, ceiling: -1 }), null);
});

test("validation rejects malformed forests", () => {
  const model = base();
  const invalid: unknown[] = [];
  invalid.push({ ...model, features: ["size", "size", "fence", "questions"] });
  invalid.push({ ...model, features: ["size", "lines", "fence"] });
  invalid.push({ ...model, features: ["size", "lines", "fence", "nonsense"] });
  invalid.push({ ...model, quantiles: levels(0.5, 0.75, 0.8, 0.95) });
  invalid.push({ ...model, quantiles: levels(0.6, 0.5, 0.8, 0.95, 0.99) });
  invalid.push({ ...model, quantiles: levels(0, 0.75, 0.8, 0.95, 0.99) });
  invalid.push({ ...model, baseline: levels(0, 0, 0, 0, 81) });
  invalid.push({ ...model, baseline: levels(0, 0, 0, 0, Number.POSITIVE_INFINITY) });
  invalid.push({ ...model, trees: { ...model.trees, p50: [] } });
  invalid.push({
    ...model,
    trees: { ...model.trees, p50: [{ f: [0, 0], t: [0], l: [-1], r: [-1], v: [0] }] },
  });
  invalid.push({
    ...model,
    trees: { ...model.trees, p50: [{ f: [0], t: [0], l: [-1], r: [0], v: [0] }] },
  });
  invalid.push({
    ...model,
    trees: { ...model.trees, p50: [{ f: [0], t: [0], l: [1], r: [-1], v: [0] }] },
  });
  invalid.push({
    ...model,
    trees: { ...model.trees, p50: [{ f: [0], t: [0], l: [-1], r: [-1], v: [Number.NaN] }] },
  });
  invalid.push({ ...model, trees: { p50: [leaf(0)] } });
  for (const [index, value] of invalid.entries()) {
    assert.equal(validateQuantileModel(value), null, `case ${index}`);
  }
});

test("validation rejects reserved prototype keys", () => {
  const body = JSON.stringify(base()).slice(0, -1);
  assert.equal(validateQuantileModel(JSON.parse(`${body},"__proto__":{"polluted":true}}`)), null);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(validateQuantileModel(JSON.parse(`${body},"constructor":1}`)), null);
  assert.equal(validateQuantileModel(JSON.parse(`${body},"prototype":[]}`)), null);
  assert.equal(validateQuantileModel(null), null);
  assert.equal(validateQuantileModel([]), null);
  assert.equal(validateQuantileModel("model"), null);
});

/** Complete binary tree in breadth-first order; depth d has 2^d leaves with distinct values. */
function completeTree(depth: number): QuantileTree {
  const count = 2 ** (depth + 1) - 1;
  const firstLeaf = 2 ** depth - 1;
  const tree: QuantileTree = { f: [], t: [], l: [], r: [], v: [] };
  for (let node = 0; node < count; node += 1) {
    const isLeaf = node >= firstLeaf;
    const level = Math.floor(Math.log2(node + 1));
    tree.f.push(level % 3);
    tree.t.push(0.5);
    tree.l.push(isLeaf ? -1 : 2 * node + 1);
    tree.r.push(isLeaf ? -1 : 2 * node + 2);
    tree.v.push(isLeaf ? Math.log1p(10 * (node - firstLeaf + 1)) : 0);
  }
  return tree;
}
const walkReference = (tree: QuantileTree, row: number[]): number => {
  let node = 0;
  while (tree.l[node] !== -1)
    node = row[tree.f[node]] <= tree.t[node] ? tree.l[node] : tree.r[node];
  return tree.v[node];
};

test("validator and walker accept depth-2 and depth-3 heads", () => {
  const texts = [
    "fix typo",
    "audit /a/b/c then /d/e/f and `x`\nsecond line\nthird line\nfourth line\nfifth line here",
    "```\ncode\n```\nrun it now please\nand more\nlines\nfor\nthe\nsize bucket",
    "x ".repeat(300),
  ];
  for (const depth of [2, 3]) {
    const tree = completeTree(depth);
    const model = validateQuantileModel({
      ...base(),
      trees: {
        p50: [tree],
        p75: [tree],
        p80: [tree],
        p95: [tree],
        p99: [tree],
      },
    });
    assert.ok(model, `depth ${depth} accepted`);
    assert.equal(tree.f.length, 2 ** (depth + 1) - 1);
    for (const text of texts) {
      const row = shape(text);
      const expected = walkReference(tree, [row.size, row.lines, row.fence]);
      assert.equal(predictQuantileLogs(model, row).p50, expected, `depth ${depth}: ${text}`);
    }
  }
});
