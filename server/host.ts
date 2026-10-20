import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type express from "express";
import os from "node:os";
import { latestRates, mountRoots } from "./host-history.ts";

const PROC = "/proc";
const PAGE_SIZE = 4096;
const CLK_TCK = 100;
const SAMPLE_MS = 200;
const MAX_PROCS = 200;

const passwd = new Map<number, string>();
try {
  for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
    const p = line.split(":");
    if (p.length >= 3 && p[2] != null) passwd.set(Number(p[2]), p[0]);
  }
} catch {}
export function userOf(uid: number) { return passwd.get(uid) ?? String(uid); }

export interface CpuStat { total: number; idle: number; cores: { total: number; idle: number }[]; ts: number }

function readCpuStat(): CpuStat | null {
  try {
    const text = fs.readFileSync(path.join(PROC, "stat"), "utf8");
    let total = 0, idle = 0;
    const cores: { total: number; idle: number }[] = [];
    for (const line of text.split("\n")) {
      const m = /^cpu(\d*)\s+(.*)$/.exec(line);
      if (!m) continue;
      const vals = m[2].trim().split(/\s+/).map(Number);
      const sum = vals.reduce((a, b) => a + b, 0);
      const idleTicks = Number(vals[3]) || 0;
      if (m[1] === "") { total = sum; idle = idleTicks; }
      else cores.push({ total: sum, idle: idleTicks });
    }
    return { total, idle, cores, ts: Date.now() };
  } catch { return null; }
}

export interface Proc {
  pid: number; ppid: number; name: string; state: string; uid: number;
  utime: number; stime: number; starttime: number; rssPages: number;
  threads: number; nice: number; cmd: string; label: string; cwd: string;
  cpu?: number; memPct?: number;
}

const HOME = os.homedir();
const INTERPRETERS = /^(node|nodejs|bun|deno|tsx|ts-node|python[\d.]*|pypy[\d.]*|ruby|perl|php|java|sh|bash|zsh|dash|uv|uvx|npx|npm|pnpm|yarn)$/;
const tildify = (p: string) => p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
const tail = (p: string, n = 2) => p.split("/").filter(Boolean).slice(-n).join("/") || p;

/* Human label from argv: interpreters show the script they run, everything else its executable,
   plus the first plain word after it (a subcommand such as "proxy" or "agent"). */
export function procLabel(argv: string[], comm: string): string {
  if (!argv.length) return comm;
  let i = 0;
  let head = path.basename(argv[0]);
  if (INTERPRETERS.test(head)) {
    for (let j = 1; j < argv.length; j++) {
      const a = argv[j];
      if (a === "-m" || a === "-c" || a === "-e") { if (a === "-m" && argv[j + 1]) { head = argv[j + 1]; i = j + 1; } break; }
      if (a.startsWith("-")) continue;
      head = a.includes("/") ? tail(a, a.startsWith("/") ? 1 : 2) : a; i = j; break;
    }
  }
  const next = argv[i + 1];
  const sub = next && /^[a-z][\w:-]{1,20}$/i.test(next) ? " " + next : "";
  return (head + sub).slice(0, 48);
}

function readProcStat(pid: string, memTotal: number): Proc | null {
  try {
    const dir = path.join(PROC, pid);
    const line = fs.readFileSync(path.join(dir, "stat"), "utf8");
    const end = line.lastIndexOf(")");
    if (end < 0) return null;
    const rest = line.slice(end + 2).trim().split(/\s+/);
    let rssPages = 0;
    try { rssPages = Number(fs.readFileSync(path.join(dir, "statm"), "utf8").trim().split(/\s+/)[1]) || 0; } catch {}
    let uid = 0;
    try {
      const m = /^Uid:\s+(\d+)/.exec(fs.readFileSync(path.join(dir, "status"), "utf8"));
      if (m) uid = Number(m[1]);
    } catch {}
    let argv: string[] = [];
    try { argv = fs.readFileSync(path.join(dir, "cmdline"), "utf8").split("\0").filter(Boolean); } catch {}
    const cmd = argv.join(" ").replace(/\s+/g, " ").trim();
    const name = line.slice(line.indexOf("(") + 1, end).replace(/\s+/g, " ") || `pid ${pid}`;
    let cwd = "";
    try { cwd = tildify(fs.readlinkSync(path.join(dir, "cwd"))); } catch {}
    return {
      pid: Number(pid), ppid: Number(rest[1]) || 0, name, state: rest[0] || "?", uid,
      utime: Number(rest[11]) || 0, stime: Number(rest[12]) || 0,
      starttime: Number(rest[19]) || 0, rssPages, threads: Number(rest[17]) || 1,
      nice: Number(rest[16]) || 0, cmd: cmd || `(${name})`, label: procLabel(argv, name), cwd,
      memPct: memTotal > 0 ? (rssPages * PAGE_SIZE) / memTotal * 100 : 0,
    };
  } catch { return null; }
}

function readAllProcs(memTotal: number): Proc[] {
  const out: Proc[] = [];
  try {
    for (const entry of fs.readdirSync(PROC, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pid = Number(entry.name);
      if (!Number.isFinite(pid)) continue;
      const p = readProcStat(entry.name, memTotal);
      if (p) out.push(p);
    }
  } catch {}
  return out;
}

function readMeminfo(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const line of fs.readFileSync(path.join(PROC, "meminfo"), "utf8").split("\n")) {
      const [key, rest] = line.split(":");
      const v = Number(rest?.match(/\d+/)?.[0]);
      if (key && Number.isFinite(v)) out[key.trim()] = v * 1024;
    }
  } catch {}
  return out;
}

function readUptime(): number {
  try { return Number(fs.readFileSync(path.join(PROC, "uptime"), "utf8").split(" ")[0]) || 0; } catch { return 0; }
}

function readLoadavg(): number[] {
  try { return fs.readFileSync(path.join(PROC, "loadavg"), "utf8").trim().split(/\s+/).slice(0, 3).map(Number); } catch { return [0, 0, 0]; }
}

export function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

/* Two /proc/stat samples spaced by SAMPLE_MS, then every /proc pid sampled before and after
   so per-process CPU% is a real utilisation figure, not an instantaneous snapshot. */
export async function hostSnapshot(): Promise<{ cpu: CpuStat | null; procs: Proc[]; mem: Record<string, number> }> {
  const mem = readMeminfo();
  const cpu1 = readCpuStat();
  const procs1 = readAllProcs(mem.MemTotal ?? 0);
  await sleep(SAMPLE_MS);
  const cpu2 = readCpuStat();
  const procs2 = readAllProcs(mem.MemTotal ?? 0);
  const before = new Map(procs1.map(p => [p.pid, p]));
  const out: Proc[] = [];
  for (const p2 of procs2) {
    const p1 = before.get(p2.pid);
    if (!p1) continue;
    let cpu = 0;
    if (cpu1 && cpu2) {
      const dTotal = cpu2.total - cpu1.total;
      const dProc = (p2.utime + p2.stime) - (p1.utime + p1.stime);
      cpu = dTotal > 0 ? Math.max(0, (dProc / dTotal) * 100) : 0;
    }
    out.push({ ...p2, cpu });
  }
  out.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
  return { cpu: cpu2, procs: out.slice(0, MAX_PROCS), mem };
}

export interface DiskRow { source: string; fstype: string; size: number; used: number; avail: number; pcent: number; target: string }

/* Root plus every real directory mount. Mounts that report identical numbers share one disk
   (the overlay root and /home/coder both sit on the same device here), so they merge into one row. */
export function diskRows(): DiskRow[] {
  const out: DiskRow[] = [];
  try {
    const txt = execFileSync("df", ["--output=source,fstype,size,used,avail,pcent,target", "/", ...mountRoots()], { encoding: "utf8", maxBuffer: 4 << 20 });
    for (const line of txt.trim().split("\n").slice(1)) {
      const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line);
      if (!m || Number(m[3]) === 0) continue;
      const row = { source: m[1], fstype: m[2], size: Number(m[3]) * 1024, used: Number(m[4]) * 1024, avail: Number(m[5]) * 1024, pcent: Number(m[6]), target: m[7] };
      const same = out.find(d => d.size === row.size && d.used === row.used);
      if (same) { if (!same.target.split(" · ").includes(row.target)) same.target += ` · ${row.target}`; }
      else out.push(row);
    }
  } catch {}
  return out;
}

function sameOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    if (new URL(String(req.headers.origin)).host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: "Cross-site request refused." });
}

/* ---------- endpoints ---------- */

export function hostMetrics(req: express.Request, res: express.Response) {
  res.setHeader("Cache-Control", "no-store");
  (async () => {
    const c1 = readCpuStat();
    await sleep(SAMPLE_MS);
    const c2 = readCpuStat();
    const mem = readMeminfo();
    const disk = diskRows();
    const uptimeSec = readUptime();
    const load = readLoadavg();
    const memTotal = mem.MemTotal ?? 0;
    const memAvailable = mem.MemAvailable ?? 0;
    const memUsed = memTotal - memAvailable;
    let cpuTotal = 0;
    const cpuCores: number[] = [];
    if (c1 && c2) {
      const dTotal = c2.total - c1.total;
      const dIdle = c2.idle - c1.idle;
      cpuTotal = dTotal > 0 ? Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal))) : 0;
      for (let i = 0; i < c2.cores.length; i++) {
        const c = c2.cores[i]; const p = c1.cores[i];
        const d = c.total - (p?.total ?? 0);
        const di = c.idle - (p?.idle ?? 0);
        cpuCores.push(d > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / d))) : 0);
      }
    }
    res.json({
      cpu: { total: cpuTotal, cores: cpuCores, n: cpuCores.length },
      load,
      mem: { total: memTotal, available: memAvailable, used: memUsed, pct: memTotal > 0 ? memUsed / memTotal * 100 : 0, swapTotal: mem.SwapTotal ?? 0, swapFree: mem.SwapFree ?? 0 },
      disk,
      io: latestRates(),
      uptime: uptimeSec, boot: Date.now() - uptimeSec * 1000,
      platform: process.platform, arch: process.arch,
    });
  })().catch(() => res.status(503).json({ error: "Host metrics are unavailable." }));
}

export async function hostProcesses(req: express.Request, res: express.Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { procs } = await hostSnapshot();
    res.json({ processes: procs.map(p => ({
      pid: p.pid, ppid: p.ppid, name: p.name, user: userOf(p.uid), state: p.state,
      cpu: p.cpu ?? 0, mem: p.memPct ?? 0, rss: p.rssPages * PAGE_SIZE,
      threads: p.threads, nice: p.nice, cmd: p.cmd.slice(0, 400), label: p.label, cwd: p.cwd,
    })) });
  } catch { res.status(503).json({ error: "Process list is unavailable." }); }
}

function readListeningSockets(): { port: number; proto: string; inode: number; uid: number }[] {
  const out: { port: number; proto: string; inode: number; uid: number }[] = [];
  for (const proto of ["tcp", "tcp6"]) {
    try {
      const text = fs.readFileSync(path.join(PROC, `net/${proto}`), "utf8");
      for (const line of text.trim().split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f[3] !== "0A") continue; // 0A = LISTEN
        const port = Number.parseInt(f[1].split(":")[1] ?? "", 16);
        const uid = Number(f[9]) || 0;
        let inode = Number(f[11]) || 0;
        if (!inode) for (let i = f.length - 1; i >= 8; i--) { const v = Number(f[i]); if (v > 1024) { inode = v; break; } }
        if (Number.isFinite(port) && inode) out.push({ port, proto, inode, uid });
      }
    } catch {}
  }
  return out;
}

function inodeOwners(): Map<number, { pid: number; cmd: string; uid: number }> {
  const map = new Map<number, { pid: number; cmd: string; uid: number }>();
  try {
    for (const entry of fs.readdirSync(PROC, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pid = Number(entry.name);
      if (!Number.isFinite(pid)) continue;
      try {
        const fds = fs.readdirSync(path.join(PROC, entry.name, "fd"));
        for (const fd of fds) {
          let target = "";
          try { target = fs.readlinkSync(path.join(PROC, entry.name, "fd", fd)); } catch { continue; }
          const m = /^socket:\[(\d+)\]$/.exec(target);
          if (m) map.set(Number(m[1]), { pid, cmd: "", uid: 0 });
        }
      } catch {}
    }
  } catch {}
  return map;
}

export function hostPorts(req: express.Request, res: express.Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const owners = inodeOwners();
    const sockets = readListeningSockets();
    const portList = sockets.map(s => {
      const pidOwner = owners.get(s.inode);
      let cmd = "", uid = 0;
      if (pidOwner) {
        try { cmd = fs.readFileSync(path.join(PROC, String(pidOwner.pid), "cmdline"), "utf8").replace(/\0/g, " ").trim(); } catch {}
        uid = pidOwner.uid;
      }
      const argv = cmd.split(" ").filter(Boolean);
      return { port: s.port, proto: s.proto, pid: pidOwner?.pid ?? 0, cmd: cmd.slice(0, 400), label: procLabel(argv, ""), user: pidOwner ? userOf(pidOwner.uid) : "" };
    }).filter(p => p.pid > 0 || p.cmd.length > 0)
      .filter((p, i, all) => all.findIndex(q => q.port === p.port && q.pid === p.pid) === i)
      .sort((a, b) => a.port - b.port);
    res.json({ ports: portList });
  } catch { res.status(503).json({ error: "Port information is unavailable." }); }
}

export async function hostProcessDetail(req: express.Request, res: express.Response) {
  res.setHeader("Cache-Control", "no-store");
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: "Invalid pid." });
  try {
    const p = readProcStat(String(pid), 0);
    if (!p) return res.status(404).json({ error: "Process not found." });
    const mem = readMeminfo();
    const memTotal = mem.MemTotal ?? 0;
    const uptimeSec = readUptime();
    const startedMs = uptimeSec > 0 && p.starttime > 0
      ? Date.now() - (uptimeSec * 1000 - p.starttime / CLK_TCK * 1000)
      : 0;
    const upSec = startedMs > 0 ? Math.max(0, (Date.now() - startedMs) / 1000) : 0;
    const h = Math.floor(upSec / 3600), min = Math.floor((upSec % 3600) / 60), s = Math.floor(upSec % 60);
    const status: Record<string, string> = {};
    try {
      for (const line of fs.readFileSync(path.join(PROC, String(pid), "status"), "utf8").split("\n")) {
        const m = /^([A-Z]+):\s+(.*)$/.exec(line);
        if (m) status[m[1]] = m[2];
      }
    } catch {}
    let children: { pid: number; name: string; cmd: string }[] = [];
    try {
      for (const entry of fs.readdirSync(PROC, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const cpid = Number(entry.name);
        if (!Number.isFinite(cpid) || cpid === pid) continue;
        try {
          const cl = fs.readFileSync(path.join(PROC, entry.name, "stat"), "utf8");
          const end = cl.lastIndexOf(")");
          const rest = cl.slice(end + 2).trim().split(/\s+/);
          if (Number(rest[1]) === pid) {
            const cname = cl.slice(cl.indexOf("(") + 1, end).replace(/\s+/g, " ");
            let ccmd = "";
            try { ccmd = fs.readFileSync(path.join(PROC, entry.name, "cmdline"), "utf8").replace(/\0/g, " ").trim(); } catch {}
            children.push({ pid: cpid, name: procLabel(ccmd.split(" ").filter(Boolean), cname || `pid ${cpid}`), cmd: (ccmd || `(${cname})`).slice(0, 400) });
          }
        } catch {}
      }
    } catch {}
    let ports: number[] = [];
    try {
      const fds = fs.readdirSync(path.join(PROC, String(pid), "fd"));
      const inodes = new Set<number>();
      for (const fd of fds) {
        let target = "";
        try { target = fs.readlinkSync(path.join(PROC, String(pid), "fd", fd)); } catch { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m) inodes.add(Number(m[1]));
      }
      if (inodes.size) {
        for (const proto of ["tcp", "tcp6"]) {
          try {
            const text = fs.readFileSync(path.join(PROC, `net/${proto}`), "utf8");
            for (const line of text.trim().split("\n").slice(1)) {
              const f = line.trim().split(/\s+/);
              if (f[3] !== "0A") continue;
              const inode = Number(f[11]) || 0;
              if (inode && inodes.has(inode)) {
                const port = Number.parseInt(f[1].split(":")[1] ?? "", 16);
                if (Number.isFinite(port)) ports.push(port);
              }
            }
          } catch {}
        }
      }
    } catch {}
    res.json({
      pid: p.pid, ppid: p.ppid, name: p.name, state: p.state, uid: p.uid,
      user: userOf(p.uid), cmd: p.cmd.slice(0, 4000), label: p.label, cwd: p.cwd, threads: p.threads, nice: p.nice,
      cpu: p.cpu ?? 0, memPct: p.memPct ?? 0, rss: p.rssPages * PAGE_SIZE,
      starttime: p.starttime, uptime: `${h}h ${min}m ${s}s`, startedMs,
      tgid: status.Tgid ?? "", ngid: status.Ngid ?? "", pidns: status.PidNS ?? "",
      children, ports: [...new Set(ports)].sort((a, b) => a - b),
    });
  } catch { res.status(503).json({ error: "Process detail is unavailable." }); }
}

export function hostKill(req: express.Request, res: express.Response) {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid) || pid <= 1) return res.status(400).json({ error: "Invalid pid." });
  const signal = String(req.body?.signal ?? "SIGTERM");
  if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(signal)) return res.status(400).json({ error: "Unsupported signal." });
  try { process.kill(pid, 0); } catch { return res.status(404).json({ error: "Process not found." }); }
  try {
    process.kill(pid, signal as NodeJS.Signals);
    res.json({ ok: true, pid, signal });
  } catch (e: any) {
    if (e.code === "EPERM") return res.status(403).json({ error: "Not permitted to signal this process." });
    res.status(500).json({ error: e?.message || "Could not signal process." });
  }
}

export { sameOrigin };
