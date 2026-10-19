// Search canonical transcripts across providers without using live accounts or session data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium, type Browser} from 'playwright';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-search-ui-'));
const providers = ['claude', 'codex', 'pi'];
const ids = providers.map(provider => `session-search-${provider}`);
const hostile = '<img src=x onerror="window.sessionSearchInjected=true">';
fs.mkdirSync(path.join(data, 'logs'));
fs.mkdirSync(path.join(data, 'uploads'));
fs.writeFileSync(path.join(data, 'threads.json'), JSON.stringify(providers.map((provider, i) => ({
  id: ids[i], provider, title: i === 2 ? `Pi archive ${hostile}` : `${provider} work`,
  model: 'fixture', mode: 'acceptEdits', cwd: data, status: 'idle', cost: 0,
  createdAt: i + 1, updatedAt: i + 1, ...(i === 2 ? {archived: Date.now()} : {}),
}))));
for (const [i, id] of ids.entries()) {
  const events = [
    {type: 'user_input', text: `Orchard historical ${providers[i]} request ${hostile}`},
    {type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: `Surrounding reply from ${providers[i]}.`}]}},
    ...Array.from({length: 50}, (_, n) => ({type: 'user_input', text: `Later question ${n} from ${providers[i]}.`})),
    {type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'fixture', content: `Tool evidence orchard ${providers[i]}.`}]}},
  ];
  fs.writeFileSync(path.join(data, 'logs', `${id}.jsonl`), events.map(event => JSON.stringify(event)).join('\n') + '\n');
}
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_ENV_FILES = '/dev/null';
const {makeToken} = await import('../server/auth.ts');
let port = 0;
for (const candidate of [7071, 7072, 7073, 7074, 7075]) {
  const probe = net.createServer();
  const free = await new Promise<boolean>(resolve => {
    probe.once('error', () => resolve(false));
    probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  if (free) { port = candidate; break; }
}
assert.ok(port, 'an isolated scratch port, 7071–7075, is available');
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.ts'], {
  env: {...process.env, PORT: String(port), AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(data, 'run'), AGENT_CONSOLE_PID_FILE: '',
    AGENT_CONSOLE_AUTH: 'password', AGENT_CONSOLE_MOCK: '1', AGENT_CONSOLE_PAGE: '12',
    AGENT_CONSOLE_WARM_MAX: '0', AGENT_CONSOLE_HEADROOM: '0', AGENT_CONSOLE_LABELS: '0',
    AGENT_CONSOLE_BRAIN: path.join(data, 'no-brain')},
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser: Browser | undefined;
let serverError = '';
server.stderr.on('data', chunk => { serverError += String(chunk); });
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Scratch server did not start: ${serverError}`)), 15000);
    server.stdout.on('data', chunk => {
      if (String(chunk).includes('agent-console listening')) { clearTimeout(timer); resolve(); }
    });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Scratch server exited: ${code}: ${serverError}`)); });
  });
  assert.equal((await fetch(`${base}/sessions`, {headers: {accept: 'text/html'}, redirect: 'manual'})).status, 302);
  for (const route of ['/api/sessions/search?q=orchard', `/api/sessions/${ids[0]}`]) {
    assert.equal((await fetch(base + route)).status, 401, 'session API requires authentication');
  }
  for (const name of ['session_search', 'session_read']) {
    for (const token of ['', 'invalid-token']) {
      assert.equal((await fetch(`${base}/api/agent-tools/${name}`, {
        method: 'POST', headers: {'content-type': 'application/json', 'x-agent-console-tool': token}, body: '{}',
      })).status, 401, 'provider tools reject missing or invalid credentials');
    }
  }
  const headers = {cookie: `ac_session=${makeToken()}`};
  for (const query of ['', '!!!', 'a'.repeat(501)]) {
    assert.equal((await fetch(`${base}/api/sessions/search?q=${encodeURIComponent(query)}`, {headers})).status, 400, 'invalid search query is rejected');
  }
  assert.equal((await fetch(`${base}/api/sessions/search?q=orchard&provider=${'x'.repeat(101)}`, {headers})).status, 400);
  assert.equal((await fetch(`${base}/api/sessions/not-a-session`, {headers})).status, 400, 'unknown session is rejected');
  const response = await fetch(`${base}/api/sessions/search?q=orchard`, {headers});
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const found = await response.json();
  assert.deepEqual([...new Set(found.results.map((hit: any) => hit.provider))].sort(), [...providers].sort());
  assert.ok(found.results.some((hit: any) => hit.thread === ids[2]), 'archived Pi session remains searchable');
  assert.ok(found.results.some((hit: any) => hit.line === 1), 'messages outside the initial page remain searchable');
  assert.ok(found.results.some((hit: any) => hit.role === 'tool'), 'tool output remains searchable');
  const bounded = await (await fetch(`${base}/api/sessions/${ids[0]}?start=2&limit=1`, {headers})).json();
  assert.equal(bounded.events.length, 1);
  assert.equal(bounded.events[0].line, 2);
  assert.match(bounded.events[0].text, /Surrounding reply/);

  browser = await chromium.launch();
  const errors: string[] = [];
  for (const mobile of [false, true]) {
    const context = await browser.newContext({viewport: mobile ? {width: 390, height: 844} : {width: 1280, height: 900},
      colorScheme: 'dark', serviceWorkers: 'block', isMobile: mobile, hasTouch: mobile});
    await context.addCookies([{name: 'ac_session', value: makeToken(), url: base}]);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/sessions?q=orchard`);
    await page.waitForFunction(() => document.querySelector('#session-results')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#session-results > li').count(), 6);
    assert.equal(await page.locator('#session-results img, #session-results script').count(), 0, 'results render hostile transcript text safely');
    assert.equal(await page.evaluate(() => (window as any).sessionSearchInjected), undefined);
    await page.selectOption('#session-provider', 'pi');
    await page.waitForFunction(() => document.querySelectorAll('#session-results > li').length === 2 && document.querySelector('#session-results')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#session-results h2 a').first().getAttribute('href'), `/#thread=${ids[2]}`);
    assert.ok((await page.locator('#session-results .search-meta').allTextContents()).every(text => text.startsWith('pi ·')));
    await page.locator('#session-results > li').filter({has: page.locator('.search-meta', {hasText: /line 1$/})}).locator('summary').click();
    await page.waitForFunction(() => document.querySelector('#session-results pre')?.textContent?.includes('Surrounding reply from pi.'));
    assert.equal(await page.locator('#session-results pre img').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'results fit viewport');
    await page.screenshot({path: `/tmp/ac-session-search-${mobile ? 'phone' : 'desktop'}.png`, fullPage: true});
    await page.fill('#session-query', 'unfindablefixtureword');
    await page.getByRole('button', {name: 'Search', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#search-status')?.textContent?.startsWith('No matches.'));
    assert.equal(await page.locator('#session-results > li').count(), 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS session search: authentication, old and archived transcripts, all providers, tool output, validation, safe rendering, surrounding messages, responsive views');
} finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  fs.rmSync(data, {recursive: true, force: true});
}
