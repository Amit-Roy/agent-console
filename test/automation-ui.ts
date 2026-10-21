// Automation in real Chromium: the Auto lane in the sidebar and the /automation page (flow graph, active step, step drawers,
// triggers, failures, git hooks). Mock server with seeded data; spends nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-automation-ui-"));
const wts = path.join(data, "worktrees");
const OUT = process.env.OUT || "/tmp";
const base = "http://127.0.0.1:17779";
const now = Date.now();
const mk = (id: string, title: string, issueRun?: object, extra = {}) => ({ id, title, provider: "mock", model: "echo", mode: "plan", cwd: process.cwd(), status: "idle", cost: 0, createdAt: now - 9e5, updatedAt: now - 1000, titleLocked: true, ...(issueRun ? { issueRun } : {}), ...extra });
const run = (role: string, over = {}) => ({ key: "o/r#5", repo: "o/r", number: 5, effort: "bau", role, branch: "issue-5-x", base: "main", ...over });
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([
  mk("11111111-1111-4111-8111-111111111111", "Plain chat"),
  mk("22222222-2222-4222-8222-222222222222", "r:5 Fix the export", run("work")),
  mk("33333333-3333-4333-8333-333333333333", "r:5 review PR#9", run("review", { pr: 9 }), { status: "running" }),
]));
fs.writeFileSync(path.join(data, "window-dispatch.json"), JSON.stringify({ enabled: true, dryRun: false }));
// a dispatched worktree with its hook, the way startIssue lays it out
const gd = path.join(data, "main.git", "worktrees", "r-issue-5");
fs.mkdirSync(path.join(gd, "ac-hooks"), { recursive: true }); fs.mkdirSync(path.join(wts, "r-issue-5"), { recursive: true });
fs.writeFileSync(path.join(wts, "r-issue-5", ".git"), `gitdir: ${gd}\n`);
fs.writeFileSync(path.join(gd, "ac-hooks", "pre-push"), `#!/bin/sh\nif [ "$remote_ref" = "refs/heads/main" ]; then exit 1; fi\n`);
// a local agent-console checkout for the Debug button
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
const repos = path.join(data, "repos"), origin = path.join(data, "origin.git"), local = path.join(repos, "agent-console");
fs.mkdirSync(origin); g(origin, "init", "-q", "--bare", "-b", "main"); fs.mkdirSync(repos);
execFileSync("git", ["clone", "-q", origin, local], { stdio: "ignore" });
fs.writeFileSync(path.join(local, "a"), "1"); g(local, "add", "a"); g(local, "commit", "-qm", "init"); g(local, "push", "-q", "origin", "HEAD:main"); g(local, "remote", "set-head", "origin", "main");
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, PORT: "17779", AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"), AGENT_CONSOLE_WORKTREES: wts, AGENT_CONSOLE_REPOS: repos }, stdio: "ignore" });
const cookie = { name: "ac_session", value: makeToken(), url: base };
const post = (body: object) => fetch(base + "/api/automation/_mock/event", { method: "POST", headers: { "content-type": "application/json", cookie: `ac_session=${cookie.value}` }, body: JSON.stringify(body) });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).status < 500) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  // events after start-up, so the open run is genuinely active
  for (const e of [
    { step: "triage", kind: "ok", ref: "o/r#5", msg: "labeled by pi/nemotron" },
    { step: "router", kind: "ok", ref: "o/r#5", msg: "live: route pi/default — pi allowance unknown" },
    { step: "worker", kind: "start", run: "work:w1", ref: "o/r#5", msg: "pi/default" },
    { step: "worktree", kind: "fail", ref: "o/r#6", msg: "No local checkout of o/missing" },
    { step: "review", kind: "start", run: "review:r1", ref: "o/r#5", msg: "claude/sonnet" },
  ]) assert.equal((await post(e)).status, 200);

  browser = await chromium.launch();
  for (const [name, viewport, scheme] of [["desktop-light", { width: 1280, height: 900 }, "light"], ["phone-dark", { width: 390, height: 844 }, "dark"]] as const) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, isMobile: name.startsWith("phone"), hasTouch: name.startsWith("phone") });
    await ctx.addCookies([cookie]);
    const page = await ctx.newPage();
    const errors: string[] = [], external: string[] = [];
    page.on("console", m => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", e => errors.push(String(e)));
    page.on("request", r => { const u = r.url(); if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(base)) external.push(u); });
    const ok = (label: string, cond: boolean, extra = "") => assert.ok(cond, `${name}: ${label} ${extra}`);

    // --- the Auto lane: auto-started threads live here, not in Threads -----------------------------------------
    await page.goto(base);
    await page.waitForSelector("#lane-auto", { state: "attached" });
    if (name.startsWith("phone")) await page.click("#menu");
    ok("Threads lane shows only the plain chat", (await page.locator("#threads li:not(.empty-list) .t").allInnerTexts()).join("|") === "Plain chat");
    await page.click("#lane-auto");
    ok("Auto lane is selected and visible", (await page.getAttribute("#lane-auto", "aria-selected")) === "true" && await page.locator("#pane-auto").isVisible());
    const issue = page.locator('#autos .auto-group[data-issue="o/r#5"]');
    const toggle = issue.locator(".auto-group-toggle");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    const rows = (await page.locator("#autos li[data-thread] .t").allInnerTexts()).filter(t => !t.startsWith("ac:debug")); // a debug thread from an earlier viewport belongs here too
    ok("both runs of the issue are listed", rows.length === 2 && rows.includes("r:5 Fix the export") && rows.includes("r:5 review PR#9"), rows.join("|"));
    ok("rows are grouped by issue with a header", await issue.count() === 1 && (await toggle.innerText()).includes("#5"));
    const page_roles = (await page.locator("#autos .role").allInnerTexts()).map(s => s.toLowerCase());
    ok("role chips", ["review", "work"].every(r => (page_roles).includes(r)));
    ok("the lane tab has a dot for running work (hidden while all idle)", (await page.locator("#lane-auto-dot").count()) === 1 && !(await page.locator("#lane-auto-dot").isVisible()));
    ok("a link to the dashboard", (await page.getAttribute("#auto-link", "href")) === "/automation");
    await page.click('#autos li[data-thread="22222222-2222-4222-8222-222222222222"]');
    await page.waitForFunction(() => document.querySelector("#head .title")?.textContent?.includes("r:5 Fix the export"));

    // --- the page --------------------------------------------------------------------------------------------------
    await page.goto(`${base}/automation`);
    await page.waitForSelector('[data-step="dispatcher"]');
    ok("all thirteen steps are drawn", (await page.locator("[data-step]").count()) === 13);
    const inPipe = async (p: string) => page.locator(`[data-pipeline="${p}"] [data-step]`).evaluateAll(ns => ns.map(n => (n as HTMLElement).dataset.step));
    ok("PR workflow: issue to labels, labels to PR, premium review and merge", JSON.stringify(await inPipe("pr")) === JSON.stringify(["triage", "dispatcher", "router", "worktree", "worker", "self_review", "pr", "review", "redo", "merge", "apply"]), JSON.stringify(await inPipe("pr")));
    ok("PR workflow phases are labelled", (await page.locator('[data-pipeline="pr"] .phase h3').allInnerTexts()).map(t => t.toLowerCase()).join("|") === "1. issue to labels|2. labels to pull request|3. premium review and merge");
    ok("window opener is its own workflow", JSON.stringify(await inPipe("windows")) === JSON.stringify(["opener", "usage"]));
    ok("review and redo loop", (await page.locator('[data-pipeline="pr"] .link.loop[data-to="redo"]').count()) === 1);
    ok("review loop is boxed with its label", (await page.locator('[data-pipeline="pr"] .cycle [data-step]').evaluateAll((b) => b.map((x) => x.dataset.step).join())) === "review,redo"
      && /3 reviews at most/.test(await page.locator('[data-pipeline="pr"] .cycle .cap').innerText()));
    ok("loop arrows name their conditions", (await page.locator('[data-pipeline="pr"] .link.loop[data-to="redo"]').innerText()).replace(/\s+/g, " ").trim() === "changes requested new commits pushed"
      && (await page.locator('[data-pipeline="pr"] .link[data-to="merge"]').innerText()).trim() === "approved");
    ok("each workflow lists its own triggers", (await page.locator('[data-pipeline="pr"] .ptrig').innerText()).includes("GitHub webhook") && (await page.locator('[data-pipeline="windows"] .ptrig').innerText()).includes("Window opener tick"));
    const state = (s: string) => page.getAttribute(`[data-step="${s}"]`, "data-state");
    ok("worker is the active step", (await state("worker")) === "active");
    ok("review is active too", (await state("review")) === "active");
    ok("worktree failed", (await state("worktree")) === "failed");
    ok("triage ok", (await state("triage")) === "ok");
    ok("router ok", (await state("router")) === "ok");
    ok("apply has not run", (await state("apply")) === "idle");
    ok("the header says it is live", /live/i.test(await page.locator("#mode").innerText()));
    ok("failures list the failed step", (await page.locator("#failures li").allInnerTexts()).join(" ").includes("No local checkout"));
    ok("other triggers list what belongs to no workflow", (await page.locator("#triggers").innerText()).includes("Debug button") && !(await page.locator("#triggers").innerText()).includes("GitHub webhook"));
    ok("git hooks list the worktree and the branch it protects", /r-issue-5/.test(await page.locator("#hooks").innerText()) && /main/.test(await page.locator("#hooks").innerText()));
    ok("a Debug button", await page.locator("#debug").isVisible());
    // clicking a step opens its log
    await page.click('[data-step="worktree"]');
    await page.waitForSelector("#drawer:not([hidden])");
    ok("drawer names the step and shows its log", /Worktree/.test(await page.locator("#drawer h2").innerText()) && (await page.locator("#drawer-log").innerText()).includes("No local checkout"));
    await page.keyboard.press("Escape");
    ok("Escape closes the drawer", await page.locator("#drawer").isHidden());
    await page.click('[data-step="triage"]'); await page.waitForSelector("#drawer:not([hidden])");
    ok("another step shows its own log", (await page.locator("#drawer-log").innerText()).includes("labeled by pi/nemotron") && !(await page.locator("#drawer-log").innerText()).includes("No local checkout"));
    await page.keyboard.press("Escape");
    ok("no horizontal overflow", !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
    await page.screenshot({ path: `${OUT}/automation-${name}.png`, fullPage: true });
    // live: new events move a step without reloading
    const rid = `merge:${name}`;
    await post({ step: "merge", kind: "start", run: rid, ref: "o/r#5" });
    await page.waitForFunction(() => document.querySelector('[data-step="merge"]')?.getAttribute("data-state") === "active", null, { timeout: 15_000 });
    await post({ step: "merge", kind: "ok", run: rid, ref: "o/r#5", msg: "PR #9 merged" });
    await page.waitForFunction(() => document.querySelector('[data-step="merge"]')?.getAttribute("data-state") === "ok", null, { timeout: 15_000 });
    // Debug: opens the new thread in the console
    await page.click('[data-step="worktree"]'); await page.waitForSelector("#drawer:not([hidden])");
    page.on("dialog", d => { errors.push("dialog: " + d.message()); void d.dismiss(); });
    await Promise.all([page.waitForURL(/#thread=/, { timeout: 15_000 }).catch(() => {}), page.click("#debug")]);
    ok("Debug opens a thread", /#thread=[0-9a-f-]{36}/.test(page.url()), page.url() + " " + errors.join("|"));
    await page.waitForSelector("#lane-auto", { state: "attached" });
    ok("no console errors, first-party only", errors.length === 0 && external.length === 0, errors.concat(external).join(" | ").slice(0, 300));
    await ctx.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
}
console.log("PASS automation UI: Auto lane, workflow panels (PR workflow phases, window opener) with active/failed steps, review/redo loop, step drawer logs, triggers, failures, hooks, live refresh, phone layout");
