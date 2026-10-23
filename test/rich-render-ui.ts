// Isolated browser regression: inline images, video (HTTP Range), charts, tables, links and the sanitiser in the real render path.
// Run: rtk proxy node test/rich-render-ui.ts   (OUT=dir saves screenshots)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {chromium, type Browser, type Page} from 'playwright';
import sharp from 'sharp';

const port = process.env.RICH_RENDER_TEST_PORT || '7075';
assert.match(port, /^707[1-5]$/, 'use an isolated scratch port, 7071–7075');
const base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rich-data-'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rich-fixture-'));
const cwd = path.join(fixture, 'project');
fs.mkdirSync(cwd);
const png = await sharp({create: {width: 640, height: 360, channels: 4, background: '#7e8bd6'}}).png().toBuffer();
fs.writeFileSync(path.join(cwd, 'shot.png'), png);
fs.writeFileSync(path.join(fixture, 'outside.webm'), 'secret');
fs.writeFileSync(path.join(cwd, 'sample.ts'), 'export const sample = 1;\n');
fs.writeFileSync(path.join(cwd, 'fake.mp4'), 'this is not a video');
fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=1');
// A real, decodable clip when ffmpeg can make one (Playwright's Chromium plays VP8 WebM, not H.264).
const clip = path.join(cwd, 'clip.webm');
const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1:r=10', '-c:v', 'libvpx', '-b:v', '200k', clip]);
const realClip = ff.status === 0 && fs.existsSync(clip);
if (!realClip) fs.writeFileSync(clip, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000)]));
fs.writeFileSync(path.join(cwd, 'movie.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(5000, 1)]));
const clipSize = fs.statSync(clip).size;

const chart = JSON.stringify({type: 'bar', title: 'Cost per run', data: {labels: ['A', 'B', 'C'], datasets: [{label: 'USD', data: [1.5, 3, 2.25]}, {label: 'Cached', data: [1, 2, 1]}]}, options: {scales: {y: {title: {text: 'USD'}, beginAtZero: true}}}});
const message = [
  '---\ntitle: Rich render\nstatus: draft\n---',
  '![Compaction versus prompt caching](<./shot.png>)',
  `![Absolute](${path.join(cwd, 'shot.png')})`,
  '![Missing diagram](./nope.png)',
  '![Remote picture](https://img.test/remote.png)',
  '![Demo clip](./clip.webm)',
  'Bare https://example.com/some/very/long/path?with=query&and=more and [Sonnet API rates](https://example.com/rates).',
  'Code URL `http://127.0.0.1:8765/x.mp4` and path `' + path.join(cwd, 'sample.ts') + ':1` but not `npm run test` or import `@AGENTS.md`.',
  '| Name | Count | Share |\n|---|---:|---|\n| alpha | 1,200 | 12% |\n| beta | 34 | 3.5% |\n| gamma | 5 | 0.1% |',
  '```chart\n' + chart + '\n```',
].join('\n\n');
const thread = (id: string, title: string, updatedAt: number) => ({id, provider: 'mock', model: 'echo', effort: 'medium', mode: 'plan', title, cwd, status: 'idle', cost: 0, createdAt: 1, updatedAt});
const rich = thread('33333333-3333-4333-8333-333333333333', 'Rich render', 1);
const plain = thread('44444444-4444-4444-8444-444444444444', 'Plain', 2); // newest: opens first, has no chart
fs.mkdirSync(path.join(data, 'logs'));
fs.writeFileSync(path.join(data, 'threads.json'), JSON.stringify([rich, plain]));
fs.writeFileSync(path.join(data, 'commands.json'), '{}');
const log = (id: string, text: string) => fs.writeFileSync(path.join(data, 'logs', `${id}.jsonl`), JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text}]}}) + '\n');
log(rich.id, message);
log(plain.id, 'Just text, no chart here.');
process.env.AGENT_CONSOLE_DATA = data;
const {makeToken} = await import('../server/auth.ts');
const server = spawn(process.execPath, ['server/index.ts'], {
  env: {...process.env, PORT: port, AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_RUN: path.join(data, 'run'), AGENT_CONSOLE_PID_FILE: '', AGENT_CONSOLE_AUTH: 'password', AGENT_CONSOLE_MOCK: '1', AGENT_CONSOLE_HEADROOM: '0', AGENT_CONSOLE_LABELS: '0', AGENT_CONSOLE_ENV_FILES: '/dev/null'},
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverError = '';
server.stderr.on('data', b => { serverError += String(b); });
let browser: Browser | undefined;
const shot = async (page: Page, name: string) => {
  if (!process.env.OUT) return;
  fs.mkdirSync(process.env.OUT, {recursive: true});
  await page.screenshot({path: path.join(process.env.OUT, name)});
};
const pass = (s: string) => console.log(`PASS ${s}`);

try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`scratch server exited (${server.exitCode}): ${serverError}`);
    try { if ((await fetch(`${base}/login`)).ok) break; } catch {}
    if (i === 99) throw new Error('scratch server did not start');
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: 'dark', serviceWorkers: 'block', isMobile: true, hasTouch: true});
  await context.addCookies([{name: 'ac_session', value: makeToken(), url: base}]);
  await context.route('https://img.test/**', route => route.fulfill({status: 200, contentType: 'image/png', body: png}));
  const page = await context.newPage();
  const errors: string[] = [], csp: string[] = [], requests: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => ((window as any).__csp ||= []).push(e.violatedDirective + ' ' + e.blockedURI)));
  await page.goto(base);
  await page.locator('#chat .msg.asst').first().waitFor();
  await page.waitForTimeout(500);
  assert.ok(!requests.includes('/vendor/chart.umd.min.js'), 'Chart.js is not loaded until a chart appears');
  pass('first load does not fetch Chart.js');

  // Open the thread that holds the rich message.
  await page.locator('#threads li', {hasText: 'Rich render'}).first().click().catch(async () => { await page.locator('#nav, #menu').first().click().catch(() => {}); await page.locator('#threads li', {hasText: 'Rich render'}).first().click(); });
  const chat = page.locator('#chat');
  await chat.locator('figure.chart canvas').waitFor({timeout: 15000}).catch(async e => { console.log(errors, await page.evaluate(() => document.querySelector('#chat')!.innerHTML.slice(0, 1500))); await shot(page, 'debug.png'); throw e; });
  assert.ok(requests.includes('/vendor/chart.umd.min.js'), 'chart block lazy-loads Chart.js');
  pass('chart block renders a canvas via lazy-loaded Chart.js');

  // ---- images
  const localImg = chat.locator('a.md-img img').first();
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>('#chat a.md-img img'); return !!i && i.complete && i.naturalWidth > 0; });
  const src = await localImg.getAttribute('src');
  assert.match(src!, /^\/api\/file-image\?/, 'local image goes through the scoped image route');
  const imgRes = await page.request.get(base + src!);
  assert.equal(imgRes.status(), 200);
  assert.match(imgRes.headers()['content-type'], /^image\/png/);
  assert.equal(await chat.locator('a.md-img img').first().evaluate((i: HTMLImageElement) => i.loading), 'lazy');
  pass('local image src rewritten and loads (200 image/png)');
  await page.waitForFunction(() => document.querySelectorAll('#chat a.md-img.loaded').length >= 3);
  assert.equal(await chat.locator('a.md-img img[src^="https://img.test/"]').count(), 1, 'remote image keeps its https src and loads under the CSP');
  assert.deepEqual(await page.evaluate(() => (window as any).__csp || []), [], 'no CSP violations');
  const fail = chat.locator('.md-fail', {hasText: 'Missing diagram'});
  await fail.waitFor();
  assert.equal(await fail.locator('a.md-fail-open').textContent(), 'Open');
  pass('broken image falls back to alt text + Open link; remote https image loads');
  await chat.locator('a.md-img[data-viewer-image]').first().click();
  await page.locator('#file-viewer[open]').waitFor();
  await page.waitForFunction(() => document.querySelector('#file-viewer[open]')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#file-viewer img.file-viewer-image').count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('#file-viewer[open]').waitFor({state: 'hidden'});
  pass('click-to-zoom opens the shared viewer');

  // ---- video
  const video = chat.locator('video.md-video').first();
  const vsrc = (await video.getAttribute('src'))!;
  assert.match(vsrc, /^\/api\/file-media\?/);
  if (realClip) {
    await page.waitForFunction(() => (document.querySelector('#chat video.md-video') as HTMLVideoElement).readyState >= 1, null, {timeout: 10000});
    assert.ok(await video.evaluate((v: HTMLVideoElement) => v.duration > 0 && v.controls && v.playsInline && v.preload === 'metadata'));
  }
  const head = await page.request.get(base + vsrc, {headers: {Range: 'bytes=0-99'}});
  assert.equal(head.status(), 206);
  assert.equal(head.headers()['content-range'], `bytes 0-99/${clipSize}`);
  assert.equal((await head.body()).length, 100);
  assert.equal(head.headers()['accept-ranges'], 'bytes');
  const tail = await page.request.get(base + vsrc, {headers: {Range: 'bytes=-50'}});
  assert.equal(tail.status(), 206);
  assert.equal((await tail.body()).length, 50);
  const open = await page.request.get(base + vsrc, {headers: {Range: `bytes=${clipSize - 10}-`}});
  assert.equal((await open.body()).length, 10);
  assert.equal((await page.request.get(base + vsrc, {headers: {Range: `bytes=${clipSize + 5}-`}})).status(), 416);
  const full = await page.request.get(base + vsrc);
  assert.equal(full.status(), 200);
  assert.equal((await full.body()).length, clipSize);
  const media = (p: string) => `${base}/api/file-media?thread=${rich.id}&path=${encodeURIComponent(p)}`;
  // home and /tmp are viewable by design (6ea823f), so the fixture's ../outside.webm is in scope; system folders are not
  assert.equal((await page.request.get(media('../outside.webm'))).status(), 415, 'elsewhere in /tmp: in scope, refused only as not a real video');
  assert.equal((await page.request.get(media('/etc/outside.webm'))).status(), 403, 'outside home and /tmp');
  assert.equal((await page.request.get(media('.env'))).status(), 403, 'credential file');
  assert.equal((await page.request.get(media('shot.png'))).status(), 415, 'not a video extension');
  assert.equal((await page.request.get(media('fake.mp4'))).status(), 415, 'wrong magic bytes');
  assert.equal((await page.request.get(media('movie.mp4'))).status(), 200);
  assert.equal((await page.request.get(`${base}/api/file-media?thread=nope&path=clip.webm`)).status(), 404);
  assert.equal((await (await browser.newContext()).request.get(base + vsrc)).status(), 401, 'requires the session cookie');
  pass('video element + Range (206/416/suffix/open-ended), type/magic/scope checks, auth');

  // ---- links
  const bare = chat.locator('a[href^="https://example.com/some/very/long/path"]');
  assert.equal(await bare.getAttribute('target'), '_blank');
  assert.match((await bare.getAttribute('rel'))!, /noopener/);
  const rates = chat.locator('a', {hasText: 'Sonnet API rates'});
  assert.equal(await rates.getAttribute('href'), 'https://example.com/rates');
  assert.equal(await rates.getAttribute('target'), '_blank');
  pass('bare URL autolinks and markdown http(s) links are anchors with target=_blank rel=noopener');
  const urlCode = chat.locator('a.code-link', {hasText: 'http://127.0.0.1:8765/x.mp4'});
  assert.equal(await urlCode.getAttribute('href'), 'http://127.0.0.1:8765/x.mp4');
  assert.equal(await urlCode.getAttribute('target'), '_blank');
  assert.ok(await urlCode.locator('code').count(), 'keeps code styling');
  assert.equal(await chat.locator('video[src="http://127.0.0.1:8765/x.mp4"]').count() + await chat.locator('.md-fail', {hasText: 'x.mp4'}).count(), 1, 'video link gets a player (or its fallback)');
  assert.equal(await chat.locator('a.code-link', {hasText: 'npm run test'}).count(), 0, 'plain commands are not linked');
  assert.equal(await chat.locator('a.code-link', {hasText: '@AGENTS.md'}).count(), 0, 'at-imports are not linked');
  const pathCode = chat.locator('a.code-link[data-file-ref]', {hasText: 'sample.ts'});
  await pathCode.click();
  await page.locator('#file-viewer[open]').waitFor();
  await page.waitForFunction(() => document.querySelector('#file-viewer[open]')?.getAttribute('aria-busy') === 'false');
  assert.match((await page.locator('#file-viewer-title').textContent())!, /sample\.ts/);
  await page.keyboard.press('Escape');
  await page.locator('#file-viewer[open]').waitFor({state: 'hidden'});
  assert.ok(await chat.locator('a.code-link').first().evaluate((a: HTMLElement) => getComputedStyle(a.querySelector('code')!).overflowWrap === 'anywhere'));
  pass('URL / path inside inline code become links (http -> new tab, path -> file viewer)');

  // ---- table
  const meta = chat.locator('.table-wrap table').first();
  assert.equal(await meta.locator('tbody tr').count(), 2, 'frontmatter shown as a key/value table');
  assert.equal(await meta.locator('tbody td').first().innerText(), 'title');
  assert.ok(!(await chat.innerText()).includes('status: draft'), 'raw frontmatter text is not rendered');
  const table = chat.locator('.table-wrap table').nth(1);
  assert.equal(await table.locator('th.num').count(), 2, 'numeric columns detected (Count, Share)');
  assert.equal(await table.locator('td.num').count(), 6);
  assert.equal(await table.locator('td.num').first().evaluate(e => getComputedStyle(e).textAlign), 'right');
  assert.equal(await table.locator('th').first().evaluate(e => getComputedStyle(e).position), 'sticky');
  assert.equal(await chat.locator('.table-wrap').first().evaluate(e => getComputedStyle(e).overflowX), 'auto');
  pass('table: numeric right-align, sticky header + first column, scroll wrapper');
  await page.setViewportSize({width: 390, height: 2400});
  await page.waitForTimeout(400);
  await shot(page, 'mobile-rich-dark.png');
  await page.setViewportSize({width: 390, height: 844});

  // ---- chart details: theme palette, a11y, streaming, cleanup, size clamp, strict JSON
  const info = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#chat figure.chart canvas')!;
    const c = (window as any).Chart.getChart(canvas);
    const viz = getComputedStyle(document.documentElement).getPropertyValue('--viz-1').trim();
    return {type: c.config.type, color: c.data.datasets[0].backgroundColor, viz, label: canvas.getAttribute('aria-label'), role: canvas.getAttribute('role'), table: document.querySelectorAll('#chat figure.chart details table tbody tr').length};
  });
  assert.equal(info.type, 'bar');
  assert.equal(info.color, info.viz, 'series use the app palette token');
  assert.match(info.label!, /Cost per run/);
  assert.equal(info.role, 'img');
  assert.equal(info.table, 3, 'accessible data table');
  pass('chart: palette tokens, aria-label from title, data table');

  const r = await page.evaluate(async (chartJson) => {
    const m = await import('/render.js');
    m.setFileScope(() => null);
    const host = document.createElement('div'); document.body.append(host);
    const out: Record<string, any> = {};
    const full = '```chart\n' + chartJson + '\n```';
    m.renderMarkdown('```chart\n' + chartJson.slice(0, 60), host);
    out.partialIsCode = !!host.querySelector('.code') && !host.querySelector('figure.chart');
    m.renderMarkdown(full, host);
    await new Promise(res => setTimeout(res, 400));
    const fig = host.querySelector('figure.chart')!; (fig as any).__mark = 1;
    const canvas = fig.querySelector('canvas')!;
    const chartObj = (window as any).Chart.getChart(canvas);
    out.drawn = !!chartObj;
    m.renderMarkdown(full + '\n\nmore streamed text', host); // streaming re-render
    const again = host.querySelector('figure.chart')!;
    out.sameNode = (again as any).__mark === 1 && again.querySelector('canvas') === canvas && (window as any).Chart.getChart(canvas) === chartObj;
    m.renderMarkdown('chart removed', host);
    out.destroyed = (window as any).Chart.getChart(canvas) === undefined;
    const big = JSON.stringify({type: 'line', data: {labels: [], datasets: [{data: Array.from({length: 600}, (_, i) => i)}]}});
    m.renderMarkdown('```chart\n' + big + '\n```', host);
    out.clamped = !host.querySelector('figure.chart');
    m.renderMarkdown('```chart\n{"type":"bar","data":{"datasets":[{"data":[1,"__import__(x)"]}]}}\n```', host);
    out.invalid = !host.querySelector('figure.chart') && !!host.querySelector('.code');
    m.renderMarkdown('```chart\n{"type":"bar","data":{"datasets":[{"data":[1,2],"backgroundColor":"url(javascript:1)"}]},"options":{"onClick":"alert(1)"}}\n```', host);
    await new Promise(res => setTimeout(res, 300));
    const cv = host.querySelector('canvas'); const co = cv && (window as any).Chart.getChart(cv);
    out.safeOptions = !!co && co.options.onClick == null && co.data.datasets[0].backgroundColor !== 'url(javascript:1)';
    host.remove();
    return out;
  }, chart);
  assert.deepEqual(r, {partialIsCode: true, drawn: true, sameNode: true, destroyed: true, clamped: true, invalid: true, safeOptions: true});
  pass('chart: incomplete JSON stays a code block, streaming reuses the node, instances destroyed, clamped, strict + whitelisted config');

  // ---- sanitiser
  const s = await page.evaluate(async () => {
    const m = await import('/render.js');
    m.setFileScope(() => 'x');
    (window as any).__xss = 0;
    const host = document.createElement('div'); document.body.append(host);
    m.renderMarkdown('<script>window.__xss=1</script><img src=x onerror="window.__xss=2"><a href="javascript:window.__xss=3">j</a>\n\n[md](javascript:alert(1))\n\n<video src="javascript:alert(1)" onerror="window.__xss=4" autoplay></video>\n\n<video><source src="file:///etc/passwd" onerror="window.__xss=5"></video>\n\n<video src="https://v.test/a.mp4" controls></video>\n\n![x](javascript:alert(1))', host);
    await new Promise(res => setTimeout(res, 200));
    const all = [...host.querySelectorAll('*')];
    const out = {
      xss: (window as any).__xss, scripts: host.querySelectorAll('script').length,
      handlers: all.filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length,
      jsHrefs: all.filter(e => [...e.attributes].some(a => /^\s*javascript:/i.test(a.value))).length,
      badMedia: [...host.querySelectorAll('video, source')].filter(e => e.hasAttribute('src') && !/^https:\/\/v\.test/.test(e.getAttribute('src')!)).length,
      autoplay: host.querySelectorAll('[autoplay]').length, goodVideo: host.querySelectorAll('video[src="https://v.test/a.mp4"], .md-fail').length, // unreachable host: player or its fallback
    };
    host.remove();
    return out;
  });
  assert.deepEqual(s, {xss: 0, scripts: 0, handlers: 0, jsHrefs: 0, badMedia: 0, autoplay: 0, goodVideo: 1});
  pass('sanitiser strips script/onerror/javascript: and unsafe video sources; allows http(s) video');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS rich render');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const stopped = new Promise<void>(resolve => server.once('exit', () => resolve()));
    server.kill();
    await stopped;
  }
  fs.rmSync(data, {recursive: true, force: true});
  fs.rmSync(fixture, {recursive: true, force: true});
}
