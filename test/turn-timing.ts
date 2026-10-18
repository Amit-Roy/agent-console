// Turn timing: the clock's arithmetic, sanitizing, the bounded store, and the Threads integration (fixture provider, no network).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ac-turn-timing-'));
process.env.AGENT_CONSOLE_DATA=dir;process.env.AGENT_CONSOLE_BRAIN=path.join(dir,'no-brain');process.env.AGENT_CONSOLE_LABELS='0';
const {TurnClock,TurnTimingStore,errorClass,retryEvent,runFacts,nearestRank}=await import('../server/turn-timing.ts');
const SECRET='NEVER_STORE_THIS_PROMPT rm -rf /secret';
const asst=(content:any[],extra:any={})=>({type:'assistant',message:{role:'assistant',content},...extra});
const result=(id:string,is_error=false)=>({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:SECRET,is_error}]}});

// sanitizing: classes and statuses only, never message text
assert.equal(errorClass('rate_limit'),'rate_limit');
assert.equal(errorClass('serverOverloaded'),'server_overloaded');
assert.equal(errorClass(`429 Too Many Requests: ${SECRET}`),'rate_limit');
assert.equal(errorClass(`Request timed out after 60s ${SECRET}`),'timeout');
assert.equal(errorClass(`weird ${SECRET}`),'other');
assert.equal(errorClass(null),'unknown');
const r=retryEvent({attempt:2,message:`upstream 503 Service Unavailable ${SECRET}`,delay:1200});
assert.deepEqual(r,{type:'system',subtype:'api_retry',attempt:2,error_status:503,error:'server_error',retry_delay_ms:1200});
assert.equal(retryEvent({status:529,error:'overloaded'}).error_status,529);
assert.equal(nearestRank([1,2,3,4,5,6,7,8,9,10],95),10);assert.equal(nearestRank([1,2,3,4,5,6,7,8,9,10],50),5);assert.equal(nearestRank([],50),null);

// clock: cold start, TTFT, two model steps around parallel tools, a question wait, subagent tools ignored, retries, rate limits
const c=new TurnClock({provider:'claude',alias:'opus',start:1000,cold:true,queueMs:250});
c.event({type:'run_settings',model:'opus'},1000);                                 // adapter-made: not process output
c.event({type:'system',subtype:'init',model:'claude-opus-5-5'},1400);              // startup 400
c.event({type:'stream_event',event:{type:'message_start'}},1450);
c.event({type:'system',subtype:'api_retry',attempt:1,error_status:null,error:'unknown'},1500);
c.event({type:'rate_limit_event',rate_limit_info:{status:'allowed'}},1550);
c.event({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning'}},1560);
c.event({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:SECRET}}},1600); // TTFT 600
c.event(asst([{type:'text',text:SECRET}]),1700);
c.event(asst([{type:'tool_use',id:'a',name:'Bash',input:{command:SECRET}}]),2000);
c.event(asst([{type:'tool_use',id:'b',name:'Read',input:{}}]),2100);
c.event(asst([{type:'tool_use',id:'s',name:'Grep',input:{}}],{parent_tool_use_id:'a'}),2200); // subagent: not ours
c.event(result('b'),2600);
c.event(result('a',true),3000);                                                      // tools union 2000-3000 = 1000
c.event({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'x'}}},3100); // step 2
c.event(asst([{type:'tool_use',id:'q',name:'AskUserQuestion',input:{}}]),3200);
c.event({type:'question',id:'Q1',questions:[]},3250);
c.event({type:'question_answer',id:'Q1'},5250);                                     // waiting on the user 2000
c.event(result('q'),5300);                                                           // AskUserQuestion tool: 3200-3250 + 5250-5300 = 100 tool
c.event(asst([{type:'text',text:'done'}]),5400);                                    // step 3
const row=c.finish({type:'result',is_error:false},6000,1350);
assert.equal(row.model,'claude-opus-5-5');assert.equal(row.alias,'opus');
assert.equal(row.cold,1);assert.equal(row.spawn_ms,1350);assert.equal(row.queue_ms,250);
assert.equal(row.first_ms,600);assert.equal(row.total_ms,5000);assert.equal(row.startup_ms,400);
assert.equal(row.wait_ms,2000);assert.equal(row.tool_ms,1100);assert.equal(row.model_ms,5000-1100-2000-400);
assert.equal(row.steps,3);assert.equal(row.retries,1);assert.equal(row.rate_limits,1);assert.deepEqual(row.retry_detail,[{s:null,c:'unknown'}]);
assert.deepEqual(row.tools.map(t=>[t.n,t.ms,t.e??0]),[['Bash',1000,1],['Read',500,0],['AskUserQuestion',2100,0]]);
assert.equal(row.outcome,'ok');
const facts=runFacts(row);
assert.deepEqual(facts.slowest,{name:'AskUserQuestion',ms:2100});assert.equal(facts.other_ms,2400);assert.equal(facts.cold,true);assert.equal(facts.retries,2);
assert.ok(!JSON.stringify(row).includes('NEVER_STORE'));

// warm turn, no output (e.g. aborted early): no TTFT, no spawn time even if one is offered, open tools close at the end
const w=new TurnClock({provider:'codex',alias:'default',start:0,cold:false});
w.event({type:'run_settings',model:'default'},0);
w.event({type:'system',subtype:'init',model:'gpt-6-codex'},50);
w.event(asst([{type:'tool_use',id:'t',name:'exec<script>',input:{}}]),100);
const wr=w.finish({subtype:'aborted',is_error:true},400,999);
assert.equal(wr.spawn_ms,null);assert.equal(wr.first_ms,100);assert.equal(wr.tool_ms,300);assert.equal(wr.tools[0].n,'execscript');assert.equal(wr.outcome,'aborted');assert.equal(wr.model,'gpt-6-codex');

// store: 0600, bounded rows, retention, nearest-rank summary, process lifecycle
const file=path.join(dir,'store.sqlite');
let store=new TurnTimingStore(file,6,30);
try{
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 const now=Date.now();
 for(const [i,first] of [100,200,300,400,500].entries()) store.recordTurn('th1',{...row,turn_ts:now-1000+i,first_ms:first,cold:i===0?1:0,spawn_ms:i===0?900:null});
 store.recordTurn('th2',{...wr,turn_ts:now-500,provider:'pi'});
 store.recordProcess({thread:'th1',provider:'claude',kind:'spawn'});
 store.recordProcess({thread:'th1',provider:'claude',kind:'ready',ms:900});
 store.recordProcess({thread:'th1',provider:'claude',kind:'exit',ms:60000,code:null,signal:'SIGTERM',reason:'idle'});
 let s=store.summary(now-86400_000,now+60_000,{phone:[{provider:'claude',total_ms:700},{provider:'claude',total_ms:900}]});
 assert.equal(s.turns,6);
 const cl=s.ttft.find(x=>x.provider==='claude')!;assert.equal(cl.p50_ms,300);assert.equal(cl.p95_ms,500);assert.equal(cl.count,5);
 assert.ok(s.ttft.find(x=>x.provider==='all'));
 assert.deepEqual(s.phone_ttft,[{provider:'claude',count:2,p50_ms:700,p95_ms:900}]);
 assert.equal(s.tools[0].name,'AskUserQuestion');assert.ok(s.tools.length<=5);assert.equal(s.tools.find(t=>t.name==='Bash')!.errors,5);
 assert.equal(s.cold.cold,1);assert.equal(s.cold.spawn.p50_ms,900);
 assert.equal(s.retries.retries,5);assert.equal(s.retries.rate_limits,5);assert.equal(s.retries.by_class.unknown,5);
 assert.equal(s.exits.idle,1);assert.equal(s.outcomes.aborted,1);assert.equal(s.models['claude/claude-opus-5-5'],5);
 assert.equal(store.summary(now-86400_000,now+60_000,{thread:'th2'}).turns,1);
 store.recordTurn('th3',{...row,turn_ts:now-1});
 store.close();store=new TurnTimingStore(file,6,30);
 assert.equal(store.summary(0,now+1).turns,6,'survives reopen; oldest rows beyond the cap are dropped');
 store.close();store=new TurnTimingStore(file,6,0);
 assert.equal(store.summary(0,now+1).turns,0,'retention window prunes');
 assert.ok(!fs.readFileSync(file).includes('NEVER_STORE'));
}finally{store.close();}

// browser first-token samples ride the existing validated latency endpoint as a new kind
{
 const {LatencyStore}=await import('../server/latency.ts');
 const ls=new LatencyStore(path.join(dir,'phone.sqlite'));
 const base={thread:'fx',kind:'first_token',width:390,height:844,touch:true};
 assert.equal(ls.record([{...base,total_ms:1200,wait_ms:0,text:SECRET},{...base,total_ms:300001},{...base,kind:'first_tokens',total_ms:5}],(id:string)=>id==='fx'?{provider:'mock'}:undefined),1);
 assert.deepEqual(ls.samples('first_token',0,Date.now()+1).map(x=>({...x})),[{provider:'mock',total_ms:1200}]);
 ls.close();
}
// Threads: server stamps every persisted event, records cold then warm turns, lifecycle, and the Run details facts
const {Threads,turnTiming}=await import('../server/threads.ts');const {PROVIDERS}=await import('../server/providers/index.ts');
let ctx:any,alive=true;
PROVIDERS.set('fixture',{id:'fixture',label:'Fixture',modes:['plan'],defaultMode:'plan',models:()=>['alias'],defaultModel:()=>'alias',status:()=>({ok:true}),start(_t:any,c:any){ctx=c;alive=true;return{get alive(){return alive;},send(){},abort(){},kill(){alive=false;c.exited({code:null,signal:'SIGTERM',stderr:'',aborted:true});}};}} as any);
const threads=new Threads(()=>{});
try{
 const t=threads.create({provider:'fixture',cwd:dir,title:'Fixture'});
 threads.send(t.id,SECRET);
 ctx.event({type:'system',subtype:'init',model:'fixture-model-1'});
 ctx.event({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'hi'}}});
 ctx.event(asst([{type:'tool_use',id:'x',name:'Bash',input:{command:SECRET}}]));
 ctx.event(result('x'));
 ctx.event({type:'system',subtype:'api_retry',attempt:1,error_status:529,error:'overloaded'});
 ctx.event({type:'result',subtype:'success',is_error:false,duration_ms:5});
 const log=fs.readFileSync(path.join(dir,'logs',`${t.id}.jsonl`),'utf8').trim().split('\n').map(l=>JSON.parse(l));
 assert.ok(log.every(e=>typeof e.ts==='number'),'every persisted event carries a server timestamp');
 assert.ok(!log.some(e=>e.type==='stream_event'),'deltas stay unpersisted');
 const timing=threads.get(t.id)!.lastRun!.timing!;
 assert.equal(timing.cold,true);assert.equal(timing.model,'fixture-model-1');assert.equal(timing.steps,1);assert.equal(timing.tool_calls,1);assert.equal(timing.retries,1);
 assert.ok(timing.first_ms!=null&&timing.spawn_ms!=null);
 threads.send(t.id,'again');ctx.event({type:'result',subtype:'success',is_error:false});
 assert.equal(threads.get(t.id)!.lastRun!.timing!.cold,false,'second turn reuses the process');
 threads.update(t.id,{title:'x'});threads.update(t.id,{mode:'plan',model:'alias'}); // settings change kills the process
 const s=turnTiming()!.summary(0,Date.now()+1);
 assert.equal(s.turns,2);assert.equal(s.cold.cold,1);assert.equal(s.models['fixture/fixture-model-1'],2);assert.equal(s.retries.by_status['529'],1);
 assert.equal(s.exits.settings,1);
 assert.ok(!fs.readdirSync(dir).filter(f=>f.startsWith('latency.sqlite')).some(f=>fs.readFileSync(path.join(dir,f)).includes('NEVER_STORE')),'no prompt or command text in the timing store');
}finally{threads.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
console.log('turn timing ok');
