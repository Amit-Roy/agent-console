// Isolated browser regression: a background subagent whose task_notification is on a newer history page than its task_started
// must end up "finished" (not "in background") once the older page is loaded. Run: rtk proxy node test/bg-chip-paging-ui.ts (OUT=dir saves screenshots)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium, type Browser} from 'playwright';

const port = '7072', base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bg-chip-'));
const id = '55555555-5555-4555-8555-555555555555';
fs.mkdirSync(path.join(data, 'logs'));
fs.writeFileSync(path.join(data, 'threads.json'), JSON.stringify([{id, provider: 'mock', model: 'echo', effort: 'medium', mode: 'plan', title: 'BG chip', cwd: process.cwd(), status: 'idle', cost: 0, createdAt: 1, updatedAt: 1}]));
fs.writeFileSync(path.join(data, 'commands.json'), '{}');
const text = (t: string) => ({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: t}]}});
const events = [
  {type: 'user_input', text: 'spawn it'},
  {type: 'assistant', message: {role: 'assistant', content: [{type: 'tool_use', id: 'agent-1', name: 'Agent', input: {description: 'Survey the repo', subagent_type: 'explore', prompt: 'look'}}]}},
  {type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'agent-1', content: 'Started in background'}]}},
  {type: 'system', subtype: 'task_started', tool_use_id: 'agent-1', is_backgrounded: true},
  {type: 'user_input', text: 'next turn'},
  ...Array.from({length: 30}, (_, i) => text(`Filler ${i}`)), // pushes the first turn onto an older page
  {type: 'system', subtype: 'task_notification', tool_use_id: 'agent-1', status: 'completed', summary: 'Finished'},
];
fs.writeFileSync(path.join(data, 'logs', `${id}.jsonl`), events.map(e => JSON.stringify(e) + '\n').join(''));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_ENV_FILES = '/dev/null';
const {makeToken} = await import('../server/auth.ts');
const server = spawn(process.execPath, ['server/index.ts'], {
  env: {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENT_CONSOLE_'))), PORT: port, AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_RUN: path.join(data, 'run'), AGENT_CONSOLE_PID_FILE: '', AGENT_CONSOLE_MOCK: '1', AGENT_CONSOLE_PAGE: '12', AGENT_CONSOLE_HEADROOM: '0', AGENT_CONSOLE_LABELS: '0', AGENT_CONSOLE_ENV_FILES: '/dev/null'},
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverError = '';
server.stderr.on('data', b => { serverError += String(b); });
let browser: Browser | undefined;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`scratch server exited (${server.exitCode}): ${serverError}`);
    try { if ((await fetch(`${base}/login`)).ok) break; } catch {}
    if (i === 99) throw new Error('scratch server did not start');
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1000, height: 800}, serviceWorkers: 'block'});
  await context.addCookies([{name: 'ac_session', value: makeToken(), url: base}]);
  await context.addInitScript(t => localStorage.setItem('ac_thread', t), id);
  const page = await context.newPage();
  await page.goto(base);
  await page.getByText('Filler 29').waitFor({timeout: 5000}).catch(async e => { console.log(await page.evaluate(() => document.body.innerText.slice(0, 600))); throw e; });
  assert.equal(await page.locator('.card.agent').count(), 0, 'the agent card is on an older page');
  for (let i = 0; i < 10 && !(await page.locator('.card.agent').count()); i++) {
    await page.locator('#chat').evaluate(e => { e.scrollTop = 0; });
    await page.locator('.earlier').evaluate((b: HTMLElement) => b.click());
    await page.waitForTimeout(600);
  }
  await page.locator('.card.agent').waitFor();
  await page.waitForTimeout(300);
  if (process.env.OUT) { fs.mkdirSync(process.env.OUT, {recursive: true}); await page.locator('.card.agent').scrollIntoViewIfNeeded(); await page.screenshot({path: path.join(process.env.OUT, 'chip.png')}); }
  const chip = (await page.locator('.card.agent .task-chip').innerText()).trim();
  const header = await page.locator('#state-t').innerText().catch(() => '');
  assert.match(chip, /finished/, `chip: ${chip}`);
  assert.doesNotMatch(header, /agent/, `header: ${header}`);
  assert.equal(await page.locator('.task-chip.running').count(), 0);
  console.log(`PASS paged history: chip "${chip}", header "${header}"`);
} finally {
  await browser?.close();
  server.kill();
}
