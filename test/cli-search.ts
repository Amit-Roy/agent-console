import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliSearch } from "../server/cli-search.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-search-"));
const good = path.join(dir, "tools.json");
fs.writeFileSync(
  good,
  JSON.stringify({
    tools: [
      {
        name: "mr-watcher",
        path: "bin/mr-watcher",
        description: "Block until a PR gets a comment, failing check, conflict, merge or close.",
        usage: ["mr-watcher arm 42 [43] [-R owner/repo]   # run_in_background"],
        tags: ["wait", "pr", "ci", "secrettag"],
      },
      {
        name: "task-issue",
        path: "bin/task-issue",
        description: "Open a GitHub issue from a prompt.",
        usage: ['task-issue "prompt"'],
        tags: ["github", "pr"],
      },
      {
        name: "hidden-helper",
        path: "bin/hidden-helper",
        description: "Internal wait helper for pr work.",
        usage: ["hidden-helper"],
        tags: ["wait", "pr"],
      },
      {
        name: "sh",
        path: "sh",
        description: "Shell for wait scripts.",
        usage: ["sh -c cmd"],
        tags: [],
      },
    ],
    internal: ["hidden-helper"],
  }),
);
const saved = process.env.AGENT_CONSOLE_TOOL_MANIFESTS;
try {
  process.env.AGENT_CONSOLE_TOOL_MANIFESTS = `${good}:${path.join(dir, "missing.json")}`;
  const search = new CliSearch();
  const out = search.search({ terms: ["wait", "pr"] });
  const lines = out.split("\n");
  assert.match(lines[0], /^\d of 3 CLIs for \[wait, pr\]:$/);
  assert(lines[1].startsWith("mr-watcher: Block until"), lines[1]);
  assert(lines[1].endsWith(path.join(dir, "bin/mr-watcher")));
  assert.equal(lines[2], "  mr-watcher arm 42 [43] [-R owner/repo]   # run_in_background");
  assert(!out.includes("secrettag"), "tags must never be printed");
  assert(!out.includes("hidden-helper"), "internal entries are unsearchable");
  assert(out.includes("manifest unavailable:") && out.includes("missing.json"));
  assert.equal(
    search
      .search({ terms: ["secrettag"] })
      .split("\n")[1]
      .startsWith("mr-watcher"),
    true,
  );
  assert(search.search({ terms: ["watch"] }).includes("mr-watcher:"), "prefix match");
  assert(
    search.search({ terms: ['"x" OR NOT (*'] }).includes("of 3 CLIs for"),
    "FTS syntax escaped",
  );
  assert(
    search.search({ terms: ["zzzz"] }).startsWith("0 of 3 CLIs for [zzzz]; try broader terms"),
  );
  assert(search.search({ terms: ["pr"], limit: 1 }).startsWith("1 of 3 CLIs"));
  assert(/^\S+: Shell/m.test(search.search({ terms: ["shell"] })));
  assert.throws(() => search.search({ terms: [] }));

  // Bad manifest: footer, never throws.
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  process.env.AGENT_CONSOLE_TOOL_MANIFESTS = bad;
  const broken = new CliSearch().search({ terms: ["pr"] });
  assert(broken.startsWith("0 of 0 CLIs for [pr]"), broken);
  assert(broken.includes("manifest unavailable:") && broken.includes("bad.json"));

  // Rebuild after mtime change.
  const cached = new CliSearch();
  cached.search({ terms: ["pr"] });
  fs.writeFileSync(
    bad,
    JSON.stringify({ tools: [{ name: "newtool", path: "x", description: "pr thing" }] }),
  );
  fs.utimesSync(bad, new Date(), new Date(Date.now() + 5000));
  assert(cached.search({ terms: ["pr"] }).includes("newtool:"));
  console.log(
    "cli-search: BM25 ranking, hidden tags, internal exclusion, footers, and reload pass",
  );
} finally {
  if (saved === undefined) delete process.env.AGENT_CONSOLE_TOOL_MANIFESTS;
  else process.env.AGENT_CONSOLE_TOOL_MANIFESTS = saved;
  fs.rmSync(dir, { recursive: true, force: true });
}
