// Issue #20: every CI job bills at least one whole minute, so the workflow keeps few jobs and
// docs/ci.md records the measured billing and the keep/move/remove decision.
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = read("../.github/workflows/ci.yml");
const doc = read("../docs/ci.md");

const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"));
const names = (jobsBlock.match(/^ {2}[a-z][a-z-]*:$/gm) ?? []).map((line) =>
  line.trim().slice(0, -1),
);
assert.deepEqual(
  names.sort(),
  ["release", "telemetry-comment", "test", "test-shard"],
  `jobs: ${names}`,
);

// The Lean proof check shares the release job's runner instead of paying its own billed minute.
const release = workflow.slice(workflow.indexOf("\n  release:\n"), workflow.indexOf("\n  test:\n"));
assert.match(release, /npm run test:formal/, "release job must run the Lean queue proofs");

const queueReadme = read("../formal/queue/README.md");
assert.doesNotMatch(
  queueReadme,
  /formal-queue/,
  "formal/queue/README.md must not name the removed formal-queue job",
);

for (const heading of ["Billed minutes per run", "Decision"])
  assert.ok(doc.includes(`\n## ${heading}\n`), `docs/ci.md needs section: ## ${heading}`);
assert.match(doc, /1,809/, "docs/ci.md must reconcile the 1,809 minutes used");
assert.match(
  doc,
  /GitHub Actions is still needed: yes/i,
  "docs/ci.md must record the yes/no decision",
);
console.log("ci-workflow ok");
