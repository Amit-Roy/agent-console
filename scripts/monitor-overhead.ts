// Measures what the workspace monitor costs: two scratch servers (mock agent, empty data dir, no live data) run side by side
// for the same time, one with AGENT_CONSOLE_MONITOR=off and one with the default monitor. CPU is read from /proc/<pid>/stat
// and RSS from /proc/<pid>/status every 5 s after a warm-up. Usage: node scripts/monitor-overhead.ts [seconds=240] [warmup=45]
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seconds = Number(process.argv[2] || 240), warmup = Number(process.argv[3] || 45);
const hz = 100; // USER_HZ on Linux
const free = () => new Promise<number>(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const proc = (pid: number) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024;
  return { cpuSec: (Number(stat[11]) + Number(stat[12])) / hz, rssMb: rss };
};
async function launch(label: string, monitor: "on" | "off") {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `ac-overhead-${label}-`));
  fs.mkdirSync(path.join(scratch, "data"), { mode: 0o700 }); fs.mkdirSync(path.join(scratch, "run"));
  const port = await free();
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: root, stdio: "ignore", env: { ...process.env, HOME: scratch, PORT: String(port), AGENT_CONSOLE_DATA: path.join(scratch, "data"), AGENT_CONSOLE_RUN: path.join(scratch, "run"), AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_MONITOR: monitor } });
  return { label, child, scratch, rss: [] as number[], start: undefined as undefined | { cpuSec: number }, end: undefined as undefined | { cpuSec: number } };
}
const runs = await Promise.all([launch("off", "off"), launch("on", "on")]);
await new Promise(r => setTimeout(r, warmup * 1000));
for (const r of runs) r.start = proc(r.child.pid!);
const t0 = Date.now();
for (let n = 0; n < seconds / 5; n++) {
  await new Promise(r => setTimeout(r, 5000));
  for (const r of runs) r.rss.push(proc(r.child.pid!).rssMb);
}
const wall = (Date.now() - t0) / 1000;
const out: Record<string, unknown> = { seconds: Math.round(wall), warmup, host: `${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GiB` };
for (const r of runs) {
  r.end = proc(r.child.pid!);
  const cpu = r.end.cpuSec - r.start!.cpuSec;
  out[r.label] = { cpuSeconds: +cpu.toFixed(2), cpuPercentOfOneCore: +(100 * cpu / wall).toFixed(3), rssMbMean: +(r.rss.reduce((a, b) => a + b, 0) / r.rss.length).toFixed(1), rssMbMax: +Math.max(...r.rss).toFixed(1) };
  r.child.kill("SIGTERM");
}
const on = out.on as any, off = out.off as any;
out.monitorCost = { cpuPercentOfOneCore: +(on.cpuPercentOfOneCore - off.cpuPercentOfOneCore).toFixed(3), rssMbMean: +(on.rssMbMean - off.rssMbMean).toFixed(1) };
console.log(JSON.stringify(out, null, 2));
await new Promise(r => setTimeout(r, 500));
for (const r of runs) fs.rmSync(r.scratch, { recursive: true, force: true });
