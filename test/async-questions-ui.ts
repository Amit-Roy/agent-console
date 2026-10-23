import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WebSocket } from "ws";

// Exercise the real Codex adapter and server with app-server wire messages. No inference or live sessions.
const root = process.env.AGENT_CONSOLE_TEST_ROOT || fileURLToPath(new URL("../", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-async-question-ui-"));
const data = path.join(scratch, "data"),
  bin = path.join(scratch, "bin"),
  codexHome = path.join(scratch, "codex");
for (const dir of [data, bin, codexHome]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 }); // readiness marker; no credentials
const rpcLog = path.join(scratch, "rpc.jsonl");
const questionTitle = "Which version should I prepare?";
const freeTitle = "Anything else I should account for?";
const fallback = "FALLBACK_PLAINTEXT_QUESTION_MUST_NOT_RENDER";
fs.writeFileSync(
  path.join(bin, "codex"),
  `#!${process.execPath}
const fs=require('node:fs');let buffer='',thread='fixture-'+process.pid,serial=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const record=m=>fs.appendFileSync(${JSON.stringify(rpcLog)},JSON.stringify(m)+'\\n');
process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||thread;send({id:m.id,result:{thread:{id:thread}}});}
if(m.method==='turn/start'){
const text=m.params.input[0].text,turn='turn-'+(++serial);record({method:m.method,thread,text});
send({id:m.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
if(text.startsWith('ask async ')){
const item={type:'agentMessage',id:'async-question-'+thread,text:${JSON.stringify(fallback)},questions:[{title:${JSON.stringify(questionTitle)},options:['Quick pass','Full review']},{title:${JSON.stringify(freeTitle)},options:null}]};
send({method:'item/started',params:{threadId:thread,item}});
send({method:'item/completed',params:{threadId:thread,item}});
send({method:'item/completed',params:{threadId:thread,item}}); // duplicate notification must not duplicate the picker
}else send({method:'item/completed',params:{threadId:thread,item:{type:'agentMessage',id:'answer-'+thread,text:'Native Codex continuation received.'}}});
send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
if(text.startsWith('ask async '))setTimeout(()=>{record({method:'fixture/exited',thread});process.exit(0);},40);
}
if(m.method==='turn/steer'){record({method:m.method,thread,text:m.params.input[0].text});send({id:m.id,result:{turnId:m.params.expectedTurnId}});}
}});
`,
  { mode: 0o700 },
);
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_ENV_FILES = path.join(scratch, "no-env");
process.env.AGENT_CONSOLE_AUTH = "password";
const { makeToken } = await import("../server/auth.ts");
const port = process.env.ASYNC_TEST_PORT || "7075",
  base = `http://127.0.0.1:${port}`;
const serverEnv = {
  PATH: bin + path.delimiter + process.env.PATH,
  HOME: os.homedir(),
  NODE_NO_WARNINGS: "1",
  CODEX_HOME: codexHome,
  PORT: port,
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_RUN: path.join(scratch, "run"),
  AGENT_CONSOLE_AUTH: "password",
  AGENT_CONSOLE_ENV_FILES: path.join(scratch, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(scratch, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_HEADROOM: "0",
  AGENT_CONSOLE_LABELS: "0",
};
let server: ChildProcess | undefined;
let serverOutput = "";
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => unknown, message: string) => {
  for (let n = 0; n < 400; n++) {
    const result = test();
    if (result) return result;
    await pause();
  }
  throw Error(message);
};
const nativeRows = () =>
  fs.existsSync(rpcLog)
    ? fs
        .readFileSync(rpcLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s))
    : [];
async function start() {
  serverOutput = "";
  server = spawn(process.execPath, ["server/index.ts"], {
    cwd: root,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr])
    stream?.on("data", (b) => {
      serverOutput = (serverOutput + b).slice(-3000);
    });
  for (let n = 0; n < 400; n++) {
    assert.equal(server.exitCode, null, `scratch server failed: ${serverOutput}`);
    try {
      if ((await fetch(base + "/login")).status === 200) return;
    } catch {}
    await pause();
  }
  throw Error("Scratch server did not become ready");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  child.kill("SIGTERM");
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "Scratch server did not stop",
  );
  server = undefined;
}
const sockets: WebSocket[] = [];
function connect() {
  const inbox: any[] = [];
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", {
    headers: { origin: base, cookie: `ac_session=${makeToken()}` },
  });
  sockets.push(ws);
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const wait = async (pred: (m: any) => boolean) => {
    let result: any;
    await until(() => {
      const i = inbox.findIndex(pred);
      if (i < 0) return false;
      result = inbox.splice(i, 1)[0];
      return true;
    }, "Timed out waiting for async question protocol");
    return result;
  };
  return { ws, wait, inbox };
}
const browser = await chromium.launch();
try {
  await start();
  for (const width of [1280, 390]) {
    let channel = connect();
    await channel.wait((m) => m.t === "hello");
    channel.ws.send(
      JSON.stringify({
        t: "create",
        provider: "codex",
        cwd: root,
        mode: "bypassPermissions",
        title: `Async Codex ${width}`,
      }),
    );
    const made = await channel.wait((m) => m.t === "created" || m.t === "error");
    assert.equal(made.t, "created", made.message);
    const id = made.thread.id;
    channel.ws.send(JSON.stringify({ t: "send", thread: id, text: `ask async ${width}` }));
    const asked = await channel.wait(
      (m) => m.t === "event" && m.thread === id && m.event.type === "question",
    );
    assert.equal(asked.event.async, true);
    assert.deepEqual(
      asked.event.questions.map((q: any) => q.question),
      [questionTitle, freeTitle],
    );
    await channel.wait((m) => m.t === "event" && m.thread === id && m.event.type === "result");
    const initial = nativeRows().find((r) => r.text === `ask async ${width}`);
    assert.ok(initial);
    await until(
      () => nativeRows().some((r) => r.method === "fixture/exited" && r.thread === initial.thread),
      "fake app-server did not exit",
    );
    if (width === 1280) {
      channel.ws.close();
      await stop();
      await start(); // pending async requests survive a complete Console restart
    }
    const reconnect = connect();
    const hello = await reconnect.wait((m) => m.t === "hello");
    assert.equal(
      hello.questions[id].length,
      1,
      "completed/native-exited requests remain pending exactly once",
    );
    assert.equal(hello.questions[id][0].id, asked.event.id);
    assert.equal(hello.threads.find((t: any) => t.id === id).waiting, 1);
    channel = reconnect;
    channel.ws.send(JSON.stringify({ t: "open", thread: id }));
    const history = await channel.wait((m) => m.t === "history" && m.thread === id);
    assert.equal(history.questions.length, 1);
    assert.equal(
      history.events.filter((e: any) => e.type === "question").length,
      1,
      "duplicate native completion emits one canonical question",
    );
    assert.equal(
      history.events.some(
        (e: any) => e.type === "assistant" && JSON.stringify(e).includes(fallback),
      ),
      false,
    );

    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await ctx.addInitScript((id) => localStorage.setItem("ac_thread", id), id);
    const page = await ctx.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    const active = page.locator(".question-card:not(.question-summary)");
    await active.waitFor();
    assert.equal(await active.count(), 1);
    assert.match(await active.innerText(), new RegExp(questionTitle.replace("?", "\\?")));
    assert.equal((await page.locator("#chat").innerText()).includes(fallback), false);
    if (process.env.SCREENSHOTS) {
      fs.mkdirSync(process.env.SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.SCREENSHOTS, `async-question-${width}.png`),
        fullPage: true,
      });
    }
    await active.getByRole("radio", { name: "Full review", exact: true }).check();
    await active.getByRole("button", { name: "Continue", exact: true }).click();
    await active
      .getByRole("textbox", { name: "Your answer", exact: true })
      .fill("Keep the mobile layout readable");
    await active.getByRole("button", { name: "Send answer", exact: true }).click();
    const answered = await channel.wait(
      (m) =>
        m.t === "event" &&
        m.thread === id &&
        m.event.type === "question_answer" &&
        !m.event.cancelled,
    );
    assert.deepEqual(Object.values(answered.event.answers), [
      ["Full review"],
      ["Keep the mobile layout readable"],
    ]);
    await channel.wait((m) => m.t === "event" && m.thread === id && m.event.type === "result");
    await page.locator(".question-summary").waitFor();
    assert.equal(await active.count(), 0);
    const native = nativeRows().filter(
      (r) => ["turn/start", "turn/steer"].includes(r.method) && r.thread === initial.thread,
    );
    assert.equal(native.length, 2, "the answer reaches native Codex once as a second turn");
    assert.equal(native[1].method, "turn/start");
    assert.match(native[1].text, /Full review/);
    assert.match(native[1].text, /Keep the mobile layout readable/);
    channel.ws.send(
      JSON.stringify({
        t: "answer",
        thread: id,
        id: asked.event.id,
        answers: answered.event.answers,
        request: `duplicate-${width}`,
      }),
    );
    await channel.wait((m) => m.t === "answer_error" && m.request === `duplicate-${width}`);
    await pause(80);
    assert.equal(
      nativeRows().filter(
        (r) => ["turn/start", "turn/steer"].includes(r.method) && r.thread === initial.thread,
      ).length,
      2,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    await ctx.close();
    channel.ws.send(JSON.stringify({ t: "delete", thread: id }));
    await channel.wait((m) => m.t === "removed" && m.thread === id);
    console.log(
      `PASS ${width}px native Codex async metadata: picker after result/process exit${width === 1280 ? "/server restart" : ""}, no fallback plaintext, one resumed native turn, duplicate answer rejected`,
    );
  }
} finally {
  for (const ws of sockets) ws.terminate();
  await browser.close();
  await stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
