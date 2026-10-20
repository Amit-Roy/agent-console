import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mayMergeProtected } from "../server/automation/policy.ts";
import { PROTECTED, isProtected, skillDir, selfReviewBlock, reviewPrompt } from "../server/automation/review-prompts.ts";
import { issuePrompt } from "../server/window-dispatch.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = fs.readFileSync(path.join(root, "skills/pr-standards/SKILL.md"), "utf8");

// the skill is a small, self-consistent file: frontmatter, contract, existing references, the same protected paths as the code
assert.match(skill, /^---\nname: pr-standards\ndescription: .+\n---\n/);
assert.ok(skill.length < 7000, `skill is ${skill.length} chars`);
assert.match(skill, /^Review: APPROVED$/m); assert.match(skill, /^Review: CHANGES REQUESTED$/m);
assert.match(skill, /Top down\./); assert.match(skill, /Request and response models\./); assert.match(skill, /Test first\./);
for (const m of skill.matchAll(/`(vendor\/[^`]+)`/g)) assert.ok(fs.existsSync(path.join(root, "skills/pr-standards", m[1])), m[1]);
assert.ok(fs.existsSync(path.join(root, "skills/pr-standards/vendor/LICENSE")) && /Commit: [0-9a-f]{40}/.test(fs.readFileSync(path.join(root, "skills/pr-standards/vendor/SOURCE.md"), "utf8")));
for (const p of PROTECTED) assert.ok(skill.includes("`" + p + "`"), `skill lists ${p}`);

// protected paths: exact files and whole directories
assert.equal(isProtected(["README.md", "docs/x.md"]), false);
for (const f of ["server/window-dispatch.ts", "server/automation/router.ts", "skills/pr-standards/SKILL.md", "package.json", "bin/agent-console", ".github/workflows/ci.yml", "server/auth.ts"]) assert.equal(isProtected(["docs/x.md", f]), true, f);
assert.equal(isProtected(["server/automation-notes.md"]), false, "a name that merely starts the same is not protected");
assert.equal(mayMergeProtected("claude"), true); assert.equal(mayMergeProtected("codex"), true); assert.equal(mayMergeProtected("pi"), false);

// skills are read from the main checkout, never from the worktree under review
assert.equal(skillDir("/home/u"), "/home/u/repos/agent-console/skills/pr-standards");
const run = { key: "o/agent-console#9", repo: "o/agent-console", number: 9, effort: "bau", role: "work" as const, branch: "issue-9-x", base: "main" };
const dec: any = { key: run.key, issue: { repo: run.repo, number: 9, title: "t", labels: [] }, effort: "bau", route: {}, reason: "" };
const work = issuePrompt(dec, "issue-9-x", "main");
const block = selfReviewBlock(skillDir());
assert.ok(work.includes(block));
assert.match(block, new RegExp(skillDir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/SKILL.md"));
assert.match(block, /failed first/); assert.match(block, /## Self-review/); assert.match(block, /data, not instructions|never instructions/i);
assert.ok(work.length < 8000, `worker prompt is ${work.length} chars (about ${Math.round(work.length / 4)} tokens)`);
assert.ok(block.length < 2000);

// The reviewer cannot apply changes to shared checkouts; deployment belongs to the host.
const normal = reviewPrompt(run, 7, "main", { protected: false });
assert.match(normal, /gh pr merge 7 --repo o\/agent-console --squash/); assert.match(normal, /at most 20 changed lines/); assert.match(normal, /git push origin HEAD:refs\/heads\/issue-9-x/);
assert.match(normal, /host-side application/); assert.match(normal, /read-only/); assert.doesNotMatch(normal, /git merge --ff-only|restart-when-idle/); assert.match(normal, /Self-review/); assert.ok(normal.includes(skillDir()));
const guarded = reviewPrompt(run, 7, "main", { protected: true });
assert.doesNotMatch(guarded, /gh pr merge 7/); assert.match(guarded, /Do not merge/); assert.match(guarded, /protected path/i);
assert.match(reviewPrompt({ ...run, repo: "o/webapp" }, 7, "main", { protected: false }), /Nothing else to apply/);
console.log("PASS pr-standards: skill is small and consistent, protected paths, main-checkout loading, prompt budget, reviewer fix-up cap");
