import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandList, parseCommand } from "../server/commands.ts";
import { normalizeCommands } from "../server/providers/claude.ts";
import { compactCodex } from "../server/providers/codex-compact.ts";
import { piTranslator } from "../server/providers/pi.ts";
assert.deepEqual(parseCommand(" /compact \n"), { name: "compact", args: "" });
assert.deepEqual(parseCommand("/compact preserve the plan"), {
  name: "compact",
  args: "preserve the plan",
});
assert.equal(parseCommand("/home/coder/repos"), undefined);
assert.equal(
  commandList([{ name: "/compact", description: "native" }]).filter((c) => c.name === "compact")
    .length,
  1,
);
assert.ok(commandList().some((c) => c.name === "compact"));
assert.deepEqual(
  normalizeCommands(["/compact", { name: "/custom", description: "desc" }]).map((c) => c.name),
  ["compact", "custom"],
);
const out: any[] = [];
piTranslator((e) => out.push(e))({
  type: "response",
  command: "compact",
  success: true,
  data: { estimatedTokensAfter: 5000 },
});
assert.ok(out.some((e) => e.type === "system" && e.subtype === "compact_boundary"));
assert.equal(out.find((e) => e.type === "context_usage").used, 5000);
assert.equal(out.at(-1).is_error, false);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-compact-protocol-"));
const previous = process.env.PATH;
const previousMode = process.env.AC_COMPACT_FIXTURE;
try {
  fs.writeFileSync(
    path.join(dir, "codex"),
    `#!${process.execPath}
let pending=''; process.stdin.on('data',b=>{ pending+=b; let i; while((i=pending.indexOf('\\n'))>=0){let m=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);const send=x=>console.log(JSON.stringify(x));if(m.id===1)send({id:1,result:{}});if(m.id===2){if(process.env.AC_COMPACT_FIXTURE==='error')send({id:2,error:{message:'Fixture resume failed'}});else send({id:2,result:{thread:{id:'fixture'}}});}if(m.id===3){send({id:3,result:{}});if(process.env.AC_COMPACT_FIXTURE==='wait')continue;send({method:'turn/completed',params:{threadId:'different',turn:{status:'completed'}}});setTimeout(()=>{if(process.env.AC_COMPACT_FIXTURE!=='missing')send({method:'item/completed',params:{threadId:'fixture',item:{type:'contextCompaction'}}});send({method:'turn/completed',params:{threadId:'fixture',turn:{status:'completed'}}});},100);}}});
`,
    { mode: 0o700 },
  );
  process.env.PATH = dir + path.delimiter + previous;
  async function run(mode: string) {
    process.env.AC_COMPACT_FIXTURE = mode;
    const events: any[] = [];
    const at = Date.now();
    await new Promise<void>((resolve) => {
      const op = compactCodex(
        { id: "fixture", cwd: dir, model: "default", mode: "plan", sessionId: "fixture" },
        {
          commands() {},
          exited() {},
          event(e) {
            events.push(e);
            if (e.type === "result") resolve();
          },
        },
      );
      if (mode === "wait") setTimeout(() => op.abort(), 150);
    });
    return { events, elapsed: Date.now() - at };
  }
  const ok = await run("ok");
  assert.ok(ok.elapsed >= 100); // acknowledgement alone must not report success
  assert.equal(ok.events.at(-1).is_error, false);
  assert.equal(ok.events.filter((e) => e.subtype === "compact_boundary").length, 1);
  assert.equal((await run("missing")).events.at(-1).is_error, true);
  const error = await run("error");
  assert.match(error.events.find((e) => e.type === "console_error").text, /resume failed/);
  const stopped = await run("wait");
  assert.equal(stopped.events.filter((e) => e.type === "result").length, 1);
  assert.match(stopped.events.find((e) => e.type === "console_error").text, /stopped/);
  fs.unlinkSync(path.join(dir, "codex"));
  process.env.PATH = dir;
  const missing = await run("missing-binary");
  assert.equal(missing.events.at(-1).is_error, true);
  assert.ok(missing.elapsed < 2000);
} finally {
  process.env.PATH = previous;
  if (previousMode === undefined) delete process.env.AC_COMPACT_FIXTURE;
  else process.env.AC_COMPACT_FIXTURE = previousMode;
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  "PASS built-in command discovery/parsing, Claude discovery, Pi compaction, Codex completion confirmation, wrong-thread isolation, RPC errors and cancellation",
);
