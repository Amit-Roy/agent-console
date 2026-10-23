import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type express from "express";
import { DATA_DIR } from "./auth.ts";

/* Background host sampler: one sample every 5 s kept for an hour, folded into one-minute
   averages kept for a day and persisted so the 12 h / 24 h charts survive restarts. */
const PROC = "/proc";
const STEP_MS = 5000;
const RAW_KEEP = 720; // 1 h of 5 s samples
const MIN_KEEP = 1440; // 24 h of 1 min averages
const HISTORY_FILE = path.join(DATA_DIR, "host-history.json");
const DU_FILE = path.join(DATA_DIR, "host-du.json");
const DU_MAX_AGE = 24 * 3600_000;
const DU_DUTY = 0.2; // du may run a fifth of the time: about 20% of one core, under 3% of this 8-core box

// Sample columns: ts, cpu %, mem %, swap %, load1, net rx B/s, net tx B/s, disk read B/s, disk write B/s
export type Sample = [number, number, number, number, number, number, number, number, number];
const COLS = ["ts", "cpu", "mem", "swap", "load", "rx", "tx", "rd", "wr"];

const raw: Sample[] = [];
let minutes: Sample[] = [];
let prev: {
  ts: number;
  cpuTotal: number;
  cpuIdle: number;
  rx: number;
  tx: number;
  rd: number;
  wr: number;
} | null = null;

function counters() {
  let cpuTotal = 0,
    cpuIdle = 0,
    rx = 0,
    tx = 0,
    rd = 0,
    wr = 0;
  try {
    const line = fs.readFileSync(path.join(PROC, "stat"), "utf8").split("\n")[0];
    const vals = line.trim().split(/\s+/).slice(1).map(Number);
    cpuTotal = vals.reduce((a, b) => a + b, 0);
    cpuIdle = (vals[3] || 0) + (vals[4] || 0);
  } catch {}
  try {
    for (const line of fs.readFileSync(path.join(PROC, "net/dev"), "utf8").split("\n").slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m || m[1] === "lo") continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      rx += f[0] || 0;
      tx += f[8] || 0;
    }
  } catch {}
  try {
    // whole disks only, so partitions are not counted twice
    for (const line of fs.readFileSync(path.join(PROC, "diskstats"), "utf8").split("\n")) {
      const f = line.trim().split(/\s+/);
      if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(f[2] ?? "")) continue;
      rd += (Number(f[5]) || 0) * 512;
      wr += (Number(f[9]) || 0) * 512;
    }
  } catch {}
  return { ts: Date.now(), cpuTotal, cpuIdle, rx, tx, rd, wr };
}

function memory() {
  const m: Record<string, number> = {};
  try {
    for (const line of fs.readFileSync(path.join(PROC, "meminfo"), "utf8").split("\n")) {
      const [k, rest] = line.split(":");
      const v = Number(rest?.match(/\d+/)?.[0]);
      if (k && Number.isFinite(v)) m[k.trim()] = v;
    }
  } catch {}
  const total = m.MemTotal || 0,
    swapTotal = m.SwapTotal || 0;
  return {
    mem: total ? ((total - (m.MemAvailable || 0)) / total) * 100 : 0,
    swap: swapTotal ? ((swapTotal - (m.SwapFree || 0)) / swapTotal) * 100 : 0,
  };
}

function load1() {
  try {
    return Number(fs.readFileSync(path.join(PROC, "loadavg"), "utf8").split(" ")[0]) || 0;
  } catch {
    return 0;
  }
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function sample() {
  const c = counters();
  if (prev) {
    const dt = (c.ts - prev.ts) / 1000;
    const dTotal = c.cpuTotal - prev.cpuTotal;
    const cpu =
      dTotal > 0 ? Math.max(0, Math.min(100, 100 * (1 - (c.cpuIdle - prev.cpuIdle) / dTotal))) : 0;
    const rate = (a: number, b: number) => (dt > 0 ? Math.max(0, Math.round((a - b) / dt)) : 0);
    const { mem, swap } = memory();
    const s: Sample = [
      c.ts,
      round(cpu),
      round(mem),
      round(swap),
      round(load1(), 2),
      rate(c.rx, prev.rx),
      rate(c.tx, prev.tx),
      rate(c.rd, prev.rd),
      rate(c.wr, prev.wr),
    ];
    raw.push(s);
    if (raw.length > RAW_KEEP) raw.shift();
    foldMinute(s);
  }
  prev = c;
}

let bucket: Sample[] = [];
function foldMinute(s: Sample) {
  const minute = Math.floor(s[0] / 60_000);
  if (bucket.length && Math.floor(bucket[0][0] / 60_000) !== minute) {
    minutes.push(average(bucket, minute * 60_000 - 60_000));
    if (minutes.length > MIN_KEEP) minutes.splice(0, minutes.length - MIN_KEEP);
    bucket = [];
  }
  bucket.push(s);
}

function average(rows: Sample[], ts: number): Sample {
  const out = [ts, 0, 0, 0, 0, 0, 0, 0, 0] as Sample;
  for (const r of rows) for (let i = 1; i < COLS.length; i++) out[i] += r[i] / rows.length;
  for (let i = 1; i < COLS.length; i++) out[i] = i >= 5 ? Math.round(out[i]) : round(out[i], 2);
  return out;
}

function persist() {
  try {
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ cols: COLS, minutes }));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch {}
}

let started = false;
export function startHostSampler() {
  if (started) return;
  started = true;
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    const cutoff = Date.now() - 24 * 3600_000;
    if (Array.isArray(saved?.minutes))
      minutes = saved.minutes.filter(
        (r: Sample) => Array.isArray(r) && r.length === COLS.length && r[0] >= cutoff,
      );
  } catch {}
  sample();
  setInterval(sample, STEP_MS).unref();
  setInterval(persist, 5 * 60_000).unref();
  process.once("beforeExit", persist);
  // automatic rescans wait for a quiet box; the Rescan button skips this check
  const quiet = () => load1() < os.cpus().length * 0.5;
  setTimeout(() => {
    if (duStale() && quiet()) void scanDisk();
  }, 60_000).unref();
  setInterval(() => {
    if (duStale() && quiet()) void scanDisk();
  }, 3600_000).unref();
}

/* Downsample to at most `max` points by averaging consecutive samples. */
function downsample(rows: Sample[], max: number): Sample[] {
  if (rows.length <= max) return rows;
  const per = Math.ceil(rows.length / max);
  const out: Sample[] = [];
  for (let i = 0; i < rows.length; i += per) out.push(average(rows.slice(i, i + per), rows[i][0]));
  return out;
}

/** The newest sample's CPU and memory percentages; the workspace monitor reads these instead of sampling the host again. */
export function latestHost() {
  const s = raw[raw.length - 1];
  return s ? { cpu: s[1], mem: s[2] } : undefined;
}

export function latestRates() {
  const s = raw[raw.length - 1];
  return s ? { rx: s[5], tx: s[6], rd: s[7], wr: s[8] } : { rx: 0, tx: 0, rd: 0, wr: 0 };
}

export function hostHistory(req: express.Request, res: express.Response) {
  res.setHeader("Cache-Control", "no-store");
  const range = Math.max(60, Math.min(86400, Number(req.query.range) || 300));
  const from = Date.now() - range * 1000;
  // An hour or less comes from 5 s samples; longer ranges from minute averages, topped up with
  // the current partial minute's raw samples so the right edge is live.
  let rows: Sample[];
  if (range <= 3600) rows = raw.filter((r) => r[0] >= from);
  else {
    const last = minutes.length ? minutes[minutes.length - 1][0] + 60_000 : from;
    rows = minutes.filter((r) => r[0] >= from).concat(raw.filter((r) => r[0] >= last));
  }
  res.json({ cols: COLS, range, step: STEP_MS, points: downsample(rows, 360) });
}

/* ---------- disk usage tree ---------- */

interface DuState {
  scannedAt: number;
  ms: number;
  root: string;
  sizes: Record<string, number>;
}
let du: DuState | null = null;
let duRunning: Promise<void> | null = null;
try {
  du = JSON.parse(fs.readFileSync(DU_FILE, "utf8"));
} catch {}

// folders that have listed subfolders, computed once per scan
let parentSet: { of: DuState | null; set: Set<string> } = { of: null, set: new Set() };
function parents() {
  if (parentSet.of !== du)
    parentSet = {
      of: du,
      set: new Set(Object.keys(du?.sizes ?? {}).map((p) => path.posix.dirname(p))),
    };
  return parentSet.set;
}

const duStale = () => !duRunning && (!du || Date.now() - du.scannedAt > DU_MAX_AGE);

/* One du walk of the root filesystem, five levels deep, entries of 16 MB and up, cached on disk.
   The walk is mostly kernel time (nice cannot cap it on an idle box), so the child is also
   duty-cycled with SIGSTOP/SIGCONT to DU_DUTY of each 200 ms. A walk takes several minutes. */
export function scanDisk(): Promise<void> {
  if (duRunning) return duRunning;
  const t0 = Date.now();
  duRunning = new Promise<void>((resolve) => {
    const sizes: Record<string, number> = {};
    let buf = "";
    // -x keeps each walk on one filesystem, so real directory mounts such as /home/coder get their own
    // root. Mounts go first: du skips an argument it already passed while walking an earlier one.
    const mounts = mountRoots();
    const roots = [...mounts, "/"];
    const child = spawn(
      "nice",
      ["-n", "19", "ionice", "-c3", "du", "-x", "-B1", "-d5", "--threshold=16M", ...roots],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    // every 200 ms: continue, then stop again after DU_DUTY of the period
    const pid = child.pid;
    let done = false;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (pid && !done) process.kill(pid, sig);
      } catch {}
    };
    signal("SIGSTOP");
    const duty = setInterval(() => {
      signal("SIGCONT");
      setTimeout(() => signal("SIGSTOP"), 200 * DU_DUTY).unref();
    }, 200);
    const reap = () => {
      signal("SIGKILL");
    };
    process.once("exit", reap); // a stopped du must never outlive the server
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = /^(\d+)\t(.+)$/.exec(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m) sizes[m[2]] = Number(m[1]);
      }
    });
    child.on("error", () => resolve());
    child.on("close", () => {
      clearInterval(duty);
      done = true;
      process.off("exit", reap);
      // fold nested mounts into their ancestors so / and /home add up
      for (const r of mounts) {
        for (let p = path.posix.dirname(r); sizes[r] != null; p = path.posix.dirname(p)) {
          if (sizes[p] != null) sizes[p] += sizes[r];
          if (p === "/") break;
        }
      }
      if (Object.keys(sizes).length) {
        du = { scannedAt: Date.now(), ms: Date.now() - t0, root: "/", sizes };
        try {
          fs.writeFileSync(DU_FILE, JSON.stringify(du));
        } catch {}
      }
      resolve();
    });
  }).finally(() => {
    duRunning = null;
  });
  return duRunning;
}

/* Directory mount points backed by a block device (bind-mounted files like /etc/hosts are skipped). */
let mountsCache: { ts: number; roots: string[] } | null = null;
export function mountRoots(): string[] {
  if (mountsCache && Date.now() - mountsCache.ts < 60_000) return mountsCache.roots;
  const out: string[] = [];
  try {
    for (const line of fs.readFileSync(path.join(PROC, "mounts"), "utf8").split("\n")) {
      const [src, target] = line.split(" ");
      if (!src?.startsWith("/dev/") || !target || target === "/") continue;
      const t = target.replace(/\\040/g, " ");
      try {
        if (fs.statSync(t).isDirectory()) out.push(t);
      } catch {}
    }
  } catch {}
  mountsCache = { ts: Date.now(), roots: [...new Set(out)] };
  return mountsCache.roots;
}

export function hostDu(req: express.Request, res: express.Response) {
  res.setHeader("Cache-Control", "no-store");
  const want = path.posix.normalize(String(req.query.path || "/")).replace(/(.)\/$/, "$1");
  if (!du)
    return res.json({ path: want, scanning: !!duRunning, scannedAt: 0, size: 0, children: [] });
  const prefix = want === "/" ? "/" : want + "/";
  const children: { path: string; size: number; more: boolean }[] = [];
  const sizes = du.sizes;
  for (const [p, size] of Object.entries(sizes)) {
    if (p === want || !p.startsWith(prefix) || p.slice(prefix.length).includes("/")) continue;
    children.push({ path: p, size, more: false });
  }
  children.sort((a, b) => b.size - a.size);
  const top = children.slice(0, 25);
  for (const c of top) c.more = parents().has(c.path);
  res.json({
    path: want,
    scanning: !!duRunning,
    scannedAt: du.scannedAt,
    ms: du.ms,
    size: sizes[want] ?? 0,
    children: top,
  });
}

export function hostDuRescan(_req: express.Request, res: express.Response) {
  void scanDisk();
  res.json({ ok: true, scanning: true });
}
