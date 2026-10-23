import { run } from "node:test";
import { spec } from "node:test/reporters";

// Node's CLI sorts file names. Start the longest suites first so they overlap
// short suites instead of extending the end of the pool (CI baseline, 2026-10-23).
const slow = [
  "test/attachment-drafts-ui.ts",
  "test/github-triage-cli.ts",
  "test/drafts-ui.ts",
  "test/issue-review.ts",
  "test/composer-scroll-ui.ts",
  "test/pi-e2e-ui.ts",
];
const files = process.argv.slice(2);
const priority = (file) => {
  const index = slow.indexOf(file);
  return index < 0 ? slow.length : index;
};
files.sort((a, b) => priority(a) - priority(b));
if (!files.length) throw new Error("Pass test files to the runner.");
const stream = run({
  files,
  concurrency: Number(process.env.TEST_CONCURRENCY || 4),
});
stream.on("test:fail", () => {
  process.exitCode = 1;
});
stream.compose(new spec()).pipe(process.stdout);
