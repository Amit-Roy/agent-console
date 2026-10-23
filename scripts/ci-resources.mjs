#!/usr/bin/env node
// CI runner usage: sample CPU, memory and load once a second, then summarise the run so test
// concurrency can be tuned to the runner instead of guessed.
//   node scripts/ci-resources.mjs sample <csv>             (runs until killed)
//   node scripts/ci-resources.mjs summary <csv> [test.log]  (Markdown, for $GITHUB_STEP_SUMMARY)
//   node scripts/ci-resources.mjs budget <test.log>         (fails when a file or the whole run is over budget)
// Budgets keep the suite from growing slower unnoticed: TEST_FILE_BUDGET_S per file, TEST_WALL_BUDGET_S overall.
import fs from "node:fs";
import os from "node:os";

const [mode, csv, testLog] = process.argv.slice(2);
if (!csv || !["sample", "summary", "budget"].includes(mode)) {
  console.error("usage: ci-resources.mjs sample|summary <csv> [test.log] | budget <test.log>");
  process.exit(2);
}

// node --test spec reporter: "✔ test/file.ts (1234.5ms)" per file, "ℹ duration_ms 1234.5" for the run.
function testTimes(log) {
  const text = fs.readFileSync(log, "utf8");
  const wall = text.match(/^ℹ duration_ms ([\d.]+)/m);
  return {
    files: [...text.matchAll(/^[✔✖] (test\/\S+) \(([\d.]+)ms\)/gm)].map((m) => [
      m[1],
      Number(m[2]) / 1000,
    ]),
    wall: wall ? Number(wall[1]) / 1000 : 0,
  };
}

if (mode === "budget") {
  const fileBudget = Number(process.env.TEST_FILE_BUDGET_S || 10),
    wallBudget = Number(process.env.TEST_WALL_BUDGET_S || 25);
  const { files, wall } = testTimes(csv);
  if (!files.length) {
    console.error(`No test timings in ${csv}`);
    process.exit(1);
  }
  const over = files.filter(([, s]) => s > fileBudget).sort((a, b) => b[1] - a[1]);
  for (const [f, s] of over)
    console.log(
      `::error file=${f}::${f} took ${s.toFixed(1)} s, over the ${fileBudget} s per-file budget. Share a server or browser, replace fixed sleeps with condition waits, or split the file.`,
    );
  if (wall > wallBudget)
    console.log(
      `::error::Tests took ${wall.toFixed(1)} s, over the ${wallBudget} s budget. See "Slowest files" in the run summary.`,
    );
  if (over.length || wall > wallBudget) process.exit(1);
  console.log(
    `Test budget ok: ${files.length} files, slowest ${Math.max(...files.map(([, s]) => s)).toFixed(1)} s of ${fileBudget} s, run ${wall.toFixed(1)} s of ${wallBudget} s.`,
  );
  process.exit(0);
}

// /proc/stat "cpu" line: user nice system idle iowait irq softirq steal ...
function cpuTimes() {
  const v = fs
    .readFileSync("/proc/stat", "utf8")
    .split("\n")[0]
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const idle = v[3] + v[4];
  return { total: v.reduce((a, b) => a + b, 0), idle, iowait: v[4], steal: v[7] || 0 };
}
function memMB() {
  const m = Object.fromEntries(
    fs
      .readFileSync("/proc/meminfo", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [k, v] = l.split(":");
        return [k, parseInt(v, 10) / 1024];
      }),
  );
  return { used: m.MemTotal - m.MemAvailable, swap: m.SwapTotal - m.SwapFree };
}

if (mode === "sample") {
  fs.writeFileSync(csv, "t,cpu,iowait,steal,mem_mb,swap_mb,load1,procs\n");
  const start = Date.now();
  let prev = cpuTimes();
  setInterval(() => {
    const now = cpuTimes(),
      dt = now.total - prev.total || 1;
    const pct = (x) => ((100 * x) / dt).toFixed(1);
    const mem = memMB();
    const procs = fs.readFileSync("/proc/loadavg", "utf8").split(" ")[3].split("/")[0];
    fs.appendFileSync(
      csv,
      [
        ((Date.now() - start) / 1000).toFixed(0),
        pct(dt - (now.idle - prev.idle)),
        pct(now.iowait - prev.iowait),
        pct(now.steal - prev.steal),
        mem.used.toFixed(0),
        mem.swap.toFixed(0),
        os.loadavg()[0].toFixed(2),
        procs,
      ].join(",") + "\n",
    );
    prev = now;
  }, 1000);
} else {
  const rows = fs.existsSync(csv)
    ? fs
        .readFileSync(csv, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((l) => l.split(",").map(Number))
    : [];
  const out = [];
  const totalMB = os.totalmem() / 2 ** 20;
  out.push(
    `## Runner usage`,
    "",
    `- ${os.availableParallelism()} CPUs, ${(totalMB / 1024).toFixed(1)} GiB RAM, ${rows.length} samples at 1 s`,
  );
  if (rows.length) {
    const col = (i) => rows.map((r) => r[i]);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
    const cpu = col(1),
      mem = col(4);
    out.push(
      `- CPU busy: average ${avg(cpu).toFixed(0)}%, p95 ${p95(cpu).toFixed(0)}%, peak ${Math.max(...cpu).toFixed(0)}%`,
    );
    out.push(
      `- I/O wait average ${avg(col(2)).toFixed(1)}%, steal average ${avg(col(3)).toFixed(1)}%`,
    );
    out.push(
      `- Memory used: peak ${(Math.max(...mem) / 1024).toFixed(2)} GiB of ${(totalMB / 1024).toFixed(1)} GiB, swap peak ${Math.max(...col(5)).toFixed(0)} MiB`,
    );
    out.push(
      `- Load average (1 min) peak ${Math.max(...col(6)).toFixed(1)}, runnable processes peak ${Math.max(...col(7))}`,
    );
    out.push(
      "",
      "| Seconds | CPU % | I/O wait % | Memory GiB | Runnable |",
      "|---:|---:|---:|---:|---:|",
    );
    for (let i = 0; i < rows.length; i += 5) {
      const b = rows.slice(i, i + 5),
        c = (k) => avg(b.map((r) => r[k]));
      out.push(
        `| ${b[0][0]}–${b.at(-1)[0]} | ${c(1).toFixed(0)} | ${c(2).toFixed(1)} | ${(Math.max(...b.map((r) => r[4])) / 1024).toFixed(2)} | ${Math.max(...b.map((r) => r[7]))} |`,
      );
    }
  }
  if (testLog && fs.existsSync(testLog)) {
    const { files, wall } = testTimes(testLog);
    if (files.length) {
      const sum = files.reduce((a, [, s]) => a + s, 0);
      out.push(
        "",
        `## Test files`,
        "",
        `- ${files.length} files, ${sum.toFixed(1)} s summed${wall ? `, ${wall.toFixed(1)} s wall (${(sum / wall).toFixed(1)} files running on average)` : ""}`,
      );
      out.push("", "| Slowest files | Seconds |", "|---|---:|");
      for (const [f, s] of files.sort((a, b) => b[1] - a[1]).slice(0, 10))
        out.push(`| \`${f}\` | ${s.toFixed(1)} |`);
    }
  }
  console.log(out.join("\n"));
}
