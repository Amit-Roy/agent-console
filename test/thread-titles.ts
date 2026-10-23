import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ac-titles-'));
process.env.AGENT_CONSOLE_DATA=dir;process.env.AGENT_CONSOLE_BRAIN=path.join(dir,'no-brain');process.env.AGENT_CONSOLE_LABELS='0';process.env.AGENT_CONSOLE_MOCK='1';
const {registerHooks}=await import('node:module');
let fontLoads=0;
const hooks=registerHooks({resolve(specifier,context,next){if(specifier==='fontkit')fontLoads++;return next(specifier,context);}});
const {Threads}=await import('../server/threads.ts');const {PROVIDERS}=await import('../server/providers/index.ts');
PROVIDERS.set('fixture',{id:'fixture',label:'Fixture',modes:['plan'],defaultMode:'plan',models:()=>['fixture'],defaultModel:()=>'fixture',status:()=>({ok:true}),start(){return{alive:true,send(){},abort(){},kill(){}};}} as any);
const tick=()=>new Promise(r=>setTimeout(r,50));
const {cleanTitle}=await import('../server/providers/title.ts');
assert.equal(fontLoads,0,'font parser must stay unloaded until a title needs measuring');
hooks.deregister();
assert.equal(cleanTitle('Auth:fix redirect'), 'Auth:fix redirect', 'Topic:feat survives cleanup');
assert.equal(cleanTitle('unstructured title'), undefined, 'malformed model replies must be rejected');
assert.equal(cleanTitle('Auth:fix login redirect'), 'Auth:fix login', 'feature keeps whole words inside the budget');
assert.equal(cleanTitle('Auth:'), undefined, 'empty features must be rejected');
assert.equal(cleanTitle('Title:rename chats'), 'Title:rename chats', 'Title is also a valid subject');
const examples = [
 ['Auth:fix redirect', 'Auth:fix redirect'],
 ['Chat:image paste', 'Chat:image paste'],
 ['UI:dark mode', 'UI:dark mode'],
 ['Mobile:keyboard focus', 'Mobile:keyboard'],
 ['Build:cache assets', 'Build:cache assets'],
 ['Tests:flaky login', 'Tests:flaky login'],
 ['Search:index logs', 'Search:index logs'],
 ['Costs:show usage', 'Costs:show usage'],
 ['Threads:rename chats', 'Threads:rename chats'],
 ['Android:sidebar width', 'Android:sidebar'],
 ['Notifications:push alerts', 'Notifica:push alerts'],
 ['資料:検索を修正', '資料:検索を修'],
];
for (const [raw, expected] of examples) {
 assert.equal(cleanTitle(raw), expected, raw);
 assert.ok(expected.length <= 20, raw);
}
const threads=new Threads(()=>{});
try{
 // an unnamed thread is named by its prompts
 const t=threads.create({provider:'fixture',cwd:dir});assert.equal(t.autoTitle,true);assert.ok(!t.titleLocked);
 threads.send(t.id,'fix the login redirect bug please');await tick();assert.equal(threads.get(t.id)!.title,'fix:the login');
 assert.equal(threads.get(t.id)!.autoTitle,false);
 // the title helper reads every user message from the log, not a stored copy
 assert.equal(threads.get(t.id)!.recent,undefined);
 // a manual rename locks the title for good
 threads.update(t.id,{title:'My own name'});assert.equal(threads.get(t.id)!.titleLocked,true);
 threads.send(t.id,'now rework the billing export totally',{delivery:'queued'} as any);await tick();
 assert.equal(threads.get(t.id)!.title,'My own name');
 // a title given at creation is a manual title
 const named=threads.create({provider:'fixture',cwd:dir,title:'agent-console:10 Idle windows'});assert.equal(named.titleLocked,true);
 threads.send(named.id,'completely different subject entirely');await tick();assert.equal(threads.get(named.id)!.title,'agent-console:10 Idle windows');
 // A distinct long model reply is shortened on a feature word boundary.
 const capped=threads.create({provider:'fixture',cwd:path.join(dir,'capped')});threads.send(capped.id,'Mobile:keyboard focus overflow');await tick();assert.ok(threads.get(capped.id)!.title!.length <= 20, 'title exceeds Android width');assert.equal(threads.get(capped.id)!.title,'Mobile:keyboard');
}finally{threads.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS thread titles: first prompt names, history-based input, manual rename and creation title lock');
