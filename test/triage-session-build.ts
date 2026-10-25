import assert from "node:assert/strict";
import { canonicalSessionSamples } from "../scripts/triage-session-build.ts";

const task = (id: string, ids: string[], tokens: number, group = id) => ({
  id,
  group,
  request: "Build an app.",
  preworkContext: [],
  provider: "fixture",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-02T00:00:00.000Z",
  inputTokens: tokens,
  outputTokens: tokens / 2,
  cacheReadTokens: tokens / 4,
  nonCachedInputTokens: (tokens * 3) / 4,
  toolCalls: 0,
  toolRounds: 0,
  provenance: { nativeSessionIds: ids },
});
const link = (threadId: string, ids: string[], active = false) => ({
  threadId,
  nativeSessionIds: ids,
  active,
});

const mirrored = canonicalSessionSamples(
  { tasks: [task("console:a", ["n1"], 999)], sessionLinks: [link("a", ["n1"])] },
  { tasks: [task("native:n1", ["n1", "child1"], 100)] },
);
assert.equal(mirrored.tasks.length, 1);
assert.equal(
  mirrored.tasks[0].inputTokens,
  100,
  "A Console mirror must not double-count native totals",
);
assert.equal(mirrored.tasks[0].toolCalls, 0, "Zero-tool conversations remain samples");
assert.equal(mirrored.audit.duplicateConsoleMirrors, 1);

const resumed = canonicalSessionSamples(
  { tasks: [task("console:a", ["n1", "n2"], 500)], sessionLinks: [link("a", ["n1", "n2"])] },
  { tasks: [task("native:n1", ["n1"], 100), task("native:n2", ["n2"], 200)] },
);
assert.equal(resumed.tasks.length, 1);
assert.equal(
  resumed.tasks[0].inputTokens,
  300,
  "Disjoint backend sessions within one Console session are aggregated",
);

const incompleteNative = canonicalSessionSamples(
  {
    tasks: [task("console:a", ["n1", "missing"], 500)],
    sessionLinks: [link("a", ["n1", "missing"])],
  },
  { tasks: [task("native:n1", ["n1"], 100)] },
);
assert.equal(
  incompleteNative.tasks[0].inputTokens,
  500,
  "Complete ledger is preferred to partial native coverage",
);
assert.equal(incompleteNative.audit.consoleFallbackSessions, 1);

const active = canonicalSessionSamples(
  { tasks: [], sessionLinks: [link("a", ["n1"], true)] },
  { tasks: [task("native:n1", ["n1"], 100)] },
);
assert.equal(active.tasks.length, 0);
assert.equal(active.audit.activeComponents, 1);

const forked = canonicalSessionSamples(
  { tasks: [], sessionLinks: [link("a", ["n1"]), link("b", ["n2"])] },
  { tasks: [task("native:n1", ["n1"], 100, "lineage"), task("native:n2", ["n2"], 200, "lineage")] },
);
assert.equal(forked.tasks.length, 2);
assert.equal(
  forked.tasks[0].group,
  forked.tasks[1].group,
  "Related native forks must not cross train/test groups",
);
assert.deepEqual(forked.tasks[0].preworkContext, []);
const realFork = canonicalSessionSamples(
  {
    tasks: [],
    sessionLinks: [
      link("parent", ["parent-native"]),
      { ...link("fork", ["fork-native"]), lineageNativeSessionIds: ["parent-native"] },
    ],
  },
  {
    tasks: [
      task("native:parent", ["parent-native"], 100),
      task("native:fork", ["fork-native"], 200),
    ],
  },
);
assert.equal(realFork.tasks.length, 2, "Fork lineage is not transcript identity");
assert.deepEqual(realFork.tasks.map((item) => item.inputTokens).sort(), [100, 200]);
assert.equal(
  realFork.tasks[0].group,
  realFork.tasks[1].group,
  "Fork lineage joins only validation groups",
);
console.log(
  "Session canonicalization: mirrors, resumptions, native gaps, active exclusion, and fork grouping passed.",
);

const origin = (userOrigin: boolean) => ({
  provenance: { nativeSessionIds: [] as string[], userOrigin },
});
const probe = (sessionId: string, userOrigin: boolean) => ({
  ...task(`native:${sessionId}`, [sessionId], 10),
  ...origin(userOrigin),
  provenance: { nativeSessionIds: [sessionId], userOrigin },
});
const filtered = canonicalSessionSamples(
  {
    tasks: [task("console:c", ["linked"], 50)],
    sessionLinks: [link("c", ["linked"])],
  },
  {
    tasks: [
      probe("sdk-cli-probe", false),
      probe("tmp-cwd", false),
      probe("linked", false),
      probe("interactive", true),
    ],
  },
);
assert.deepEqual(filtered.tasks.map((item) => item.id).sort(), ["console:c", "native:interactive"]);
assert.equal(filtered.audit.nonUserOrigin, 2);
