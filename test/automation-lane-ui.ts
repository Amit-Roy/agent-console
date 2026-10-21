// This isolated browser fixture exercises the production Auto lane and stylesheet without starting providers or reading user data.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const out = process.env.OUT || "/tmp/auto-issue-groups-evidence";
fs.mkdirSync(out, { recursive: true });
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auto issue grouping browser fixture</title><link rel="stylesheet" href="/style.css">
<style>body{margin:0;padding:24px;background:var(--s0);color:var(--t1)}#fixture{max-width:420px;margin:auto}.fixture-note{color:var(--t3);font-size:12px}h1{font-size:20px}#lane-auto-dot{display:inline-block}.thread-list{padding:0;list-style:none}</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="i-chev-right" viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></symbol></defs></svg>
<section id="fixture"><h1>Auto <span id="lane-auto-dot" class="dot running"></span></h1><p class="fixture-note">Browser fixture · production Auto lane and styles · seeded issue work</p><ul id="autos" class="thread-list auto-list" aria-label="Automated runs"></ul></section>
<script type="module">
import { createAutoLane } from '/automation-lane.js';
const now = Date.now();
const make = (id, title, issueRun, extra = {}) => ({ id, title, issueRun, provider: 'codex', model: 'gpt-6.1-sol', status: 'idle', updatedAt: now, ...extra });
const run = (role, extra = {}) => ({ key: 'Owner/console#42', repo: 'Owner/console', number: 42, effort: 'bau', role, ...extra });
const state = { current: null, threads: new Map([
  ['work', make('work', 'Fix issue #42 export', run('work'), { updatedAt: now - 1000 })],
  ['review', make('review', 'Review PR #79 for issue #42', run('review', { key: 'old-review-key', repo: 'owner/CONSOLE' }), { status: 'running' })],
  ['retry', make('retry', 'Retry issue #42 export', run('work', { key: 'legacy-retry-key' }), { updatedAt: now - 2000 })],
  ['other', make('other', 'Other repository issue #42', run('work', { repo: 'Owner/other', key: 'Owner/other#42' }))],
  ['debug', make('debug', 'Automation debug', run('debug', { repo: 'Owner/console', number: 0, key: 'automation#debug' }))],
  ['archived', make('archived', 'Archived issue #42 work', run('work'), { archived: now })],
  ['plain', make('plain', 'Plain chat', undefined)],
]) };
const opened = [], nav = [];
const lane = createAutoLane({ state, openThread: id => opened.push(id), setNav: value => nav.push(value), provLabel: p => p === 'codex' ? 'Codex' : p, ago: () => 'just now' });
Object.assign(window, { fixture: { state, lane, opened, nav } });
lane.render();
</script></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/") { res.setHeader("content-type", "text/html"); res.end(html); return; }
  const vendors: Record<string, string> = { "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js", "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs" };
  const file = path.resolve(root, vendors[url.pathname] || `public${url.pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", file.endsWith(".css") ? "text/css" : /\.(js|mjs)$/.test(file) ? "application/javascript" : file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream");
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
try {
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    const context = await browser.newContext({ viewport, colorScheme: "dark", recordVideo: { dir: out, size: viewport } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base);
    await page.waitForSelector(".auto-group-toggle");
    const group = page.locator('.auto-group[data-issue="owner/console#42"]');
    const toggle = group.locator(".auto-group-toggle");
    assert.equal(await page.locator(".auto-group").count(), 3, `${name}: canonical issue, separate repository, and debug groups`);
    assert.equal(await group.locator("li[data-thread]").count(), 3, `${name}: work, review, and retry share one issue`);
    assert.equal(await page.locator('li[data-thread="archived"],li[data-thread="plain"]').count(), 0);
    assert.equal(await page.locator('.auto-group[data-issue="owner/other#42"]').count(), 1);
    assert.ok((await page.locator(".auto-group").allTextContents()).some(text => text.includes("automation#debug")), `${name}: debug fallback retained`);
    assert.match(await toggle.innerText(), /#42/);
    assert.match(await toggle.innerText(), /console/i);
    assert.match(await toggle.innerText(), /3/);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await group.locator(".auto-runs").isVisible(), false);
    assert.equal(await toggle.locator(".dot.running").isVisible(), true, `${name}: collapsed issue still shows running work`);
    const controls = await toggle.getAttribute("aria-controls");
    assert.ok(controls && await group.locator(".auto-runs").getAttribute("id") === controls);
    await page.screenshot({ path: path.join(out, `${name}-collapsed.png`) });
    // Hold each verified state briefly so the recorded interaction is readable at normal playback speed.
    await page.waitForTimeout(700);
    await toggle.focus();
    await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await group.locator(".auto-runs").isVisible(), true);
    await page.screenshot({ path: path.join(out, `${name}-expanded.png`) });
    await page.waitForTimeout(700);
    await page.locator('li[data-thread="review"]').click();
    assert.deepEqual(await page.evaluate(() => ({ opened: (window as any).fixture.opened, nav: (window as any).fixture.nav })), { opened: ["review"], nav: [false] });
    await toggle.focus();
    await page.keyboard.press("Space");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await page.evaluate(() => { const { state, lane } = (window as any).fixture; state.threads.get("work").updatedAt += 5000; lane.render(); });
    assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${name}: live rerender preserves collapse`);
    assert.equal(await toggle.evaluate(element => document.activeElement === element), true, `${name}: live rerender preserves keyboard focus`);
    await page.evaluate(() => { const { state, lane } = (window as any).fixture; state.current = "review"; lane.render(); });
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${name}: new selection opens its issue`);
    assert.equal(await page.locator('li[data-thread="review"]').getAttribute("aria-current"), "true");
    await toggle.click();
    await page.evaluate(() => (window as any).fixture.lane.render());
    assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${name}: current group can remain manually collapsed`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no horizontal overflow`);
    assert.deepEqual(errors, []);
    const video = page.video();
    await context.close();
    assert.ok(video);
    await video.saveAs(path.join(out, `${name}-interaction.webm`));
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log("PASS Auto issue groups: canonical identity, collapse and keyboard controls, live updates, selection, desktop and phone.");
