import { piRateEnv } from "../server/providers/pi-rate-env.ts";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const environment = piRateEnv({ NODE_OPTIONS: "--no-warnings", AGENT_CONSOLE_TOOL_URL: "http://example.test/gate", AGENT_CONSOLE_TOOL_TOKEN: "fixture" });
assert.match(environment.NODE_OPTIONS!, /--no-warnings --import=file:/);
assert.equal(environment.AGENT_CONSOLE_TOOL_TOKEN, "fixture");
const standalone = piRateEnv(environment, false);
assert.equal(standalone.AGENT_CONSOLE_TOOL_URL, undefined);
assert.equal(standalone.AGENT_CONSOLE_TOOL_TOKEN, undefined);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preload = pathToFileURL(path.join(root, "server/providers/pi-rate-preload.mjs")).href;
let sdk: string | undefined;
try {
  const piRequire = createRequire(path.join(os.homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent/package.json"));
  sdk = pathToFileURL(piRequire.resolve("openai")).href;
} catch {}
const actions: any[] = [];
const upstream: string[] = [];
let sdkAttempts = 0;
let websocketMessages = 0;
const websocketOrder: number[] = [];
const sockets = new Set<any>();
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url === "/gate/model_request") {
    assert.equal(req.headers["x-agent-console-tool"], "fixture-only");
    const value = JSON.parse(body);
    actions.push(value);
    if (value.action === "acquire") await new Promise(resolve => setTimeout(resolve, 35));
    res.end("{}");
    return;
  }
  if (req.url === "/failed/model_request") { res.writeHead(503).end(); return; }
  upstream.push(req.url!);
  if (req.url === "/v1/chat/completions" && ++sdkAttempts === 1) {
    res.writeHead(429, { "Content-Type": "application/json", "retry-after": "0" }).end(JSON.stringify({ error: { message: "fixture rate limit" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop", index: 0 }] }));
});
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const { WebSocketServer } = await import("ws");
const wss = new WebSocketServer({ server });
wss.on("connection", socket => socket.on("message", data => { websocketMessages++; const message = JSON.parse(String(data)); websocketOrder.push(message.seq ?? -1); socket.send(message.rateLimit ? JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }) : "OK"); }));
const childScript = `
import assert from 'node:assert/strict';
import http from 'node:http';
const base = ${JSON.stringify(base)};
const paths = ['/v1/responses','/v1/messages','/models/a:streamGenerateContent','/models/a:generateContent','/api/generate','/model/a/converse-stream','/publishers/anthropic/models/claude:streamRawPredict','/publishers/anthropic/models/claude:rawPredict'];
for (const p of paths) await fetch(base+p,{method:'POST',body:'{}'});
await fetch(new Request(base+'/vendor-custom',{method:'POST',body:JSON.stringify({model:'fixture',messages:[]})}));
await new Promise((resolve,reject)=>{
 const req=http.request(base+'/model/test/converse-stream',{method:'POST'},res=>{res.resume();res.on('end',resolve)});
 req.on('error',reject);req.end('{}');
});
const ws = new WebSocket(base.replace('http:','ws:')+'/ws');
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
for(let n=0;n<2;n++) await new Promise(resolve=>{ws.addEventListener('message',resolve,{once:true});ws.send(JSON.stringify({type:'response.create',model:'fixture',input:[]}));});
const replies=[];
ws.addEventListener('message',event=>replies.push(event.data));
const both = new Promise(resolve=>{let n=0;const received=()=>{if(++n===2){ws.removeEventListener('message',received);resolve()}};ws.addEventListener('message',received);});
ws.send(JSON.stringify({type:'response.create',seq:1,input:[]}));
ws.send(JSON.stringify({type:'response.create',seq:2,input:[],rateLimit:true}));
await both;
ws.close();
await fetch(base+'/catalog');
await fetch(base+'/gate/session_search',{method:'POST',body:'{}'});
await assert.rejects(fetch(base+'/v1/responses',{method:'POST',signal:AbortSignal.timeout(5)}), /abort|timeout/i);
${sdk ? `const {default: OpenAI} = await import(${JSON.stringify(sdk)});
const client = new OpenAI({apiKey:'fixture-only',baseURL:base+'/v1',maxRetries:1});
const answer = await client.chat.completions.create({model:'fixture',messages:[]});
assert.equal(answer.choices[0].message.content,'OK');` : ""}
process.env.AGENT_CONSOLE_TOOL_URL = base+'/failed';
const rejectedSocket = new WebSocket(base.replace('http:','ws:')+'/ws-failure');
await new Promise(resolve=>rejectedSocket.addEventListener('open',resolve,{once:true}));
const closed = new Promise(resolve=>rejectedSocket.addEventListener('close',resolve,{once:true}));
rejectedSocket.send(JSON.stringify({type:'response.create',input:[]}));
assert.equal((await closed).code,4001);
await assert.rejects(fetch(base+'/must-not-send',{method:'POST',body:JSON.stringify({model:'fixture',prompt:'test'})}), /broker failed/);
`;
try {
  const child = spawn(process.execPath, ["--import", preload, "--input-type=module", "--eval", childScript], {
    env: { ...process.env, NODE_OPTIONS: "", AGENT_CONSOLE_TOOL_URL: base + "/gate", AGENT_CONSOLE_TOOL_TOKEN: "fixture-only" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Pi preload test timed out")); }, 12_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(upstream.filter(url => url === "/v1/responses").length, 1, "aborted queue never sends upstream");
  assert.equal(upstream.includes("/must-not-send"), false, "broker failure blocks upstream");
  assert.equal(actions.filter(action => action.action === "acquire").length, 15 + (sdk ? 2 : 0));
  assert.equal(websocketMessages, 4, "reused WebSocket model messages each acquire a slot");
  assert.deepEqual(websocketOrder, [-1, -1, 1, 2], "queued WebSocket sends preserve order");
  assert.equal(actions.some(action => action.action === "cooldown" && action.retryAfter === undefined), true, "WebSocket rate limits update shared cooldown");
  assert.equal(upstream.includes("/model/test/converse-stream"), true);
  if (sdk) {
    assert.equal(sdkAttempts, 2, "installed Pi OpenAI SDK retry reaches the global gate again");
    assert.deepEqual(actions.filter(action => action.action === "cooldown" && action.retryAfter === "0"), [{ action: "cooldown", retryAfter: "0" }]);
  }
  console.log(`pi-rate-preload: provider paths, custom endpoints, cancellation, fail-closed broker${sdk ? ", installed Pi SDK retries" : " (Pi SDK not installed)"} passed`);
} finally {
  for (const client of wss.clients) client.terminate();
  wss.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
