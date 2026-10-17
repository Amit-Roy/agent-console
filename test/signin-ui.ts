// Coder sign-in expiry: requests redirected to Coder's sign-in page are reported as such and recovered by a reload that keeps the draft.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ac-signin-ui-'));
const base='http://127.0.0.1:17777',id='t-sign';
fs.writeFileSync(path.join(data,'threads.json'),JSON.stringify([{id,provider:'mock',model:'echo',effort:'medium',mode:'bypassPermissions',title:'Sign-in thread',cwd:'/home/coder/repos',status:'idle',cost:0,createdAt:1,updatedAt:1}]));
fs.mkdirSync(path.join(data,'logs'));
fs.writeFileSync(path.join(data,'logs',id+'.jsonl'),JSON.stringify({type:'user_input',text:'hello'})+'\n');
process.env.AGENT_CONSOLE_DATA=data;
const {makeToken}=await import('../server/auth.ts');
const server=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'17777',AGENT_CONSOLE_MOCK:'1'},stdio:'ignore'});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=','base64');
const coderSignIn={status:303,headers:{location:'https://coder.invalid/api/v2/applications/auth-redirect'}};
let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(base)).status<500)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch();
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await context.addCookies([{name:'ac_session',value:makeToken(),url:base}]);
 // proxy the websocket so the test can drop it and refuse reconnects, like a failed upgrade after sign-in expiry
 let refuse=false;const sockets:any[]=[];
 await context.routeWebSocket('**/ws',ws=>{if(refuse){ws.close();return;}sockets.push(ws);const up=ws.connectToServer();up.onMessage(m=>ws.send(m));ws.onMessage(m=>up.send(m));});
 const open=async()=>{const page=await context.newPage();await page.goto(base);await page.waitForFunction(()=>document.getElementById('ttl')?.textContent==='Sign-in thread');return page;};

 // 1. upload while the Coder app session is gone
 const page=await open();
 await page.route('**/uploads/**',r=>r.fulfill(coderSignIn));
 await page.setInputFiles('#file',{name:'shot.png',mimeType:'image/png',buffer:png});
 await page.waitForSelector('.errtxt:has-text("Coder sign-in expired")');
 assert.equal(await page.locator('#thumbs li').count(),0,'failed upload is dropped');
 await page.waitForSelector('#banner:not([hidden]) button:has-text("Sign in again")');
 assert.match(await page.textContent('#banner')||'',/^Coder sign-in expired/);
 console.log('PASS  sign-in: redirected upload is reported and Sign in again is offered');

 // 2. Sign in again reloads (through Coder in real use) and keeps the typed draft
 await page.fill('#input','my unsent draft');
 await page.unroute('**/uploads/**');
 await page.click('#banner button:has-text("Sign in again")');
 await page.waitForFunction(()=>document.getElementById('ttl')?.textContent==='Sign-in thread');
 await page.waitForFunction(()=>(document.getElementById('input') as HTMLTextAreaElement).value==='my unsent draft');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('ac_draft')),null,'draft handoff is consumed');
 assert.equal(await page.isEnabled('#send'),true,'restored draft can be sent');
 assert.equal(await page.isHidden('#banner'),true,'banner clears after signing in');
 console.log('PASS  sign-in: Sign in again reloads and keeps the draft');
 await page.close();

 // 3. the live connection drops and reconnects are refused: show sign-in, not "Reconnecting…" forever
 const p2=await open();
 await p2.route('**/manifest.webmanifest',r=>r.fulfill(coderSignIn));
 refuse=true;for(const s of sockets.splice(0))s.close();
 await p2.waitForSelector('#banner:not([hidden]) button:has-text("Sign in again")',{timeout:15000});
 console.log('PASS  sign-in: refused reconnect is diagnosed as sign-in expiry');

 // 4. a plain network drop still says Reconnecting (no false sign-in prompt)
 refuse=false;
 const p3=await open();
 refuse=true;for(const s of sockets.splice(0))s.close();
 await p3.waitForSelector('#banner:has-text("Reconnecting")');
 await p3.waitForTimeout(3500);
 assert.equal(await p3.locator('#banner button').count(),0,'no sign-in prompt when HTTP still works');
 refuse=false;
 await p3.waitForFunction(()=>document.getElementById('banner')!.hidden,null,{timeout:15000});
 console.log('PASS  sign-in: ordinary disconnects still reconnect without a sign-in prompt');
}finally{await browser?.close();server.kill();}
