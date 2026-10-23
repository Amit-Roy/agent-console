// docs/hosting-migration.md (issue #71) must keep the shape its acceptance checks ask for:
// every candidate states cost, resource guarantee, GPU path and long-running fit with a dated source,
// and the migration plan covers deployment, session continuity, rollback and validation.
import assert from "node:assert/strict";
import fs from "node:fs";

const doc = fs.readFileSync(new URL("../docs/hosting-migration.md", import.meta.url), "utf8");
const section = (title: string) => {
  const start = doc.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `missing section: ## ${title}`);
  const next = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, next < 0 ? undefined : next);
};

// The comparison table: one row per candidate, no empty cells, each row with a source link.
const rows = section("Candidates")
  .split("\n")
  .filter((l) => l.startsWith("|"));
const header = rows[0].split("|").map((c) => c.trim().toLowerCase());
for (const col of [
  "option",
  "monthly cost",
  "resource guarantee",
  "gpu on demand",
  "long-running agents",
  "source",
])
  assert.ok(header.includes(col), `candidate table needs column: ${col}`);
const body = rows.slice(2);
assert.ok(body.length >= 5, "compare at least five options");
for (const row of body) {
  const cells = row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  assert.equal(cells.length, header.length - 2, `row has wrong cell count: ${row}`);
  assert.ok(cells.every(Boolean), `row has an empty cell: ${row}`);
  assert.match(row, /https:\/\//, `row needs a source link: ${row}`);
}
// The issue proposed Lambda; the table must answer it either way.
assert.ok(
  body.some((r) => /lambda/i.test(r)),
  "AWS Lambda must be assessed",
);
assert.ok(
  body.some((r) => /gcp|google/i.test(r)),
  "GCP must be assessed",
);
assert.match(doc, /Prices checked \d{4}-\d{2}-\d{2}/, "state when prices were checked");

// Exactly one recommended target, named in the recommendation.
assert.match(section("Recommendation"), /\*\*Target:\*\* \S/, "recommendation names one target");

for (const title of ["Deployment", "Session continuity", "Rollback", "Validation"]) {
  const s = section(title);
  assert.ok(/^\d+\. /m.test(s), `${title} needs numbered steps`);
}
// Validation must be checkable: commands, not intentions.
assert.match(section("Validation"), /`[^`]+`/, "validation steps include commands");
console.log("hosting plan doc: ok");
