// Real browser + isolated server, deterministic mock provider; never calls a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ac-queue-ui-'));
const base='http://127.0.0.1:17776';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const original='UNSENT_ORIGINAL_PRIVATE '+ 'full message '.repeat(35);
const create=(id:string,title:string)=>({id,title,provider:'mock',model:'echo',mode:'plan',cwd:process.cwd(),status:'idle',cost:0,createdAt:1,updatedAt:1});
const seed=()=>{
 fs.writeFileSync(path.join(data,'threads.json'),JSON.stringify([create(a,'Queue A'),create(b,'Queue B')]));
 fs.writeFileSync(path.join(data,'queues.json'),JSON.stringify({[a]:[{id:'qa',text:original,revision:0,editing:true,attachments:[]}],[b]:[{id:'qb',text:'Cancel keeps this original.',revision:0,editing:true,attachments:[]}]}));
};seed();
process.env.AGENT_CONSOLE_DATA=data;
const {makeToken}=await import('../server/auth.ts');
const start=()=>spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'17776',AGENT_CONSOLE_MOCK:'1',AGENT_CONSOLE_BRAIN:path.join(data,'no-brain')},stdio:'ignore'});
let server=start(),browser;
const ready=async()=>{for(let i=0;i<100;i++){try{if((await fetch(base)).status<500)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server not ready');};
const stop=async()=>{if(server.exitCode===null){server.kill('SIGTERM');await new Promise<void>(r=>server.once('exit',()=>r()));}};
try{
 await ready();assert.equal((await fetch(base+'/api/latency')).status,401);
 browser=await chromium.launch();
 for(const width of [390,1280]){
  if(width===1280){await stop();seed();server=start();await ready();}
  const context=await browser.newContext({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390});await context.addCookies([{name:'ac_session',value:makeToken(),url:base}]);await context.addInitScript(id=>localStorage.setItem('ac_thread',id),a);
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!!(window as any).agentConsoleMetrics);
  {
   await page.getByRole('button',{name:'Edit queued message',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('#queue-draft') as HTMLTextAreaElement).disabled);assert.equal(await page.locator('#queue-draft').inputValue(),original);
   await page.fill('#queue-draft','');await page.locator('#queue-save').click();await page.waitForFunction(()=>document.querySelector('#queue-edit-error')?.textContent?.includes('Enter a message'));assert.equal(await page.locator('#queue-editor').isVisible(),true);
   await page.fill('#queue-draft','EDITED_PRIVATE_FINAL');
   // Reconnect with an edit open: server persistence keeps delivery paused and preserves the browser draft.
   await stop();server=start();await ready();await page.waitForFunction(()=>document.querySelector('#banner')?.hidden===true,{},{timeout:15000});
   assert.equal(await page.locator('#queue-draft').inputValue(),'EDITED_PRIVATE_FINAL');
   await page.locator('#queue-save').click();await page.waitForFunction(()=>!document.querySelector('#queue-editor')?.hasAttribute('open'));
   await page.waitForFunction(()=>document.querySelector('#chat')?.textContent?.includes('mock reply (plan, echo): EDITED_PRIVATE_FINAL'));
   assert.ok(!(await page.locator('#chat').textContent())!.includes(original));
   if(width===390)await page.locator('#menu').click();await page.locator('#threads li').filter({hasText:'Queue B'}).click();await page.getByRole('button',{name:'Edit queued message',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('#queue-draft') as HTMLTextAreaElement).disabled);
   await page.fill('#queue-draft','DISCARDED_DRAFT');await page.locator('#queue-cancel').click();await page.waitForFunction(()=>document.querySelector('#chat')?.textContent?.includes('mock reply (plan, echo): Cancel keeps this original.'));assert.ok(!(await page.locator('#chat').textContent())!.includes('DISCARDED_DRAFT'));
  }
  const pick=async(title:string)=>{if(width===390)await page.locator('#menu').click();await page.locator('#threads li').filter({hasText:title}).click();};
  await pick('Queue A');await page.waitForFunction(id=>(window as any).agentConsoleMetrics?.thread===id,a);await pick('Queue B');await page.waitForFunction(id=>(window as any).agentConsoleMetrics?.thread===id,b);await pick('Queue A');await page.waitForFunction(()=>!!(window as any).agentConsoleMetrics?.cached);
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  await page.waitForFunction(async()=>{const d=await fetch('/api/latency').then(r=>r.json());return d.groups?.cached?.count>0&&d.groups?.open?.count>0;});
  const result=await page.evaluate(()=>fetch('/api/latency').then(r=>r.json()));assert.ok(result.count>0);assert.ok(result.recent.every((s:any)=>typeof s.total_ms==='number'&&s.width>0));assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(result.groups.open.p95_ms>=result.groups.open.median_ms);
  await page.locator('#more').click();await page.getByRole('menuitem',{name:/Run details/}).click();await page.waitForFunction(()=>document.querySelector('#latency-summary')?.textContent?.includes('Open a thread'));await page.getByRole('button',{name:'Done',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  console.log(`PASS ${width}px queue editor/full text/save/cancel/reconnect, real latency upload/storage, cached timing, private authenticated summary and Run details`);await context.close();
 }
 await stop();server=start();await ready();const persisted=await fetch(base+'/api/latency',{headers:{cookie:`ac_session=${makeToken()}`}}).then(r=>r.json());assert.ok(persisted.count>0);console.log('PASS latency samples persist across server restarts');
}finally{await browser?.close();await stop();fs.rmSync(data,{recursive:true,force:true});}
