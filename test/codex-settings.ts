import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codex } from "../server/providers/codex.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-app-"));
const previous = process.env.PATH;
try {
  fs.writeFileSync(
    path.join(dir, "codex"),
    `#!${process.execPath}
let buffer='',thread,seq=0,steered='',current,waiting=false;const requests=[];
const send=x=>console.log(JSON.stringify(x));const note=(method,params)=>send({method,params:{threadId:thread,...params}});
function finish(){note('item/completed',{item:{id:'answer'+seq,type:'agentMessage',text:JSON.stringify({requests,args:process.argv.slice(2),steered,privacy:process.env.HEADROOM_BEACON})}});note('turn/completed',{turn:{id:current,status:'completed'}});}
process.stdin.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\\n'))>=0){let m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);requests.push(m);if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||'new-session';send({id:m.id,result:{thread:{id:thread}}});}if(m.method==='turn/start'){current='turn'+(++seq);waiting=m.params.input[0].text==='wait';send({id:m.id,result:{turn:{id:current}}});note('turn/started',{turn:{id:current}});note('item/started',{item:{id:'cmd'+seq,type:'commandExecution',command:'echo fixture'}});note('item/completed',{item:{id:'cmd'+seq,type:'commandExecution',command:'echo fixture',aggregatedOutput:'fixture',exitCode:0,status:'completed'}});const last={totalTokens:120,inputTokens:100,cachedInputTokens:50,outputTokens:20};note('thread/tokenUsage/updated',{tokenUsage:{last,total:Object.fromEntries(Object.entries(last).map(([k,v])=>[k,v*seq])),modelContextWindow:1000}});if(!waiting)setTimeout(finish,30);}if(m.method==='turn/steer'){if(m.params.input[0].text==='reject'){send({id:m.id,error:{message:'Steer rejected by fixture'}});continue;}if(m.params.expectedTurnId!==current){send({id:m.id,error:{message:'Wrong turn'}});continue;}steered=m.params.input[0].text;send({id:m.id,result:{turnId:current}});setTimeout(finish,30);}if(m.method==='thread/compact/start'){send({id:m.id,result:{}});note('item/completed',{item:{type:'contextCompaction',id:'compact'}});note('turn/completed',{turn:{status:'completed'}});}}});
`,
    { mode: 0o700 },
  );
  process.env.PATH = dir + path.delimiter + previous;
  const make = (model: string, effort: string, sessionId?: string) => {
    const events: any[] = [];
    const agent = codex.start(
      { id: "fixture", cwd: dir, mode: "bypassPermissions", model, effort, sessionId },
      {
        event: (e) => events.push(e),
        commands() {},
        exited(info) {
          events.push({ type: "exit_info", ...info });
        },
      },
    );
    const wait = async (pred: (e: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const e = events.find(pred);
        if (e) return e;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("Timed out: " + JSON.stringify(events));
    };
    return { agent, events, wait };
  };
  for (const [model, effort, session] of [
    ["fixture-model", "high", "fixture-session"],
    ["default", "high", undefined],
    ["default", "default", undefined],
  ]) {
    const r = make(model!, effort!, session);
    try {
      r.agent.send("fixture");
      const answer = await r.wait(
        (e) => e.type === "assistant" && e.message.content[0].type === "text",
      );
      const { requests, args, privacy } = JSON.parse(answer.message.content[0].text);
      assert.equal(args[0], "app-server");
      assert.equal(privacy, "off");
      const thread = requests.find((m: any) => m.method.startsWith("thread/"));
      assert.equal(thread.method, session ? "thread/resume" : "thread/start");
      assert.equal(thread.params.model, model === "default" ? undefined : model);
      assert.equal(
        thread.params.config?.model_reasoning_effort,
        effort === "default" ? undefined : effort,
      );
      assert.equal(thread.params.threadId, session);
      assert.equal(thread.params.sandbox, "danger-full-access");
      assert.equal(thread.params.approvalPolicy, "never");
      assert.ok(r.events.some((e) => e.type === "context_usage" && e.used === 120));
      assert.ok(r.events.some((e) => e.type === "token_usage" && e.input_tokens === 100));
      await r.wait((e) => e.type === "result");
    } finally {
      r.agent.kill();
    }
  }
  const r = make("default", "default");
  try {
    r.agent.send("wait");
    await assert.rejects(r.agent.steer!("reject") as Promise<void>, /rejected/);
    await r.agent.steer!("Focus on the tests", [
      {
        id: "i",
        path: "/tmp/image.png",
        name: "image.png",
        kind: "image",
        media_type: "image/png",
        size: 12,
      },
    ]);
    const answer = await r.wait(
      (e) => e.type === "assistant" && e.message.content[0].type === "text",
    );
    const parsed = JSON.parse(answer.message.content[0].text);
    assert.equal(parsed.steered, "Focus on the tests");
    assert.equal(parsed.requests.filter((m: any) => m.method === "turn/start").length, 1);
    const s = parsed.requests.findLast((m: any) => m.method === "turn/steer");
    assert.equal(s.params.expectedTurnId, "turn1");
    assert.equal(s.params.input[1].type, "localImage");
    await r.wait((e) => e.type === "result");
    assert.equal(r.events.filter((e) => e.type === "result").length, 1);
    r.events.length = 0;
    r.agent.send("second turn");
    await r.wait((e) => e.type === "result");
    assert.equal(r.events.find((e) => e.type === "token_usage").input_tokens, 100);
    assert.equal(r.events.filter((e) => e.type === "system" && e.subtype === "init").length, 0);
  } finally {
    r.agent.kill();
  }
  const c = make("default", "default", "fixture-session");
  try {
    c.agent.compact!();
    await c.wait((e) => e.type === "result");
    assert.ok(c.events.some((e) => e.subtype === "compact_boundary"));
    assert.equal(c.events.at(-1).is_error, false);
  } finally {
    c.agent.kill();
  }
  assert.equal(codex.steer, true);
  console.log(
    "PASS persistent Codex protocol: model/effort/defaults, resume, native steering/rejection/images, one turn, reusable process, per-turn usage, compaction and privacy (fake CLI; no quota)",
  );
} finally {
  process.env.PATH = previous;
  fs.rmSync(dir, { recursive: true, force: true });
}
