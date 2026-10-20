// Restart the agent-console server once every thread is idle, without the server's help (works on any version):
// connect as a client, watch thread status and the queues, then stop/start through bin/agent-console and verify.
// Run detached by `bin/agent-console restart-when-idle`; log goes to $RUN/idle-restart.log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = process.env.AGENT_CONSOLE_RUN || path.join(os.homedir(), ".cache", "agent-console");
const PORT = process.env.PORT || "7070";
const BIN = path.join(ROOT, "bin", "agent-console");
const pidFile = path.join(RUN, "pid");
const read = () => { try { return fs.readFileSync(pidFile, "utf8").trim(); } catch { return ""; } };
const original = read();
const auth = { origin: `http://127.0.0.1:${PORT}`, cookie: `ac_session=${makeToken()}` };
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: auth });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// background subagents run inside the agent process: a restart kills them even though their thread looks idle
const busy = (t) => t.status === "running" || t.background > 0;
let threads, queues = new Map(), durableQueues = false, idleSince = 0, restarting = false;
const give = (why, code) => { console.log(why); process.exit(code); };
const deadline = setTimeout(() => give("Waited 30 minutes; server left running.", 1), 30 * 60_000);
ws.on("error", (e) => give(`Could not connect: ${e.message}`, 1));
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === "hello") {
    threads = new Map(m.threads.map((t) => [t.id, t]));
    queues = new Map(Object.entries(m.queues || {}));
    durableQueues = !!m.features?.queueEditing; // queues survive a restart on newer servers, so they need not drain first
    console.log(`Waiting for ${m.threads.filter(busy).length} busy thread(s) (running turns or background subagents) before restarting pid ${original}.`);
  }
  if (m.t === "thread") threads?.set(m.thread.id, m.thread);
  if (m.t === "removed") { threads?.delete(m.thread); queues.delete(m.thread); }
  if (m.t === "queue") queues.set(m.thread, m.items || []);
});
const check = setInterval(async () => {
  if (restarting) return;
  if (read() !== original) give("Server was already restarted; nothing to do.", 0);
  if (!threads || [...threads.values()].some(busy) || (!durableQueues && [...queues.values()].some((q) => q.length))) { idleSince = 0; return; }
  idleSince ||= Date.now();
  if (Date.now() - idleSince < 1500) return; // a queued message may start the next turn right after one ends
  restarting = true;
  clearInterval(check); clearTimeout(deadline); ws.close();
  try {
    for (const dir of ["server", "server/providers"]) for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts"))) {
      const source = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, dir, f), "utf8"));
      execFileSync(process.execPath, ["--check", "--input-type=module"], { input: source, stdio: "pipe" });
    }
  } catch (e) { give(`Restart cancelled: the new code does not parse.\n${String(e.stderr ?? e).slice(0, 800)}`, 1); }
  // Syntax validation can take seconds. A different restart may have completed meanwhile.
  if (read() !== original) give("Server was already restarted; nothing to do.", 0);
  console.log("All threads idle. Restarting Agent Console.");
  console.log(execFileSync(BIN, ["stop"], { encoding: "utf8" }).trim());
  for (let i = 0; i < 100; i++) { try { process.kill(Number(original), 0); } catch { break; } await sleep(100); }
  const out = execFileSync(BIN, ["start"], { encoding: "utf8" });
  console.log(out.trim());
  if (!out.includes("up (pid")) give("Restart failed.", 1);
  const probe = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: auth });
  const t = setTimeout(() => give("Restart verification timed out.", 1), 10_000);
  probe.on("error", (e) => give(`Restart verification failed: ${e.message}`, 1));
  probe.on("message", (raw) => { if (JSON.parse(String(raw)).t === "hello") { clearTimeout(t); give("Restarted and answering.", 0); } });
}, 500);
