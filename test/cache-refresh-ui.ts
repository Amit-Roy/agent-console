// Isolated real-browser cache revalidation with deliberately delayed history; no models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ac-cache-ui-')),base='http://127.0.0.1:17779';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const threads=[a,b].map((id,i)=>({id,title:`Cache ${i}`,provider:'mock',model:'echo',mode:'plan',cwd:process.cwd(),status:'idle',cost:0,createdAt:1,updatedAt:1}));
fs.writeFileSync(path.join(data,'threads.json'),JSON.stringify(threads));fs.mkdirSync(path.join(data,'logs'));
const assistant=(text:string)=>({type:'assistant',message:{role:'assistant',content:[{type:'text',text}]}});
for(const id of [a,b])fs.writeFileSync(path.join(data,'logs',id+'.jsonl'),[...Array.from({length:450},(_,i)=>assistant(`History ${id===a?'A':'B'} ${i}`))].map(x=>JSON.stringify(x)+'\n').join(''));
process.env.AGENT_CONSOLE_DATA=data;
const {makeToken}=await import('../server/auth.ts');
const server=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'17779',AGENT_CONSOLE_MOCK:'1',AGENT_CONSOLE_PAGE:'200',AGENT_CONSOLE_BRAIN:path.join(data,'no-brain')},stdio:'ignore'});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(base)).status<500)break;}catch{}await pause(100);}
 browser=await chromium.launch();const ctx=await browser.newContext({viewport:{width:1280,height:800}});
 await ctx.addCookies([{name:'ac_session',value:makeToken(),url:base}]);await ctx.addInitScript(id=>localStorage.setItem('ac_thread',id),a);
 const page=await ctx.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 let client:any,historyCount=0,refreshCount=0;
 await page.routeWebSocket('**/ws',socket=>{
  client=socket;let closed=false;socket.onClose(()=>{closed=true;});const upstream=socket.connectToServer();
  upstream.onMessage(raw=>{
   const m=JSON.parse(String(raw));
   if(m.t==='hello')m.threads.find((t:any)=>t.id===a).status='running';
   if(m.t!=='history'){socket.send(JSON.stringify(m));return;}
   historyCount++;
   if(m.thread===a&&historyCount>1){refreshCount++;m.events.push(assistant(`Fresh version ${refreshCount}`));}
   const inject=m.thread===a&&refreshCount===1;
   if(inject)setTimeout(()=>{if(!closed){
    socket.send(JSON.stringify({t:'event',thread:a,event:{type:'stream_event',event:{type:'message_start'}}}));
    socket.send(JSON.stringify({t:'event',thread:a,event:{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Stream while waiting unique'}}}}));
   }},400);
   setTimeout(()=>{
    if(closed)return;socket.send(JSON.stringify(m));
    if(inject)setTimeout(()=>{if(!closed)socket.send(JSON.stringify({t:'event',thread:a,event:{type:'user_input',text:'Live during render unique'}}));},20);
   },1000);
  });
 });
 await page.goto(base);await page.waitForFunction(()=>(window as any).agentConsoleMetrics?.thread==='11111111-1111-4111-8111-111111111111');
 const pick=async(title:string)=>page.locator('#threads li').filter({hasText:title}).click();
 await pick('Cache 1');await page.waitForFunction(()=>(window as any).agentConsoleMetrics?.thread==='22222222-2222-4222-8222-222222222222');
 await pick('Cache 0');
 const cached=await page.evaluate(()=>({metrics:(window as any).agentConsoleMetrics,text:document.querySelector('#chat')!.textContent,updating:!!document.querySelector('#conversation-updating')}));
 assert.ok(cached.metrics.cached&&cached.metrics.total_ms<200,JSON.stringify(cached.metrics));assert.ok(cached.text!.includes('History A 449'));assert.ok(cached.updating);
 await page.waitForTimeout(250);assert.ok((await page.locator('#chat').textContent())!.includes('History A 449'));assert.equal(await page.locator('.skeleton').count(),0);
 await page.locator('#chat').evaluate(e=>{e.scrollTop=120;});
 await page.waitForTimeout(300);assert.equal(await page.getByText('Stream while waiting unique',{exact:true}).count(),0);
 await page.waitForFunction(()=>!!(window as any).agentConsoleMetrics?.refresh);
 assert.ok(Math.abs(await page.locator('#chat').evaluate(e=>e.scrollTop)-120)<5,'refresh preserves reader scroll position');
 assert.equal(await page.getByText('Stream while waiting unique',{exact:true}).count(),1);
 assert.equal(await page.getByText('Fresh version 1',{exact:true}).count(),1);assert.equal(await page.getByText('Live during render unique',{exact:true}).count(),1);
 const refreshed=await page.evaluate(()=>(window as any).agentConsoleMetrics);assert.ok(refreshed.cached&&refreshed.total_ms<200&&refreshed.refresh.total_ms>=1000);
 await page.locator('#chat').evaluate(e=>{e.scrollTop=e.scrollHeight;});await page.waitForTimeout(100);
 // A second refresh abandoned mid-flight must keep the original visible snapshot.
 await pick('Cache 1');await pick('Cache 0');await page.waitForTimeout(150);await pick('Cache 1');await pick('Cache 0');
 assert.ok((await page.locator('#chat').textContent())!.includes('Fresh version 1'));assert.ok((await page.evaluate(()=>(window as any).agentConsoleMetrics)).cached);
 await page.waitForFunction(()=>document.querySelector('#chat')?.textContent?.includes('Fresh version 3'));
 assert.equal(await page.getByText('Fresh version 3',{exact:true}).count(),1);
 // An idle snapshot invalidated in the background also restores before revalidation.
 await pick('Cache 1');await pick('Cache 0');client.send(JSON.stringify({t:'invalidate',thread:b}));await pause(50);const before=historyCount;await pick('Cache 1');
 assert.ok((await page.evaluate(()=>(window as any).agentConsoleMetrics)).cached);assert.ok((await page.locator('#chat').textContent())!.includes('History B 449'));
 await page.waitForFunction(()=>!document.querySelector('#conversation-updating'));assert.ok(historyCount>before);
 // Older pages stay intact while a stale snapshot is being read, with further paging still available.
 await page.locator('.earlier').click();await page.waitForFunction(()=>document.querySelector('#chat')?.textContent?.includes('History B 100'));
 await page.locator('#chat').evaluate(e=>{e.scrollTop=600;});await page.waitForTimeout(100);
 await pick('Cache 0');client.send(JSON.stringify({t:'invalidate',thread:b}));await pause(50);const pagedBefore=historyCount;await pick('Cache 1');
 assert.ok((await page.locator('#chat').textContent())!.includes('History B 100'));
 assert.ok((await page.locator('#conversation-updating').textContent())!.includes('saved history'));
 await pause(1100);assert.equal(historyCount,pagedBefore,'reading older cached pages does not request latest history');
 await page.locator('.earlier').click();await page.waitForFunction(()=>document.querySelector('#chat')?.textContent?.includes('History B 0'));
 await pick('Cache 0');await pick('Cache 1');assert.ok((await page.locator('#chat').textContent())!.includes('History B 0'),'paging while deferred remains cached');
 await page.locator('#chat').evaluate(e=>{e.scrollTop=e.scrollHeight;});await page.waitForFunction(()=>!document.querySelector('#conversation-updating'));
 assert.ok(!(await page.locator('#chat').textContent())!.includes('History B 0'));
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.waitForFunction(async()=>{const d=await fetch('/api/latency').then(r=>r.json());return d.groups?.cached?.count>0&&d.groups?.refresh?.count>0;});
 assert.deepEqual(errors,[]);console.log(`PASS running/stale switches restore below200ms despite1000ms history, refreshdistinct, liveeventsordered, abandonedrefreshpreservesDOM, idleinvalidationsrevalidate (${historyCount} history replies)`);
 await ctx.close();
}finally{await browser?.close();if(server.exitCode===null){server.kill('SIGTERM');await new Promise<void>(r=>server.once('exit',()=>r()));}fs.rmSync(data,{recursive:true,force:true});}
