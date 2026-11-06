import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  announceClosed,
  announcePr,
  watchClosed,
  watchPrSignals,
} from "../server/automation/closed-signal.ts";
import { createTriageService } from "../server/github-triage.ts";

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "closed-")), "events");
process.env.AGENT_CONSOLE_TRIAGE_CONFIG = path.join(path.dirname(dir), "cfg.json"); // default events dir = <tmp>/github-events
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An announcement triggers a sweep; a burst during a sweep coalesces into exactly one more run.
{
  let runs = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const watcher = watchClosed(dir, async () => {
    runs++;
    if (runs === 1) await gate;
  });
  announceClosed(dir, { repo: "o/r", number: 1, kind: "issue" });
  await wait(150);
  assert.equal(runs, 1);
  announceClosed(dir, { repo: "o/r", number: 2, kind: "issue" });
  announceClosed(dir, { repo: "o/r", number: 3, kind: "pull_request" });
  await wait(150);
  assert.equal(runs, 1, "no overlapping sweeps");
  release();
  await wait(200);
  assert.equal(runs, 2, "one follow-up run covers the burst");
  watcher.close();
}

// The webhook reports closed issues and merged PRs only, never queues triage for them, and rejects unknown repos.
{
  const secret = "s".repeat(24),
    seen: any[] = [];
  const svc = createTriageService({
    secret,
    repos: ["o/r"],
    dbPath: path.join(path.dirname(dir), "t.sqlite"),
    classify: async () => {
      throw new Error("no");
    },
    onClosed: (i) => seen.push(i),
    log: () => {},
  });
  const post = async (event: string, body: any) => {
    const text = JSON.stringify(body);
    const headers = {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`,
      "x-github-delivery": "d" + Math.random().toString(16).slice(2),
      "x-github-event": event,
      "content-length": String(Buffer.byteLength(text)),
    };
    const { Readable } = await import("node:stream");
    const req: any = Readable.from([Buffer.from(text)]);
    req.method = "POST";
    req.url = "/api/github/webhook";
    req.headers = headers;
    let code = 0,
      out = "";
    await new Promise<void>((done) => {
      const res: any = {
        headersSent: false,
        writeHead: (c: number) => {
          code = c;
        },
        end: (b?: string) => {
          out = b ?? "";
          done();
        },
      };
      svc.handler(req, res);
    });
    return { code, body: JSON.parse(out) };
  };
  const repository = { full_name: "o/r" };
  assert.deepEqual(
    (await post("issues", { action: "closed", repository, issue: { number: 5 } })).body,
    { closed: true },
  );
  assert.deepEqual(
    (
      await post("pull_request", {
        action: "closed",
        repository,
        pull_request: { number: 6, merged: true },
      })
    ).body,
    { closed: true },
  );
  assert.deepEqual(
    (
      await post("pull_request", {
        action: "closed",
        repository,
        pull_request: { number: 7, merged: false },
      })
    ).body,
    { closed: false },
  );
  assert.deepEqual(
    (await post("issues", { action: "closed", repository, issue: { number: 8, pull_request: {} } }))
      .body,
    { closed: false },
  );
  assert.equal(
    (
      await post("issues", {
        action: "closed",
        repository: { full_name: "x/y" },
        issue: { number: 9 },
      })
    ).code,
    403,
  );
  assert.deepEqual(seen, [
    { repo: "o/r", number: 5, kind: "issue" },
    { repo: "o/r", number: 6, kind: "pull_request" },
  ]);
  await svc.close?.();
}

// Per-PR signals: every event writes a marker, never enqueues, forged requests are rejected, the watcher consumes and debounces.
{
  const secret = "s".repeat(24),
    base = path.dirname(dir),
    signalDir = path.join(base, "github-events", "pr-signals");
  fs.rmSync(signalDir, { recursive: true, force: true }); // drop markers from the closed-signal block above
  let enqueued = 0;
  const svc = createTriageService({
    secret,
    repos: ["o/r"],
    dbPath: path.join(base, "p.sqlite"),
    classify: async () => {
      enqueued++;
      throw new Error("no");
    },
    onItem: () => {
      enqueued++;
    },
    log: () => {},
  });
  const send = async (event: string, body: any, sign = true) => {
    const text = JSON.stringify(body);
    const digest = createHmac("sha256", sign ? secret : "x".repeat(24))
      .update(text)
      .digest("hex");
    const { Readable } = await import("node:stream");
    const req: any = Readable.from([Buffer.from(text)]);
    req.method = "POST";
    req.url = "/api/github/webhook";
    req.headers = {
      "x-hub-signature-256": `sha256=${digest}`,
      "x-github-delivery": "p" + Math.random().toString(16).slice(2),
      "x-github-event": event,
      "content-length": String(Buffer.byteLength(text)),
    };
    let code = 0;
    await new Promise<void>((done) => {
      svc.handler(req, {
        headersSent: false,
        writeHead: (c: number) => {
          code = c;
        },
        end: () => done(),
      } as any);
    });
    return code;
  };
  const repository = { full_name: "o/r" };
  const sha = "a".repeat(40);
  const cases: [string, any][] = [
    [
      "check_suite",
      { repository, check_suite: { head_sha: sha, pull_requests: [{ number: 11 }] } },
    ],
    ["check_run", { repository, check_run: { head_sha: sha, pull_requests: [{ number: 12 }] } }],
    ["status", { repository, sha }],
    ["pull_request_review", { repository, pull_request: { number: 13 } }],
    ["pull_request_review_comment", { repository, pull_request: { number: 14 } }],
    ["issue_comment", { repository, issue: { number: 15, pull_request: {} } }],
    ["deployment_status", { repository, deployment: { sha } }],
    [
      "workflow_run",
      {
        repository,
        action: "completed",
        workflow_run: { head_sha: sha, pull_requests: [{ number: 16 }] },
      },
    ],
  ];
  for (const [event, body] of cases) assert.equal(await send(event, body), 200, event);
  const files = fs.readdirSync(signalDir).sort();
  assert.deepEqual(
    files,
    [
      "o_r-11.json",
      "o_r-12.json",
      "o_r-13.json",
      "o_r-14.json",
      "o_r-15.json",
      "o_r-16.json",
      `o_r-${sha}.json`,
    ].sort(),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(signalDir, "o_r-11.json"), "utf8")).event,
    "check_suite",
  );
  // issue comment on a plain issue: no marker
  await send("issue_comment", { repository, issue: { number: 99 } });
  assert.ok(!fs.existsSync(path.join(signalDir, "o_r-99.json")));
  // forged signature and unknown repo rejected, nothing written
  assert.equal(
    await send("check_run", { repository, check_run: { pull_requests: [{ number: 77 }] } }, false),
    401,
  );
  assert.equal(
    await send("check_run", {
      repository: { full_name: "x/y" },
      check_run: { pull_requests: [{ number: 78 }] },
    }),
    403,
  );
  assert.ok(!fs.existsSync(path.join(signalDir, "o_r-77.json")));
  assert.ok(!fs.existsSync(path.join(signalDir, "x_y-78.json")));
  await wait(100);
  assert.equal(enqueued, 0, "PR signals never enqueue triage (pull_request itself may)");
  // pull_request still announces
  await send("pull_request", {
    repository,
    action: "synchronize",
    pull_request: { number: 17, head: { sha } },
  });
  assert.ok(fs.existsSync(path.join(signalDir, "o_r-17.json")));
  await svc.close?.();
}

{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prsig-")),
    sigDir = path.join(base, "pr-signals"),
    got: any[] = [];
  fs.mkdirSync(sigDir, { recursive: true });
  fs.writeFileSync(path.join(sigDir, "bad-1.json"), "{not json");
  announcePr({ repo: "o/r", pr: 1, event: "check_run" }, base); // present before start
  const stop = watchPrSignals((s) => got.push(s), { dir: base, debounceMs: 200 });
  await wait(50);
  assert.deepEqual(fs.readdirSync(sigDir), [], "files consumed and deleted, invalid one dropped");
  // burst for one key + one other key
  for (const event of ["check_run", "check_suite", "status"])
    announcePr({ repo: "o/r", pr: 2, event }, base);
  announcePr({ repo: "o/r", sha: "b".repeat(40), event: "status" }, base);
  await wait(500);
  stop();
  assert.equal(got.filter((s) => s.pr === 1).length, 1);
  assert.equal(got.filter((s) => s.pr === 2).length, 1, "burst collapses to one callback");
  assert.equal(got.find((s) => s.pr === 2).event, "status", "latest event wins");
  assert.equal(got.length, 3);
  assert.deepEqual(fs.readdirSync(sigDir), []);
}
console.log("closed-signal ok");
