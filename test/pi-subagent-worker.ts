import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-mock-"));
process.env.AGENT_CONSOLE_DATA = path.join(tmp, "data");
process.env.AGENT_CONSOLE_RATE_URL = "http://127.0.0.1:9/model-request"; // the server sets these; the mock pi never calls a model
process.env.AGENT_CONSOLE_RATE_TOKEN = "test-token-0123456789";
process.env.PATH = `${tmp}/bin:${process.env.PATH}`;
fs.mkdirSync(`${tmp}/bin`, { recursive: true });

// Mock pi (RPC): records argv, answers one prompt with assistant text + usage. It writes no files: the worker must.
fs.writeFileSync(
  `${tmp}/bin/pi`,
  `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(tmp, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
const out = (o) => console.log(JSON.stringify(o));
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const r = JSON.parse(l);
  if (r.type !== "prompt") return;
  if (r.message.includes("CRASH")) { console.error("boom"); process.exit(3); }
  if (r.message.includes("HANG")) return;
  out({ id: r.id, type: "response", command: "prompt", success: true });
  out({ type: "agent_start" });
  out({ type: "message_end", message: { role: "assistant", model: "nemotron", content: [{ type: "text", text: "# Findings\\nQuantum result with sources" }], stopReason: "stop", usage: { input: 1200, output: 300, cacheRead: 50, cacheWrite: 0, cost: { total: 0 } } } });
  out({ type: "agent_settled" });
});
`,
  { mode: 0o755 },
);

const { runPiResearch, researchToolText } = await import("../server/pi-subagent-worker.ts");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cwd-"));

// success: worker (not pi) writes notes + index; project folder stays untouched; usage is attributed to pi
const ok = await runPiResearch({
  version: 1,
  task: "Research quantum computing",
  cwd,
  caller: { thread: "t1", provider: "claude" },
});
assert.equal(ok.version, 1);
assert.equal(ok.phase, "completed", ok.error);
assert.equal(ok.provider, "pi");
assert.ok(
  ok.notesPath.startsWith(path.join(tmp, "data")),
  "outputs live under the console data dir",
);
assert.equal(fs.readFileSync(ok.notesPath, "utf8"), ok.finalText);
assert.match(fs.readFileSync(ok.notesPath, "utf8"), /Quantum result/);
const index = JSON.parse(fs.readFileSync(ok.indexPath, "utf8"));
assert.equal(index.task, "Research quantum computing");
assert.equal(index.provider, "pi");
assert.equal(index.caller.provider, "claude");
assert.deepEqual(fs.readdirSync(cwd), [], "project folder not written");
assert.equal(ok.usage.output, 300);
assert.equal(ok.usage.input, 1250);
const argv = JSON.parse(fs.readFileSync(path.join(tmp, "argv.json"), "utf8"));
assert.equal(
  argv[argv.indexOf("--tools") + 1],
  "read,grep,find,ls",
  "research subagent is read-only",
);
assert.ok(
  !argv.some((a: string) => a.includes("console-tools")),
  "pi subagent cannot recurse into console tools",
);

// telemetry ledger: one row per run, caller vs pi attribution
const ledgerFile = path.join(tmp, "data", "pi-research-usage.jsonl");
const ledger = fs
  .readFileSync(ledgerFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
assert.equal(ledger.length, 1);
assert.equal(ledger[0].caller.provider, "claude");
assert.equal(ledger[0].pi.output, 300);

// tool text hands the caller the answer and the paths
const text = researchToolText(ok);
assert.match(text, /Quantum result/);
assert.ok(text.includes(ok.notesPath));

// failures: crash, timeout, empty task, bad cwd
const crashed = await runPiResearch({ task: "CRASH please", cwd });
assert.equal(crashed.phase, "failed");
assert.match(crashed.error!, /boom|exit/);
const hung = await runPiResearch({ task: "HANG", cwd, timeoutMs: 700 });
assert.equal(hung.phase, "failed");
assert.match(hung.error!, /timed out/);
await assert.rejects(runPiResearch({ task: "  ", cwd }), /must not be empty/);
await assert.rejects(
  runPiResearch({ task: "x", cwd: path.join(cwd, "missing") }),
  /cwd not accessible/,
);

console.log(
  "pi-subagent-worker: read-only pi run, worker-written notes/index, usage ledger, failure paths pass",
);
process.exit(0);
