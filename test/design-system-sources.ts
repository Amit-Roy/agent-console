import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { run } = await import("../scripts/check-design-system-sources.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ds-sources-"));
const uas: string[] = [];
const json = (body: any) => ({ ok: true, status: 200, json: async () => body });
const fakeFetch = async (url: string, opts: any) => {
  uas.push(opts?.headers?.["User-Agent"]);
  if (url.includes("reddit.com"))
    return json({
      data: {
        children: [
          { data: { title: "Design system improvement ideas", permalink: "/r/design_system/a/" } },
          { data: { title: "Cat photos", permalink: "/r/design_system/b/" } },
        ],
      },
    });
  if (url.endsWith("newstories.json")) return json([1, 2]);
  if (url.endsWith("/1.json"))
    return json({ title: "Design system feedback wanted", url: "https://example.com/hn1" });
  return json({ title: "Unrelated", url: "https://example.com/hn2" });
};
const out: string[] = [];
const issues: any[] = [];
const opts = {
  fetch: fakeFetch,
  dir,
  out: (m: string) => out.push(m),
  createIssue: (i: any) => {
    issues.push(i);
  },
};
try {
  // dry-run prints, creates nothing, writes nothing
  const dry = await run({ ...opts, dryRun: true });
  assert.equal(dry.found.length, 2);
  assert.equal(issues.length, 0, "dry-run must not create issues");
  assert.ok(out.some((l) => l.includes("[DRY-RUN]")));
  assert.ok(
    !fs.existsSync(path.join(dir, ".design-system-seen.json")) &&
      !fs.existsSync(path.join(dir, "logs")),
    "dry-run writes no state",
  );
  assert.ok(
    uas.every((u) => /Agent-Console-Design-System/.test(u)),
    "every request sends a User-Agent",
  );

  // real run: one labelled issue per new suggestion, logged
  const real = await run(opts);
  assert.equal(real.created.length, 2);
  assert.equal(issues.length, 2);
  assert.ok(
    issues.every((i) => i.title && i.body.includes("http") && i.labels.includes("design-system")),
  );
  assert.equal(
    fs
      .readFileSync(path.join(dir, "logs", "design-system-suggestions.log"), "utf8")
      .trim()
      .split("\n").length,
    2,
  );

  // second run: deduplicated by URL
  assert.equal((await run(opts)).created.length, 0);
  assert.equal(issues.length, 2);

  // failing issue creation is reported and retried next run
  fs.rmSync(path.join(dir, ".design-system-seen.json"));
  issues.length = 0;
  const failing = await run({
    ...opts,
    createIssue: () => {
      throw new Error("gh down");
    },
  });
  assert.equal(failing.created.length, 0);
  assert.ok(failing.errors.some((e) => /gh down/.test(e)));
  assert.equal((await run(opts)).created.length, 2, "unmarked suggestions retry");

  // blocked source (403) is reported, other source still works
  const blocked = await run({
    ...opts,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "ac-ds-sources-")),
    fetch: async (u: string, o: any) =>
      u.includes("reddit.com") ? { ok: false, status: 403 } : fakeFetch(u, o),
  });
  assert.ok(blocked.errors.some((e) => /403/.test(e)));
  assert.equal(blocked.found.length, 1);
  console.log("design-system-sources ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
