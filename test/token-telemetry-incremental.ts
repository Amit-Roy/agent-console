// Incremental log tails must give exactly what a fresh full read gives, for appends, mid-line appends, shrinks and rewrites.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountingReplayer, accountingSamples } from "../server/accounting-log.ts";
import { raisedItems, raisedReplayer } from "../server/session-prs.ts";
import { createTelemetryService } from "../server/token-telemetry.ts";

const repo = "example-owner/agent-console";
const turn = (startTs: number, text: string, inTok: number) =>
  [
    JSON.stringify({ type: "user_input", ts: startTs, text }),
    JSON.stringify({
      type: "token_usage",
      input_tokens: inTok,
      cached_input_tokens: inTok / 2,
      output_tokens: 7,
    }),
    JSON.stringify({ type: "result", duration_ms: 5 }),
  ].join("\n");
const filedCommand = ["gh", "issue", "create", "--title", "x"].join(" ");
const filed = [
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: filedCommand } }],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "c1", content: `https://github.com/${repo}/issues/8` },
      ],
    },
  }),
];

// --- replayers: any split of the text into chunks gives the wrapper's output ---
const fixture = [
  turn(10, "look at #7 café", 400),
  filed[0],
  turn(20, "second \u{1F600}", 800),
  filed[1],
  turn(30, "third", 1200),
].join("\n");
const meta = { id: "t", provider: "codex", model: "gpt", createdAt: 0 };
for (let seed = 1; seed <= 25; seed++) {
  const samples = accountingReplayer(meta);
  const raised = raisedReplayer();
  let carry = "";
  let offset = 0;
  let step = seed * 7;
  while (offset < fixture.length) {
    const cut = Math.min(fixture.length, offset + (step % 97) + 1);
    step = (step * 31 + 11) % 1009;
    const parts = (carry + fixture.slice(offset, cut)).split("\n");
    carry = parts.pop() as string;
    for (const line of parts) {
      samples.feed(line);
      raised.feed(line);
    }
    offset = cut;
  }
  samples.feed(carry);
  raised.feed(carry);
  assert.deepEqual(samples.samples, accountingSamples(fixture, meta));
  assert.deepEqual(raised.raised, raisedItems(fixture));
}
assert.equal(accountingSamples(fixture, meta).length, 3);
assert.deepEqual(
  raisedItems(fixture).map((item) => item.number),
  [8],
);

// --- service: one long-lived incremental service vs a fresh full-read service ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-telemetry-inc-"));
fs.mkdirSync(path.join(dir, "logs"));
const logFile = path.join(dir, "logs", "inc.jsonl");
const threads = [
  { id: "inc", provider: "codex", model: "gpt", title: "T", createdAt: 0, defaultRepo: repo },
];
const store = new Map<number, { id: number; body: string; user: { login: string } }[]>();
const github = async (method: string, endpoint: string, body?: any) => {
  if (endpoint === "user") return { login: "bot" };
  if (/\/pulls\//.test(endpoint)) throw Object.assign(new Error("nf"), { status: 404 });
  const match = /issues\/(\d+)\/comments/.exec(endpoint);
  if (match && method === "GET") return store.get(Number(match[1])) ?? [];
  if (match && method === "POST") {
    store.set(Number(match[1]), [{ id: 1, body: body.body, user: { login: "bot" } }]);
    return {};
  }
  throw new Error(`unexpected ${method} ${endpoint}`);
};
const make = () =>
  createTelemetryService({
    repos: () => [repo],
    dataDir: dir,
    github: github as any,
    threads: () => threads,
  });
const incremental = make();
const bodyOf = async (svc: ReturnType<typeof make>, number: number) => {
  store.delete(number);
  await svc.syncByNumber(repo, number);
  return store.get(number)?.[0].body;
};
let tick = 1_700_000_000;
const stamp = () => fs.utimesSync(logFile, tick, tick++);
const check = async (label: string) => {
  for (const number of [7, 8]) {
    const fresh = await bodyOf(make(), number);
    assert.equal(await bodyOf(incremental, number), fresh, `${label} #${number}`);
  }
  return bodyOf(incremental, 7);
};

const second = turn(20, "more", 800);
fs.writeFileSync(logFile, `${turn(10, "see #7", 400)}\n${second.slice(0, -12)}`);
stamp();
const partial = await check("partial last line");
fs.appendFileSync(logFile, `${second.slice(-12)}\n${filed[0]}\n`);
stamp();
const completed = await check("line completed");
assert.notEqual(completed, partial);
fs.appendFileSync(logFile, `${filed[1]}\n${turn(30, `${"x".repeat(700_000)}é`, 1200)}`);
stamp();
await check("big multibyte line without trailing newline");
fs.appendFileSync(logFile, "\n");
stamp();
await check("newline after a complete tail");
fs.appendFileSync(logFile, turn(40, "tail", 100).slice(0, 30));
stamp();
await check("new partial");
fs.appendFileSync(logFile, " \n");
stamp();
await check("garbage line replaces partial");
const size = fs.statSync(logFile).size;
fs.writeFileSync(logFile, `${turn(10, "rewritten #7", 90)}\n`);
stamp();
assert.ok(fs.statSync(logFile).size < size);
await check("shrink");
fs.writeFileSync(logFile, `${turn(10, "rewritten #7", 90)}\n${turn(50, "more #7", 5000)}\n`);
stamp();
await check("in-place rewrite that grew");
fs.writeFileSync(logFile, fs.readFileSync(logFile, "utf8").replace("5000", "6000"));
stamp();
await check("same-size rewrite");
fs.rmSync(logFile);
assert.equal(await bodyOf(incremental, 7), await bodyOf(make(), 7));
console.log("token-telemetry-incremental ok");
