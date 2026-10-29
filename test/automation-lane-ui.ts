// This isolated browser fixture exercises the production Auto lane and stylesheet without starting providers or reading user data.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const out = process.env.OUT || "/tmp/auto-issue-groups-evidence";
fs.mkdirSync(out, { recursive: true });
const sprite = fs
  .readFileSync(path.join(root, "public/index.html"), "utf8")
  .match(/<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>/)?.[0];
assert.ok(sprite, "production icon sprite exists");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auto issue grouping browser fixture</title><link rel="stylesheet" href="/style.css">
<style>body{margin:0;padding:24px;background:var(--s0);color:var(--t1)}#fixture{max-width:var(--side-w);margin:auto}.fixture-note{color:var(--t3);font-size:12px}h1{font-size:20px}#lane-auto-dot{display:inline-block}.thread-list{padding:0;list-style:none}</style>
${sprite}
<section id="fixture"><h1>Auto <span id="lane-auto-dot" class="dot running"></span></h1><p class="fixture-note">Browser fixture · production Auto lane and styles · seeded issue work</p><ul id="autos" class="thread-list auto-list" aria-label="Automated runs"></ul><div id="auto-archive" hidden><button id="auto-archive-toggle" class="side-label side-toggle" type="button" aria-expanded="false" aria-controls="auto-archived"><svg class="ico" aria-hidden="true"><use href="#i-chev-right"/></svg><span>Archived</span><span id="auto-archive-count" class="count"></span></button><ul id="auto-archived" class="thread-list auto-list" aria-label="Archived automated runs" hidden></ul></div></section>
<script type="module">
import { createAutoLane } from '/automation-lane.js';
const now = Date.now();
const make = (id, title, issueRun, extra = {}) => ({ id, title, issueRun, provider: 'codex', model: 'gpt-6.1-sol', status: 'idle', updatedAt: now, ...extra });
const run = (role, extra = {}) => ({ key: 'example-owner/agent-console#43', repo: 'example-owner/agent-console', number: 43, effort: 'bau', role, ...extra });
const state = { current: null, threads: new Map([
  ['work', make('work', 'Fix issue #43 export', run('work'), { updatedAt: now - 1000 })],
  ['review', make('review', 'Review PR #79 for issue #43', run('review', { key: 'old-review-key', repo: 'example-owner/agent-console' }), { status: 'running' })],
  ['retry', make('retry', 'Retry issue #43 export', run('work', { key: 'legacy-retry-key', repo: 'example-owner/AGENT-CONSOLE' }), { updatedAt: now - 2000 })],
  ['other', make('other', 'Other repository issue #43', run('work', { repo: 'example-owner/other', key: 'example-owner/other#43' }))],
  ['debug', make('debug', 'Automation debug', run('debug', { repo: 'example-owner/agent-console', number: 0, key: 'automation#debug' }))],
  ['archived', make('archived', 'Archived issue #43 work', run('work'), { archived: now })],
  ['plain', make('plain', 'Plain chat', undefined)],
]) };
const opened = [], nav = [], issueTabs = [], premiumAssignments = [];
window.open = (...args) => { issueTabs.push(args); return null; };
const lane = createAutoLane({ state, assignPremium: issue => premiumAssignments.push(issue), openThread: id => opened.push(id), setNav: value => nav.push(value), provLabel: p => p === 'codex' ? 'Codex' : p, ago: () => 'just now' });
Object.assign(window, { fixture: { state, lane, opened, nav, issueTabs, premiumAssignments } });
lane.render();
</script></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html");
    res.end(html);
    return;
  }
  const vendors: Record<string, string> = {
    "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
    "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  };
  const file = path.resolve(root, vendors[url.pathname] || `public${url.pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader(
    "content-type",
    file.endsWith(".css")
      ? "text/css"
      : /\.(js|mjs)$/.test(file)
        ? "application/javascript"
        : file.endsWith(".woff2")
          ? "font/woff2"
          : "application/octet-stream",
  );
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
try {
  for (const [device, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const)
    for (const colorScheme of ["dark", "light"] as const) {
      const name = `${device}-${colorScheme}`;
      const context = await browser.newContext({
        viewport,
        colorScheme,
        hasTouch: device === "phone",
        isMobile: device === "phone",
        recordVideo: { dir: out, size: viewport },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      await page.waitForSelector(".auto-group-toggle");
      const group = page.locator('.auto-group[data-issue="example-owner/agent-console#43"]');
      const toggle = group.locator(".auto-group-toggle");
      assert.equal(
        await page.locator(".auto-group").count(),
        3,
        `${name}: canonical issue, separate repository, and debug groups`,
      );
      assert.equal(
        await group.locator("li[data-thread]").count(),
        4,
        `${name}: work, review, retry, and archived history share one issue`,
      );
      assert.equal(await page.locator('li[data-thread="plain"]').count(), 0);
      assert.equal(await page.locator('#autos li[data-thread="archived"]').count(), 1);
      assert.equal(
        await page.locator("#auto-archived .auto-group").count(),
        0,
        `${name}: mixed issue never duplicates into archive`,
      );
      assert.equal(await page.locator("#auto-archive").isVisible(), false);
      assert.equal(
        await page.locator('.auto-group[data-issue="example-owner/other#43"]').count(),
        1,
      );
      assert.ok(
        (await page.locator(".auto-group").allTextContents()).some((text) =>
          text.includes("automation#debug"),
        ),
        `${name}: debug fallback retained`,
      );
      assert.equal(await toggle.locator(".k").textContent(), "example-owner/agent-console#43");
      assert.equal(
        await toggle
          .locator(".k")
          .evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth &&
              element.scrollHeight <= element.clientHeight,
          ),
        true,
        `${name}: complete repository and issue label fits sidebar width`,
      );
      assert.match(await toggle.innerText(), /4/);
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await group.locator(".auto-runs").isVisible(), false);
      assert.equal(
        await toggle.locator(".dot.running").isVisible(),
        true,
        `${name}: collapsed issue still shows running work`,
      );
      const controls = await toggle.getAttribute("aria-controls");
      assert.ok(controls && (await group.locator(".auto-runs").getAttribute("id")) === controls);
      const more = group.locator(".auto-group-more");
      assert.equal(await more.count(), 1, `${name}: issue header exposes an actions menu`);
      assert.equal(
        await page.locator('.auto-group[data-issue="automation#debug"] .auto-group-more').count(),
        0,
        `${name}: debug groups have no invalid issue action`,
      );
      assert.equal(await more.getAttribute("aria-haspopup"), "menu");
      if (device === "phone") {
        const target = await more.boundingBox();
        assert.ok(
          target && target.width >= 44 && target.height >= 44,
          `${name}: issue menu has a 44px touch target`,
        );
      }
      await more.click();
      assert.equal(
        await toggle.getAttribute("aria-expanded"),
        "false",
        `${name}: opening actions does not expand the issue`,
      );
      assert.equal(
        await page.getByRole("menuitem", { name: "Show issue", exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByRole("menuitem", { name: "Assign to premium", exact: true }).count(),
        1,
      );
      await page.screenshot({ path: path.join(out, `${name}-menu-open.png`) });
      await page.waitForTimeout(700);
      await page.evaluate(() => (window as any).fixture.lane.render());
      assert.equal(
        await page.getByRole("menuitem", { name: "Show issue", exact: true }).isVisible(),
        true,
        `${name}: live updates preserve an open menu`,
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await more.evaluate((element) => document.activeElement === element),
        true,
        `${name}: Escape restores issue action focus`,
      );
      await more.click();
      await page.waitForTimeout(700);
      await page.getByRole("menuitem", { name: "Show issue", exact: true }).click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).fixture.issueTabs),
        [
          [
            "https://github.com/example-owner/agent-console/issues/43",
            "_blank",
            "noopener,noreferrer",
          ],
        ],
        `${name}: action synchronously opens the canonical GitHub issue in a safe new tab`,
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          opened: (window as any).fixture.opened,
          nav: (window as any).fixture.nav,
        })),
        { opened: [], nav: [] },
        `${name}: issue action does not select a run or close navigation`,
      );
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await page.waitForTimeout(700);
      const otherMore = page.locator(
        '.auto-group[data-issue="example-owner/other#43"] .auto-group-more',
      );
      await otherMore.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      assert.deepEqual(
        await page.evaluate(() => (window as any).fixture.issueTabs.at(-1)),
        ["https://github.com/example-owner/other/issues/43", "_blank", "noopener,noreferrer"],
        `${name}: separate repository opens its own issue`,
      );
      await page.screenshot({ path: path.join(out, `${name}-collapsed.png`) });
      await more.click();
      await page.getByRole("menuitem", { name: "Assign to premium", exact: true }).click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).fixture.premiumAssignments),
        [{ repo: "example-owner/agent-console", number: 43 }],
        `${name}: premium assignment uses canonical issue identity`,
      );
      assert.equal(
        await toggle.getAttribute("aria-expanded"),
        "false",
        `${name}: premium action does not expand the issue`,
      );
      // Hold each verified state briefly so the recorded interaction is readable at normal playback speed.
      await page.waitForTimeout(700);
      await toggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.equal(await group.locator(".auto-runs").isVisible(), true);
      await page.screenshot({ path: path.join(out, `${name}-expanded.png`) });
      await page.waitForTimeout(700);
      await page.locator('li[data-thread="review"]').click();
      assert.deepEqual(
        await page.evaluate(() => ({
          opened: (window as any).fixture.opened,
          nav: (window as any).fixture.nav,
        })),
        { opened: ["review"], nav: [false] },
      );
      await toggle.focus();
      await page.keyboard.press("Space");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await page.evaluate(() => {
        const { state, lane } = (window as any).fixture;
        state.threads.get("work").updatedAt += 5000;
        lane.render();
      });
      assert.equal(
        await toggle.getAttribute("aria-expanded"),
        "false",
        `${name}: live rerender preserves collapse`,
      );
      assert.equal(
        await toggle.evaluate((element) => document.activeElement === element),
        true,
        `${name}: live rerender preserves keyboard focus`,
      );
      await page.evaluate(() => {
        const { state, lane } = (window as any).fixture;
        state.current = "review";
        lane.render();
      });
      assert.equal(
        await toggle.getAttribute("aria-expanded"),
        "true",
        `${name}: new selection opens its issue`,
      );
      assert.equal(
        await page.locator('li[data-thread="review"]').getAttribute("aria-current"),
        "true",
      );
      await toggle.click();
      await page.evaluate(() => (window as any).fixture.lane.render());
      assert.equal(
        await toggle.getAttribute("aria-expanded"),
        "false",
        `${name}: current group can remain manually collapsed`,
      );
      await page.evaluate(() => {
        const { state, lane } = (window as any).fixture;
        state.current = "archived";
        lane.render();
      });
      assert.equal(
        await group.locator('li[data-thread="archived"]').isVisible(),
        true,
        `${name}: archived current member opens its live issue`,
      );
      assert.equal(
        await page.locator("#auto-archive-toggle").getAttribute("aria-expanded"),
        "false",
        `${name}: selecting archived member of live issue does not open archive`,
      );
      await page.screenshot({ path: path.join(out, `${name}-mixed-live.png`) });
      await page.waitForTimeout(700);
      await page.evaluate(() => {
        const { state, lane } = (window as any).fixture;
        state.current = null;
        for (const thread of state.threads.values())
          if (
            thread.issueRun?.repo?.toLowerCase() === "example-owner/agent-console" &&
            thread.issueRun.number === 43
          ) {
            thread.archived = Date.now();
            thread.status = "idle";
          }
        lane.render();
      });
      assert.equal(
        await page
          .locator('#autos .auto-group[data-issue="example-owner/agent-console#43"]')
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator('#auto-archived .auto-group[data-issue="example-owner/agent-console#43"]')
          .count(),
        1,
        `${name}: complete issue moves together`,
      );
      assert.equal(
        await page.locator("#auto-archive-count").textContent(),
        "1",
        `${name}: archive counts issues, not runs`,
      );
      await page.locator("#auto-archive-toggle").click();
      const archivedMore = page.locator(
        '#auto-archived .auto-group[data-issue="example-owner/agent-console#43"] .auto-group-more',
      );
      await archivedMore.click();
      await page.screenshot({ path: path.join(out, `${name}-archived-menu-open.png`) });
      await page.waitForTimeout(700);
      await page.getByRole("menuitem", { name: "Show issue", exact: true }).click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).fixture.issueTabs.at(-1)),
        [
          "https://github.com/example-owner/agent-console/issues/43",
          "_blank",
          "noopener,noreferrer",
        ],
        `${name}: archived issue also opens GitHub`,
      );
      await archivedMore.click();
      await page.getByRole("menuitem", { name: "Assign to premium", exact: true }).click();
      assert.equal(
        await page.evaluate(() => (window as any).fixture.premiumAssignments.length),
        2,
        `${name}: archived issue supports premium assignment`,
      );
      await page.screenshot({ path: path.join(out, `${name}-all-archived.png`) });
      await page.waitForTimeout(700);
      await page.evaluate(() => {
        const { state, lane } = (window as any).fixture;
        state.threads.get("review").status = "running";
        lane.render();
      });
      assert.equal(
        await group.locator("li[data-thread]").count(),
        4,
        `${name}: archived running work returns whole issue to Live`,
      );
      assert.equal(await page.locator("#auto-archived .auto-group").count(), 0);
      assert.equal(await page.locator("#lane-auto-dot").isVisible(), true);
      await page.screenshot({ path: path.join(out, `${name}-running-live.png`) });
      await page.waitForTimeout(700);
      await page.evaluate(() => {
        const { state, lane } = (window as any).fixture;
        state.threads.get("review").status = "idle";
        state.threads.get("review").background = 1;
        lane.render();
      });
      assert.equal(
        await group.locator("li[data-thread]").count(),
        4,
        `${name}: archived background work keeps whole issue Live`,
      );
      await page.screenshot({ path: path.join(out, `${name}-background-live.png`) });
      assert.equal(
        await toggle.locator(".dot.running").isVisible(),
        true,
        `${name}: collapsed issue shows background work behind the lane dot`,
      );
      assert.match(await toggle.getAttribute("aria-label"), /1 running/);
      assert.equal(
        await group.locator('li[data-thread="review"] .dot.running').count(),
        1,
        `${name}: idle run with background tasks shows busy`,
      );
      assert.equal(await page.locator("#auto-archived .auto-group").count(), 0);
      await page.evaluate(() => {
        const { state, lane } = (window as any).fixture;
        state.threads.get("review").background = 0;
        lane.render();
      });
      assert.equal(
        await page
          .locator('#autos .auto-group[data-issue="example-owner/agent-console#43"]')
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator('#auto-archived .auto-group[data-issue="example-owner/agent-console#43"]')
          .count(),
        1,
      );
      await page.waitForTimeout(700);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${name}: no horizontal overflow`,
      );
      assert.deepEqual(errors, []);
      const video = page.video();
      await context.close();
      assert.ok(video);
      await video.saveAs(path.join(out, `${name}-interaction.webm`));
    }
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log(
  "PASS Auto issue menus and groups: GitHub issue tabs, premium assignment callbacks, menu refresh and keyboard focus, exclusive Live/archive membership, running/background work, canonical identity, selection, desktop/phone light/dark.",
);
