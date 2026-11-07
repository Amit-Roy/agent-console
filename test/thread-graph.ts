// Thread graph builder (#421): peer, fork, file, brain, issue, repo and schedule links; fan-out cap, node cap, window and delta cursor.
import assert from "node:assert/strict";
import {
  buildThreadGraph,
  FANOUT_CAP,
  type GraphThread,
  NODE_CAP,
  type TouchRow,
} from "../server/thread-graph.ts";

const NOW = 1_000_000;
const make = (id: string, extra: Partial<GraphThread> = {}): GraphThread => ({
  id,
  provider: "claude",
  title: `title ${id}`,
  status: "idle",
  updatedAt: NOW,
  cwd: `/work/${id}`,
  ...extra,
});
const touch = (thread: string, kind: string, key: string, ts = NOW): TouchRow => ({
  thread,
  kind,
  key,
  line: 1,
  ts,
});
const kindsOf = (graph: ReturnType<typeof buildThreadGraph>) =>
  graph.edges.map((edge) => `${edge.kind}:${edge.a}>${edge.b}`).sort();

// Links
{
  const graph = buildThreadGraph({
    now: NOW,
    threads: [
      make("alpha"),
      make("beta", { forkedFrom: "alpha" }),
      make("gamma", { schedule: { task: "nightly", run: "r1" } }),
      make("delta", { schedule: { task: "nightly", run: "r2" }, background: 2, waiting: 1 }),
      make("epsilon", { issueRun: { repo: "o/r", number: 7 } }),
      make("zeta", { issueRun: { repo: "o/r", number: 7 } }),
    ],
    touches: [
      touch("alpha", "peer", "gamma"),
      touch("alpha", "file", "/x/a.ts"),
      touch("gamma", "file", "/x/a.ts"),
      touch("alpha", "file", "/x/solo.ts"),
      touch("beta", "brain_r", "wiki/page"),
      touch("delta", "brain_w", "wiki/page"),
      touch("alpha", "peer", "missing-thread"),
    ],
    prs: [{ thread: "alpha", repo: "o/r", number: 7 }],
    repos: new Map([
      ["/work/alpha", "/repo/main"],
      ["/work/beta", "/repo/main"],
    ]),
  });
  assert.deepEqual(kindsOf(graph), [
    "brain:beta>delta",
    "file:alpha>gamma",
    "fork:alpha>beta",
    "issue:alpha>epsilon",
    "issue:alpha>zeta",
    "issue:epsilon>zeta",
    "peer:gamma>alpha",
    "repo:alpha>hub:repo:/repo/main",
    "repo:beta>hub:repo:/repo/main",
    "schedule:delta>hub:schedule:nightly",
    "schedule:gamma>hub:schedule:nightly",
  ]);
  const delta = graph.nodes.find((node) => node.id === "delta");
  assert.equal(delta?.subagents, 2, "subagents are a count, not nodes");
  assert.equal(delta?.waiting, true);
  assert.equal(delta?.schedule, "nightly");
  assert.equal(graph.nodes.length, 6);
  assert.ok(graph.hubs.some((hub) => hub.kind === "file" && hub.key === "/x/a.ts"));
  assert.ok(
    !graph.hubs.some((hub) => hub.key === "/x/solo.ts"),
    "a key held by one thread is no hub",
  );
  console.log("PASS thread-graph links: peer, fork, file, brain, issue, repo, schedule");
}

// Fan-out cap
{
  const ids = Array.from({ length: FANOUT_CAP + 1 }, (_, index) => `t${index}`);
  const graph = buildThreadGraph({
    now: NOW,
    threads: ids.map((id) => make(id)),
    touches: ids.map((id) => touch(id, "file", "/lockfile")),
  });
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.dropped.keys, 1);
  console.log("PASS thread-graph fan-out cap drops widely shared keys and counts them");
}

// Node cap, window and kinds
{
  const many = Array.from({ length: NODE_CAP + 5 }, (_, index) =>
    make(`n${index}`, { updatedAt: NOW - index }),
  );
  const capped = buildThreadGraph({ now: NOW, threads: many, touches: [] });
  assert.equal(capped.nodes.length, NODE_CAP);
  assert.equal(capped.dropped.nodes, 5);
  assert.equal(capped.nodes[0].id, "n0", "newest first");

  const threads = [make("fresh"), make("stale", { updatedAt: 10 })];
  const touches = [touch("fresh", "file", "/f"), touch("stale", "file", "/f", 10)];
  const windowed = buildThreadGraph({ now: NOW, threads, touches, since: NOW - 100 });
  assert.deepEqual(
    windowed.nodes.map((node) => node.id),
    ["fresh"],
  );
  assert.equal(
    windowed.edges.length,
    1,
    "an edge to an older thread stays while one end is in the window",
  );
  const none = buildThreadGraph({ now: NOW, threads, touches, kinds: new Set(["peer"]) });
  assert.equal(none.edges.length, 0);
  assert.equal(none.hubs.length, 0);
  console.log("PASS thread-graph node cap, window and kinds filter");
}

// Delta by cursor
{
  const threads = [make("old", { updatedAt: 100 }), make("new", { updatedAt: NOW })];
  const touches = [touch("old", "file", "/s", 100), touch("new", "file", "/s", NOW)];
  const full = buildThreadGraph({ now: NOW, threads, touches });
  const delta = buildThreadGraph({ now: NOW + 10_000, threads, touches, since: full.cursor });
  assert.deepEqual(
    delta.nodes.map((node) => node.id),
    ["new"],
  );
  assert.equal(delta.edges.length, 1);
  assert.ok(delta.cursor > full.cursor);
  console.log("PASS thread-graph since delta returns only changed nodes and their edges");
}
