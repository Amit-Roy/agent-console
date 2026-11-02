// Measures boot time the way production boots (issue #18): bundles the server, then starts it RUNS times in a row on a scratch
// data dir (mock agent, no live data) with a compile cache, and prints each boot.jsonl record. Exits 1 if any first listen
// misses the target. Usage: node scripts/boot-measure.ts [runs=3] [targetMs=2000] [port=7079]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.argv[2] || 3),
  targetMs = Number(process.argv[3] || 2000),
  port = process.argv[4] || "7079";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-boot-measure-"));
const file = path.join(data, "boot.jsonl");
const records = () =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

execFileSync(process.execPath, ["scripts/bundle-server.mjs"], { cwd: root, stdio: "inherit" });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_RUN: path.join(data, "run"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  NODE_COMPILE_CACHE: path.join(data, "compile-cache"),
  PORT: port,
};
// never claim the live server's pid file or Acode bridge port
for (const key of [
  "AGENT_CONSOLE_PID_FILE",
  "AGENT_CONSOLE_ACODE_PORT",
  "AGENT_CONSOLE_ACODE_URL",
  "AGENT_CONSOLE_STANDBY",
])
  delete env[key];

// One boot: wait until both the listen and the deferred record are written, then stop the server by its own pid.
const bootOnce = () =>
  new Promise<void>((resolve, reject) => {
    const before = records().length;
    const started = Date.now();
    const child = spawn(process.execPath, [".bundle/server/index.ts.mjs"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    // a server that exits on its own never writes both records, typically because the port is taken
    const early = (code: number | null) => {
      clearInterval(timer);
      reject(new Error(`server exited with code ${code} before booting; is port ${port} free?`));
    };
    child.once("exit", early);
    const timer = setInterval(() => {
      const done = records().length >= before + 2;
      if (!done && Date.now() - started < 60_000) return;
      clearInterval(timer);
      child.off("exit", early);
      child.once("exit", () =>
        done ? resolve() : reject(new Error("no boot record within 60 s")),
      );
      child.kill("SIGTERM");
    }, 100);
  });

try {
  for (let run = 0; run < runs; run++) await bootOnce();
  const listens = records().filter((rec) => rec.kind === "listen");
  for (const rec of records())
    console.log(
      `${rec.kind.padEnd(8)} ${String(rec.totalMs).padStart(5)} ms  ${rec.phases.map((phase: { name: string; ms: number }) => `${phase.name}=${phase.ms}`).join(" ")}`,
    );
  const missed = listens.filter((rec) => rec.totalMs > targetMs).length;
  console.log(
    `${listens.length - missed}/${listens.length} boots listened within ${targetMs} ms (load ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} CPUs)`,
  );
  process.exitCode = missed ? 1 : 0;
} finally {
  fs.rmSync(data, { recursive: true, force: true });
}
