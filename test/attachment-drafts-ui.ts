// Binary drafts must survive navigation and interrupted uploads without sending partial messages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import zlib from 'node:zlib';
import type {Browser, BrowserContext, Page, Route} from 'playwright';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-attachment-drafts-'));
const port = Number(process.env.ATTACHMENT_DRAFTS_UI_PORT || 7074), base = `http://127.0.0.1:${port}`;
const ids = ['a10c801e-893e-4d42-b1df-f57eced19ad1', 'b20c801e-893e-4d42-b1df-f57eced19ad2'];
const out = process.env.OUT;
if (out) fs.mkdirSync(out, {recursive: true});
fs.mkdirSync(path.join(data, 'uploads'));
fs.mkdirSync(path.join(data, 'logs'));
fs.writeFileSync(path.join(data, 'threads.json'), JSON.stringify(ids.map((id, i) => ({id, provider: 'mock', model: 'echo', mode: 'acceptEdits', title: `Attachment draft ${i + 1}`, cwd: os.tmpdir(), status: 'idle', cost: 0, createdAt: 2 - i, updatedAt: 2 - i}))));
for (const id of ids) fs.writeFileSync(path.join(data, 'logs', `${id}.jsonl`), JSON.stringify({type: 'user_input', text: 'fixture'}) + '\n');
process.env.AGENT_CONSOLE_DATA = data;
const server = spawn(process.execPath, ['server/index.ts'], {env: {...process.env, PORT: String(port), AGENT_CONSOLE_MOCK: '1', AGENT_CONSOLE_WARM_MAX: '0', AGENT_CONSOLE_RUN: path.join(data, 'run'), AGENT_CONSOLE_BRAIN: path.join(data, 'no-brain')}, stdio: ['ignore', 'pipe', 'pipe']});
// The server boots in its own process while this one loads Playwright and starts both browsers.
const listening = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Scratch server did not start')), 15000);
  server.stdout.on('data', chunk => {if (String(chunk).includes('agent-console listening')) {clearTimeout(timer); resolve();}});
  server.once('exit', code => {clearTimeout(timer); reject(new Error(`Scratch server exited: ${code}`));});
});
listening.catch(() => {});
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let context: BrowserContext | undefined;
let restartContext: BrowserContext | undefined;
let restarting: Promise<void> | undefined;
const errors: string[] = [];
const sent: any[] = [];
const videos: string[] = [];
try {
  const [{makeToken}, {chromium}] = await Promise.all([import('../server/auth.ts'), import('playwright')]);
  launching = chromium.launch();
  launching.catch(() => {});
  let holdSend = false;
  const configureSocket = (current: BrowserContext) => current.routeWebSocket('**/ws', socket => {
    const upstream = socket.connectToServer();
    upstream.onMessage(raw => socket.send(raw));
    socket.onMessage(raw => {
      if (!(holdSend && JSON.parse(String(raw)).t === 'send')) upstream.send(raw);
    });
  });
  const options = {viewport: {width: 1280, height: 900}, serviceWorkers: 'block' as const, ...(out ? {recordVideo: {dir: out, size: {width: 1280, height: 900}}} : {})};
  const profile = path.join(data, 'browser-profile');
  const openPersistent = async () => {
    const opened = restartContext = await chromium.launchPersistentContext(profile, {...options, headless: true});
    opened.setDefaultTimeout(7000);
    await configureSocket(opened);
    await opened.addCookies([{name: 'ac_session', value: makeToken(), url: base}]);
    return opened;
  };
  const restartOpening = openPersistent();
  restartOpening.catch(() => {});
  await listening;
  browser = await launching;
  context = await browser.newContext(options);
  context.setDefaultTimeout(7000);
  await configureSocket(context);
  await context.addCookies([{name: 'ac_session', value: makeToken(), url: base}]);
  let page: Page;
  const track = (next: Page) => {
    next.on('pageerror', error => errors.push(error.message));
    next.on('websocket', socket => socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.t === 'send') sent.push(message);
    }));
  };
  const watch = (next: Page) => {
    page = next;
    track(next);
  };
  watch(await context.newPage());
  // Composer readiness is the assertion; unrelated resource loading must not delay navigation.
  const navigation = {waitUntil: 'domcontentloaded' as const, timeout: 15000};
  // Timer polling: the default requestAnimationFrame polling keeps Chromium rendering frames for the whole wait.
  const poll = {polling: 25};
  // Both flows drive the same composer helpers; each one binds them to its own current page.
  const composer = (current: () => Page) => {
    const ready = () => current().waitForFunction(() => !(document.getElementById('input') as any)?.disabled && Boolean(document.getElementById('ttl')?.textContent), undefined, poll);
    const thread = async (index: number) => {
      const row = current().locator('#threads li .t', {hasText: `Attachment draft ${index + 1}`});
      if (await row.count()) await row.click();
      else await current().evaluate(id => {location.hash = `thread=${id}`;}, ids[index]);
      await current().waitForFunction(id => localStorage.getItem('ac_thread') === id, ids[index], poll);
    };
    const value = () => current().locator('#input').evaluate((element: any) => element.value);
    const attachmentOrder = () => current().locator('#thumbs .rm').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
    const settled = (count: number) => current().waitForFunction(n => document.querySelectorAll('#thumbs li').length === n && !document.querySelector('#thumbs [aria-busy="true"]'), count, poll);
    const stored = (threadId: string, count: number, needsBlob = false) => current().waitForFunction(async ({threadId, count, needsBlob}) => {
      const rows: any[] = await new Promise((resolve, reject) => {
        const open = indexedDB.open('ac_composer', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, transaction = db.transaction('attachments');
          const request = transaction.objectStore('attachments').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => db.close();
        };
      });
      const own = rows.filter(row => row.thread === threadId);
      return own.length === count && (!needsBlob || own.some(row => row.blob instanceof Blob && row.blob.size > 0));
    }, {threadId, count, needsBlob}, {polling: 50});
    return {ready, thread, value, attachmentOrder, settled, stored};
  };
  const {ready, thread, value, attachmentOrder, settled, stored} = composer(() => page);
  const file = (name: string, text: string) => ({name, mimeType: 'text/plain', buffer: Buffer.from(text)});
  // A flat 120x80 PNG encoded with zlib, so the test does not load sharp's native library just for a fixture.
  const png = (width: number, height: number, [red, green, blue]: number[]) => {
    const chunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8), crc = Buffer.alloc(4);
      head.writeUInt32BE(body.length); head.write(type, 4);
      crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])));
      return Buffer.concat([head, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({length: width}, () => [red, green, blue]).flat())]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({length: height}, () => row)))), chunk('IEND', Buffer.alloc(0))]);
  };
  const image = {name: 'draft-image.png', mimeType: 'image/png', buffer: png(120, 80, [0x33, 0x99, 0xff])};
  // A real browser restart (persistent profile, no storageState) touches nothing the main flow does in its own browser, so it runs beside it.
  const restartFlow = async () => {
    let restartPage!: Page;
    const bound = composer(() => restartPage);
    const open = async (opening: Promise<BrowserContext>) => {
      const reopened = await opening;
      restartPage = reopened.pages()[0] || await reopened.newPage();
      track(restartPage);
      return reopened;
    };
    let restarted = await open(restartOpening);
    await restartPage.goto(base, navigation); await bound.ready(); await bound.thread(0);
    await restartPage.fill('#input', 'Draft survives a complete browser restart');
    await restartPage.locator('#file').setInputFiles([file('browser-restart.txt', 'persistent browser attachment'), file('browser-restart-second.txt', 'second persistent browser attachment')]);
    await bound.settled(2); await bound.stored(ids[0], 2);
    const persistentOrder = ['Remove browser-restart.txt', 'Remove browser-restart-second.txt'];
    assert.deepEqual(await bound.attachmentOrder(), persistentOrder, 'persistent browser starts with insertion order');
    const persistentVideo = restartPage.video();
    await restarted.close(); restartContext = undefined;
    if (persistentVideo) videos.push(await persistentVideo.path());
    restarted = await open(openPersistent());
    await restartPage.goto(base, navigation); await bound.ready(); await bound.thread(0); await bound.settled(2);
    assert.equal(await bound.value(), 'Draft survives a complete browser restart', 'real browser restart preserves text without storageState');
    assert.equal(await restartPage.getByRole('button', {name: 'Remove browser-restart.txt', exact: true}).count(), 1, 'real browser restart preserves uploaded attachment without storageState');
    assert.deepEqual(await bound.attachmentOrder(), persistentOrder, 'real browser restart preserves attachment order');
    assert.deepEqual(errors, []);
    const reopenedVideo = restartPage.video();
    await restarted.close(); restartContext = undefined;
    if (reopenedVideo) videos.push(await reopenedVideo.path());
  };
  restarting = restartFlow();
  restarting.catch(() => {});
  await page.goto(base, navigation); await ready(); await thread(0);
  await page.fill('#input', 'First draft\n  keep whitespace  ');
  await page.locator('#file').setInputFiles([file('first.txt', 'first attachment'), image]);
  await settled(2); await stored(ids[0], 2);
  const firstOrder = ['Remove first.txt', 'Remove draft-image.png'];
  assert.deepEqual(await attachmentOrder(), firstOrder, 'attachments retain insertion order');
  const first = await value();
  assert.match(first, /\[Image #1\]/, 'image label is inserted');
  assert.equal(await page.locator('#thumbs img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), true, 'image preview decodes');
  await thread(1);
  await page.fill('#input', 'Second draft');
  await page.locator('#file').setInputFiles(file('second.txt', 'second attachment'));
  await settled(1); await stored(ids[1], 1);
  await thread(0); await settled(2);
  assert.equal(await value(), first, 'thread switch restores exact text');
  await page.reload(navigation); await ready(); await thread(0); await settled(2);
  assert.equal(await value(), first, 'reload restores text and attachments');
  assert.deepEqual(await attachmentOrder(), firstOrder, 'reload preserves attachment order');
  const saved = await context.storageState({indexedDB: true});
  const firstVideo = page.video();
  await context.close();
  if (firstVideo) videos.push(await firstVideo.path());
  context = await browser.newContext({...options, storageState: saved});
  context.setDefaultTimeout(7000);
  await configureSocket(context);
  watch(await context.newPage());
  await page.goto(base, navigation); await ready(); await thread(0); await settled(2);
  assert.equal(await value(), first, 'closed browser context restores draft');
  assert.deepEqual(await attachmentOrder(), firstOrder, 'closed browser context preserves attachment order');
  assert.equal(await page.locator('#thumbs img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), true, 'restored image preview loads');
  await page.getByRole('button', {name: 'Remove first.txt', exact: true}).click();
  await settled(1); await stored(ids[0], 1); await stored(ids[1], 1);
  await page.reload(navigation); await ready(); await thread(0); await settled(1);
  assert.equal(await page.getByRole('button', {name: 'Remove first.txt', exact: true}).count(), 0, 'removed attachment stays removed');
  await page.click('#send');
  await page.waitForFunction(() => (document.getElementById('input') as any).value === '', undefined, poll);
  await settled(0); await stored(ids[0], 0); await stored(ids[1], 1);
  await thread(1); await settled(1);
  assert.equal(await value(), 'Second draft', 'sending clears only its own thread');

  let failUpload = true;
  // A route makes every request in the context round-trip through this process, so each one is removed once its step is done.
  const failPattern = `**/uploads/${ids[1]}`;
  const failHandler = async (route: Route) => {
    if (route.request().method() === 'POST' && decodeURIComponent(route.request().headers()['x-name'] || '') === 'retry.txt' && failUpload) {
      await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Fixture upload failure'})});
    } else await route.continue();
  };
  await context.route(failPattern, failHandler);
  await page.locator('#file').setInputFiles(file('retry.txt', 'retry attachment'));
  await page.getByRole('button', {name: 'Retry retry.txt', exact: true}).waitFor();
  await stored(ids[1], 2, true);
  const beforeFailureSend = sent.length;
  await page.click('#send');
  await page.getByText('Retry or remove failed attachments before sending.', {exact: true}).waitFor();
  assert.equal(sent.length, beforeFailureSend, 'failed attachment blocks partial sends');
  assert.equal(await value(), 'Second draft', 'failed send retains text');
  await page.reload(navigation); await ready(); await thread(1);
  await page.getByRole('button', {name: 'Retry retry.txt', exact: true}).waitFor();
  assert.equal(await value(), 'Second draft', 'failed upload draft survives reload');
  failUpload = false;
  await page.getByRole('button', {name: 'Retry retry.txt', exact: true}).click();
  await settled(2);
  assert.equal(await page.getByRole('button', {name: 'Retry retry.txt', exact: true}).count(), 0, 'retry succeeds with original bytes');
  await page.click('#send'); await settled(0); await stored(ids[1], 0);
  const secondSend = sent.filter(message => message.thread === ids[1]).at(-1);
  assert.equal(secondSend?.attachments.length, 2, 'successful retry sends both attachments');
  await context.unroute(failPattern, failHandler);

  await thread(0);
  await page.fill('#input', 'Resume interrupted upload');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  let blockUpload = true;
  const blockPattern = `**/uploads/${ids[0]}`;
  const blockHandler = async (route: Route) => {
    if (route.request().method() === 'POST' && blockUpload) await blocked;
    await route.continue().catch(() => {});
  };
  await context.route(blockPattern, blockHandler);
  const requested = page.waitForRequest(request => request.method() === 'POST' && request.url() === `${base}/uploads/${ids[0]}`, {timeout: 7000});
  await page.locator('#file').setInputFiles(file('resume.txt', 'persist these interrupted bytes'));
  await requested; await stored(ids[0], 1, true);
  assert.equal(await page.locator('#thumbs li[aria-busy="true"]').count(), 1, 'interrupted upload is still pending');
  blockUpload = false;
  const reloaded = page.reload(navigation);
  await ready().catch(() => {});
  await reloaded;
  release();
  await ready(); await thread(0); await settled(1);
  assert.equal(await value(), 'Resume interrupted upload', 'interrupted upload retains prompt');
  const resumed = fs.readdirSync(path.join(data, 'uploads', ids[0])).flatMap(entry => {
    const location = path.join(data, 'uploads', ids[0], entry);
    return fs.statSync(location).isDirectory() ? fs.readdirSync(location).map(name => path.join(location, name)) : [location];
  }).some(location => fs.readFileSync(location, 'utf8') === 'persist these interrupted bytes');
  assert.equal(resumed, true, 'resumed upload preserves exact stored Blob bytes');
  await context.unroute(blockPattern, blockHandler);
  await page.getByRole('button', {name: 'Remove resume.txt', exact: true}).click();
  await settled(0); await stored(ids[0], 0);
  await page.fill('#input', '');
  await page.reload(navigation); await ready(); await thread(0); await settled(0);
  assert.equal(await value(), '', 'explicit clear survives reload');
  await page.fill('#input', 'Recover unacknowledged message');
  await page.locator('#file').setInputFiles([file('unacknowledged.txt', 'recover this uploaded file'), image]);
  await settled(2);
  const unacknowledged = await value();
  holdSend = true;
  await page.click('#send');
  await page.waitForFunction(() => (document.getElementById('input') as any).value === '', undefined, poll);
  await settled(0);
  const originalRecoveryCopy = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('ac_sending:'))!;
    return {key, value: localStorage.getItem(key)!};
  });
  await page.fill('#input', 'Later unacknowledged message');
  await page.locator('#file').setInputFiles({...image, name: 'later-image.png'});
  await settled(1);
  const later = await value();
  await page.click('#send');
  await page.waitForFunction(() => (document.getElementById('input') as any).value === '', undefined, poll);
  await settled(0);
  await page.reload(navigation); await ready(); await thread(0); await settled(3);
  assert.equal(await value(), `${unacknowledged.replace('[Image #1]', '[Image #2]')}\n\n${later}`, 'held sends recover chronologically with unique image labels');
  assert.equal(await page.getByRole('button', {name: 'Remove unacknowledged.txt', exact: true}).count(), 1, 'unacknowledged send restores uploaded file');
  await page.waitForFunction(() => {
    const image = document.querySelector('#thumbs img') as HTMLImageElement | null;
    return image?.complete && image.naturalWidth > 0;
  }, undefined, poll);
  assert.deepEqual((await page.locator('#thumbs .n').allTextContents()).sort(), ['1', '2'], 'recovered images have distinct attachment labels');
  assert.deepEqual(await attachmentOrder(), ['Remove unacknowledged.txt', 'Remove draft-image.png', 'Remove later-image.png'], 'held sends recover attachment insertion order');
  await stored(ids[0], 3);
  const recoveredText = await value();
  await page.evaluate(({key, value}) => localStorage.setItem(key, value), originalRecoveryCopy);
  await page.reload(navigation); await ready(); await thread(0); await settled(3);
  assert.equal(await value(), recoveredText, 'interrupted recovery cleanup remains idempotent after image renumbering');
  assert.deepEqual(await attachmentOrder(), ['Remove unacknowledged.txt', 'Remove draft-image.png', 'Remove later-image.png'], 'repeated recovery keeps attachment order and does not duplicate attachments');
  assert.deepEqual((await page.locator('#thumbs .n').allTextContents()).sort(), ['1', '2'], 'repeated recovery keeps remapped image labels');
  holdSend = false;
  assert.deepEqual(errors, []);
  if (out) {
    await page.screenshot({path: path.join(out, 'attachment-drafts-restored-desktop.png')});
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForFunction(() => getComputedStyle(document.getElementById('side')!).visibility === 'hidden', undefined, poll);
    await page.screenshot({path: path.join(out, 'attachment-drafts-restored-narrow.png')});
    await page.setViewportSize({width: 1280, height: 900});
  }
  const stale = await page.evaluate(async () => new Promise<any>((resolve, reject) => {
    const open = indexedDB.open('ac_composer', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, transaction = db.transaction('attachments');
      const request = transaction.objectStore('attachments').getAll();
      request.onsuccess = () => resolve(request.result.find(row => row.id));
      transaction.oncomplete = () => db.close();
    };
  }));
  while (await page.locator('#thumbs .rm').count()) await page.locator('#thumbs .rm').first().click();
  await page.fill('#input', '');
  await stored(ids[0], 0);
  await page.evaluate(async ({stale, threadId}) => {
    localStorage.setItem('ac_sending:accepted-fixture', JSON.stringify({thread: threadId, text: 'Accepted message must not restore', attachments: [stale], accepted: true, createdAt: Date.now(), sequence: 1}));
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('ac_composer', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction('attachments', 'readwrite');
        transaction.objectStore('attachments').put(stale);
        transaction.oncomplete = () => {db.close(); resolve();};
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, {stale, threadId: ids[0]});
  await stored(ids[0], 1);
  await page.reload(navigation); await ready(); await thread(0); await settled(0); await stored(ids[0], 0);
  assert.equal(await value(), '', 'accepted receipt prevents stale attachment resurrection');
  assert.equal(await page.evaluate(() => localStorage.getItem('ac_sending:accepted-fixture')), null, 'accepted receipt is removed after stale rows are deleted');
  assert.deepEqual(errors, []);
  const finalVideo = page.video();
  await context.close(); context = undefined;
  if (finalVideo) videos.push(await finalVideo.path());
  await browser.close(); browser = launching = undefined;
  await restarting; restarting = undefined;
  console.log('PASS attachment drafts: thread isolation, image preview, reload, real browser restart, remove/send, failed-upload retry, interrupted-upload recovery, chronological unacknowledged sends, accepted receipt cleanup');
  if (videos.length) console.log(`Videos: ${videos.join(', ')}`);
} finally {
  await restartContext?.close().catch(() => {});
  await restarting?.catch(() => {});
  await context?.close();
  browser ??= await launching?.catch(() => undefined);
  await browser?.close();
  if (server.exitCode === null) {const exited = once(server, 'exit'); server.kill(); await exited;}
  fs.rmSync(data, {recursive: true, force: true});
}
