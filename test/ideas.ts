// App ideas repo: index.md lists ideas, each links to <slug>.md; adding an idea writes both files and commits them (and pushes when tracked).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Ideas, parseIndex, slugify, addBullet } = await import("../server/ideas.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ideas-"));
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
try {
  // parsing: list lines with a link to a root .md file; anything else in index.md is left alone
  assert.deepEqual(
    parseIndex(
      "# App ideas\n\nIntro text.\n\n- [Plant Pal](plant-pal.md) — Reminds me to water plants\n* [Odd](odd.md): colon form\n- [Bad](../etc/passwd.md) — escapes\n- not a link\n",
    ),
    [
      { slug: "plant-pal", name: "Plant Pal", line: "Reminds me to water plants" },
      { slug: "odd", name: "Odd", line: "colon form" },
    ],
  );
  assert.equal(slugify("  Plant Pal 2.0! "), "plant-pal-2-0");
  assert.equal(slugify("###"), "");

  // a missing repo lists nothing and is created on the first add
  const repo = path.join(tmp, "app-ideas");
  const ideas = new Ideas({ dir: repo });
  assert.deepEqual(ideas.list().ideas, []);
  const added = await ideas.add({ name: "Plant Pal", line: "Reminds me to water plants" });
  assert.equal(added.idea.slug, "plant-pal");
  assert.match(added.commit, /^[0-9a-f]{7,}$/);
  assert.equal(added.pushed, null, "no upstream: nothing to push");
  assert.match(
    fs.readFileSync(path.join(repo, "index.md"), "utf8"),
    /^# App ideas\n[\s\S]*- \[Plant Pal\]\(plant-pal\.md\) — Reminds me to water plants\n$/,
  );
  assert.match(
    fs.readFileSync(path.join(repo, "plant-pal.md"), "utf8"),
    /^# Plant Pal\n\nReminds me to water plants\n\n## Features\n/,
  );
  assert.equal(git(repo, "log", "--format=%s"), "Add idea: Plant Pal");
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD"),
    "index.md\nplant-pal.md",
    "one commit holds index.md and the new file",
  );
  assert.equal(git(repo, "status", "--porcelain"), "");

  // list and read
  assert.deepEqual(ideas.list().ideas, [
    { slug: "plant-pal", name: "Plant Pal", line: "Reminds me to water plants" },
  ]);
  const doc = ideas.read("plant-pal");
  assert.equal(doc.name, "Plant Pal");
  assert.match(doc.markdown, /## Features/);
  assert.throws(
    () => ideas.read("../index"),
    (e: any) => e.status === 404,
  );
  assert.throws(
    () => ideas.read("nope"),
    (e: any) => e.status === 404,
  );

  // validation speaks plainly and changes nothing
  await assert.rejects(ideas.add({ name: "", line: "x" }), /name/i);
  await assert.rejects(ideas.add({ name: "x", line: "" }), /one-line/i);
  await assert.rejects(ideas.add({ name: "x", line: "two\nlines" }), /one line/i);
  await assert.rejects(ideas.add({ name: "a [b]", line: "x" }), /brackets/i);
  await assert.rejects(ideas.add({ name: "!!!", line: "x" }), /letter or digit/i);
  await assert.rejects(
    ideas.add({ name: "plant pal", line: "dupe" }),
    (e: any) => e.status === 409 && /already exists/.test(e.message),
  );
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1");
  assert.equal(git(repo, "status", "--porcelain"), "");

  // a hand-written index keeps its other lines; the new entry is appended
  fs.writeFileSync(
    path.join(repo, "index.md"),
    "# My ideas\n\nWeird stuff.\n\n- [Plant Pal](plant-pal.md) — Reminds me to water plants\n",
  );
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "hand edit");
  await ideas.add({ name: "Sky Log", line: "Photo diary of clouds" });
  assert.equal(
    fs.readFileSync(path.join(repo, "index.md"), "utf8"),
    "# My ideas\n\nWeird stuff.\n\n- [Plant Pal](plant-pal.md) — Reminds me to water plants\n- [Sky Log](sky-log.md) — Photo diary of clouds\n",
  );

  // an idea listed without its file reads as a plain 404, not a crash
  fs.appendFileSync(path.join(repo, "index.md"), "- [Ghost](ghost.md) — no file yet\n");
  assert.equal(ideas.list().ideas.length, 3);
  assert.throws(
    () => ideas.read("ghost"),
    (e: any) => e.status === 404 && /no feature file/i.test(e.message),
  );
  git(repo, "checkout", "-q", "--", "index.md");

  // a failed commit leaves no half-written idea behind
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  await assert.rejects(ideas.add({ name: "Broken", line: "never lands" }), /commit/i);
  assert.ok(!fs.existsSync(path.join(repo, "broken.md")));
  assert.equal(git(repo, "status", "--porcelain"), "");
  fs.rmSync(path.join(repo, ".git", "hooks", "pre-commit"));

  // a tracked private remote gets the commit pushed
  const bare = path.join(tmp, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const clone = path.join(tmp, "clone");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "-u", "origin", "HEAD");
  const pushed = await new Ideas({ dir: repo }).add({ name: "Tide Clock", line: "When to swim" });
  assert.equal(pushed.pushed, true);
  execFileSync("git", ["clone", "-q", bare, clone]);
  assert.ok(fs.existsSync(path.join(clone, "tide-clock.md")));
  assert.equal(git(clone, "log", "-1", "--format=%s"), "Add idea: Tide Clock");
  // a failed push keeps the commit and never echoes credentials from the remote URL
  git(repo, "remote", "set-url", "origin", "https://u:s3cret@127.0.0.1:9/none.git");
  const offline = await new Ideas({ dir: repo }).add({ name: "Moon Map", line: "Offline push" });
  assert.equal(offline.pushed, false);
  assert.ok(offline.pushError && !offline.pushError.includes("s3cret"), offline.pushError);
  assert.equal(git(repo, "log", "-1", "--format=%s"), "Add idea: Moon Map");
  // bullets: placeholder replaced, order kept, missing sections created in canonical order, repo commits it
  const fresh = fs.readFileSync(path.join(repo, "plant-pal.md"), "utf8");
  assert.match(
    fresh,
    /## Features\n\n_None yet[^\n]*\n\n## Implementation\n\n_None yet[^\n]*\n\n## Others\n\n_None yet/,
  );
  const one = addBullet(fresh, "Features", "Water alerts");
  assert.match(one, /## Features\n\n- Water alerts\n\n## Implementation/);
  assert.match(
    addBullet(one, "Features", "Photo log"),
    /- Water alerts\n- Photo log\n\n## Implementation/,
  );
  assert.match(addBullet(one, "Others", "Name TBD"), /## Others\n\n- Name TBD\n$/);
  assert.equal(
    addBullet("# X\n\nline\n\n## Others\n\n- a\n", "Implementation", "b"),
    "# X\n\nline\n\n## Implementation\n\n- b\n\n## Others\n\n- a\n",
  );
  assert.equal(addBullet("# X\n\nline\n", "Features", "b"), "# X\n\nline\n\n## Features\n\n- b\n");
  const bl = await new Ideas({ dir: repo }).addBullet("plant-pal", {
    section: "Implementation",
    text: "SQLite + cron",
  });
  assert.equal(bl.pushed, false);
  assert.match(
    fs.readFileSync(path.join(repo, "plant-pal.md"), "utf8"),
    /## Implementation\n\n- SQLite \+ cron\n\n## Others/,
  );
  assert.equal(git(repo, "log", "-1", "--format=%s"), "Add implementation bullet: Plant Pal");
  await assert.rejects(
    new Ideas({ dir: repo }).addBullet("plant-pal", { section: "Nope", text: "x" }),
    /Pick a section/,
  );
  await assert.rejects(
    new Ideas({ dir: repo }).addBullet("ghost", { section: "Others", text: "x" }),
    /No such idea/,
  );
  console.log("ideas ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
