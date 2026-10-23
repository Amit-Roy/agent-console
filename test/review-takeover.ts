import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReviewer } from "../server/issue-review.ts";
import { createEventLog } from "../server/automation/events.ts";

// Every fixture is private. No real GitHub requests, user threads, or model calls are made.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-review-takeover-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const failures: string[] = [];
let fixtureNumber = 0;

let sharedGit: { repos: string; main: string; sha: string } | undefined;
function gitFixture() {
  if (sharedGit) return sharedGit;
  const repos = path.join(root, "repos"),
    main = path.join(repos, "webapp");
  fs.mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "a.txt"), "base\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "Initial fixture");
  const origin = path.join(root, "origin.git");
  git(main, "clone", "-q", "--bare", main, origin);
  git(main, "remote", "add", "origin", origin);
  git(main, "fetch", "-q", "origin");
  git(main, "remote", "set-head", "origin", "main");
  git(main, "checkout", "-qb", "issue-13");
  fs.appendFileSync(path.join(main, "a.txt"), "fix\n");
  git(main, "commit", "-qam", "Fixture fix");
  git(main, "push", "-q", "origin", "issue-13");
  git(main, "checkout", "-q", "main");
  const sha = git(main, "rev-parse", "issue-13");
  return (sharedGit = { repos, main, sha });
}

function fixture(ordinal = 1) {
  const dir = path.join(root, String(++fixtureNumber));
  fs.mkdirSync(dir);
  const { repos, main, sha } = gitFixture();
  let now = 1_800_000_000_000;
  const common = {
    key: "o/webapp#13",
    repo: "o/webapp",
    number: 13,
    effort: "bau",
    branch: "issue-13",
    base: "main",
    pr: 43,
  };
  const worker: any = {
    id: "worker-13",
    status: "idle",
    provider: "pi",
    model: "cheap",
    cwd: main,
    issueRun: { ...common, role: "work", reviews: ordinal, reviewedAt: now, finishedAt: now },
  };
  const reviewer: any = {
    id: "reviewer-13",
    status: "idle",
    provider: "codex",
    model: "premium",
    issueRun: { ...common, role: "review", worker: worker.id, reviews: ordinal, startedAt: now },
  };
  const threads = [worker, reviewer],
    created: any[] = [],
    sent: any[] = [],
    marks: any[] = [];
  let comments: any[] = [],
    merged = false,
    routingProvider = "codex",
    commitAt = now - 1000;
  const events = createEventLog({ file: path.join(dir, "events.jsonl"), now: () => now });
  const runner = {
    create(o: any) {
      const t = { ...o, id: `created-${created.length + 1}`, status: "idle" };
      created.push(t);
      threads.push(t);
      return t;
    },
    send(id: string, text: string) {
      sent.push({ id, text });
      const t = threads.find((t) => t.id === id);
      if (t) t.status = "running";
    },
    mark(id: string, patch: any) {
      marks.push({ id, patch });
      const t = threads.find((t) => t.id === id);
      if (t) Object.assign(t.issueRun, patch);
    },
  };
  const deps: any = {
    runner,
    events,
    dirs: { repos, worktrees: path.join(dir, "worktrees") },
    now: () => now,
    threads: () => threads,
    dataDir: path.join(dir, "data"),
    log: () => {},
    route: () => ({
      v: 1,
      decision: "route",
      route: { provider: routingProvider, model: "premium", effort: "high" },
      alternatives: [],
      why: "fixture",
    }),
    github: async (_method: string, url: string) => {
      if (/\/issues\/43\/comments/.test(url)) return comments;
      if (/\/pulls\?/.test(url))
        return [{ number: 43, body: "## Self-review\nChecked the fixture.", head: { sha } }];
      if (/\/pulls\/43\/files/.test(url)) return [{ filename: "src/a.ts" }];
      if (/\/pulls\/43$/.test(url))
        return { state: merged ? "closed" : "open", merged, merge_commit_sha: sha, head: { sha } };
      if (/\/commits\//.test(url))
        return { commit: { committer: { date: new Date(commitAt).toISOString() } } };
      throw new Error(`Unexpected fixture request: ${url}`);
    },
  };
  const rv = createReviewer(deps);
  return {
    worker,
    reviewer,
    threads,
    created,
    sent,
    marks,
    events,
    rv,
    deps,
    sha,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    comments(body: string, at = now, id = 1) {
      comments = [{ id, body, created_at: new Date(at).toISOString() }];
    },
    merged() {
      merged = true;
    },
    route(provider: string) {
      routingProvider = provider;
    },
    commitAt(value: number) {
      commitAt = value;
    },
  };
}

async function check(name: string, test: () => Promise<void>) {
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`not ok - ${name}`, error);
  }
}

try {
  for (const ordinal of [1, 3])
    for (const is_error of [true, false]) {
      await check(
        `review ${ordinal}, ${is_error ? "infrastructure error" : "no verdict"}: refund and cooldown`,
        async () => {
          const f = fixture(ordinal);
          const staleReviewer = structuredClone(f.reviewer);
          await f.rv.turnEnded(f.reviewer, { is_error });
          assert.equal(
            f.worker.issueRun.reviews,
            ordinal - 1,
            "an attempt without a substantive verdict does not spend a review",
          );
          assert.equal(
            f.worker.issueRun.reviewedAt,
            undefined,
            "the worker is eligible for a fresh reviewer",
          );
          assert.equal(
            f.worker.issueRun.retryAt,
            f.now() + 15 * 60_000,
            "infrastructure retry uses a persisted 15-minute cooldown",
          );
          const refunds = f.marks.filter(
            (m) => m.id === f.worker.id && m.patch.reviews === ordinal - 1,
          ).length;
          await f.rv.turnEnded(staleReviewer, { is_error });
          await f.rv.sweep(f.threads);
          assert.equal(
            f.marks.filter((m) => m.id === f.worker.id && m.patch.reviews === ordinal - 1).length,
            refunds,
            "a duplicate callback or sweep cannot refund twice",
          );
          assert.equal(f.created.length, 0, "a sweep cannot immediately respawn a failed reviewer");
          // A new server must honor the persisted cooldown, too.
          const restarted = createReviewer(f.deps);
          await restarted.sweep(f.threads);
          assert.equal(f.created.length, 0);
          f.advance(15 * 60_000 - 1);
          await restarted.sweep(f.threads);
          assert.equal(f.created.length, 0);
          f.advance(1);
          await restarted.sweep(f.threads);
          assert.equal(f.created.length, 1, "the next reviewer starts after the cooldown");
          assert.equal(f.created[0].issueRun.reviews, ordinal, "the failed ordinal is reused");
          const marksAfterRetry = f.marks.length;
          await restarted.turnEnded(staleReviewer, { is_error });
          assert.equal(
            f.worker.issueRun.reviews,
            ordinal,
            "a delayed old callback must not refund the replacement reviewer",
          );
          assert.equal(
            f.marks.length,
            marksAfterRetry,
            "a persisted judged reviewer is ignored after restart",
          );
        },
      );
    }

  await check(
    "posted changes remain substantive even when the provider ends with an error",
    async () => {
      const f = fixture();
      f.comments("Review: CHANGES REQUESTED\nsrc/a.ts:1 — Wrong total. — Correct the total.");
      await f.rv.turnEnded(f.reviewer, { is_error: true });
      assert.equal(f.worker.issueRun.reviews, 1);
      assert.equal(f.reviewer.issueRun.outcome, "changes");
      assert.equal(f.worker.issueRun.redoing, true);
      assert.equal(f.sent.at(-1)?.id, f.worker.id);
      assert.match(f.sent.at(-1).text, /Wrong total/);
    },
  );

  await check("merged PR wins over an errored provider result", async () => {
    const f = fixture(3);
    f.merged();
    await f.rv.turnEnded(f.reviewer, { is_error: true });
    assert.equal(f.reviewer.issueRun.outcome, "merged");
    assert.equal(f.worker.issueRun.reviews, 3);
    assert.equal(f.sent.length, 0);
    assert.ok(f.events.read({ step: "merge" }).events.some((e) => e.kind === "ok"));
  });

  await check("approval remains substantive when the provider ends with an error", async () => {
    const f = fixture();
    f.comments("Review: APPROVED\nAcceptance checks passed; required CI is pending.");
    await f.rv.turnEnded(f.reviewer, { is_error: true });
    assert.equal(f.reviewer.issueRun.outcome, "approved");
    assert.equal(f.worker.issueRun.reviews, 1);
    assert.equal(
      f.sent.length,
      0,
      "an actual approval must not be treated as an infrastructure retry",
    );
  });

  await check(
    "a previous review's recent verdict cannot spend an infrastructure-failed attempt",
    async () => {
      const f = fixture(2);
      f.comments(
        "Review: CHANGES REQUESTED\nsrc/a.ts:1 — Previous review's finding. — Correct the total.",
        f.now() - 30_000,
      );
      await f.rv.turnEnded(f.reviewer, { is_error: true });
      assert.equal(
        f.worker.issueRun.reviews,
        1,
        "only a verdict posted by this attempt can spend its slot",
      );
      assert.equal(f.worker.issueRun.redoing, undefined);
      assert.equal(f.sent.length, 0);
      assert.equal(f.worker.issueRun.retryAt, f.now() + 15 * 60_000);
    },
  );

  for (const posted of [false, true]) {
    await check(
      `new reviewer comment boundary ${posted ? "accepts new" : "rejects prior"} verdict in the same second`,
      async () => {
        const f = fixture(0);
        f.worker.issueRun.reviewedAt = undefined;
        f.advance(123);
        const second = Math.floor(f.now() / 1000) * 1000;
        f.comments("Review: CHANGES REQUESTED\nsrc/a.ts:1 — Old finding. — Fix it.", second, 100);
        await f.rv.sweep([f.worker]);
        assert.equal(f.created.length, 1);
        const reviewer = f.created[0];
        assert.equal(reviewer.issueRun.verdictAfter, 100);
        if (posted)
          f.comments("Review: CHANGES REQUESTED\nsrc/a.ts:2 — New finding. — Fix it.", second, 101);
        reviewer.status = "idle";
        await f.rv.turnEnded(reviewer, { is_error: true });
        assert.equal(f.worker.issueRun.reviews, posted ? 1 : 0);
        assert.equal(reviewer.issueRun.outcome, posted ? "changes" : "error");
        assert.equal(f.worker.issueRun.redoing === true, posted);
      },
    );
  }

  await check(
    "third review takes premium ownership of the unchanged PR and carries failed work context",
    async () => {
      const f = fixture(2);
      f.worker.issueRun.reviewedAt = undefined;
      f.comments("Review: CHANGES REQUESTED\nsrc/a.ts:1 — Wrong total. — Correct the total.");
      f.events.record({
        step: "worker",
        kind: "fail",
        ref: "o/webapp#13",
        msg: "Provider handshake failed",
        data: { thread: "failed-13" },
      });
      f.events.record({
        step: "worker",
        kind: "fail",
        ref: "o/webapp#99",
        msg: "Unrelated private failure",
      });
      f.threads.push({
        id: "failed-13",
        cwd: "/fixture/failed-work",
        status: "error",
        provider: "pi",
        model: "cheap",
        issueRun: { ...f.worker.issueRun, role: "work" },
      });
      await f.rv.sweep([f.worker]);
      assert.equal(
        f.created.length,
        1,
        "third review must take over even if the worker pushed no new commit",
      );
      const takeover = f.created[0],
        prompt = f.sent.at(-1)?.text ?? "";
      assert.equal(takeover.issueRun.takeover, true);
      assert.equal(takeover.issueRun.reviews, 3);
      assert.match(takeover.title, /premium.*takeover/i);
      assert.equal(takeover.provider, "codex");
      assert.match(prompt, /gh pr merge 43 --repo o\/webapp --squash/);
      assert.doesNotMatch(prompt, /at most 20 changed lines|Anything larger is CHANGES REQUESTED/);
      assert.match(prompt, /worker-13/);
      assert.match(prompt, /failed-13/);
      assert.match(prompt, /\/fixture\/failed-work/);
      assert.match(prompt, /Provider handshake failed/);
      assert.doesNotMatch(prompt, /Unrelated private failure/);
      assert.match(prompt, /logs[\/]failed-13\.jsonl/);
      assert.match(prompt, /review|inspect/i);
      assert.match(prompt, /fix/i);
      assert.match(prompt, /checks|tests/i);
    },
  );

  await check("third review never assigns ownership to a cheap provider", async () => {
    const f = fixture(2);
    f.worker.issueRun.reviewedAt = undefined;
    f.route("pi");
    await f.rv.sweep([f.worker]);
    assert.equal(f.created.length, 0, "premium takeover must defer a non-premium route");
    assert.equal(f.worker.issueRun.reviews, 2, "deferral must not consume the final review");
  });

  await check("second changes verdict hands the existing PR directly to premium", async () => {
    const f = fixture(2);
    f.comments("Review: CHANGES REQUESTED\nsrc/a.ts:1 — Wrong total. — Correct the total.");
    await f.rv.turnEnded(f.reviewer, {});
    assert.equal(f.sent.length, 0, "the exhausted cheap worker must not get another redo");
    assert.equal(f.worker.issueRun.reviewedAt, undefined);
    assert.ok(!f.worker.issueRun.redoing);
    await f.rv.sweep(f.threads);
    assert.equal(f.created.length, 1);
    assert.equal(f.created[0].issueRun.takeover, true);
    assert.equal(f.created[0].issueRun.reviews, 3);
    assert.equal(f.sent[0].id, f.created[0].id);
  });

  await check("legacy exhausted reviews get exactly one premium ownership migration", async () => {
    const f = fixture(3);
    f.reviewer.issueRun.outcome = "changes";
    await f.rv.sweep(f.threads);
    assert.equal(
      f.created.length,
      1,
      "a previously parked legacy issue must resume with premium ownership",
    );
    assert.equal(f.created[0].issueRun.takeover, true);
    assert.equal(f.created[0].issueRun.reviews, 3);
    await f.rv.sweep(f.threads);
    assert.equal(f.created.length, 1, "migration cannot start a second premium owner");
  });

  for (const state of ["takeover", "unjudged", "running"]) {
    await check(`legacy migration excludes ${state} reviewer`, async () => {
      const f = fixture(3);
      if (state === "takeover") {
        f.reviewer.issueRun.takeover = true;
        f.reviewer.issueRun.outcome = "changes";
      }
      if (state === "running") f.reviewer.status = "running";
      await f.rv.sweep(f.threads);
      assert.equal(
        f.created.length,
        0,
        "migration must not duplicate an existing or unfinished reviewer",
      );
    });
  }
  for (const waiting of ["quotaPaused", "background"]) {
    await check(
      `${waiting} reviewer keeps its existing attempt until continuation finishes`,
      async () => {
        const f = fixture();
        f.reviewer[waiting] =
          waiting === "background" ? 1 : { provider: "codex", resetsAt: f.now() + 60000 };
        await f.rv.turnEnded(f.reviewer, { is_error: true });
        await f.rv.sweep(f.threads);
        assert.equal(f.worker.issueRun.reviews, 1);
        assert.equal(f.reviewer.issueRun.outcome, undefined);
        assert.equal(
          f.created.length,
          0,
          "a continuing reviewer must not get a competing replacement",
        );
        delete f.reviewer[waiting];
        await f.rv.turnEnded(f.reviewer, { is_error: true });
        assert.equal(
          f.worker.issueRun.reviews,
          0,
          "a genuinely finished failed attempt returns its slot",
        );
      },
    );
  }

  await check("review launch failure returns its reserved slot", async () => {
    const f = fixture(0);
    f.worker.issueRun.reviewedAt = undefined;
    f.reviewer.issueRun.outcome = "old";
    f.deps.runner.send = () => {
      throw new Error("Tool host unavailable");
    };
    await f.rv.sweep([f.worker]);
    assert.equal(f.created.length, 1);
    assert.equal(f.created[0].issueRun.outcome, "error");
    assert.equal(f.worker.issueRun.reviews, 0);
    assert.equal(f.worker.issueRun.reviewedAt, undefined);
    assert.equal(f.worker.issueRun.retryAt, f.now() + 15 * 60_000);
  });

  await check("a verdict beyond the first 100 PR comments still counts", async () => {
    const f = fixture(0);
    f.worker.issueRun.reviewedAt = undefined;
    f.reviewer.issueRun.outcome = "old";
    const original = f.deps.github;
    let posted = false;
    f.deps.github = async (method: string, url: string) => {
      if (!url.includes("/issues/43/comments")) return original(method, url);
      if (url.includes("page=2"))
        return posted
          ? [
              {
                id: 110,
                body: "Review: CHANGES REQUESTED\nsrc/a.ts:1 — Incorrect. — Fix it.",
                created_at: new Date(f.now()).toISOString(),
              },
            ]
          : [];
      return Array.from({ length: 100 }, (_, i) => ({
        id: i + 10,
        body: "Earlier discussion",
        created_at: new Date(f.now()).toISOString(),
      }));
    };
    const rv = createReviewer(f.deps);
    await rv.sweep([f.worker]);
    const review = f.created[0];
    assert.equal(review.issueRun.verdictAfter, 109);
    posted = true;
    review.status = "idle";
    await rv.turnEnded(review, { is_error: true });
    assert.equal(review.issueRun.outcome, "changes");
    assert.equal(f.worker.issueRun.reviews, 1);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

assert.equal(failures.length, 0, `Failed regressions: ${failures.join("; ")}`);
console.log("review takeover regressions passed");
