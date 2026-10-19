import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
fs.mkdirSync(path.join(os.homedir(),'.cache'),{recursive:true});const dir=fs.mkdtempSync(path.join(os.homedir(),'.cache','ac-titles-'));
process.env.AGENT_CONSOLE_DATA=dir;process.env.AGENT_CONSOLE_BRAIN=path.join(dir,'no-brain');process.env.AGENT_CONSOLE_LABELS='0';process.env.AGENT_CONSOLE_MOCK='1';
const {Threads}=await import('../server/threads.ts');const {PROVIDERS}=await import('../server/providers/index.ts');
PROVIDERS.set('fixture',{id:'fixture',label:'Fixture',modes:['plan'],defaultMode:'plan',models:()=>['fixture'],defaultModel:()=>'fixture',status:()=>({ok:true}),start(){return{alive:true,send(){},abort(){},kill(){}};}} as any);
const tick=()=>new Promise(r=>setTimeout(r,50));
const threads=new Threads(()=>{});
try{
 // an unnamed thread is named by its prompts
 const t=threads.create({provider:'fixture',cwd:dir});assert.equal(t.autoTitle,true);assert.ok(!t.titleLocked);
 threads.send(t.id,'fix the login redirect bug please');await tick();assert.equal(threads.get(t.id)!.title,'fix the login redirect');
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
}finally{threads.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS thread titles: first prompt names, history-based input, manual rename and creation title lock');
