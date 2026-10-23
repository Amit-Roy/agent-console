import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { Worker } from "node:worker_threads";
import os from "node:os";
import { latestRates, mountRoots } from "./host-history.ts";

const PROC = "/proc";
const PAGE_SIZE = 4096;
const CLK_TCK = 100;
const MAX_PROCS = 200;

const passwd = new Map<number, string>();
try {
  for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
    const p = line.split(":");
    if (p.length >= 3 && p[2] != null) passwd.set(Number(p[2]), p[0]);
  }
} catch {}
export function userOf(uid: number) {
  return passwd.get(uid) ?? String(uid);
}

export interface CpuStat {
  total: number;
  idle: number;
  cores: { total: number; idle: number }[];
  ts: number;
}

function readCpuStat(): CpuStat | null {
  try {
    const text = fs.readFileSync(path.join(PROC, "stat"), "utf8");
    let total = 0,
      idle = 0;
    const cores: { total: number; idle: number }[] = [];
    for (const line of text.split("\n")) {
      const m = /^cpu(\d*)\s+(.*)$/.exec(line);
      if (!m) continue;
      const vals = m[2].trim().split(/\s+/).map(Number);
      const sum = vals.reduce((a, b) => a + b, 0);
      const idleTicks = Number(vals[3]) || 0;
      if (m[1] === "") {
        total = sum;
        idle = idleTicks;
      } else cores.push({ total: sum, idle: idleTicks });
    }
    return { total, idle, cores, ts: Date.now() };
  } catch {
    return null;
  }
}

export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  uid: number;
  utime: number;
  stime: number;
  starttime: number;
  rssPages: number;
  threads: number;
  nice: number;
  cmd: string;
  label: string;
  cwd: string;
  cpu?: number;
  memPct?: number;
}

const HOME = os.homedir();
const INTERPRETERS =
  /^(node|nodejs|bun|deno|tsx|ts-node|python[\d.]*|pypy[\d.]*|ruby|perl|php|java|sh|bash|zsh|dash|uv|uvx|npx|npm|pnpm|yarn)$/;
const tildify = (p: string) =>
  p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
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
      if (a === "-m" || a === "-c" || a === "-e") {
        if (a === "-m" && argv[j + 1]) {
          head = argv[j + 1];
          i = j + 1;
        }
        break;
      }
      if (a.startsWith("-")) continue;
      head = a.includes("/") ? tail(a, a.startsWith("/") ? 1 : 2) : a;
      i = j;
      break;
    }
  }
  const next = argv[i + 1];
  const sub = next && /^[a-z][\w:-]{1,20}$/i.test(next) ? " " + next : "";
  return (head + sub).slice(0, 48);
}

/* uid, argv and cwd never change for a live process, so they are read once per pid+starttime. */
const slow = new Map<string, { uid: number; cmd: string; label: string; cwd: string }>();

function readProcStat(pid: string, memTotal: number): Proc | null {
  const dir = path.join(PROC, pid);
  try {
    const line = fs.readFileSync(path.join(dir, "stat"), "utf8");
    const end = line.lastIndexOf(")");
    if (end < 0) return null;
    const rest = line
      .slice(end + 2)
      .trim()
      .split(/\s+/);
    const name = line.slice(line.indexOf("(") + 1, end).replace(/\s+/g, " ") || `pid ${pid}`;
    const starttime = Number(rest[19]) || 0;
    // statm's second field is resident pages; stat's field 24 (rest[21]) is the same number
    const rssPages = Number(rest[21]) || 0;
    const key = `${pid}:${starttime}`;
    let info = slow.get(key);
    if (!info) {
      let uid = 0;
      try {
        const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(path.join(dir, "status"), "utf8"));
        if (m) uid = Number(m[1]);
      } catch {}
      let argv: string[] = [];
      try {
        argv = fs.readFileSync(path.join(dir, "cmdline"), "utf8").split("\0").filter(Boolean);
      } catch {}
      let cwd = "";
      try {
        cwd = tildify(fs.readlinkSync(path.join(dir, "cwd")));
      } catch {}
      const cmd = argv.join(" ").replace(/\s+/g, " ").trim().slice(0, 4000);
      info = { uid, cmd: cmd || `(${name})`, label: procLabel(argv, name), cwd };
      slow.set(key, info);
    }
    return {
      pid: Number(pid),
      ppid: Number(rest[1]) || 0,
      name,
      state: rest[0] || "?",
      uid: info.uid,
      utime: Number(rest[11]) || 0,
      stime: Number(rest[12]) || 0,
      starttime,
      rssPages,
      threads: Number(rest[17]) || 1,
      nice: Number(rest[16]) || 0,
      cmd: info.cmd,
      label: info.label,
      cwd: info.cwd,
      memPct: memTotal > 0 ? ((rssPages * PAGE_SIZE) / memTotal) * 100 : 0,
    };
  } catch {
    return null;
  }
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
  try {
    return Number(fs.readFileSync(path.join(PROC, "uptime"), "utf8").split(" ")[0]) || 0;
  } catch {
    return 0;
  }
}

function readLoadavg(): number[] {
  try {
    return fs
      .readFileSync(path.join(PROC, "loadavg"), "utf8")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map(Number);
  } catch {
    return [0, 0, 0];
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* One /proc pass per request. Per-process CPU% is the delta against the previous pass (the page
   polls every 2 s); with no recent pass, a second one runs 250 ms later. Results are shared for
   a second so several open tabs cost one pass. */
let lastPass: { ts: number; total: number; ticks: Map<number, number> } | null = null;
let snapshot: { ts: number; promise: Promise<{ procs: Proc[] }> } | null = null;

function pass(memTotal: number) {
  const procs = readAllProcs(memTotal);
  const total = readCpuStat()?.total ?? 0;
  return {
    procs,
    total,
    ts: Date.now(),
    ticks: new Map(procs.map((p) => [p.pid, p.utime + p.stime])),
  };
}

export function hostSnapshot(): Promise<{ procs: Proc[] }> {
  if (snapshot && Date.now() - snapshot.ts < 1000) return snapshot.promise;
  const promise = (async () => {
    const memTotal = readMeminfo().MemTotal ?? 0;
    if (!lastPass || Date.now() - lastPass.ts > 15_000) {
      lastPass = pass(memTotal);
      await sleep(250);
    }
    const prev = lastPass;
    const cur = pass(memTotal);
    const dTotal = cur.total - prev.total;
    const out: Proc[] = [];
    for (const p of cur.procs) {
      const before = prev.ticks.get(p.pid);
      const cpu =
        before != null && dTotal > 0
          ? Math.max(0, ((p.utime + p.stime - before) / dTotal) * 100)
          : 0;
      out.push({ ...p, cpu });
    }
    lastPass = cur;
    const live = new Set(cur.procs.map((p) => `${p.pid}:${p.starttime}`));
    for (const k of slow.keys()) if (!live.has(k)) slow.delete(k);
    out.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
    return { procs: out.slice(0, MAX_PROCS) };
  })();
  snapshot = { ts: Date.now(), promise };
  return promise;
}

export interface DiskRow {
  size: number;
  used: number;
  avail: number;
  pcent: number;
  target: string;
}

/* Root plus every real directory mount, via statfs (no df child process). Mounts reporting identical
   numbers share one disk (the overlay root and /home/coder here), so they merge into one row. */
let diskCache: { ts: number; rows: DiskRow[] } | null = null;
export function diskRows(): DiskRow[] {
  if (diskCache && Date.now() - diskCache.ts < 15_000) return diskCache.rows;
  const out: DiskRow[] = [];
  for (const target of ["/", ...mountRoots()]) {
    try {
      const st = fs.statfsSync(target);
      const size = st.blocks * st.bsize,
        avail = st.bavail * st.bsize,
        used = (st.blocks - st.bfree) * st.bsize;
      if (!size) continue;
      const row = { size, used, avail, pcent: Math.ceil((used / (used + avail)) * 100), target };
      const same = out.find((d) => d.size === row.size && Math.abs(d.used - row.used) < 64 << 20);
      if (same) same.target += ` · ${target}`;
      else out.push(row);
    } catch {}
  }
  diskCache = { ts: Date.now(), rows: out };
  return out;
}

function sameOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    if (new URL(String(req.headers.origin)).host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: "Cross-site request refused." });
}

/* ---------- endpoints ---------- */

let cpuPrev: CpuStat | null = null;
export function hostMetrics(req: express.Request, res: express.Response) {
  res.setHeader("Cache-Control", "no-store");
  (async () => {
    let c1 = cpuPrev;
    if (!c1 || Date.now() - c1.ts > 15_000 || Date.now() - c1.ts < 500) {
      c1 = readCpuStat();
      await sleep(250);
    }
    const c2 = readCpuStat();
    cpuPrev = c2;
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
        const c = c2.cores[i];
        const p = c1.cores[i];
        const d = c.total - (p?.total ?? 0);
        const di = c.idle - (p?.idle ?? 0);
        cpuCores.push(d > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / d))) : 0);
      }
    }
    res.json({
      cpu: { total: cpuTotal, cores: cpuCores, n: cpuCores.length },
      load,
      mem: {
        total: memTotal,
        available: memAvailable,
        used: memUsed,
        pct: memTotal > 0 ? (memUsed / memTotal) * 100 : 0,
        swapTotal: mem.SwapTotal ?? 0,
        swapFree: mem.SwapFree ?? 0,
      },
      disk,
      io: latestRates(),
      uptime: uptimeSec,
      boot: Date.now() - uptimeSec * 1000,
      platform: process.platform,
      arch: process.arch,
    });
  })().catch(() => res.status(503).json({ error: "Host metrics are unavailable." }));
}

type Reply = { status: number; body: unknown };

async function processList(): Promise<Reply> {
  const { procs } = await hostSnapshot();
  const guard = protectedPids();
  return {
    status: 200,
    body: {
      processes: procs.map((p) => ({
        protected: guard.has(p.pid),
        pid: p.pid,
        ppid: p.ppid,
        name: p.name,
        user: userOf(p.uid),
        state: p.state,
        cpu: p.cpu ?? 0,
        mem: p.memPct ?? 0,
        rss: p.rssPages * PAGE_SIZE,
        threads: p.threads,
        nice: p.nice,
        cmd: p.cmd.slice(0, 400),
        label: p.label,
        cwd: p.cwd,
      })),
    },
  };
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
        // columns: sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...
        const uid = Number(f[7]) || 0;
        const inode = Number(f[9]) || 0;
        if (Number.isFinite(port) && inode) out.push({ port, proto, inode, uid });
      }
    } catch {}
  }
  return out;
}

/* Socket inode -> pid needs a readlink of every fd of every process, the costliest read on this
   page. It runs async (yielding between processes) and only when the set of listening sockets
   changed; the port list itself is cached for 5 s. */
let owners = new Map<number, number>();
let ownersKey = "";
let portsCache: { ts: number; promise: Promise<unknown[]> } | null = null;

async function scanOwners(wanted: Set<number>) {
  const map = new Map<number, number>();
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(PROC);
  } catch {}
  for (const name of entries) {
    if (map.size === wanted.size) break;
    if (!/^\d+$/.test(name)) continue;
    try {
      const fds = await fs.promises.readdir(path.join(PROC, name, "fd"));
      const links = await Promise.all(
        fds.map((fd) => fs.promises.readlink(path.join(PROC, name, "fd", fd)).catch(() => "")),
      );
      for (const target of links) {
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m && wanted.has(Number(m[1]))) map.set(Number(m[1]), Number(name));
      }
    } catch {}
  }
  return map;
}

async function listPorts() {
  const sockets = readListeningSockets();
  const key = sockets
    .map((s) => s.inode)
    .sort()
    .join(",");
  const alive = [...owners.values()].every((pid) => fs.existsSync(path.join(PROC, String(pid))));
  if (key !== ownersKey || !alive) {
    owners = await scanOwners(new Set(sockets.map((s) => s.inode)));
    ownersKey = key;
  }
  return sockets
    .map((s) => {
      const pid = owners.get(s.inode) ?? 0;
      let cmd = "";
      if (pid)
        try {
          cmd = fs
            .readFileSync(path.join(PROC, String(pid), "cmdline"), "utf8")
            .replace(/\0/g, " ")
            .trim();
        } catch {}
      return {
        port: s.port,
        proto: s.proto,
        pid,
        cmd: cmd.slice(0, 400),
        label: procLabel(cmd.split(" ").filter(Boolean), ""),
        user: pid ? userOf(s.uid) : "",
      };
    })
    .filter((p) => p.pid > 0 || p.cmd.length > 0)
    .filter((p, i, all) => all.findIndex((q) => q.port === p.port && q.pid === p.pid) === i)
    .sort((a, b) => a.port - b.port);
}

async function portList(): Promise<Reply> {
  if (!portsCache || Date.now() - portsCache.ts > 5000)
    portsCache = { ts: Date.now(), promise: listPorts() };
  try {
    const guard = protectedPids();
    const ports = ((await portsCache.promise) as { pid: number }[]).map((p) => ({
      ...p,
      protected: guard.has(p.pid),
    }));
    return { status: 200, body: { ports } };
  } catch (e) {
    portsCache = null;
    throw e;
  }
}

function processDetail(pid: number): Reply {
  const p = readProcStat(String(pid), 0);
  if (!p) return { status: 404, body: { error: "Process not found." } };
  const mem = readMeminfo();
  const memTotal = mem.MemTotal ?? 0;
  const uptimeSec = readUptime();
  const startedMs =
    uptimeSec > 0 && p.starttime > 0
      ? Date.now() - (uptimeSec * 1000 - (p.starttime / CLK_TCK) * 1000)
      : 0;
  const upSec = startedMs > 0 ? Math.max(0, (Date.now() - startedMs) / 1000) : 0;
  const h = Math.floor(upSec / 3600),
    min = Math.floor((upSec % 3600) / 60),
    s = Math.floor(upSec % 60);
  const status: Record<string, string> = {};
  try {
    for (const line of fs
      .readFileSync(path.join(PROC, String(pid), "status"), "utf8")
      .split("\n")) {
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
        const rest = cl
          .slice(end + 2)
          .trim()
          .split(/\s+/);
        if (Number(rest[1]) === pid) {
          const cname = cl.slice(cl.indexOf("(") + 1, end).replace(/\s+/g, " ");
          let ccmd = "";
          try {
            ccmd = fs
              .readFileSync(path.join(PROC, entry.name, "cmdline"), "utf8")
              .replace(/\0/g, " ")
              .trim();
          } catch {}
          children.push({
            pid: cpid,
            name: procLabel(ccmd.split(" ").filter(Boolean), cname || `pid ${cpid}`),
            cmd: (ccmd || `(${cname})`).slice(0, 400),
          });
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
      try {
        target = fs.readlinkSync(path.join(PROC, String(pid), "fd", fd));
      } catch {
        continue;
      }
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
            const inode = Number(f[9]) || 0;
            if (inode && inodes.has(inode)) {
              const port = Number.parseInt(f[1].split(":")[1] ?? "", 16);
              if (Number.isFinite(port)) ports.push(port);
            }
          }
        } catch {}
      }
    }
  } catch {}
  return {
    status: 200,
    body: {
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      state: p.state,
      uid: p.uid,
      user: userOf(p.uid),
      cmd: p.cmd.slice(0, 4000),
      label: p.label,
      cwd: p.cwd,
      threads: p.threads,
      nice: p.nice,
      cpu: p.cpu ?? 0,
      memPct: p.memPct ?? 0,
      rss: p.rssPages * PAGE_SIZE,
      starttime: p.starttime,
      uptime: `${h}h ${min}m ${s}s`,
      startedMs,
      tgid: status.Tgid ?? "",
      ngid: status.Ngid ?? "",
      pidns: status.PidNS ?? "",
      children,
      ports: [...new Set(ports)].sort((a, b) => a - b),
      protected: protectedPids().has(p.pid),
    },
  };
}

/* /proc scans cost tens of milliseconds of synchronous reads (hundreds when the box is busy), so
   they run in a worker thread and never stall chat streaming on the main event loop. The worker
   starts on first use and exits after a minute without requests. */
export const workerOps = { processList, portList, processDetail };
let worker: Worker | null = null,
  idle: NodeJS.Timeout | null = null,
  nextId = 0;
const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

function inWorker(op: keyof typeof workerOps, arg?: number): Promise<Reply> {
  if (!worker) {
    worker = new Worker(new URL("./host-worker.ts", import.meta.url));
    worker.unref();
    worker.on("message", ({ id, reply, error }) => {
      const p = pending.get(id);
      pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(reply);
    });
    const fail = () => {
      for (const p of pending.values()) p.reject(new Error("Host worker stopped."));
      pending.clear();
      worker = null;
    };
    worker.on("error", fail);
    worker.on("exit", fail);
  }
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    void worker?.terminate();
    worker = null;
  }, 60_000).unref();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, op, arg });
  });
}

function viaWorker(
  op: keyof typeof workerOps,
  error: string,
  arg?: (req: express.Request) => number | null,
) {
  return async (req: express.Request, res: express.Response) => {
    res.setHeader("Cache-Control", "no-store");
    const a = arg ? arg(req) : undefined;
    if (a === null) return res.status(400).json({ error: "Invalid pid." });
    try {
      const r = await inWorker(op, a);
      res.status(r.status).json(r.body);
    } catch {
      res.status(503).json({ error });
    }
  };
}

export const hostProcesses = viaWorker("processList", "Process list is unavailable.");
export const hostPorts = viaWorker("portList", "Port information is unavailable.");
export const hostProcessDetail = viaWorker(
  "processDetail",
  "Process detail is unavailable.",
  (req) => {
    const pid = Number(req.params.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  },
);

/* Processes whose death takes the console or the workspace down: this server and its ancestors
   (the restart wrapper, the shell, PID 1) and the Coder agent that keeps the workspace connected. */
let guardCache: { ts: number; pids: Set<number> } | null = null;
export function protectedPids(): Set<number> {
  if (guardCache && Date.now() - guardCache.ts < 30_000) return guardCache.pids;
  const out = new Set<number>([1, process.pid]);
  for (let pid = process.pid, i = 0; pid > 1 && i < 32; i++) {
    try {
      const line = fs.readFileSync(path.join(PROC, String(pid), "stat"), "utf8");
      pid = Number(line.slice(line.lastIndexOf(")") + 2).split(" ")[1]) || 0;
      if (pid) out.add(pid);
    } catch {
      break;
    }
  }
  try {
    for (const name of fs.readdirSync(PROC)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (
          /^(\S*\/)?coder\0agent\b/.test(fs.readFileSync(path.join(PROC, name, "cmdline"), "utf8"))
        )
          out.add(Number(name));
      } catch {}
    }
  } catch {}
  guardCache = { ts: Date.now(), pids: out };
  return out;
}

export function hostKill(req: express.Request, res: express.Response) {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid) || pid <= 1) return res.status(400).json({ error: "Invalid pid." });
  if (protectedPids().has(pid))
    return res.status(403).json({
      error: "Protected: stopping this process would take down the console or the workspace.",
    });
  const signal = String(req.body?.signal ?? "SIGTERM");
  if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(signal))
    return res.status(400).json({ error: "Unsupported signal." });
  try {
    process.kill(pid, 0);
  } catch {
    return res.status(404).json({ error: "Process not found." });
  }
  try {
    process.kill(pid, signal as NodeJS.Signals);
    res.json({ ok: true, pid, signal });
  } catch (e: any) {
    if (e.code === "EPERM")
      return res.status(403).json({ error: "Not permitted to signal this process." });
    res.status(500).json({ error: e?.message || "Could not signal process." });
  }
}

export { sameOrigin };
