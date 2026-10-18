// Isolated browser regression for Acode launch and the public capability boundary.
// Run: rtk test node test/acode-ui.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium, type Browser} from 'playwright';

const base = 'http://127.0.0.1:7075';
const bridge = 'http://127.0.0.1:7086';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-acode-data-'));
const cwd = fs.mkdtempSync(path.join(os.homedir(), 'repos', 'ac-acode-ui-'));
fs.writeFileSync(path.join(cwd, 'first.ts'), 'export const first = 1;\n'.repeat(10));
fs.writeFileSync(path.join(cwd, 'second.md'), '# Second file\n');
fs.writeFileSync(path.join(cwd, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDV8AAAAASUVORK5CYII=', 'base64'));
const thread = {id: '33333333-3333-4333-8333-333333333333', provider: 'mock', model: 'echo', effort: 'medium', mode: 'plan', title: 'Acode fixture', cwd, status: 'idle', cost: 0, createdAt: 1, updatedAt: 1};
fs.mkdirSync(path.join(data, 'logs'));
fs.writeFileSync(path.join(data, 'threads.json'), JSON.stringify([thread]));
fs.writeFileSync(path.join(data, 'commands.json'), '{}');
fs.writeFileSync(path.join(data, 'logs', `${thread.id}.jsonl`), JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: '[First](./first.ts:4:3)\n\n[Second](./second.md)\n\n[Image](./image.png)'}]}}) + '\n');
process.env.AGENT_CONSOLE_DATA = data;
const {makeToken} = await import('../server/auth.ts');
const session = makeToken();
const server = spawn(process.execPath, ['server/index.ts'], {env: {...process.env, PORT: '7075', AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_RUN: path.join(data, 'run'), AGENT_CONSOLE_PID_FILE: '', AGENT_CONSOLE_AUTH: 'password', AGENT_CONSOLE_MOCK: '1', AGENT_CONSOLE_HEADROOM: '0', AGENT_CONSOLE_LABELS: '0', AGENT_CONSOLE_ENV_FILES: '/dev/null', AGENT_CONSOLE_ACODE_TEST: '1', AGENT_CONSOLE_ACODE_URL: 'https://bridge.example.test/', AGENT_CONSOLE_ACODE_PORT: '7086'}, stdio: ['ignore', 'ignore', 'pipe']});
let serverError = '';
server.stderr.on('data', bytes => {serverError += String(bytes);});
let browser: Browser | undefined;
try {
  // Startup retry is bounded; this process owns both isolated listeners.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const probe = async () => {
      if (server.exitCode !== null) return reject(new Error(`scratch server exited: ${serverError}`));
      try {if ((await fetch(`${base}/login`)).ok) return resolve();} catch {}
      if (Date.now() > deadline) return reject(new Error(`scratch startup timed out: ${serverError}`));
      setTimeout(probe, 100);
    };
    void probe();
  });
  browser = await chromium.launch();
  const context = await browser.newContext({serviceWorkers: 'block'});
  await context.addCookies([{name: 'ac_session', value: session, url: base}]);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const requests: string[] = [];
  page.on('request', request => {if (request.url().includes('/api/acode/')) requests.push(request.url());});
  await page.goto(base);
  const ref = (name: string) => page.locator('#chat a').filter({hasText: new RegExp(`^${name}$`)});
  await ref('First').waitFor();
  assert.deepEqual(requests, [], 'Acode makes no startup requests');
  const edit = page.locator('#file-viewer-edit');
  const open = async (name: string) => {
    await ref(name).click();
    await page.waitForFunction(() => document.querySelector('#file-viewer[open]')?.getAttribute('aria-busy') === 'false');
  };
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('#file-viewer-edit')?.getAttribute('href')?.startsWith('acode://'));
    const href = (await edit.getAttribute('href'))!;
    assert.ok(href.startsWith('acode://agent-console/edit/'));
    return {href, payload: JSON.parse(decodeURIComponent(href.slice('acode://agent-console/edit/'.length)))};
  };
  await open('First');
  assert.equal(await edit.textContent(), 'Edit');
  const first = await ready();
  assert.deepEqual(Object.keys(first.payload).sort(), ['column', 'endpoint', 'line', 'ticket']);
  assert.equal(first.payload.endpoint, 'https://bridge.example.test');
  assert.match(first.payload.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.payload.line, 4);
  assert.equal(first.payload.column, 3);
  assert.ok(!first.href.includes('first.ts'), 'launch URL carries no workspace path');
  await page.evaluate(() => document.addEventListener('click', event => {
    const target = (event.target as Element).closest('#file-viewer-edit');
    if (target) {event.preventDefault(); (window as any).__acodeLaunch = target.getAttribute('href');}
  }, true));
  await edit.click();
  assert.equal(await page.evaluate(() => (window as any).__acodeLaunch), first.href);
  await page.getByRole('button', {name: 'Info', exact: true}).click();
  assert.equal(await page.getByRole('link', {name: 'Set up Acode editing'}).getAttribute('href'), '/acode-setup');
  await page.keyboard.press('Escape');
  await open('Second');
  const second = await ready();
  assert.notEqual(second.payload.ticket, first.payload.ticket, 'another file gets a fresh grant');
  assert.equal(second.payload.line, 1);
  assert.equal(second.payload.column, 1);
  await page.keyboard.press('Escape');
  await open('Image');
  assert.equal(await edit.isVisible(), false, 'images cannot launch the text editor');
  await page.goto(`${base}/acode-setup`);
  await page.waitForFunction(() => document.querySelector('#download')?.hasAttribute('href'));
  assert.equal(await page.locator('#download').getAttribute('href'), 'https://bridge.example.test/acode-plugin.zip');
  const create = `${base}/api/acode/edit?thread=${thread.id}&path=first.ts`;
  assert.equal((await fetch(create, {method: 'POST', headers: {Cookie: `ac_session=${session}`, Origin: 'https://evil.example'}})).status, 403);
  assert.equal((await fetch(create, {method: 'POST', headers: {Origin: base}})).status, 401);
  for (const route of ['/', '/api/acode/edit']) assert.equal((await fetch(bridge + route)).status, 404);
  assert.equal((await fetch(`${bridge}/api/acode/file`)).status, 401);
  assert.equal((await fetch(`${bridge}/api/acode/file`, {headers: {Origin: 'https://evil.example'}})).status, 403);
  const preflight = await fetch(`${bridge}/api/acode/file`, {method: 'OPTIONS', headers: {Origin: 'null', 'Access-Control-Request-Method': 'PUT'}});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  console.log('PASS Acode UI: Edit launch payload, fresh grants, image exclusion, setup, isolated authenticated bridge');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise<void>(resolve => {if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve());});
  fs.rmSync(data, {recursive: true, force: true});
  fs.rmSync(cwd, {recursive: true, force: true});
}
