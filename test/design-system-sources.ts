import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { run, triage, SOURCES, RULES } = await import("../scripts/check-design-system-sources.js");

const NOW = Date.parse("2026-11-02T00:00:00Z");
const recent = "2026-10-20T00:00:00Z";
const hnHit = (id: number, title: string, points: number, url?: string) => ({
  objectID: String(id),
  title,
  points,
  num_comments: 12,
  url,
  created_at: recent,
});
const HN_HITS = [
  hnHit(1, "Six levels of dark mode", 400, "https://example.com/dark"),
  hnHit(2, "Typography for dense UIs", 150, "https://example.com/type"),
  hnHit(3, "A new database engine", 900, "https://example.com/db"),
  hnHit(4, "Color contrast myths", 50, "https://example.com/weak"),
  hnHit(5, "Focus rings done right @someone", 120),
];
const LOBSTERS = [
  {
    title: "Design tokens across platforms",
    score: 60,
    comment_count: 4,
    url: "https://example.com/tokens",
    short_id_url: "https://lobste.rs/s/abc",
    created_at: recent,
  },
  {
    title: "Six levels of dark mode",
    score: 30,
    comment_count: 1,
    url: "https://example.com/dark",
    short_id_url: "https://lobste.rs/s/dup",
    created_at: recent,
  },
  {
    title: "An old icon grid essay",
    score: 80,
    comment_count: 2,
    url: "https://example.com/old",
    short_id_url: "https://lobste.rs/s/old",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const fetched: string[] = [];
const agents: string[] = [];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fakeFetch = async (url: string, init: any) => {
  fetched.push(url);
  agents.push(init?.headers?.["User-Agent"]);
  if (url.startsWith("https://hn.algolia.com/")) return ok({ hits: HN_HITS });
  if (url.startsWith("https://lobste.rs/")) return ok(LOBSTERS);
  throw new Error(`unexpected fetch ${url}`);
};

function fakeGh(existing: string[] = []) {
  const created: any[] = [];
  return {
    created,
    gh: {
      list: () => existing.map((url) => ({ body: `Link: ${url}` })),
      create: (draft: any) => {
        created.push(draft);
        return `https://github.com/nefr0/agent-console/issues/${900 + created.length}`;
      },
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ds-sources-"));
const base = { fetch: fakeFetch, now: NOW, log: () => {}, warn: () => {} };
try {
  // triage rule: one verdict per suggestion, with a reason
  const hn = SOURCES.find((source: any) => source.name === "Hacker News");
  const item = (over: any) => ({
    source: hn,
    title: "Dark mode tips",
    url: "https://example.com/x",
    score: 200,
    postedAt: recent,
    ...over,
  });
  const verdict = (over: any, known = new Set<string>()) => triage(item(over), { now: NOW, known });
  assert.deepEqual(verdict({}), {
    verdict: "approve",
    section: "Colors",
    reason: "on topic for Colors, 200 >= 100 points, posted in the last 90 days",
  });
  assert.match(verdict({ title: "A database" }).reason, /off-topic/);
  assert.match(verdict({ score: 99 }).reason, /below popularity/);
  assert.match(verdict({ postedAt: "2025-01-01T00:00:00Z" }).reason, /older than 90 days/);
  assert.match(verdict({}, new Set(["https://example.com/x"])).reason, /already filed/);
  assert.equal(verdict({ title: "Design tokens" }).section, "Components");

  // dry run: reads only the named sources, writes drafts, creates nothing
  const dryGh = fakeGh();
  const dry = await run({ ...base, dryRun: true, outDir: path.join(tmp, "dry"), gh: dryGh.gh });
  assert.equal(dry.version, 1);
  assert.equal(dryGh.created.length, 0, "dry run creates no issues");
  assert.ok(fetched.length > 0);
  for (const url of fetched)
    assert.ok(
      SOURCES.some((source: any) => url.startsWith(source.origin)),
      `${url} is a named source`,
    );
  assert.ok(agents.every((agent) => /agent-console-design-system/.test(agent)));
  assert.deepEqual(
    dry.sources.map((source: any) => source.name),
    ["Hacker News", "Lobsters"],
  );
  const drafts = JSON.parse(fs.readFileSync(dry.file, "utf8"));
  assert.equal(dry.file, path.join(tmp, "dry", "drafts.json"));
  assert.deepEqual(
    drafts.drafts.map((draft: any) => draft.title),
    [
      "Design system (Colors): Six levels of dark mode",
      "Design system (Typography): Typography for dense UIs",
      "Design system (Usage Guidelines): Focus rings done right @\u200bsomeone",
    ],
    "approved drafts, most popular first, capped per run",
  );
  assert.equal(RULES.maxIssuesPerRun, 3);
  const first = drafts.drafts[0];
  assert.ok(first.body.includes("Link: https://example.com/dark"));
  assert.ok(first.body.includes("https://news.ycombinator.com/item?id=1"));
  assert.ok(first.body.includes("400 points"));
  assert.ok(first.body.includes("docs/design-system.md"));
  assert.deepEqual(first.labels, ["design-system", "enhancement"]);
  const reasons = Object.fromEntries(drafts.skipped.map((skip: any) => [skip.title, skip.reason]));
  assert.match(reasons["A new database engine"], /off-topic/);
  assert.match(reasons["Color contrast myths"], /below popularity/);
  assert.match(reasons["An old icon grid essay"], /older than 90 days/);
  assert.match(reasons["Design tokens across platforms"], /per-run cap/);
  assert.equal(
    drafts.skipped.filter((skip: any) => skip.title === "Six levels of dark mode").length,
    1,
    "same link from two sources is filed once",
  );

  // real run: one issue per approved suggestion, run record keeps created and skipped
  const realGh = fakeGh(["https://example.com/type"]);
  const real = await run({ ...base, outDir: path.join(tmp, "real"), gh: realGh.gh });
  assert.deepEqual(
    realGh.created.map((draft: any) => draft.title),
    [
      "Design system (Colors): Six levels of dark mode",
      "Design system (Usage Guidelines): Focus rings done right @\u200bsomeone",
      "Design system (Components): Design tokens across platforms",
    ],
  );
  assert.equal(real.created[0].issue, "https://github.com/nefr0/agent-console/issues/901");
  assert.ok(real.file.startsWith(path.join(tmp, "real", "runs")));
  const record = JSON.parse(fs.readFileSync(real.file, "utf8"));
  assert.equal(record.created.length, 3);
  assert.match(
    record.skipped.find((skip: any) => skip.title === "Typography for dense UIs").reason,
    /already filed/,
  );
  assert.ok(!fs.existsSync(path.join(tmp, "real", "drafts.json")));

  // issue list unavailable: nothing is created, the run says why
  const blind = await run({
    ...base,
    outDir: path.join(tmp, "blind"),
    gh: {
      list: () => {
        throw new Error("gh auth required");
      },
      create: () => assert.fail("must not create without dedupe"),
    },
  });
  assert.equal(blind.created.length, 0);
  assert.ok(blind.errors.some((error: string) => /gh auth required/.test(error)));
  assert.ok(blind.skipped.some((skip: any) => /not created/.test(skip.reason)));

  // one create fails: reported, the rest still filed
  let calls = 0;
  const partial = await run({
    ...base,
    outDir: path.join(tmp, "partial"),
    gh: {
      list: () => [],
      create: () => {
        calls += 1;
        if (calls === 1) throw new Error("rate limited");
        return `https://github.com/nefr0/agent-console/issues/${calls}`;
      },
    },
  });
  assert.equal(partial.created.length, 2);
  assert.ok(partial.errors.some((error: string) => /rate limited/.test(error)));

  // an external title cannot inject markdown (remote images, links) into the issue body
  const tricky = await run({
    ...base,
    dryRun: true,
    outDir: path.join(tmp, "tricky"),
    gh: fakeGh().gh,
    fetch: async (url: string) =>
      url.startsWith("https://lobste.rs/")
        ? ok([{ ...LOBSTERS[0], title: "Dark mode ![x](https://evil.example/p.png)" }])
        : ok({ hits: [] }),
  });
  assert.ok(tricky.approved[0].body.includes("> Dark mode \\!\\[x\\](https://evil.example/p.png)"));

  // a source that fails is reported; the other source is still read
  const down = await run({
    ...base,
    dryRun: true,
    outDir: path.join(tmp, "down"),
    gh: fakeGh().gh,
    fetch: async (url: string, init: any) =>
      url.startsWith("https://lobste.rs/") ? { ok: false, status: 503 } : fakeFetch(url, init),
  });
  assert.ok(down.errors.some((error: string) => /Lobsters.*503/.test(error)));
  assert.ok(down.approved.length > 0);
  console.log("design-system-sources ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
