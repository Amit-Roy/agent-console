import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ghrefs-"));
process.env.AGENT_CONSOLE_DATA = data;
fs.mkdirSync(path.join(data, "logs"));
const { exactLogUrl, parseGithubRemote, repoLogUrl, resolveGithubRef, validRefNumber } =
  await import("../server/gh-refs.ts");

const threadId = "33333333-3333-4333-8333-333333333333";
const log = (text: string) => fs.writeFileSync(path.join(data, "logs", `${threadId}.jsonl`), text);
const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ghrefs-plain-"));

test("exact URL match from log, newest wins", async () => {
  log(
    '{"a":"https://github.com/o/r/issues/207"}\n{"a":"https://github.com/o/r/pull/207"}\n{"a":"github.com/x/y/issues/1"}\n',
  );
  assert.deepEqual(await resolveGithubRef(threadId, plainDir, 207), {
    url: "https://github.com/o/r/pull/207",
  });
});

test("repo-only fallback uses most mentioned repo when no remote exists", async () => {
  const text = "github.com/a/b/issues/1 github.com/c/d/pull/2 github.com/c/d/issues/3";
  log(text);
  assert.equal(exactLogUrl(text, 99), null);
  assert.equal(repoLogUrl(text, 99), "https://github.com/c/d/issues/99");
  assert.deepEqual(await resolveGithubRef(threadId, plainDir, 99), {
    url: "https://github.com/c/d/issues/99",
  });
});

test("git remote of the working folder beats repo-only log mentions", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ghrefs-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:me/mine.git"]);
  log("github.com/c/d/issues/3\n");
  assert.deepEqual(await resolveGithubRef(threadId, repo, 99), {
    url: "https://github.com/me/mine/issues/99",
  });
});

test("no log mention and no git remote returns null", async () => {
  log("nothing here\n");
  assert.equal(await resolveGithubRef(threadId, plainDir, 5), null);
});

test("git remote parsing", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/o/r.git\n"), { owner: "o", repo: "r" });
  assert.deepEqual(parseGithubRemote("https://github.com/o/r"), { owner: "o", repo: "r" });
  assert.deepEqual(parseGithubRemote("git@github.com:o/my.repo.git"), {
    owner: "o",
    repo: "my.repo",
  });
  assert.equal(parseGithubRemote("git@gitlab.com:o/r.git"), null);
});

test("invalid numbers", async () => {
  for (const value of [0, -1, 1.5, 1000000, Number.NaN]) assert.equal(validRefNumber(value), false);
  assert.equal(validRefNumber(207), true);
  assert.equal(await resolveGithubRef(threadId, plainDir, 0), null);
});
