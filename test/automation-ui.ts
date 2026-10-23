// Automation in real Chromium: the Auto lane in the sidebar and the /automation page (flow graph, active step, step drawers,
// triggers, failures, git hooks). Mock server with seeded data; spends nothing.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-automation-ui-"));
const wts = path.join(data, "worktrees");
const OUT = process.env.OUT || "/tmp";
const RECORD = process.env.RECORD_AUTO_ARCHIVE === "1";
fs.mkdirSync(OUT, { recursive: true });
const base = "http://127.0.0.1:17779";
const now = Date.now();
const mk = (id: string, title: string, issueRun?: object, extra = {}) => ({
  id,
  title,
  provider: "mock",
  model: "echo",
  mode: "plan",
  cwd: process.cwd(),
  status: "idle",
  cost: 0,
  createdAt: now - 9e5,
  updatedAt: now - 1000,
  titleLocked: true,
  ...(issueRun ? { issueRun } : {}),
  ...extra,
});
const run = (role: string, over = {}) => ({
  key: "o/r#5",
  repo: "o/r",
  number: 5,
  effort: "bau",
  role,
  branch: "issue-5-x",
  base: "main",
  ...over,
});
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    mk("11111111-1111-4111-8111-111111111111", "Plain chat"),
    mk(
      "44444444-4444-4444-8444-444444444444",
      "r:4 Completed export",
      run("work", { key: "o/r#4", number: 4 }),
      { archived: true },
    ),
    mk(
      "55555555-5555-4555-8555-555555555555",
      "r:4 review PR#8",
      run("review", { key: "o/r#4", number: 4, pr: 8 }),
      { archived: true },
    ),
    mk("22222222-2222-4222-8222-222222222222", "r:5 Fix the export", run("work")),
    mk("33333333-3333-4333-8333-333333333333", "r:5 review PR#9", run("review", { pr: 9 }), {
      status: "running",
    }),
  ]),
);
fs.writeFileSync(
  path.join(data, "window-dispatch.json"),
  JSON.stringify({ enabled: true, dryRun: false }),
);
// a dispatched worktree with its hook, the way startIssue lays it out
const gd = path.join(data, "main.git", "worktrees", "r-issue-5");
fs.mkdirSync(path.join(gd, "ac-hooks"), { recursive: true });
fs.mkdirSync(path.join(wts, "r-issue-5"), { recursive: true });
fs.writeFileSync(path.join(wts, "r-issue-5", ".git"), `gitdir: ${gd}\n`);
fs.writeFileSync(
  path.join(gd, "ac-hooks", "pre-push"),
  `#!/bin/sh\nif [ "$remote_ref" = "refs/heads/main" ]; then exit 1; fi\n`,
);
// a local agent-console checkout for the Debug button
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    stdio: "ignore",
  });
const repos = path.join(data, "repos"),
  origin = path.join(data, "origin.git"),
  local = path.join(repos, "agent-console");
fs.mkdirSync(origin);
g(origin, "init", "-q", "--bare", "-b", "main");
fs.mkdirSync(repos);
execFileSync("git", ["clone", "-q", origin, local], { stdio: "ignore" });
fs.writeFileSync(path.join(local, "a"), "1");
g(local, "add", "a");
g(local, "commit", "-qm", "init");
g(local, "push", "-q", "origin", "HEAD:main");
g(local, "remote", "set-head", "origin", "main");
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: "17779",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
    AGENT_CONSOLE_WORKTREES: wts,
    AGENT_CONSOLE_REPOS: repos,
  },
  stdio: "ignore",
});
const cookie = { name: "ac_session", value: makeToken(), url: base };
const post = (body: object) =>
  fetch(base + "/api/automation/_mock/event", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ac_session=${cookie.value}` },
    body: JSON.stringify(body),
  });
let browser: Browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // events after start-up, so the open run is genuinely active
  for (const e of [
    { step: "triage", kind: "fail", ref: "o/r#4", msg: "Temporary labeling failure" },
    { step: "triage", kind: "ok", ref: "o/r#4", msg: "Labels repaired" },
    { step: "triage", kind: "ok", ref: "o/r#5", msg: "labeled by pi/nemotron" },
    {
      step: "router",
      kind: "ok",
      ref: "o/r#5",
      msg: "live: route pi/default — pi allowance unknown",
    },
    { step: "worker", kind: "start", run: "work:w1", ref: "o/r#5", msg: "pi/default" },
    { step: "worktree", kind: "fail", ref: "o/r#6", msg: "No local checkout of o/missing" },
    { step: "review", kind: "start", run: "review:r1", ref: "o/r#5", msg: "claude/sonnet" },
  ])
    assert.equal((await post(e)).status, 200);

  browser = await chromium.launch();
  for (const [name, viewport, scheme] of [
    ["desktop-light", { width: 1280, height: 900 }, "light"],
    ["phone-dark", { width: 390, height: 844 }, "dark"],
  ] as const) {
    const ctx = await browser.newContext({
      viewport,
      colorScheme: scheme,
      isMobile: name.startsWith("phone"),
      hasTouch: name.startsWith("phone"),
      ...(RECORD ? { recordVideo: { dir: path.join(OUT, "videos"), size: viewport } } : {}),
    });
    await ctx.addCookies([cookie]);
    const page = await ctx.newPage();
    const recordedAt = Date.now();
    const archive = async (thread: string, archived: boolean) =>
      page.evaluate(
        ({ thread, archived }) =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(
              `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
            );
            const timeout = setTimeout(() => {
              socket.close();
              reject(new Error("Archive update timed out"));
            }, 5000);
            socket.onopen = () => socket.send(JSON.stringify({ t: "archive", thread, archived }));
            socket.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("Archive socket failed"));
            };
            socket.onmessage = (event) => {
              const message = JSON.parse(event.data);
              if (
                message.t === "thread" &&
                message.thread.id === thread &&
                !!message.thread.archived === archived
              ) {
                clearTimeout(timeout);
                socket.close();
                resolve();
              }
            };
          }),
        { thread, archived },
      );
    const errors: string[] = [],
      external: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("request", (r) => {
      const u = r.url();
      if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(base)) external.push(u);
    });
    const ok = (label: string, cond: boolean, extra = "") =>
      assert.ok(cond, `${name}: ${label} ${extra}`);

    // --- the Auto lane: auto-started threads live here, not in Threads -----------------------------------------
    await page.goto(base);
    await page.waitForSelector("#lane-auto", { state: "attached" });
    // Restore the live issue after the previous viewport archived it.
    if (name.startsWith("phone")) {
      await archive("22222222-2222-4222-8222-222222222222", false);
      await archive("33333333-3333-4333-8333-333333333333", false);
    }
    if (name.startsWith("phone")) await page.click("#menu");
    ok(
      "Threads lane shows only the plain chat",
      (await page.locator("#threads li:not(.empty-list) .t").allInnerTexts()).join("|") ===
        "Plain chat",
    );
    await page.click("#lane-auto");
    ok(
      "Auto lane is selected and visible",
      (await page.getAttribute("#lane-auto", "aria-selected")) === "true" &&
        (await page.locator("#pane-auto").isVisible()),
    );
    const issue = page.locator('#autos .auto-group[data-issue="o/r#5"]');
    const toggle = issue.locator(".auto-group-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    const rows = (await page.locator("#autos li[data-thread] .t").allInnerTexts()).filter(
      (t) => !t.startsWith("ac:debug"),
    ); // a debug thread from an earlier viewport belongs here too
    ok(
      "both runs of the issue are listed",
      rows.length === 2 && rows.includes("r:5 Fix the export") && rows.includes("r:5 review PR#9"),
      rows.join("|"),
    );
    ok(
      "rows are grouped by issue with a header",
      (await issue.count()) === 1 && (await toggle.innerText()).includes("#5"),
    );
    const page_roles = (await page.locator("#autos .role").allInnerTexts()).map((s) =>
      s.toLowerCase(),
    );
    ok(
      "role chips",
      ["review", "work"].every((r) => page_roles.includes(r)),
    );
    ok(
      "the lane tab has a dot for running work (hidden while all idle)",
      (await page.locator("#lane-auto-dot").count()) === 1 &&
        !(await page.locator("#lane-auto-dot").isVisible()),
    );
    ok(
      "a link to the dashboard",
      (await page.getAttribute("#auto-link", "href")) === "/automation",
    );
    await page.click('#autos li[data-thread="22222222-2222-4222-8222-222222222222"]');
    await page.waitForFunction(() =>
      document.querySelector("#head .title")?.textContent?.includes("r:5 Fix the export"),
    );

    if (name.startsWith("phone")) await page.click("#menu");
    ok(
      "archive starts collapsed and counts archived issues",
      (await page.locator("#auto-archive").isVisible()) &&
        (await page.locator("#auto-archive-count").innerText()) === "1" &&
        (await page.getAttribute("#auto-archive-toggle", "aria-expanded")) === "false" &&
        (await page.locator("#auto-archived").isHidden()),
    );
    ok(
      "automated history never enters the Threads archive",
      (await page.locator("#archived li[data-thread]").count()) === 0 &&
        (await page.locator("#archive").isHidden()),
    );
    await page.screenshot({ path: `${OUT}/auto-archive-collapsed-${name}.png` });
    await page.waitForTimeout(400);
    await page.click("#auto-archive-toggle");
    const saved = page.locator('#auto-archived .auto-group[data-issue="o/r#4"]');
    ok(
      "saved runs stay grouped by issue",
      (await saved.count()) === 1 && (await saved.locator("li[data-thread]").count()) === 2,
    );
    await saved.locator(".auto-group-toggle").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/auto-archive-expanded-${name}.png` });
    await saved.locator('li[data-thread="44444444-4444-4444-8444-444444444444"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#head .title")?.textContent?.includes("r:4 Completed export"),
    );
    if (name.startsWith("phone")) await page.click("#menu");
    ok(
      "selecting archived chat keeps history expanded",
      (await saved.locator(".auto-group-toggle").getAttribute("aria-expanded")) === "true" &&
        (await page.getAttribute("#auto-archive-toggle", "aria-expanded")) === "true",
    );
    // The same thread update broadcast used by automatic lifecycle archival moves rows without a reload.
    await archive("22222222-2222-4222-8222-222222222222", true);
    await archive("33333333-3333-4333-8333-333333333333", true);
    await page.waitForFunction(
      () => document.querySelector("#auto-archive-count")?.textContent === "2",
    );
    ok(
      "live archive removes completed issue from active runs",
      (await page.locator('#autos .auto-group[data-issue="o/r#5"]').count()) === 0 &&
        (await page
          .locator('#auto-archived .auto-group[data-issue="o/r#5"] li[data-thread]')
          .count()) === 2,
    );
    ok(
      "rerender preserves archive and issue expansion",
      (await page.getAttribute("#auto-archive-toggle", "aria-expanded")) === "true" &&
        (await saved.locator(".auto-group-toggle").getAttribute("aria-expanded")) === "true",
    );
    ok(
      "live automated archive still leaves Threads archive empty",
      (await page.locator("#archived li[data-thread]").count()) === 0,
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/auto-archive-live-${name}.png` });
    const archiveClipSeconds = (Date.now() - recordedAt) / 1000;

    // --- the page --------------------------------------------------------------------------------------------------
    await page.goto(`${base}/automation`);
    await page.waitForSelector('[data-step="dispatcher"]');
    ok("all fifteen steps are drawn", (await page.locator("[data-step]").count()) === 15);
    const inPipe = async (p: string) =>
      page
        .locator(`[data-pipeline="${p}"] [data-step]`)
        .evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.step));
    ok(
      "PR workflow: issue to labels, labels to PR, premium review and merge",
      JSON.stringify(await inPipe("pr")) ===
        JSON.stringify([
          "triage",
          "dispatcher",
          "router",
          "worktree",
          "worker",
          "self_review",
          "pr",
          "review",
          "redo",
          "merge",
          "apply",
        ]),
      JSON.stringify(await inPipe("pr")),
    );
    ok(
      "PR workflow phases are labelled",
      (await page.locator('[data-pipeline="pr"] .phase h3').allInnerTexts())
        .map((t) => t.toLowerCase())
        .join("|") === "1. issue to labels|2. labels to pull request|3. premium review and merge",
    );
    ok(
      "window opener is its own workflow",
      JSON.stringify(await inPipe("windows")) === JSON.stringify(["opener", "usage"]),
    );
    ok(
      "workspace monitor is its own workflow",
      JSON.stringify(await inPipe("monitor")) === JSON.stringify(["monitor", "escalate"]),
    );
    ok(
      "review and redo loop",
      (await page.locator('[data-pipeline="pr"] .link.loop[data-to="redo"]').count()) === 1,
    );
    ok(
      "review loop is boxed with its label",
      (await page
        .locator('[data-pipeline="pr"] .cycle [data-step]')
        .evaluateAll((b) => b.map((x) => x.dataset.step).join())) === "review,redo" &&
        /3 reviews at most/.test(
          await page.locator('[data-pipeline="pr"] .cycle .cap').innerText(),
        ),
    );
    ok(
      "loop arrows name their conditions",
      (await page.locator('[data-pipeline="pr"] .link.loop[data-to="redo"]').innerText())
        .replace(/\s+/g, " ")
        .trim() === "changes requested new commits pushed" &&
        (await page.locator('[data-pipeline="pr"] .link[data-to="merge"]').innerText()).trim() ===
          "approved",
    );
    ok(
      "each workflow lists its own triggers",
      (await page.locator('[data-pipeline="pr"] .ptrig').innerText()).includes("GitHub webhook") &&
        (await page.locator('[data-pipeline="windows"] .ptrig').innerText()).includes(
          "Window opener tick",
        ),
    );
    const state = (s: string) => page.getAttribute(`[data-step="${s}"]`, "data-state");
    ok("worker is the active step", (await state("worker")) === "active");
    ok("review is active too", (await state("review")) === "active");
    ok("worktree failed", (await state("worktree")) === "failed");
    ok("triage ok", (await state("triage")) === "ok");
    ok("router ok", (await state("router")) === "ok");
    ok("apply has not run", (await state("apply")) === "idle");
    ok("the header says it is live", /live/i.test(await page.locator("#mode").innerText()));
    ok(
      "failures list the failed step",
      (await page.locator("#failures li").allInnerTexts()).join(" ").includes("No local checkout"),
    );
    const resolved = page.locator("#failures li").filter({ hasText: "Temporary labeling failure" });
    const unresolved = page.locator("#failures li").filter({ hasText: "No local checkout" });
    ok(
      "recovered failures are marked without warning color",
      /Resolved/.test(await resolved.innerText()) && (await resolved.locator(".bad").count()) === 0,
    );
    ok("unconfirmed failures remain flagged", /Unresolved/.test(await unresolved.innerText()));
    await unresolved.locator("button").focus();
    const previousFailure = await unresolved.locator("button").elementHandle();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction((b) => !b?.isConnected, previousFailure);
    ok(
      "live refresh preserves failure row focus",
      await unresolved.locator("button").evaluate((b) => b === document.activeElement),
    );
    await page.keyboard.press("Enter");
    await page.waitForSelector("#drawer:not([hidden])");
    await page.keyboard.press("Escape");
    ok(
      "failure log returns keyboard focus to its row",
      await unresolved.locator("button").evaluate((b) => b === document.activeElement),
    );
    await page.locator("#failures").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/resolved-failures-${name}.png` });
    ok(
      "other triggers list what belongs to no workflow",
      (await page.locator("#triggers").innerText()).includes("Debug button") &&
        !(await page.locator("#triggers").innerText()).includes("GitHub webhook"),
    );
    ok(
      "git hooks list the worktree and the branch it protects",
      /r-issue-5/.test(await page.locator("#hooks").innerText()) &&
        /main/.test(await page.locator("#hooks").innerText()),
    );
    ok("a Debug button", await page.locator("#debug").isVisible());
    // clicking a step opens its log
    await page.click('[data-step="worktree"]');
    await page.waitForSelector("#drawer:not([hidden])");
    ok(
      "drawer names the step and shows its log",
      /Worktree/.test(await page.locator("#drawer h2").innerText()) &&
        (await page.locator("#drawer-log").innerText()).includes("No local checkout"),
    );
    await page.keyboard.press("Escape");
    ok("Escape closes the drawer", await page.locator("#drawer").isHidden());
    await page.click('[data-step="triage"]');
    await page.waitForSelector("#drawer:not([hidden])");
    ok(
      "another step shows its own log",
      (await page.locator("#drawer-log").innerText()).includes("labeled by pi/nemotron") &&
        !(await page.locator("#drawer-log").innerText()).includes("No local checkout"),
    );
    await page.keyboard.press("Escape");
    ok(
      "no horizontal overflow",
      !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
    );
    await page.screenshot({ path: `${OUT}/automation-${name}.png`, fullPage: true });
    // live: new events move a step without reloading
    const rid = `merge:${name}`;
    await post({ step: "merge", kind: "start", run: rid, ref: "o/r#5" });
    await page.waitForFunction(
      () => document.querySelector('[data-step="merge"]')?.getAttribute("data-state") === "active",
      null,
      { timeout: 15_000 },
    );
    await post({ step: "merge", kind: "ok", run: rid, ref: "o/r#5", msg: "PR #9 merged" });
    await page.waitForFunction(
      () => document.querySelector('[data-step="merge"]')?.getAttribute("data-state") === "ok",
      null,
      { timeout: 15_000 },
    );
    // Debug: opens the new thread in the console
    await page.click('[data-step="worktree"]');
    await page.waitForSelector("#drawer:not([hidden])");
    page.on("dialog", (d) => {
      errors.push("dialog: " + d.message());
      void d.dismiss();
    });
    await Promise.all([
      page.waitForURL(/#thread=/, { timeout: 15_000 }).catch(() => {}),
      page.click("#debug"),
    ]);
    ok(
      "Debug opens a thread",
      /#thread=[0-9a-f-]{36}/.test(page.url()),
      page.url() + " " + errors.join("|"),
    );
    await page.waitForSelector("#lane-auto", { state: "attached" });
    ok(
      "no console errors, first-party only",
      errors.length === 0 && external.length === 0,
      errors.concat(external).join(" | ").slice(0, 300),
    );
    const recording = page.video();
    await ctx.close();
    if (recording)
      execFileSync(
        "python3",
        [
          "/home/coder/repos/brain/bin/pr-evidence-gif",
          await recording.path(),
          `${OUT}/auto-archive-${name}.gif`,
          "--duration",
          String(archiveClipSeconds),
          "--width",
          name.startsWith("phone") ? "390" : "1000",
        ],
        { stdio: "inherit" },
      );
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(
  "PASS automation UI: Auto lane with grouped archived history and live archival, workflow panels (PR workflow phases, window opener) with active/failed steps, review/redo loop, step drawer logs, triggers, failures, hooks, live refresh, phone layout",
);
