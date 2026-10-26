// Experimental probe: cold first-load cost of the source tree vs the esbuild bundle (scripts/bundle-web.mjs).
// The bundle variant is the same server with AGENT_CONSOLE_WEB_BUNDLE pointing at the build output.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { freePort } from "./free-port.ts";

const RUNS = Number(process.env.PROBE_RUNS) || 5;
const repo = path.join(import.meta.dirname, "..");
const bundleDir = path.join(os.tmpdir(), "ac-first-load-bundle", "public");
execFileSync(process.execPath, [path.join(repo, "scripts", "bundle-web.mjs"), bundleDir], { stdio: "inherit" });

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-first-load-"));
for (const dir of ["uploads", "logs"]) fs.mkdirSync(path.join(data, dir));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    { id: "probe-a", provider: "mock", model: "echo", mode: "acceptEdits", title: "Probe 1", cwd: os.tmpdir(), status: "idle", cost: 0, createdAt: 1, updatedAt: 1 },
  ]),
);
fs.writeFileSync(path.join(data, "logs", "probe-a.jsonl"), `${JSON.stringify({ type: "user_input", text: "fixture" })}\n`);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");

async function startServer(bundle: string, port: number): Promise<ChildProcess> {
  const server = spawn(process.execPath, [path.join(repo, "server", "index.ts")], {
    env: {
      ...process.env,
      AGENT_CONSOLE_WEB_BUNDLE: bundle,
      PORT: String(port),
      AGENT_CONSOLE_MOCK: "1",
      AGENT_CONSOLE_RUN: path.join(data, `run-${port}`),
      AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 20000);
    server.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("agent-console listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  return server;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function measure(browser: Awaited<ReturnType<typeof chromium.launch>>, base: string) {
  const runs = { composerMs: [] as number[], jsRequests: [] as number[], jsBytes: [] as number[], scriptSec: [] as number[] };
  const errors: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addCookies([
      { name: "__Host-ac_session", value: makeToken(), domain: new URL(base).hostname, path: "/", secure: true },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    const scripts: Promise<number>[] = [];
    page.on("requestfinished", (request) => {
      if (request.resourceType() === "script") scripts.push(request.sizes().then((s) => s.responseBodySize));
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const t0 = performance.now();
    await page.goto(base);
    await page.waitForFunction(() => !(document.getElementById("input") as HTMLTextAreaElement)?.disabled);
    runs.composerMs.push(performance.now() - t0);
    const metrics = (await cdp.send("Performance.getMetrics")).metrics;
    runs.scriptSec.push(metrics.find((m) => m.name === "ScriptDuration")?.value ?? Number.NaN);
    const sizes = await Promise.all(scripts);
    runs.jsRequests.push(sizes.length);
    runs.jsBytes.push(sizes.reduce((a, b) => a + b, 0));
    await context.close();
  }
  return {
    composerReadyMs: Math.round(median(runs.composerMs)),
    jsRequests: median(runs.jsRequests),
    jsEncodedBytes: median(runs.jsBytes),
    scriptDurationMs: Math.round(median(runs.scriptSec) * 1000),
    runs: RUNS,
    errors: [...new Set(errors)].slice(0, 5),
  };
}

const servers: ChildProcess[] = [];
const browser = await chromium.launch();
try {
  const result: Record<string, unknown> = {};
  for (const [name, bundle] of [["source", ""], ["bundle", bundleDir]]) {
    const port = await freePort();
    servers.push(await startServer(bundle, port));
    result[name] = await measure(browser, `http://127.0.0.1:${port}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  for (const server of servers) server.kill();
}
process.exit(0);
