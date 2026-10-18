import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTriageService, type GithubRequest } from "../server/github-triage.ts";

const secret = "test-only-webhook-secret-never-used-live";
const repo = "Amit-Roy/agent-console";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ac-github-triage-"));
let sequence = 0;
const decision = { effort: "bau", priority: "p1", reason: "Fixture", model: "fixture/small" } as const;
const payload = (number = 1, kind = "issues", action = "opened") => ({
  action, repository: { full_name: repo }, [kind === "issues" ? "issue" : "pull_request"]: { number },
});

function fakeGithub() {
  const items = new Map<number, any>([
    [1, { state: "open", title: "Fixture title", body: "Private fixture body", labels: [{ name: "bug" }, { name: "Eff: Deep" }, { name: "Pri: P3" }] }],
    [2, { state: "open", title: "Fixture PR", body: "PR body", labels: [{ name: "enhancement" }], pull_request: {} }],
  ]);
  const labels = new Set(["Eff: Deep", "Pri: P3"]);
  const calls: { method: string; endpoint: string; body?: any }[] = [];
  let deleteFailures = 0;
  const github: GithubRequest = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
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
    if (endpoint.endsWith("/pulls/2")) return { state: "open", draft: true };
    if (method === "GET" && labelMatch) {
      const name = decodeURIComponent(labelMatch[1]);
      if (!labels.has(name)) throw Object.assign(new Error("Missing label"), { status: 404 });
      return { name };
    }
    if (method === "POST" && endpoint === `repos/${repo}/labels`) { labels.add(body.name); return body; }
    throw new Error("Unexpected fixture API route");
  };
  return { github, items, calls, failNextDelete() { deleteFailures = 1; } };
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
    assert.equal(fixture.calls.some(call => call.endpoint.includes("/comments")), false);
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
