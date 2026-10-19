import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
fs.mkdirSync(path.join(os.homedir(),'.cache'),{recursive:true});const dir=fs.mkdtempSync(path.join(os.homedir(),'.cache','ac-schedules-')); // task folders must be inside home
process.env.AGENT_CONSOLE_DATA=dir;process.env.AGENT_CONSOLE_BRAIN=path.join(dir,'no-brain');process.env.AGENT_CONSOLE_LABELS='0';
const {Threads}=await import('../server/threads.ts');const {PROVIDERS}=await import('../server/providers/index.ts');
const {Schedules,cronPattern,describe,finalText}=await import('../server/schedules.ts');
const ctxs=new Map<string,any>();const sent:{thread:string,text:string}[]=[];const tick=()=>new Promise(r=>setTimeout(r,50));
PROVIDERS.set('fixture',{id:'fixture',label:'Fixture',modes:['plan','acceptEdits'],defaultMode:'plan',models:()=>['fixture'],defaultModel:()=>'fixture',status:()=>({ok:true}),start(t,c){ctxs.set(t.id,c);return{alive:true,send(text){sent.push({thread:t.id,text});},abort(){},kill(){}};}} as any);
const outputs=path.join(dir,'outputs');const file=path.join(dir,'schedules.json');const events:any[]=[];
const reply=(thread:string,text:string,extra={})=>{const c=ctxs.get(thread);c.event({type:'assistant',message:{role:'assistant',content:[{type:'text',text}]}});c.event({type:'result',subtype:'success',is_error:false,duration_ms:5,...extra});};
let threads=new Threads(()=>{});let schedules=new Schedules(threads,m=>events.push(m),{file,outputs,catchUp:false});
try{
 // patterns and labels
 assert.equal(cronPattern({repeat:'weekdays',time:'18:30',day:1}),'30 18 * * 1-5');assert.equal(cronPattern({repeat:'manual',time:'09:00',day:1}),null);
 assert.equal(describe({repeat:'weekly',time:'09:00',day:1}),'Mondays 09:00');assert.equal(describe({repeat:'hourly',time:'00:15',day:1}),'Hourly at :15');
 // validation speaks plainly
 assert.throws(()=>schedules.create({prompt:'x',provider:'fixture',cwd:dir}),/name/);
 assert.throws(()=>schedules.create({title:'x',prompt:'x',provider:'fixture',cwd:dir,time:'9am'}),/HH:MM/);
 assert.throws(()=>schedules.create({title:'x',prompt:'x',provider:'fixture',cwd:'/etc'}),/home folder/);
 const task=schedules.create({title:'AI news digest',prompt:'Summarise AI news.',provider:'fixture',cwd:dir,repeat:'daily',time:'09:00',tz:'Asia/Kolkata'});
 assert.ok(task.nextRunAt&&task.nextRunAt>Date.now(),'an enabled daily task knows its next run');assert.equal(task.saveOutput,true);assert.equal(events.at(-1).t,'tasks');
 // a run is an ordinary thread tagged with its task; the prompt carries the unattended-run instructions
 const run=schedules.run(task.id);const rt=threads.get(run.thread!)!;
 assert.deepEqual(rt.schedule,{task:task.id,run:run.id});assert.equal(rt.status,'running');assert.match(rt.title,/^AI news digest · /);
 assert.ok(sent.at(-1)!.text.startsWith('Summarise AI news.')&&/do not ask questions/.test(sent.at(-1)!.text));
 const shown=threads.history(rt.id).find((e:any)=>e.type==='user_input') as any;assert.equal(shown.text,'Summarise AI news.','the bubble shows the prompt only');assert.equal(shown.scheduled,'manual');
 // no overlap: a run while the previous one works is recorded as skipped
 const skipped=schedules.run(task.id);assert.equal(skipped.status,'skipped');assert.match(skipped.reason!,/still working/);assert.equal(skipped.thread,undefined);
 // the final message becomes the committed report, and a report card lands in the run's transcript
 reply(rt.id,'**Summary:** three launches.\n\n- one\n- two');await tick();
 const done=schedules.get(task.id)!.runs.find(r=>r.id===run.id)!;
 assert.equal(done.status,'done');assert.ok(done.ms!>=0);assert.ok(done.output?.path.startsWith(path.join(outputs,'ai-news-digest')+path.sep));
 assert.match(fs.readFileSync(done.output!.path,'utf8'),/three launches/);assert.match(done.output!.commit!,/^[0-9a-f]{7,}$/);
 assert.match(execFileSync('git',['-C',outputs,'log','--format=%s'],{encoding:'utf8'}),/^AI news digest: \d{4}-\d\d-\d\d \d\d:\d\d/);
 const card=threads.history(rt.id).find((e:any)=>e.type==='schedule_report') as any;assert.equal(card.run.status,'done');assert.equal(card.run.output.path,done.output!.path);
 // a follow-up in the run thread is a normal turn and leaves the run alone
 threads.send(rt.id,'Any more detail?');reply(rt.id,'Sure.');await tick();assert.equal(schedules.get(task.id)!.runs.find(r=>r.id===run.id)!.output!.path,done.output!.path);
 // a failed run is reported as failed, and saves nothing
 assert.match(sent[0].text,/first run with a saved report/);
 const bad=schedules.run(task.id);assert.ok(sent.at(-1)!.text.includes(`previous run's report is ${done.output!.path}`),'the next run is told where the last report is');ctxs.get(bad.thread!).event({type:'result',subtype:'error',is_error:true,duration_ms:1});await tick();
 assert.equal(schedules.get(task.id)!.runs.find(r=>r.id===bad.id)!.status,'failed');assert.equal(schedules.get(task.id)!.runs.find(r=>r.id===bad.id)!.output,undefined);
 // tools for agents: flat inputs, day names, titles as ids, explicit save_output wins over the fallback
 const caller=threads.create({provider:'fixture',cwd:dir,title:'Chat'});
 const made=schedules.tool('schedule_create',caller.id,{title:'Weekly triage',prompt:'Triage issues.',repeat:'weekly',time:'08:15',day:'fri',agent:'fixture'}) as any;
 assert.equal(made.created.schedule,'Fridays 08:15');assert.equal(made.created.folder,dir,'defaults to the calling thread folder');
 assert.equal((schedules.tool('schedule_list',caller.id,{}) as any).tasks.length,2);
 assert.equal((schedules.tool('schedule_update',caller.id,{id:'weekly triage',enabled:false}) as any).updated.enabled,false);assert.equal(schedules.get(made.created.id)!.nextRunAt,undefined,'a paused task has no next run');
 assert.throws(()=>schedules.tool('schedule_run_now',caller.id,{id:'nope'}),/schedule_list/);
 const r2=schedules.tool('schedule_run_now',caller.id,{id:made.created.id}) as any;assert.equal(r2.status,'running');
 const saved=schedules.tool('save_output',r2.thread,{markdown:'Full triage report.',title:'Triage'}) as any;assert.match(fs.readFileSync(saved.saved.path,'utf8'),/^# Triage\n\nFull triage report/);
 reply(r2.thread,'short final words');await tick();assert.equal(schedules.get(made.created.id)!.runs.at(-1)!.output!.path,saved.saved.path,'the explicit report is kept');
 assert.throws(()=>schedules.tool('save_output',caller.id,{markdown:' '}),/empty/);
 // restart: a run cut off by the restart is failed, never left spinning; tasks and their time zone persist
 const cut=schedules.run(task.id);schedules.shutdown();threads.shutdown();
 threads=new Threads(()=>{});schedules=new Schedules(threads,m=>events.push(m),{file,outputs,catchUp:false});
 assert.equal(schedules.get(task.id)!.runs.find(r=>r.id===cut.id)!.status,'failed');assert.equal(schedules.get(task.id)!.tz,'Asia/Kolkata');
 // catch-up: one run for the latest occurrence missed in the last 7 days, none for older ones
 const saved2=JSON.parse(fs.readFileSync(file,'utf8'));const old=Date.now()-3*86_400_000;
 const missed={...saved2.tasks[0],id:'missed',title:'Missed',runs:[],createdAt:old,updatedAt:old,enabled:true,repeat:'hourly'};
 const stale={...missed,id:'stale',title:'Stale',createdAt:Date.now()-30*86_400_000,updatedAt:Date.now()-30*86_400_000,repeat:'weekly',runs:[{id:'x',at:Date.now()-8*86_400_000,trigger:'schedule',status:'done'}],day:new Date(Date.now()-8*86_400_000).getUTCDay(),tz:'UTC',time:'00:00'};
 fs.writeFileSync(file,JSON.stringify({...saved2,tasks:[...saved2.tasks,missed,stale]}));schedules.shutdown();threads.shutdown();
 threads=new Threads(()=>{});schedules=new Schedules(threads,m=>events.push(m),{file,outputs});await tick();
 assert.equal(schedules.get('missed')!.runs.length,1);assert.equal(schedules.get('missed')!.runs[0].trigger,'catch-up');
 assert.equal(schedules.get('stale')!.runs.length,2,'a weekly task last run 8 days ago catches up its latest occurrence only');
 // deleting a task deletes its run threads
 const runThreads=schedules.get(task.id)!.runs.map(r=>r.thread).filter(Boolean) as string[];schedules.remove(task.id);
 assert.ok(runThreads.every(id=>!threads.get(id)));assert.equal(schedules.get(task.id),undefined);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.equal(finalText([{type:'user_input'},{type:'assistant',message:{content:[{type:'text',text:'a'}]}},{type:'assistant',message:{content:[{type:'tool_use'}]}},{type:'assistant',message:{content:[{type:'text',text:'b'}]}}]),'a\n\nb');
 console.log('PASS schedules: presets, validation, run threads, no overlap, git reports, report card, follow-ups, failures, agent tools, restart, catch-up, delete');
}finally{schedules.shutdown();threads.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
