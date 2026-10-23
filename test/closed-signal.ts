import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { announceClosed, watchClosed } from "../server/automation/closed-signal.ts";
import { createTriageService } from "../server/github-triage.ts";

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "closed-")), "events");
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
console.log("closed-signal ok");
