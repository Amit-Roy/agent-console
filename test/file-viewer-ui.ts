// Isolated browser regression: rendered file references, safe modal, and deferred assets.
// Run: rtk proxy node test/file-viewer-ui.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium, type Browser, type Page} from 'playwright';
import sharp from 'sharp';

const port = process.env.FILE_VIEWER_TEST_PORT || '7074';
assert.match(port, /^707[1-5]$/, 'use an isolated scratch port, 7071–7075');
const base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-file-viewer-data-'));
const fixture = fs.mkdtempSync(path.join(os.homedir(), 'repos', 'ac-file-viewer-'));
const cwd = path.join(fixture, 'project');
fs.mkdirSync(cwd);
fs.writeFileSync(path.join(fixture, 'workspace.ts'), 'export const workspace = true;');
fs.writeFileSync(path.join(fixture, 'workspace.md'), '# Workspace report\n\n[Sibling source](./workspace.ts:1)\n');
fs.mkdirSync(path.join(cwd, 'scripts'));
fs.writeFileSync(path.join(cwd, 'scripts', 'nested.ts'), 'export const nested = true;');
fs.writeFileSync(path.join(cwd, 'scripts', 'report.md'), '# Usage audit\n\nReadable **report**.\n\n| Provider | Tokens |\n|---|---:|\n| Mock | 42 |\n\n```bash\necho "hello"\n```\n\n[Sibling source](../sample.ts:4)\n\n<script>window.__markdownExecuted = true</script>\n');
fs.mkdirSync(path.join(cwd, 'many'));
for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(cwd, 'many', `file${String(i).padStart(3, '0')}.ts`), 'export const a = true;');
fs.writeFileSync(path.join(cwd, 'codex-code-mode-host'), '#!/usr/bin/env bash\nset -euo pipefail\nif [[ -f "$HOME/.codex/config.toml" ]]; then\n  echo "hello"\nfi\n');
const png = await sharp({create: {width: 320, height: 200, channels: 4, background: '#7e8bd6'}}).png().toBuffer();
fs.writeFileSync(path.join(cwd, 'preview.png'), png);
fs.writeFileSync(path.join(fixture, 'workspace.png'), png);
const sample = path.join(cwd, 'sample.ts');
fs.writeFileSync(sample, Array.from({length: 100}, (_, n) => `export const line${n + 1} = ${n + 1};`).join('\n'));
fs.writeFileSync(path.join(cwd, 'unsafe.html'), '<script>window.__fileViewerExecuted = true</script>\n<img src=x onerror="window.__fileViewerExecuted = true">');
fs.writeFileSync(path.join(fixture, 'outside.txt'), 'OUTSIDE_CONTENT_MUST_NOT_APPEAR');
const links = [
  `[Absolute reference](${sample}:32)`,
  '[Relative reference](./sample.ts:65:4)',
  '[Hash range](sample.ts#L12-L14)',
  `[File URI](file://${sample}#L8)`,
  `[Home reference](~/${path.relative(os.homedir(), sample)}:9)`,
  '[Unsafe contents](./unsafe.html:2)',
  '[Bash helper](./codex-code-mode-host)',
  '[Nested reference](./scripts/nested.ts)',
  '[Project image](./preview.png)',
  '[Markdown report](./scripts/report.md)',
  '[Markdown line](./scripts/report.md:5)',
  '[Missing file](./missing.ts:2)',
  '[Outside project](../outside.txt)',
  '[External reference](https://example.com/reference)',
].join('\n\n');
const thread = {id: '22222222-2222-4222-8222-222222222222', provider: 'mock', model: 'echo', effort: 'medium', mode: 'plan', title: 'File viewer fixture', cwd, status: 'idle', cost: 0, createdAt: 1, updatedAt: 1};
fs.mkdirSync(path.join(data, 'logs'));
fs.writeFileSync(path.join(data, 'threads.json'), JSON.stringify([thread]));
fs.writeFileSync(path.join(data, 'commands.json'), '{}');
const imageId = '11111111-1111-4111-8111-111111111111';
const upload = path.join(data, 'uploads', thread.id, imageId); fs.mkdirSync(upload, {recursive: true}); fs.writeFileSync(path.join(upload, 'pasted.png'), png);
const attachment = {id: imageId, name: 'pasted.png', kind: 'image', media_type: 'image/png', size: png.length, n: 1};
const events = [
  {type: 'user_input', text: 'Pasted [Image #1] opens in viewer', attachments: [attachment]},
  ...Array.from({length: 5}, (_, i) => ({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: `Earlier message ${i}\n\n${'A paragraph that makes the conversation scroll. '.repeat(30)}`}]}})),
  {type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: links}]}},
];
fs.writeFileSync(path.join(data, 'logs', `${thread.id}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
process.env.AGENT_CONSOLE_DATA = data;
const {makeToken} = await import('../server/auth.ts');
const server = spawn(process.execPath, ['server/index.ts'], {
  env: {...process.env, PORT: port, AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_RUN: path.join(data, 'run'), AGENT_CONSOLE_PID_FILE: '', AGENT_CONSOLE_AUTH: 'password', AGENT_CONSOLE_MOCK: '1', AGENT_CONSOLE_HEADROOM: '0', AGENT_CONSOLE_LABELS: '0', AGENT_CONSOLE_ENV_FILES: '/dev/null'},
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverError = '';
server.stderr.on('data', b => { serverError += String(b); });
let browser: Browser | undefined;
const settled = async (page: Page) => {
  await page.waitForFunction(() => document.querySelector('#file-viewer[open]')?.getAttribute('aria-busy') === 'false');
  await page.locator('#file-viewer').evaluate(e => Promise.all(e.getAnimations().map(a => a.finished)));
};
const ref = (page: Page, label: string) => page.locator('#chat a').filter({hasText: new RegExp(`^${label}$`)});
const open = async (page: Page, label: string) => {
  await ref(page, label).click();
  await page.locator('#file-viewer[open]').waitFor();
  await settled(page);
};
const close = async (page: Page) => {
  await page.keyboard.press('Escape');
  await page.locator('#file-viewer[open]').waitFor({state: 'hidden'});
};
const screenshot = async (page: Page, name: string) => {
  if (!process.env.OUT) return;
  fs.mkdirSync(process.env.OUT, {recursive: true});
  await page.screenshot({path: path.join(process.env.OUT, name)});
};

try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`scratch server exited (${server.exitCode}): ${serverError}`);
    try { if ((await fetch(`${base}/login`)).ok) break; } catch {}
    if (i === 99) throw new Error('scratch server did not start');
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, colorScheme: 'dark', serviceWorkers: 'block'});
  await context.addCookies([{name: 'ac_session', value: makeToken(), url: base}]);
  await context.addInitScript(() => {
    (window as any).__heldIdle = [];
    (window as any).__csp = [];
    document.addEventListener("securitypolicyviolation", e => (window as any).__csp.push(e.violatedDirective));
    window.requestIdleCallback = ((fn: any) => { (window as any).__heldIdle.push(fn); return (window as any).__heldIdle.length; }) as any;
  });
  let releaseHistory: () => void = () => {};
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  let receivedHistory: () => void = () => {};
  const historySeen = new Promise<void>(resolve => { receivedHistory = resolve; });
  let holdHistory = true;
  await context.routeWebSocket('**/ws', socket => {
    const upstream = socket.connectToServer();
    upstream.onMessage(async raw => {
      if (holdHistory && JSON.parse(String(raw)).t === 'history') { receivedHistory(); await historyGate; }
      socket.send(raw);
    });
    socket.onMessage(raw => upstream.send(raw));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const fileRequests: string[] = [];
  page.on('request', req => { if (['/api/file', '/api/file-image'].includes(new URL(req.url()).pathname)) fileRequests.push(req.url()); });
  const treeRequests: string[] = [];
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/files') treeRequests.push(req.url()); });
  const assets: string[] = [];
  page.on('request', req => { const p = new URL(req.url()).pathname; if (/\/file-viewer\.(js|css)$/.test(p)) assets.push(p); });
  await page.goto(base);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('initial history not requested')), 10_000);
    historySeen.then(() => { clearTimeout(timeout); resolve(); });
  });
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  assert.deepEqual(assets, [], 'viewer assets never compete with initial history');
  holdHistory = false;
  releaseHistory();
  await ref(page, 'Absolute reference').waitFor();
  await page.waitForFunction(() => (window as any).__heldIdle.length > 0);
  assert.deepEqual(assets, [], 'warmup waits for idle after history rendered');
  await page.evaluate(() => (window as any).__heldIdle.splice(0).forEach((fn: any) => fn({didTimeout: false, timeRemaining: () => 50})));
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.endsWith('/file-viewer.js')) && performance.getEntriesByType('resource').some(e => e.name.endsWith('/file-viewer.css')));
  assert.deepEqual([...assets].sort(), ['/file-viewer.css', '/file-viewer.js']);
  assert.deepEqual(treeRequests, [], 'tree data never competes with startup or idle warmup');
  console.log('PASS file viewer: no viewer requests before history; JS/CSS warm only at idle');

  let releaseTree: () => void = () => {};
  const treeGate = new Promise<void>(resolve => { releaseTree = resolve; });
  let holdTree = true;
  await context.route('**/api/files?**', async route => { if (holdTree) await treeGate; await route.continue(); });
  await ref(page, 'Absolute reference').scrollIntoViewIfNeeded();
  await ref(page, 'Absolute reference').focus();
  const scrollBefore = await page.locator('#chat').evaluate(e => e.scrollTop);
  await open(page, 'Absolute reference');
  assert.equal(page.url(), base + '/', 'file click keeps the conversation URL');
  assert.equal(await context.pages().length, 1, 'file click creates no broken navigation tab');
  assert.equal(await page.locator('#file-viewer-title').textContent(), 'sample.ts');
  assert.equal(await page.locator('#file-viewer-path').textContent(), sample);
  assert.equal(await page.locator('.file-line[data-line="32"]').getAttribute('class').then(c => c?.includes('is-selected')), true);
  assert.equal(await page.locator('#file-viewer').getAttribute('aria-busy'), 'false', 'a delayed tree response cannot block file paint');
  assert.ok(await page.locator('.file-line').count() > 0, 'file content appears while tree is held');
  holdTree = false; releaseTree();
  await page.locator('.file-tree-entry').filter({hasText: 'sample.ts'}).waitFor();
  assert.ok(treeRequests.length > 0, 'tree loads only after first file opens');
  assert.equal(treeRequests.length, 1, 'root listing does not eagerly fetch every directory');
  const scriptFolder = page.locator('.file-tree-entry').filter({hasText: /^▸scripts$/});
  await scriptFolder.click();
  await page.locator('.file-tree-entry').filter({hasText: 'nested.ts'}).waitFor();
  assert.equal(treeRequests.length, 2, 'directory fetched only when expanded');
  await page.getByRole('button', {name: 'Performance', exact: true}).click();
  assert.match(await page.locator('#file-viewer-performance').textContent() || '', /open.*ms total/);
  await page.getByRole('button', {name: 'Performance', exact: true}).click();
  await screenshot(page, 'file-viewer-desktop-dark.png');
  await page.emulateMedia({colorScheme: 'light'});
  await screenshot(page, 'file-viewer-desktop-light.png');
  await page.emulateMedia({colorScheme: 'dark'});
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#file-viewer')), true, 'Tab stays inside modal');
  }
  await close(page);
  assert.equal(await ref(page, 'Absolute reference').evaluate(e => e === document.activeElement), true, 'Escape restores the clicked link focus');
  assert.ok(Math.abs(await page.locator('#chat').evaluate(e => e.scrollTop) - scrollBefore) <= 2, 'conversation scroll survives open/close');

  await open(page, 'Relative reference');
  assert.equal(await page.locator('.file-line.is-selected').getAttribute('data-line'), '65');
  assert.match(await page.locator('.file-viewer-position').textContent() || '', /65.*4/);
  const selectedBounds = await page.locator('.file-line.is-selected').boundingBox();
  const codeBounds = await page.locator('#file-viewer-code').boundingBox();
  assert.ok(selectedBounds && codeBounds && selectedBounds.y >= codeBounds.y && selectedBounds.y + selectedBounds.height <= codeBounds.y + codeBounds.height, 'requested line scrolls into the file viewport');
  await page.getByRole('button', {name: 'Wrap lines', exact: true}).click();
  assert.equal(await page.getByRole('button', {name: 'Wrap lines', exact: true}).getAttribute('aria-pressed'), 'true');
  await close(page);
  await open(page, 'Hash range');
  assert.deepEqual(await page.locator('.file-line.is-selected').evaluateAll(es => es.map(e => e.getAttribute('data-line'))), ['12', '13', '14']);
  await close(page);
  assert.equal(await ref(page, 'File URI').getAttribute('href'), '#', 'file URI survives sanitization only as a safe local reference');
  assert.equal(await ref(page, 'File URI').getAttribute('target'), null);
  await open(page, 'File URI');
  assert.equal(await page.locator('.file-line.is-selected').getAttribute('data-line'), '8');
  await close(page);
  await open(page, 'Home reference');
  assert.equal(await page.locator('.file-line.is-selected').getAttribute('data-line'), '9');
  assert.equal(await page.locator('#file-viewer-path').textContent(), sample);
  await close(page);
  console.log('PASS file viewer: absolute, relative, line/column, hash range, file URI; focus, Escape and chat scroll');

  await open(page, 'Bash helper');
  assert.match(await page.locator('#file-viewer-status').textContent() || '', /Bash/);
  assert.ok(await page.locator('#file-viewer-code .hljs-keyword, #file-viewer-code .hljs-built_in').count() > 0, 'extensionless env bash script is syntax highlighted');
  await close(page);
  await open(page, 'Nested reference');
  await page.locator('.file-tree-entry[aria-current="true"]').waitFor();
  assert.match(await page.locator('.file-tree-entry[aria-current="true"]').textContent() || '', /nested.ts/);
  await page.locator('.file-tree-entry').filter({hasText: 'sample.ts'}).click();
  await settled(page);
  assert.equal(await page.locator('#file-viewer-title').textContent(), 'sample.ts', 'tree files open in same viewer');
  await page.locator('.file-tree-entry').filter({hasText: /^▸many$/}).click();
  await page.getByRole('button', {name: 'Load more', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Load more', exact: true}).click();
  await page.locator('.file-tree-entry').filter({hasText: 'file204.ts'}).waitFor();
  await close(page);
  for (const selector of ['#chat .imgref', '#chat .imgs a']) {
    const beforeImageTrees = treeRequests.length;
    await page.locator(selector).click(); await settled(page);
    assert.equal(await page.locator('#file-viewer-code .file-viewer-image').count(), 1, await page.locator('#file-viewer-status').textContent() || 'image missing');
    assert.ok(await page.locator('.file-viewer-image').evaluate((img: HTMLImageElement) => img.naturalWidth > 0), 'preview image decoded successfully');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], 'authenticated blob image previews comply with CSP');
    assert.equal(context.pages().length, 1, 'image links create no tabs');
    assert.equal(page.url(), base + '/');
    await screenshot(page, selector.includes('imgref') ? 'file-viewer-image.png' : 'file-viewer-image-thumb.png');
    await close(page);
  }
  await open(page, 'Project image');
  assert.equal(await page.locator('#file-viewer-code .file-viewer-image').count(), 1, await page.locator('#file-viewer-status').textContent() || 'image missing');
  await close(page);
  console.log('PASS file viewer: extensionless Bash, image pills/thumbnails, project images, lazy tree navigation and pagination');

  await open(page, 'Markdown report');
  assert.equal(await page.locator('#file-viewer-code h1').textContent(), 'Usage audit');
  assert.equal(await page.locator('#file-viewer-code table tbody td').first().textContent(), 'Mock');
  assert.ok(await page.locator('#file-viewer-code .hljs-built_in').count() > 0, 'rendered Markdown code blocks remain highlighted');
  assert.equal(await page.locator('#file-viewer-code script').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).__markdownExecuted), undefined, 'rendered Markdown is sanitized');
  await screenshot(page, 'file-viewer-markdown.png');
  await page.getByRole('button', {name: 'Source', exact: true}).click();
  assert.equal(await page.getByRole('button', {name: 'Source', exact: true}).getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#file-viewer-code').textContent() || '', /# Usage audit/);
  await page.getByRole('button', {name: 'Source', exact: true}).click();
  const sibling = page.locator('#file-viewer-code a').filter({hasText: 'Sibling source'});
  await page.locator('#file-viewer-code').focus();
  for (let i = 0; i < 12 && !await sibling.evaluate(e => e === document.activeElement); i++) await page.keyboard.press('Tab');
  assert.equal(await sibling.evaluate(e => e === document.activeElement), true, 'rendered document links are keyboard reachable inside the modal');
  await page.keyboard.press('Enter');
  await settled(page);
  assert.equal(await page.locator('#file-viewer-title').textContent(), 'sample.ts', 'preview links resolve relative to the Markdown file');
  assert.equal(await page.locator('.file-line.is-selected').getAttribute('data-line'), '4');
  await close(page);
  await open(page, 'Markdown line');
  assert.equal(await page.getByRole('button', {name: 'Source', exact: true}).getAttribute('aria-pressed'), 'true', 'line references open Markdown source');
  assert.equal(await page.locator('.file-line.is-selected').getAttribute('data-line'), '5');
  await close(page);
  console.log('PASS file viewer: rendered Markdown, safe headings/tables/code, source toggle and document-relative line links');

  await open(page, 'Unsafe contents');
  assert.match(await page.locator('#file-viewer-code').textContent() || '', /<script>window\.__fileViewerExecuted/);
  assert.equal(await page.locator('#file-viewer script, #file-viewer img').count(), 0, 'source is rendered as escaped text');
  assert.equal(await page.evaluate(() => (window as any).__fileViewerExecuted), undefined);
  await close(page);
  await open(page, 'Missing file');
  assert.match(await page.locator('#file-viewer-status').textContent() || '', /not found|does not exist|no longer exists|no such file/i);
  assert.equal(await page.getByRole('button', {name: 'Retry', exact: true}).isVisible(), true);
  fs.writeFileSync(path.join(cwd, 'missing.ts'), 'export const recovered = true;');
  await page.getByRole('button', {name: 'Retry', exact: true}).click();
  await settled(page);
  assert.match(await page.locator('#file-viewer-code').textContent() || '', /export const recovered = true/);
  await close(page);
  await open(page, 'Outside project');
  assert.match(await page.locator('#file-viewer-status').textContent() || '', /outside|not allowed|within|folder|project/i);
  assert.equal((await page.locator('#file-viewer').textContent())?.includes('OUTSIDE_CONTENT_MUST_NOT_APPEAR'), false);
  await close(page);
  await context.route('https://example.com/reference', route => route.fulfill({body: 'external fixture', contentType: 'text/plain'}));
  assert.equal(await ref(page, 'External reference').getAttribute('target'), '_blank');
  const popupPromise = page.waitForEvent('popup');
  await ref(page, 'External reference').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), 'https://example.com/reference');
  assert.equal(await page.locator('#file-viewer[open]').count(), 0);
  await popup.close();
  assert.deepEqual(errors, []);
  console.log('PASS file viewer: executable HTML escaped, missing/outside errors, external links unchanged');

  const workspaceEntry = (p: Page, name: string) => p.locator('.file-tree-entry').filter({hasText: new RegExp(`^[▸▾·]${name.replaceAll('.', '\\.')}$$`)});
  const openWorkspace = async (p: Page) => {
    await p.locator('#files').click(); await settled(p);
    assert.equal(await p.locator('#file-viewer-title').textContent(), 'Files');
    assert.equal(await p.locator('#file-viewer-path').textContent(), '~/repos');
    assert.equal(await p.locator('#file-viewer-code').textContent(), 'Select a file to preview.');
    assert.equal(await p.locator('#file-viewer-tree').isVisible(), true);
    assert.equal(await p.getByRole('button', {name: 'Copy file', exact: true}).isDisabled(), true);
    assert.equal(await p.locator('.file-tree-entry[aria-current]').count(), 0);
  };
  await screenshot(page, 'sidebar-files-desktop.png');
  const beforeWorkspaceFiles = fileRequests.length;
  await openWorkspace(page);
  await workspaceEntry(page, path.basename(fixture)).waitFor();
  assert.equal(fileRequests.length, beforeWorkspaceFiles, 'sidebar browser does not choose a file');
  assert.equal(new URL(treeRequests.at(-1)!).searchParams.get('scope'), 'repos');
  assert.equal(new URL(treeRequests.at(-1)!).searchParams.has('thread'), false);
  await screenshot(page, 'sidebar-files-empty-desktop.png');
  await workspaceEntry(page, path.basename(fixture)).click();
  await workspaceEntry(page, 'workspace.md').click(); await settled(page);
  assert.equal(await page.locator('#file-viewer-code h1').textContent(), 'Workspace report');
  await page.locator('#file-viewer-code a').filter({hasText: 'Sibling source'}).click(); await settled(page);
  assert.equal(await page.locator('#file-viewer-title').textContent(), 'workspace.ts');
  assert.equal(new URL(fileRequests.at(-1)!).searchParams.get('scope'), 'repos', 'Markdown sibling navigation keeps workspace scope');
  await workspaceEntry(page, 'workspace.png').click(); await settled(page);
  assert.equal(await page.locator('#file-viewer-code .file-viewer-image').count(), 1);
  assert.equal(new URL(fileRequests.at(-1)!).searchParams.get('scope'), 'repos', 'image download keeps workspace scope');
  await close(page);
  const afterWorkspaceFiles = fileRequests.length;
  await openWorkspace(page);
  assert.equal(fileRequests.length, afterWorkspaceFiles, 'reopening clears image without reloading it');
  await close(page);
  await open(page, 'Outside project');
  assert.match(await page.locator('#file-viewer-status').textContent() || '', /outside|not allowed|within|folder|project/i, 'chat scope remains narrow after workspace browsing');
  await close(page);
  assert.equal(await page.locator('#threads > li:not(.empty-list)').count(), 1, 'Files never creates a thread');
  console.log('PASS sidebar Files: fixed repos root from narrow thread, blank each click, no automatic file read, Markdown/image navigation and unchanged chat scope');

  const mobile = await context.newPage();
  const mobileAssets: string[] = [];
  mobile.on('request', req => { if (/\/file-viewer\.(js|css)$/.test(new URL(req.url()).pathname)) mobileAssets.push(req.url()); });
  await mobile.setViewportSize({width: 390, height: 844});
  await mobile.goto(base);
  await ref(mobile, 'Relative reference').waitFor();
  assert.deepEqual(mobileAssets, [], 'viewer can stay unloaded until a link is opened');
  await open(mobile, 'Relative reference');
  assert.equal(mobileAssets.length, 2, 'a click loads the viewer even before idle warmup');
  const bounds = await mobile.locator('#file-viewer').boundingBox();
  assert.equal(await mobile.locator('#file-viewer-tree').isVisible(), false, 'mobile files start collapsed');
  await mobile.getByRole('button', {name: 'Show files', exact: true}).click();
  await mobile.locator('.file-tree-entry').filter({hasText: 'sample.ts'}).waitFor();
  assert.equal(await mobile.locator('#file-viewer-tree').isVisible(), true);
  await screenshot(mobile, 'file-viewer-mobile-tree.png');
  await mobile.getByRole('button', {name: 'Hide files', exact: true}).click();
  assert.equal(await mobile.locator('#file-viewer-tree').isVisible(), false);
  await screenshot(mobile, 'file-viewer-mobile.png');
  assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845, `modal fits the mobile viewport: ${JSON.stringify(bounds)}`);
  assert.equal(await mobile.getByRole('button', {name: 'Close file viewer', exact: true}).isVisible(), true);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'file view creates no page overflow');
  await mobile.getByRole('button', {name: 'Close file viewer', exact: true}).click();
  await mobile.locator('#file-viewer[open]').waitFor({state: 'hidden'});
  console.log('PASS file viewer: mobile modal fits, tree toggles, close is reachable, no page overflow');
  await mobile.locator('#menu').click();
  await screenshot(mobile, 'sidebar-files-mobile.png');
  await openWorkspace(mobile);
  await workspaceEntry(mobile, path.basename(fixture)).waitFor();
  await screenshot(mobile, 'sidebar-files-empty-mobile.png');
  await workspaceEntry(mobile, path.basename(fixture)).click();
  await workspaceEntry(mobile, 'workspace.ts').click(); await settled(mobile);
  assert.equal(await mobile.locator('#file-viewer-title').textContent(), 'workspace.ts');
  await close(mobile);
  await mobile.locator('#menu').click(); await openWorkspace(mobile); await close(mobile);
  console.log('PASS sidebar Files: mobile entry shows tree, file selection works and next entry is blank');
  await page.waitForTimeout(5200);
  const samples = await page.evaluate(async () => (await fetch('/api/latency')).json());
  assert.ok(samples.groups.viewer_open, 'viewer open timings persisted to same-server latency API');
  assert.ok(samples.groups.viewer_tree, 'tree timings persisted');
  assert.ok(samples.groups.viewer_module, 'lazy module timings persisted');
  const local = await page.evaluate(() => (window as any).agentConsoleViewerMetrics);
  assert.ok(local.length <= 30 && local.length > 0);
  assert.ok(local.every((m: any) => !('path' in m) && !('content' in m)), 'metrics exclude file paths and contents');
  assert.ok(samples.groups['viewer_tree/workspace/desktop/visible'], 'workspace timings persist without using thread scope');
  console.log('PASS file viewer: bounded local diagnostics and persisted viewer timings');
  // Remove only this scratch thread, then prove the browser works in a genuinely empty installation.
  await page.evaluate(async id => {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.t === 'hello') socket.send(JSON.stringify({t: 'delete', thread: id}));
        if (message.t === 'removed') { socket.close(); resolve(); }
      };
      socket.onerror = () => reject(new Error('scratch delete socket failed'));
    });
  }, thread.id);
  const emptyContext = await browser.newContext({viewport: {width: 1280, height: 900}, serviceWorkers: 'block'});
  await emptyContext.addCookies([{name: 'ac_session', value: makeToken(), url: base}]);
  await emptyContext.addInitScript(() => { window.requestIdleCallback = (() => 1) as any; });
  const empty = await emptyContext.newPage();
  const emptyRequests: string[] = [];
  empty.on('request', req => { if (/file-viewer|\/api\/files?/.test(new URL(req.url()).pathname)) emptyRequests.push(req.url()); });
  await empty.goto(base);
  await empty.locator('#chat .empty').waitFor();
  assert.equal(await empty.locator('#threads > li:not(.empty-list)').count(), 0);
  assert.deepEqual(emptyRequests, [], 'empty installation keeps viewer unloaded');
  await openWorkspace(empty);
  await workspaceEntry(empty, path.basename(fixture)).waitFor();
  assert.ok(emptyRequests.some(url => new URL(url).pathname === '/api/files'));
  assert.ok(!emptyRequests.some(url => ['/api/file', '/api/file-image'].includes(new URL(url).pathname)));
  await workspaceEntry(empty, path.basename(fixture)).click();
  await workspaceEntry(empty, 'workspace.ts').click(); await settled(empty);
  assert.equal(await empty.locator('#file-viewer-title').textContent(), 'workspace.ts');
  assert.equal(await empty.locator('#threads > li:not(.empty-list)').count(), 0);
  await close(empty); await openWorkspace(empty); await screenshot(empty, 'sidebar-files-empty-no-threads.png');
  await emptyContext.close();
  console.log('PASS sidebar Files: zero threads, lazy assets/tree, blank startup and scoped file navigation without creating threads');
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
