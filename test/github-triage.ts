import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTriageService, renderTriageComment, TRIAGE_COMMENT_MARKER, TRIAGE_COMMENT_VERSION_MARKER, triageSourceMarker, type GithubRequest } from "../server/github-triage.ts";

import { fixtureEffortModel } from "./fixtures/triage-effort.ts";
import { quoteEffort } from "../server/providers/triage-effort.ts";
const fixtureQuote = quoteEffort({ breadth: { value: 1 }, complexity: { value: 1 }, uncertainty: { value: 1 }, risk: { value: 1 } }, fixtureEffortModel);
if (fixtureQuote.status !== "ready") throw Error("Invalid fixture pricing");

const secret = "test-only-webhook-secret-never-used-live";
const repo = "Amit-Roy/agent-console";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ac-github-triage-"));
let sequence = 0;
const decision = { effort: "bau", priority: "p1", reason: "Fixture", model: "fixture/small", scorecard: {
  version: 5, pricing: fixtureQuote, metrics: { breadth: { value: 1, evidence: "Fixture title" } }, unknowns: [],
  work: [{ step: "Implement fixture", check: "Fixture passes" }],
  design: { level: "light", reason: "One known surface" },
  tokens: { input: [8000, 20000], output: [2000, 5000], formula: fixtureQuote.formula, confidence: "experimental" },
} } as const;
const sessionReport = renderTriageComment(decision as any, "fixture-source");
assert.ok(sessionReport.includes("initial request → session work → whole-session tokens"));
assert.ok(sessionReport.includes("| Scenario | Total tokens | Generated |"));
assert.ok(sessionReport.includes("Whole-session usage includes later follow-ups."));
assert.ok(sessionReport.includes("Only the initial request supplies predictors."));
const totalModel = structuredClone(fixtureEffortModel.model);
totalModel.workloadMetric = "totalTokens";
totalModel.tokenYieldBasis = "workload";
totalModel.scenarios = totalModel.scenarios.map(row => ({ ...row, inputPerWork: 0.8, outputPerWork: 0.2,
  freshInputPerWork: 0.2, cachedInputPerWork: 0.6, roundsPerWork: null }));
const totalQuote = quoteEffort({ breadth: { value: 1 }, complexity: { value: 1 }, uncertainty: { value: 1 }, risk: { value: 1 } }, { status: "ready", model: totalModel });
assert.equal(totalQuote.status, "ready");
const totalReport = renderTriageComment({ ...decision, scorecard: { ...decision.scorecard, pricing: totalQuote } } as any);
assert.ok(totalReport.includes("Initial request → total session usage"));
assert.ok(totalReport.includes("total-token MAE"));
assert.ok(!totalReport.includes("Logged tool actions"));
assert.ok(totalReport.includes("total session tokens"));
totalModel.estimator = "historical-baseline";
totalModel.workload.coefficients = [0, 0, 0, 0]; totalModel.workload.missingCoefficients = [0, 0, 0, 0];
totalModel.validation = { ...totalModel.validation, hasLearnedComplexitySignal: false, activeWork: { mae: 3 }, activeOutputTokens: { mae: 2 } };
const baselineQuote = quoteEffort({ breadth: { value: 1 }, complexity: { value: 1 }, uncertainty: { value: 1 }, risk: { value: 1 } }, { status: "ready", model: totalModel });
assert.equal(baselineQuote.status, "ready");
const baselineReport = renderTriageComment({ ...decision, scorecard: { ...decision.scorecard, pricing: baselineQuote } } as any);
assert.ok(baselineReport.includes("complexity fit failed the held-out baseline check"));
assert.ok(baselineReport.includes("not task-specific"));
assert.ok(baselineReport.includes("Rejected complexity-fit total-token MAE"));
const legacyDecision = structuredClone(decision) as any;
legacyDecision.scorecard.pricing.scope = "completed-delivery-run";
const legacyReport = renderTriageComment(legacyDecision, "fixture-source");
assert.ok(legacyReport.includes("one observed direct-agent delivery run"));
assert.ok(!legacyReport.includes("whole-session tokens"));
const payload = (number = 1, kind = "issues", action = "opened") => ({
  action, repository: { full_name: repo }, [kind === "issues" ? "issue" : "pull_request"]: { number },
});

function fakeGithub() {
  const items = new Map<number, any>([
    [1, { state: "open", title: "Fixture title", body: "Private fixture body", labels: [{ name: "bug" }, { name: "Eff: Deep" }, { name: "Pri: P3" }] }],
    [2, { state: "open", title: "Fixture PR", body: "PR body", labels: [{ name: "enhancement" }], pull_request: {} }],
  ]);
  const pullRequests = new Map<number, any>([[2, { state: "open", draft: true, head: { sha: "first-head" }, changed_files: 2, additions: 12, deletions: 3 }]]);
  const labels = new Set(["Eff: Deep", "Pri: P3"]);
  const calls: { method: string; endpoint: string; body?: any }[] = [];
  let deleteFailures = 0;
  let lostCommentResponse = false;
  const comments = new Map<number, any[]>();
  let commentSequence = 0;
  const github: GithubRequest = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === "user" && method === "GET") return { login: "fixture-bot" };
    const listMatch = endpoint.match(/\/issues\/(\d+)\/comments(?:\?per_page=100&page=(\d+))?$/);
    if (listMatch) {
      const number = Number(listMatch[1]);
      const rows = comments.get(number) ?? [];
      if (method === "GET") return structuredClone(rows);
      if (method === "POST") {
        const row = { id: ++commentSequence, body: body.body, user: { login: "fixture-bot" } };
        rows.push(row); comments.set(number, rows);
        if (lostCommentResponse) { lostCommentResponse = false; throw new Error("Response lost after successful comment creation"); }
        return structuredClone(row);
      }
    }
    const commentMatch = endpoint.match(/\/issues\/comments\/(\d+)$/);
    if (commentMatch && method === "PATCH") {
      for (const rows of comments.values()) {
        const row = rows.find(row => row.id === Number(commentMatch[1]));
        if (row) { row.body = body.body; return structuredClone(row); }
      }
      throw new Error("Missing comment");
    }
    if (endpoint.includes("/issues?state=open&")) return [...items.entries()].map(([number, item]) => ({ number, ...structuredClone(item) }));
    const itemMatch = endpoint.match(/\/issues\/(\d+)(?:\/labels(?:\/(.+))?)?$/);
    const labelMatch = endpoint.match(/\/labels\/(.+)$/);
    if (itemMatch) {
      const item = items.get(Number(itemMatch[1]));
      if (!item) throw Object.assign(new Error("Missing fixture"), { status: 404 });
      if (method === "GET") return structuredClone(item);
      if (method === "POST") {
        const current = new Set(item.labels.map((label: any) => label.name));
        for (const label of body.labels) current.add(label);
        item.labels = [...current].map(name => ({ name }));
        return structuredClone(item.labels);
      }
      if (method === "DELETE") {
        if (deleteFailures-- > 0) throw new Error("Transient deletion failure");
        item.labels = item.labels.filter((label: any) => label.name !== decodeURIComponent(itemMatch[2]));
        return null;
      }
    }
    if (endpoint.includes("/pulls/2/files?")) return [{ filename: "server/example.ts" }, { filename: "test/example.ts" }];
    if (endpoint.endsWith("/pulls/2")) return structuredClone(pullRequests.get(2));
    if (method === "GET" && labelMatch) {
      const name = decodeURIComponent(labelMatch[1]);
      if (!labels.has(name)) throw Object.assign(new Error("Missing label"), { status: 404 });
      return { name };
    }
    if (method === "POST" && endpoint === `repos/${repo}/labels`) { labels.add(body.name); return body; }
    throw new Error("Unexpected fixture API route");
  };
  return { github, items, pullRequests, calls, comments, failNextDelete() { deleteFailures = 1; }, loseNextCommentResponse() { lostCommentResponse = true; } };
}

async function start(name: string, extras: Record<string, any> = {}) {
  const fake = fakeGithub();
  const dbPath = path.join(directory, `${name}.sqlite`);
  const service = createTriageService({ secret, repos: [repo], dbPath, github: fake.github, classify: async () => decision, retryDelaysMs: [2, 2], ...extras });
  const server = http.createServer(service.handler);
  server.requestTimeout = 5_000;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  async function post(data: any, settings: { event?: string; delivery?: string; signature?: string; raw?: string; headers?: Record<string, string> } = {}) {
    const raw = settings.raw ?? JSON.stringify(data);
    return fetch(`${url}/api/github/webhook`, {
      method: "POST", body: raw, headers: {
        "content-type": "application/json", "x-github-event": settings.event ?? "issues",
        "x-github-delivery": settings.delivery ?? `fixture-${++sequence}`,
        "x-hub-signature-256": settings.signature ?? `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
        ...settings.headers,
      },
    });
  }
  async function close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await service.close();
  }
  return { ...fake, service, post, close, url, dbPath };
}

try {
  let classified = 0;
  const inputs: any[] = [];
  const fixture = await start("validation", { classify: async (input: any) => { classified++; inputs.push(input); return decision; } });
  try {
    assert.equal((await fixture.post(payload(), { signature: `sha256=${"0".repeat(64)}` })).status, 401);
    const original = JSON.stringify(payload());
    const signature = `sha256=${createHmac("sha256", secret).update(original).digest("hex")}`;
    assert.equal((await fixture.post(payload(2), { signature })).status, 401);
    assert.equal((await fixture.post(payload(), { raw: "{", signature })).status, 401);
    assert.equal((await fixture.post(payload(), { headers: { "x-github-delivery": "" } })).status, 401);
    assert.equal((await fixture.post(null, { raw: "{" })).status, 400);
    assert.equal((await fixture.post(null)).status, 400);
    assert.equal((await fixture.post({ ...payload(), repository: { full_name: "other/repository" } })).status, 403);
    assert.equal((await fixture.post({ ...payload(), repository: { full_name: "amit-roy/agent-console" } })).status, 403);
    assert.equal((await fixture.post(payload(-1))).status, 400);
    assert.equal((await fixture.post(payload(Number.MAX_SAFE_INTEGER + 1))).status, 400);
    assert.equal((await fixture.post(payload(), { event: "ping" })).status, 200);
    assert.equal((await fixture.post(payload(1, "issues", "labeled"))).status, 200);
    assert.equal((await fixture.post(payload(), { event: "issue_comment" })).status, 200);
    assert.equal(classified, 0);
    assert.equal(fixture.calls.length, 0);
    assert.equal((await fixture.post(payload(), { delivery: "same-delivery" })).status, 202);
    assert.equal((await fixture.post(payload(), { delivery: "same-delivery" })).status, 202);
    await fixture.service.waitForIdle();
    assert.equal(classified, 1);
    assert.deepEqual(fixture.items.get(1).labels.map((label: any) => label.name).sort(), ["Eff: BAU", "Pri: P1", "bug"].sort());
    assert.equal(fixture.service.status().done, 1);
    const health = await (await fetch(`${fixture.url}/health`)).json() as any;
    assert.equal(health.lastModel, "fixture/small");
    assert.equal(JSON.stringify(health).includes("Private fixture body"), false);
    assert.equal((await fixture.post(payload(2, "pull_request"), { event: "pull_request" })).status, 202);
    await fixture.service.waitForIdle();
    assert.deepEqual(inputs[1].files, ["server/example.ts", "test/example.ts"]);
    assert.equal(inputs[1].draft, true);
    assert.equal(inputs[1].kind, "pull_request");
    assert.equal(inputs[1].changedFiles, 2);
    assert.equal(inputs[1].additions, 12);
    assert.equal(inputs[1].deletions, 3);
    assert.equal(fixture.comments.get(1)?.length, 1);
    assert.equal(fixture.comments.get(2)?.length, 1);
    const report = fixture.comments.get(1)![0].body;
    for (const section of ["### Book of work", "### Estimated token usage", "### Level of design"]) assert.ok(report.includes(section));
    assert.ok(report.includes(TRIAGE_COMMENT_VERSION_MARKER));
    await fixture.post(payload());
    await fixture.service.waitForIdle();
    assert.equal(fixture.comments.get(1)?.length, 1);
    assert.equal(fixture.calls.filter(call => call.method === "POST" && call.endpoint.endsWith("/comments")).length, 2);
  } finally { await fixture.close(); }
  const duplicate = await start("validation", { classify: async () => { throw new Error("Duplicate must never classify"); } });
  try {
    const response = await duplicate.post(payload(), { delivery: "same-delivery" });
    assert.equal((await response.json() as any).duplicate, true);
    await duplicate.service.waitForIdle();
    assert.equal(duplicate.calls.length, 0);
    assert.equal(fs.statSync(duplicate.dbPath).mode & 0o777, 0o600);
  } finally { await duplicate.close(); }
  console.log("PASS webhook signature, raw body, repository/action validation, durable deduplication, PR metadata and label preservation");

  const tooLarge = await start("size", { maxBodyBytes: 100 });
  try { assert.equal((await tooLarge.post(payload(), { raw: "x".repeat(101) })).status, 413); }
  finally { await tooLarge.close(); }

  let failedAttempts = 0;
  const logs: unknown[] = [];
  const failed = await start("failure", { log: (metadata: unknown) => logs.push(metadata), classify: async () => { failedAttempts++; throw new Error("Private provider error must not be logged"); } });
  try {
    await failed.post(payload());
    await failed.service.waitForIdle();
    assert.equal(failedAttempts, 3);
    assert.equal(failed.service.status().failed, 1);
    assert.equal(failed.calls.filter(call => call.method !== "GET").length, 0);
    assert.deepEqual(failed.items.get(1).labels.map((label: any) => label.name), ["bug", "Eff: Deep", "Pri: P3"]);
    assert.equal(JSON.stringify(logs).includes("Private provider"), false);
  } finally { await failed.close(); }

  const partial = await start("partial");
  partial.failNextDelete();
  try {
    await partial.post(payload());
    await partial.service.waitForIdle();
    assert.equal(partial.service.status().done, 1);
    assert.deepEqual(partial.items.get(1).labels.map((label: any) => label.name).sort(), ["Eff: BAU", "Pri: P1", "bug"].sort());
  } finally { await partial.close(); }
  console.log("PASS bounded input, three finite attempts, no labels on model failure and idempotent partial-write recovery");

  let edited: Awaited<ReturnType<typeof start>>;
  edited = await start("manual", { classify: async () => {
    edited.items.get(1).labels.push({ name: "Pri: P0" }, { name: "user-added" });
    return decision;
  } });
  try {
    await edited.post(payload());
    await edited.service.waitForIdle();
    assert.equal(edited.service.status().skipped, 1);
    assert.equal(edited.calls.filter(call => call.method !== "GET").length, 0);
    assert.ok(edited.items.get(1).labels.some((label: any) => label.name === "user-added"));
  } finally { await edited.close(); }

  const closed = await start("closed");
  closed.items.get(1).state = "closed";
  try {
    await closed.post(payload());
    await closed.service.waitForIdle();
    assert.equal(closed.service.status().skipped, 1);
    assert.equal(closed.calls.length, 1);
  } finally { await closed.close(); }

  // Simulate a process crash after the durable claim; startup must recover it.
  const recoverPath = path.join(directory, "recovery.sqlite");
  const seed = await start("recovery");
  await seed.close();
  const db = new DatabaseSync(recoverPath);
  db.prepare("INSERT INTO github_triage(delivery,repo,number,kind,status,attempts,updated) VALUES(?,?,?,?,?,?,?)")
    .run("crashed-delivery", repo, 1, "issue", "running", 1, Date.now());
  db.close();
  const recovered = await start("recovery");
  try {
    await recovered.service.waitForIdle();
    assert.equal(recovered.service.status().done, 1);
    assert.equal(recovered.service.status().running, 0);
  } finally { await recovered.close(); }
  let signalRetry!: () => void;
  const retryScheduled = new Promise<void>(resolve => { signalRetry = resolve; });
  const retrying = await start("retry-restart", {
    retryDelaysMs: [100, 100],
    classify: async () => { throw new Error("Transient model failure"); },
    log: (metadata: any) => { if (metadata.event === "retry") signalRetry(); },
  });
  await retrying.post(payload());
  await retryScheduled;
  await retrying.close();
  const resumed = await start("retry-restart");
  try {
    await resumed.service.waitForIdle();
    assert.equal(resumed.service.status().done, 1);
    assert.equal(resumed.service.status().failed, 0);
  } finally { await resumed.close(); }

  const lostComment = await start("lost-comment-response");
  lostComment.loseNextCommentResponse();
  try {
    await lostComment.post(payload());
    await lostComment.service.waitForIdle();
    // Retry finds the comment the lost response created and skips instead of duplicating it.
    assert.equal(lostComment.service.status().done + lostComment.service.status().skipped, 1);
    assert.equal(lostComment.service.status().failed, 0);
    assert.equal(lostComment.comments.get(1)?.length, 1);
    assert.equal(lostComment.calls.filter(call => call.method === "POST" && call.endpoint.endsWith("/comments")).length, 1);
  } finally { await lostComment.close(); }

  const repairLost = await start("repair-lost-comment");
  repairLost.items.get(1).labels = [{ name: "bug" }];
  repairLost.loseNextCommentResponse();
  try {
    await repairLost.post({ ...payload(1, "issues", "unlabeled"), label: { name: "Eff: Deep" } });
    await repairLost.service.waitForIdle();
    assert.equal(repairLost.service.status().done + repairLost.service.status().skipped, 1);
    assert.equal(repairLost.service.status().failed, 0);
    assert.equal(repairLost.comments.get(1)?.length, 1);
  } finally { await repairLost.close(); }

  // Drift repair: recalibration, hand-edited comments and wrong labels re-converge without losing the comment id.
  let revision = "rev-1";
  let driftRuns = 0;
  const drift = await start("drift", { assessmentRevision: () => revision, classify: async () => { driftRuns++; return decision; } });
  try {
    await drift.service.reconcile(repo);
    await drift.service.waitForIdle();
    const first = drift.comments.get(1)![0];
    const firstId = first.id;
    const runsAfterSeed = driftRuns;
    assert.deepEqual(await drift.service.reconcile(repo), { scanned: 2, queued: 0 });
    first.body = `${TRIAGE_COMMENT_MARKER}\nMaintainer scribble`;
    assert.equal((await drift.service.reconcile(repo)).queued, 1);
    await drift.service.waitForIdle();
    assert.equal(driftRuns, runsAfterSeed, "Edited comments are repaired from the stored assessment without another model call");
    assert.equal(drift.comments.get(1)![0].id, firstId);
    assert.ok(drift.comments.get(1)![0].body.includes(TRIAGE_COMMENT_MARKER));
    drift.items.get(1).labels = [{ name: "bug" }, { name: "Eff: Deep" }, { name: "Pri: P3" }];
    assert.equal((await drift.service.reconcile(repo)).queued, 1);
    await drift.service.waitForIdle();
    assert.deepEqual(drift.items.get(1).labels.map((label: any) => label.name).filter((name: string) => /^(Eff|Pri): /.test(name)).sort(), ["Eff: BAU", "Pri: P1"]);
    revision = "rev-2";
    assert.equal((await drift.service.reconcile(repo)).queued, 2);
    await drift.service.waitForIdle();
    assert.ok(driftRuns > runsAfterSeed, "A new calibration revision re-prices every item");
    assert.equal(drift.comments.get(1)!.length, 1);
    assert.equal(drift.comments.get(1)![0].id, firstId);
    assert.equal(drift.service.status().failed, 0);
  } finally { await drift.close(); }

  let stale: Awaited<ReturnType<typeof start>>;
  let staleClassifications = 0;
  stale = await start("stale-source", { classify: async () => {
    if (++staleClassifications === 1) stale.items.get(1).body = "Changed during model call";
    return decision;
  } });
  try {
    await stale.post(payload());
    await stale.service.waitForIdle();
    assert.equal(staleClassifications, 2);
    assert.equal(stale.service.status().done, 1);
    assert.ok(stale.comments.get(1)![0].body.includes(triageSourceMarker(stale.items.get(1))));
  } finally { await stale.close(); }

  let stalePr: Awaited<ReturnType<typeof start>>;
  let prClassifications = 0;
  stalePr = await start("stale-pr-source", { classify: async () => {
    if (++prClassifications === 1) stalePr.pullRequests.get(2).head.sha = "new-head";
    return decision;
  } });
  try {
    await stalePr.post(payload(2, "pull_request"), { event: "pull_request" });
    await stalePr.service.waitForIdle();
    assert.equal(prClassifications, 2);
    assert.ok(stalePr.comments.get(2)![0].body.includes(triageSourceMarker(stalePr.items.get(2), stalePr.pullRequests.get(2))));
  } finally { await stalePr.close(); }

  let repairCount = 0;
  const repair = await start("removed-labels", { classify: async () => { repairCount++; return decision; } });
  try {
    repair.items.get(1).labels = [{ name: "bug" }];
    assert.equal((await repair.post({ ...payload(1, "issues", "unlabeled"), label: { name: "bug" } })).status, 200);
    assert.equal(repairCount, 0);
    await Promise.all([
      repair.post({ ...payload(1, "issues", "unlabeled"), label: { name: "Eff: Deep" } }),
      repair.post({ ...payload(1, "issues", "unlabeled"), label: { name: "Pri: P3" } }),
    ]);
    await repair.service.waitForIdle();
    assert.equal(repairCount, 1);
    assert.deepEqual(repair.items.get(1).labels.map((label: any) => label.name).sort(), ["Eff: BAU", "Pri: P1", "bug"].sort());
    assert.equal(repair.comments.get(1)?.length, 1);
    // The bot's removal of a conflicting old label must not invoke the model again.
    await repair.post({ ...payload(1, "issues", "unlabeled"), label: { name: "Eff: Deep" } });
    await repair.service.waitForIdle();
    assert.equal(repairCount, 1);
    repair.items.get(2).labels = [{ name: "enhancement" }];
    await repair.post({ ...payload(2, "pull_request", "unlabeled"), label: { name: "Pri: P3" } }, { event: "pull_request" });
    await repair.service.waitForIdle();
    assert.equal(repairCount, 2);
    assert.equal(repair.comments.get(2)?.length, 1);
  } finally { await repair.close(); }

  let reconcileCount = 0;
  const reconcile = await start("reconcile", { classify: async () => { reconcileCount++; return decision; } });
  try {
    const initial = await reconcile.service.reconcile(repo);
    assert.equal(initial.scanned, 2);
    await reconcile.service.waitForIdle();
    assert.equal(reconcileCount, 2);
    assert.deepEqual(await reconcile.service.reconcile(repo), { scanned: 2, queued: 0 });
    // A missed edited webhook is detected even when both labels and a current-version comment exist.
    reconcile.items.get(1).body = "Edited while worker was down";
    assert.deepEqual(await reconcile.service.reconcile(repo), { scanned: 2, queued: 1 });
    await reconcile.service.waitForIdle();
    assert.equal(reconcileCount, 3);
    assert.equal(reconcile.comments.get(1)?.length, 1);
    assert.ok(reconcile.comments.get(1)![0].body.includes(triageSourceMarker(reconcile.items.get(1))));
    // Spoofed marker comments from another account cannot suppress or receive bot updates.
    const spoof = { id: 9999, user: { login: "other-account" }, body: `${TRIAGE_COMMENT_MARKER}\n${TRIAGE_COMMENT_VERSION_MARKER}\n${triageSourceMarker(reconcile.items.get(1))}` };
    reconcile.comments.set(1, [spoof]);
    assert.equal((await reconcile.service.reconcile()).queued, 1);
    await reconcile.service.waitForIdle();
    assert.equal(reconcile.comments.get(1)?.length, 2);
    assert.equal(reconcile.comments.get(1)![0].body, spoof.body);
    const body = JSON.stringify({ repository: { full_name: repo } });
    assert.equal((await fetch(`${reconcile.url}/reconcile`, { method: "POST", body })).status, 401);
    const headers = { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
    const response = await fetch(`${reconcile.url}/reconcile`, { method: "POST", body, headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { scanned: 2, queued: 0 });
  } finally { await reconcile.close(); }
  console.log("PASS one upserted scorecard, lost-response recovery, managed-label repair, event coalescing, stale-source reconciliation and comment ownership");

  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const slow = await start("slow", { classify: async () => { await gate; return decision; } });
  try {
    const response = await slow.post(payload());
    assert.equal(response.status, 202);
    assert.equal((await fetch(`${slow.url}/health`)).status, 200);
    unblock();
    await slow.service.waitForIdle();
    assert.equal(slow.service.status().done, 1);
  } finally { unblock(); await slow.close(); }
  console.log("PASS maintainer updates, closed-item skip and persisted in-flight recovery");
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
