// PR cockpit library: discovery merge, snapshot mapper, store dedup, conditional poll, rate-limit pause.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CockpitDeps,
  createPrStore,
  discoverPrs,
  extractImages,
  fetchSnapshot,
  invalidateBranch,
  parseGhResponse,
  parseKey,
  prKey,
  rateLimitPause,
  shipFileRef,
} from "../server/pr-cockpit.ts";

const fixture = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures/pr-cockpit/graphql.json"),
  "utf8",
);
const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-cockpit-"));
fs.writeFileSync(
  path.join(shipDir, "Acme_Widgets-7.json"),
  JSON.stringify({ deployed: "abc123", deploy_text: "live" }),
);
fs.writeFileSync(path.join(shipDir, "Acme_Widgets-9.json"), "{}");
fs.writeFileSync(path.join(shipDir, "Other_Repo-1.json"), "{}");

const http = (status: number, headers: Record<string, string>, body: string) =>
  `HTTP/2.0 ${status} X\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n")}\r\n\r\n${body}`;

let clock = Date.now();
let calls: string[][] = [];
let respond: (args: string[]) => string = () => http(200, {}, "null");
const deps: CockpitDeps = {
  gh: async (args) => {
    calls.push(args);
    return respond(args);
  },
  git: async (_cwd, args) =>
    args[0] === "rev-parse" ? "feat/x\n" : "git@github.com:Acme/Widgets.git\n",
  sessionPrs: async () => [
    { repo: "acme/widgets", number: 7 },
    { repo: "Acme/Widgets", number: 8 },
  ],
  issueCrossRefs: async () => [8, 10],
  shipDir,
  now: () => clock,
};
const branchCalls = () =>
  calls.filter((call) => call.some((arg) => arg.includes("pulls?head="))).length;

// source merge + dedupe
respond = (args) =>
  args.some((arg) => arg.includes("pulls?head="))
    ? http(200, {}, JSON.stringify([{ number: 10 }, { number: 11 }]))
    : http(200, {}, "null");
const thread = { id: "t1", cwd: "/w/a", issueRun: { repo: "Acme/Widgets", number: 5, pr: 7 } };
const found = await discoverPrs(thread, deps);
assert.deepEqual(found.map((ref) => prKey(ref.repo, ref.number)).sort(), [
  "acme/widgets#10",
  "acme/widgets#11",
  "acme/widgets#7",
  "acme/widgets#8",
  "acme/widgets#9",
]);
await discoverPrs(thread, deps);
assert.equal(branchCalls(), 1, "branch cached");
invalidateBranch("/w/a");
await discoverPrs(thread, deps);
assert.equal(branchCalls(), 2, "invalidate refetches");
assert.deepEqual(shipFileRef("nefro-Roy_Amit-nefro-2.json"), { repo: "nefr0/owner", number: 2 });
assert.deepEqual(parseKey("a/b#3"), { repo: "a/b", number: 3 });

// snapshot mapper
calls = [];
respond = () => http(200, {}, fixture);
const card = await fetchSnapshot({ repo: "Acme/Widgets", number: 7 }, deps);
assert.equal(calls.length, 1, "one gh call");
assert.ok(calls[0].includes("graphql"));
assert.equal(card.headSha, "abc123");
assert.deepEqual(card.checkCounts, { total: 5, passed: 2, failed: 1, pending: 1, skipped: 1 });
assert.equal(card.checks[0].jobId, "222");
assert.equal(card.checks[0].runId, "111");
assert.equal(card.unresolvedThreads, 2);
assert.equal(card.commentCount, 1, "marker and Copilot comments are noise");
assert.equal(card.reviewCount, 2, "empty/Copilot reviews dropped, changes_requested kept");
assert.deepEqual(card.images, [
  "https://example.test/assets/one.png?a=1&b=2",
  "https://example.test/two.png",
]);
assert.deepEqual(card.deploy, { deployed: "abc123", text: "live" });
assert.deepEqual(extractImages(null), []);

// store: hash-dedup of onChange
const store = createPrStore(deps, { pendingPollMs: 30_000, idlePollMs: 600_000 });
const changes: unknown[] = [];
store.onChange((change) => changes.push(change));
respond = (args) =>
  args.includes("graphql") ? http(200, {}, fixture) : http(200, {}, JSON.stringify([]));
await store.track({ id: "t2", issueRun: { repo: "Acme/Widgets", number: 5, pr: 7 } });
const tracked = store.cardsFor("t2").length;
assert.equal(tracked, 4);
assert.equal(changes.length, tracked, "one emit per new card");
await store.refresh("acme/widgets#7");
assert.equal(changes.length, tracked, "identical snapshot does not emit");
const second = JSON.parse(fixture);
second.data.repository.pullRequest.title = "Renamed";
respond = () => http(200, {}, JSON.stringify(second));
await Promise.all([store.refresh("acme/widgets#7"), store.refresh("acme/widgets#7")]);
assert.equal(changes.length, tracked + 1, "changed snapshot emits once; in-flight deduped");

// 304 does not count
let sentEtag: string | undefined;
respond = (args) => {
  if (!args.some((arg) => arg.includes("check-runs"))) return http(200, {}, JSON.stringify(second));
  sentEtag = args.find((arg) => arg.startsWith("If-None-Match"));
  const runs = [
    { name: "build", status: "completed", conclusion: "success" },
    { name: "lint", status: "completed", conclusion: "failure" },
    { name: "e2e", status: "in_progress", conclusion: null },
    { name: "docs", status: "completed", conclusion: "skipped" },
    { name: "ci/legacy", status: "completed", conclusion: "success" },
  ];
  return sentEtag
    ? http(304, {}, "")
    : http(200, { etag: '"e1"' }, JSON.stringify({ check_runs: runs }));
};
clock += 31_000;
const before = store.stats().budgetUsed;
await store.tick();
const afterFirst = store.stats().budgetUsed;
assert.ok(afterFirst > before, "200 counts");
clock += 31_000;
await store.tick();
assert.equal(sentEtag, 'If-None-Match: "e1"');
assert.equal(store.stats().budgetUsed, afterFirst, "304 not counted");

// webhook signal suppresses poll
for (const number of [7, 8, 9, 10]) store.noteSignal(`acme/widgets#${number}`);
calls = [];
clock += 31_000;
await store.tick();
assert.equal(calls.length, 0, "signal quiets polling");

// 429 backoff pause
clock += 700_000;
respond = () => http(429, { "retry-after": "120" }, "slow down");
await store.tick();
assert.equal(store.stats().pausedUntil, clock + 120_000);
calls = [];
clock += 60_000;
await store.tick();
assert.equal(calls.length, 0, "paused globally");
const reset = http(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }, "");
assert.equal(rateLimitPause(parseGhResponse(reset), 0), 2_000_000);
assert.equal(rateLimitPause(parseGhResponse(http(403, {}, "nope")), 0), null);

// stoppable, unref'd timer
store.start();
store.stop();
console.log("pr-cockpit ok");
