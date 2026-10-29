import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionSearch } from "../server/session-search.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-search-"));
const threads = [
  { id: "claude-one", provider: "claude", title: "PR standards", archived: true },
  { id: "codex-one", provider: "codex", title: "Build standards" },
  { id: "pi-one", provider: "pi", title: "Fix toolbox" },
  { id: "empty-one", provider: "future-provider", title: "Empty discussion" },
];
fs.mkdirSync(path.join(root, "logs"));
const catalog = () => fs.writeFileSync(path.join(root, "threads.json"), JSON.stringify(threads));
const file = (id: string) => path.join(root, "logs", `${id}.jsonl`);
const user = (text: string) => JSON.stringify({ type: "user_input", text });
const assistant = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const write = (id: string, rows: string[]) => fs.writeFileSync(file(id), rows.join("\n") + "\n");
catalog();
write("claude-one", [
  user("Implement zebra pr-standards skill"),
  assistant("zebra zebra zebra zebra standards"),
]);
write("codex-one", [
  user("Find zebra " + "unrelated ".repeat(200)),
  "broken json",
  assistant("Implementation deferred until tomorrow"),
]);
write("pi-one", [
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "cat pr-standards/SKILL.md", api_key: "secretneedle" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: "The skill is empty: missingguidance" }] },
  }),
]);
fs.writeFileSync(file("empty-one"), "");
const toolUse = (id: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
const toolResult = (id: string, content: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
fs.appendFileSync(
  file("pi-one"),
  [
    toolUse("t1", "gh pr list --json url"),
    toolResult("t1", "https://github.com/o/r/pull/7"),
    toolUse("t2", "cd ~/wt && gh pr create --title x"),
    toolResult(
      "t2",
      "Creating pull request\nhttps://github.com/example-owner/agent-console/pull/28\n",
    ),
  ].join("\n") + "\n",
);
let search = new SessionSearch(root);
try {
  const result = await search.search({ query: "zebra" });
  assert.equal(result.indexedSessions, 4);
  assert.equal(result.results[0].thread, "claude-one", "BM25 favors relevant short repeated text");
  assert.ok(result.results.some((r) => r.provider === "codex"));
  assert.ok(
    (await search.search({ query: "standards", provider: "claude" })).results.every(
      (r) => r.provider === "claude",
    ),
  );
  assert.ok(
    (await search.search({ query: "PR standards" })).results.some((r) => r.thread === "claude-one"),
    "archived sessions searchable",
  );
  assert.equal((await search.search({ query: "missingguidance" })).results[0].provider, "pi");
  assert.equal((await search.search({ query: "secretneedle" })).results.length, 0);
  const raised = await search.prs({ thread: "pi-one" });
  assert.deepEqual(
    raised.prs.map((p) => `${p.repo}#${p.number}`),
    ["example-owner/agent-console#28"],
    "only gh pr create output counts",
  );
  for (const ref of [
    "https://github.com/example-owner/agent-console/pull/28#issuecomment-6272643047",
    "example-owner/agent-console#28",
    "28",
  ])
    assert.equal((await search.prs({ ref })).prs[0]?.thread, "pi-one", ref);
  assert.equal((await search.prs({ ref: "other/repo#28" })).prs.length, 0);
  await assert.rejects(() => search.prs({ ref: "nonsense" }), /PR URL/);
  const read = await search.read({ thread: "codex-one", start: 2, limit: 1 });
  assert.equal(read.events[0].line, 3, "physical lines survive malformed records");
  assert.match(String(read.events[0].text), /deferred/);
  assert.equal(
    (await search.search({ query: 'zebra" OR (NEAR * : - !' })).results.length > 0,
    true,
    "FTS operators cannot become query syntax",
  );
  await assert.rejects(() => search.search({ query: "***" }), /words/);
  await assert.rejects(() => search.search({ query: "x".repeat(501) }), /500/);
  await assert.rejects(() => search.read({ thread: "../../private" }), /Invalid/);
  await assert.rejects(() => search.read({ thread: "absent" }), /Unknown/);
  assert.equal((await search.search({ query: "zebra", limit: 1 })).results.length, 1);

  fs.appendFileSync(file("pi-one"), assistant("appendedneedle") + "\n");
  assert.equal((await search.search({ query: "appendedneedle" })).results[0].line, 7);
  threads[2].title = "Renamedneedle";
  threads[2].provider = "another-provider";
  catalog();
  assert.equal(
    (await search.search({ query: "Renamedneedle", provider: "another-provider" })).results[0]
      .thread,
    "pi-one",
  );
  write("pi-one", [user("replacementneedle")]);
  assert.equal(
    (await search.search({ query: "appendedneedle" })).results.length,
    0,
    "truncate removes stale index rows",
  );
  assert.equal((await search.search({ query: "replacementneedle" })).results[0].line, 1);
  // Same-size rewrites must not be mistaken for unchanged content.
  write("pi-one", [user("replacementsignal")]);
  assert.equal((await search.search({ query: "replacementneedle" })).results.length, 0);
  assert.equal((await search.search({ query: "replacementsignal" })).results[0].line, 1);
  // Trailing partial lines are retried once the writer completes them.
  const partial = assistant("partialneedle");
  fs.appendFileSync(file("pi-one"), partial.slice(0, 20));
  assert.equal((await search.search({ query: "partialneedle" })).results.length, 0);
  fs.appendFileSync(file("pi-one"), partial.slice(20) + "\n");
  assert.equal((await search.search({ query: "partialneedle" })).results[0].line, 2);
  // Prefix rewrites combined with file growth must reset, even when the old suffix is unchanged.
  write("pi-one", [
    user("prefixold " + "padding ".repeat(400)),
    assistant("unchangedsuffix ".repeat(100)),
  ]);
  await search.warm();
  const rewrite = fs.readFileSync(file("pi-one"), "utf8").replace("prefixold", "prefixnew");
  fs.writeFileSync(file("pi-one"), rewrite + assistant("partialneedle") + "\n");
  assert.equal((await search.search({ query: "prefixold" })).results.length, 0);
  assert.equal((await search.search({ query: "prefixnew" })).results[0].line, 1);
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => search.search({ query: "partialneedle" })),
  );
  assert.ok(
    concurrent.every((r) => r.results.length === 1),
    "concurrent refreshes serialize",
  );
  search.close();
  search = new SessionSearch(root);
  assert.equal(
    (await search.search({ query: "partialneedle" })).results.length,
    1,
    "index survives restart without duplicates",
  );
  fs.unlinkSync(file("pi-one"));
  assert.equal(
    (await search.search({ query: "partialneedle" })).results.length,
    0,
    "missing log removes stale content",
  );
  threads.splice(0, 1);
  catalog();
  assert.ok(
    (await search.search({ query: "zebra" })).results.every((r) => r.thread !== "claude-one"),
    "deleted sessions excluded even when log remains",
  );
  // recent(): sessions changed after a time, newest first, empty logs left out
  threads.push(
    { id: "old-one", provider: "claude", title: "Old work" },
    { id: "new-one", provider: "pi", title: "New work" },
  );
  catalog();
  write("old-one", [user("oldtopic"), assistant("done")]);
  write("new-one", [user("newtopic"), assistant("done"), assistant("more")]);
  fs.utimesSync(file("old-one"), 1_000, 1_000);
  fs.utimesSync(file("new-one"), 3_000, 3_000);
  fs.utimesSync(file("codex-one"), 2_000, 2_000);
  const recent = await search.recent({ since: 1_500_000 });
  assert.deepEqual(
    recent.map((r) => r.id),
    ["new-one", "codex-one"],
    "newest first, nothing at or before since, empty log excluded",
  );
  assert.deepEqual(recent[0], {
    id: "new-one",
    provider: "pi",
    title: "New work",
    mtime: 3_000_000,
    lines: 3,
  });
  assert.equal((await search.recent({ since: 0, limit: 1 })).length, 1);
  await assert.rejects(search.recent({ since: Number.NaN }), /since/);
  await reliabilityChecks();
  console.log("session-search: recent() orders by mtime, honors since and limit");
  console.log(
    "session-search: BM25 ranking, all providers, archived sessions, freshness, bounds, and malformed input passed",
  );
} finally {
  search.close();
  fs.rmSync(root, { recursive: true, force: true });
}

/** Busy timeout, bounded sync wait with stale answers, and the echo filter for history tools. */
async function reliabilityChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-search-rel-"));
  fs.mkdirSync(path.join(dir, "logs"));
  const list = [
    { id: "claude-echo", provider: "claude", title: "Claude echo" },
    { id: "codex-echo", provider: "codex", title: "Codex echo" },
    { id: "pi-echo", provider: "pi", title: "Pi echo" },
  ];
  const save = () => fs.writeFileSync(path.join(dir, "threads.json"), JSON.stringify(list));
  const logOf = (threadId: string) => path.join(dir, "logs", `${threadId}.jsonl`);
  const call = (callId: string, name: string, input: object) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: callId, name, input }] },
    });
  const reply = (callId: string, content: string) =>
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: callId, content }] },
    });
  const searchResult = JSON.stringify({
    results: [{ citation: "x:L1", snippet: "echoresultneedle" }],
    indexedSessions: 3,
  });
  const readResult = JSON.stringify({
    thread: "x",
    archived: false,
    events: [{ citation: "x:L2", text: "echoreadneedle" }],
  });
  const echoLines = (tag: string, searchName: string, readName: string) => [
    call(`${tag}1`, searchName, { query: "echoquerycall" }),
    reply(`${tag}1`, searchResult),
    call(`${tag}2`, readName, { thread: "echothreadcall" }),
    reply(`${tag}2`, readResult),
    call(`${tag}3`, "Bash", { command: "echo keptcall" }),
    reply(`${tag}3`, "keptresult citation only"),
  ];
  const lines = {
    "claude-echo": echoLines(
      "c",
      "mcp__agent_console__session_search",
      "mcp__agent_console__session_read",
    ),
    "codex-echo": echoLines("x", "agent_console:session_search", "agent_console:session_read"),
    "pi-echo": echoLines("p", "session_search", "session_read"),
  };
  const writeLogs = (all: Record<string, string[]>) => {
    for (const [threadId, rows] of Object.entries(all))
      fs.writeFileSync(logOf(threadId), rows.join("\n") + "\n");
  };
  save();
  writeLogs(lines);
  const savedWait = process.env.AGENT_CONSOLE_SEARCH_SYNC_MS;
  try {
    // Echo filter: history tool calls and their results (even in a later sync) are not indexed.
    const first = new SessionSearch(dir);
    for (const word of ["echoquerycall", "echothreadcall", "echoresultneedle", "echoreadneedle"])
      assert.equal((await first.search({ query: word })).results.length, 0, word);
    assert.equal((await first.search({ query: "keptcall" })).results.length, 3);
    assert.equal((await first.search({ query: "keptresult" })).results.length, 3);
    fs.appendFileSync(logOf("pi-echo"), [call("late", "session_search", {}), ""].join("\n"));
    fs.appendFileSync(
      logOf("pi-echo"),
      [reply("late", "latewordneedle citation indexedSessions"), ""].join("\n"),
    );
    assert.equal(
      (await first.search({ query: "latewordneedle" })).results.length,
      0,
      "late result",
    );
    first.close();

    // Busy timeout is set on the connection.
    const probe = new SessionSearch(dir);
    assert.equal(Number((probe as any).db.prepare("PRAGMA busy_timeout").get().timeout), 5000);
    probe.close();

    // Migration: version-1 index with echo rows loses only those rows.
    const old = path.join(dir, "migrate");
    fs.mkdirSync(path.join(old, "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(old, "threads.json"),
      JSON.stringify([{ id: "mig", provider: "claude", title: "Migrate" }]),
    );
    fs.writeFileSync(path.join(old, "logs", "mig.jsonl"), "");
    const seed = new SessionSearch(old);
    await seed.warm();
    const sqlite = (seed as any).db;
    const rows = [
      [1, "tool", "mcp__agent_console__session_search\nechoquerycall"],
      [2, "tool", searchResult + " migechosearch"],
      [3, "tool", readResult + " migechoread"],
      [4, "tool", "Bash\nmigkeptcall"],
      [5, "tool", "plain result with citation migkeptresult"],
      [6, "assistant", "I read session_search docs migkeptprose"],
    ] as const;
    for (const [line, role, text] of rows) {
      sqlite
        .prepare("INSERT INTO events(thread,line,role,text) VALUES('mig',?,?,?)")
        .run(line, role, text);
      sqlite
        .prepare(
          "INSERT INTO session_fts(title,text,thread,line,role) VALUES('Migrate',?,'mig',?,?)",
        )
        .run(text, line, role);
    }
    sqlite.exec("PRAGMA user_version=1");
    seed.close();
    const migrated = new SessionSearch(old);
    await migrated.whenCleaned();
    for (const word of ["echoquerycall", "migechosearch", "migechoread"])
      assert.equal((await migrated.search({ query: word })).results.length, 0, word);
    for (const word of ["migkeptcall", "migkeptresult", "migkeptprose"])
      assert.equal((await migrated.search({ query: word })).results.length, 1, word);
    assert.equal(Number((migrated as any).db.prepare("PRAGMA user_version").get().user_version), 3);
    // fts_map was backfilled: deletes go by rowid and leave no FTS or map rows behind.
    const mdb = (migrated as any).db;
    const count = (sql: string) => Number(mdb.prepare(sql).get().n);
    assert.equal(count("SELECT count(*) AS n FROM fts_map WHERE thread='mig'"), 4);
    (migrated as any).deleteFts("mig", 4);
    assert.equal(count("SELECT count(*) AS n FROM session_fts WHERE thread='mig'"), 2);
    (migrated as any).deleteFts("mig");
    assert.equal(count("SELECT count(*) AS n FROM session_fts WHERE thread='mig'"), 0);
    assert.equal(count("SELECT count(*) AS n FROM fts_map WHERE thread='mig'"), 0);
    migrated.close();

    // Migration: a version-2 index skips the echo cleanup and only backfills fts_map.
    const second = path.join(dir, "migrate-v2");
    fs.mkdirSync(path.join(second, "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(second, "threads.json"),
      JSON.stringify([{ id: "mig2", provider: "claude", title: "Migrate two" }]),
    );
    fs.writeFileSync(path.join(second, "logs", "mig2.jsonl"), "");
    const seedTwo = new SessionSearch(second);
    await seedTwo.warm();
    const sqliteTwo = (seedTwo as any).db;
    for (const [line, text] of [
      [1, "mcp__agent_console__session_search\nversiontwoecho"],
      [2, "Bash\nversiontwokept"],
    ] as const) {
      sqliteTwo
        .prepare("INSERT INTO events(thread,line,role,text) VALUES('mig2',?,'tool',?)")
        .run(line, text);
      sqliteTwo
        .prepare(
          "INSERT INTO session_fts(title,text,thread,line,role) VALUES('Migrate two',?,'mig2',?,'tool')",
        )
        .run(text, line);
    }
    sqliteTwo.exec("DELETE FROM fts_map; PRAGMA user_version=2");
    seedTwo.close();
    const migratedTwo = new SessionSearch(second);
    await migratedTwo.whenCleaned();
    const twoDb = (migratedTwo as any).db;
    const countTwo = (sql: string) => Number(twoDb.prepare(sql).get().n);
    // The echo row survives because version 2 never re-runs the echo scan.
    assert.equal(
      countTwo("SELECT count(*) AS n FROM session_fts WHERE thread='mig2' AND line>0"),
      2,
    );
    assert.equal(countTwo("SELECT count(*) AS n FROM fts_map WHERE thread='mig2' AND line>0"), 2);
    assert.equal(Number(twoDb.prepare("PRAGMA user_version").get().user_version), 3);
    migratedTwo.close();

    await cleanupChecks(old);

    // Slow refresh: answer stale within the wait, then include new data once the refresh ends.
    process.env.AGENT_CONSOLE_SEARCH_SYNC_MS = "50";
    let release: () => void = () => {};
    let slow = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lagging = new SessionSearch(dir, {
      beforeRefresh: () => (slow ? gate : Promise.resolve()),
    });
    await lagging.warm();
    fs.appendFileSync(
      logOf("claude-echo"),
      JSON.stringify({ type: "user_input", text: "freshdataneedle" }) + "\n",
    );
    slow = true;
    const began = Date.now();
    const stale: any = await lagging.search({ query: "keptcall" });
    assert.ok(Date.now() - began < 1000, "returns within the wait");
    assert.equal(stale.stale, true);
    assert.equal(stale.results.length, 3, "stale answer still comes from the index");
    release();
    await lagging.warm();
    const fresh: any = await lagging.search({ query: "freshdataneedle" });
    assert.equal(fresh.results.length, 1);
    assert.equal(fresh.stale, undefined);
    lagging.close();
    console.log(
      "session-search: busy timeout, stale answers within the wait, and echo filter passed",
    );
  } finally {
    if (savedWait === undefined) delete process.env.AGENT_CONSOLE_SEARCH_SYNC_MS;
    else process.env.AGENT_CONSOLE_SEARCH_SYNC_MS = savedWait;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Many echo rows: the constructor returns first, searches hide echoes meanwhile, and progress resumes after reopen. */
async function cleanupChecks(base: string) {
  const dir = path.join(base, "bulk");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "threads.json"),
    JSON.stringify([{ id: "bulk", provider: "claude", title: "Bulk" }]),
  );
  fs.writeFileSync(path.join(dir, "logs", "bulk.jsonl"), "");
  const never = { beforeRefresh: () => new Promise<void>(() => {}) };
  const seed = new SessionSearch(dir, never);
  seed.close();
  const sqlite = new DatabaseSync(path.join(dir, "session-search.sqlite"));
  sqlite.exec(
    "INSERT OR IGNORE INTO sessions(thread,title,provider) VALUES('bulk','Bulk','claude')",
  );
  sqlite.exec("BEGIN");
  const echoText = '{"citation":"b:L1","indexedSessions":2} bulkechoword';
  for (let line = 1; line <= 6000; line++) {
    const isEcho = line % 2 === 0;
    const text = isEcho ? echoText : `bulkkeptword ${line}`;
    sqlite
      .prepare("INSERT INTO events(thread,line,role,text) VALUES('bulk',?,'tool',?)")
      .run(line, text);
    sqlite
      .prepare(
        "INSERT INTO session_fts(title,text,thread,line,role) VALUES('Bulk',?,'bulk',?,'tool')",
      )
      .run(text, line);
  }
  sqlite.exec("COMMIT; PRAGMA user_version=1");
  sqlite.close();

  process.env.AGENT_CONSOLE_SEARCH_SYNC_MS = "20";
  const first = new SessionSearch(dir, { ...never, cleanupBatchLimit: 1 });
  assert.equal(first.cleanupStats.batches, 0, "constructor does no cleanup work");
  assert.equal(
    (await first.search({ query: "bulkechoword" })).results.length,
    0,
    "hidden during cleanup",
  );
  assert.equal((await first.search({ query: "bulkkeptword", limit: 50 })).results.length, 50);
  assert.equal(first.cleanupStats.batches, 1, "paused after one batch");
  first.close();
  const half = new DatabaseSync(path.join(dir, "session-search.sqlite"));
  assert.equal(
    Number(half.prepare("PRAGMA user_version").get()!.user_version),
    1,
    "not finished yet",
  );
  assert.ok(Number(half.prepare("SELECT value FROM meta").get()!.value) > 0, "progress saved");
  half.close();

  const second = new SessionSearch(dir, never);
  await second.whenCleaned();
  assert.ok(second.cleanupStats.batches > 0);
  const done = (second as any).db;
  assert.equal(Number(done.prepare("PRAGMA user_version").get().user_version), 3);
  assert.equal(Number(done.prepare("SELECT count(*) AS n FROM events").get().n), 3000);
  assert.equal(
    Number(
      done
        .prepare("SELECT count(*) AS n FROM session_fts WHERE session_fts MATCH 'bulkechoword'")
        .get().n,
    ),
    0,
  );
  assert.equal(
    Number(done.prepare("SELECT count(*) AS n FROM meta").get().n),
    0,
    "progress cleared",
  );
  second.close();
}
