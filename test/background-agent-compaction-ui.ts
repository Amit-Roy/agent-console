// Background agent cards should KEEP their spinner after compaction reconciliation.
// Real browser + isolated backend. No provider prompts or personal data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bg-agent-compaction-"));
const port = "7074";
assert.match(port, /^707[1-5]$/, "use an isolated scratch port, 7071–7075");
const base = `http://127.0.0.1:${port}`;
const now = Date.now();

// History with agent tool_use and task_started (background) but NO task_notification
// This simulates a background agent that is still running after compaction
const history = [
  {
    type: "user_input",
    text: "Spawn a background agent",
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-agent-bg",
          name: "Agent",
          input: { description: "Background work", prompt: "Work in background" },
        },
      ],
    },
  },
  // System event: task_started with is_backgrounded = true
  {
    type: "system",
    subtype: "task_started",
    tool_use_id: "tool-agent-bg",
    is_backgrounded: true,
    ts: now + 100,
  },
  // NO task_notification - agent is still running
];

fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id: "bg-agent-test",
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: "Background agent compaction test",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: now,
      updatedAt: now,
      background: 1, // thread has 1 background agent
    },
  ]),
);
fs.writeFileSync(
  path.join(data, "logs", "bg-agent-test.jsonl"),
  history.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: port,
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_PID_FILE: "",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_PAGE: "12",
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_ENV_FILES: "/dev/null",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let serverError = "";
server.stderr.on("data", (chunk) => {
  serverError += String(chunk);
});
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode != null) throw Error("Scratch server exited before readiness");
    try {
      if ((await fetch(base)).status < 500) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "scratch backend ready");
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  });
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  await context.addInitScript(() => localStorage.setItem("ac_thread", "bg-agent-test"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(base);
  await page.locator("#chat").waitFor({ state: "attached" });
  // Wait for history to render
  await page.waitForSelector(".msg.card.agent", { timeout: 5000 }).catch(() => {});
  // Check for agent card with running task-chip
  const agentCard = page.locator(".msg.card.agent");
  await agentCard.waitFor({ state: "attached", timeout: 5000 });
  
  // Check if card has task-chip.running (should be present for background agent)
  const runningChip = await page.locator(".msg.card.agent .task-chip.running").count();
  console.log(`Agent card has running task-chip: ${runningChip > 0}`);
  
  // Check if card has pending class (spinner)
  const hasPending = await page.locator(".msg.card.agent.pending").count();
  console.log(`Agent card has pending class (spinner): ${hasPending > 0}`);
  
  // The fix: background agent with running task-chip should KEEP its spinner
  assert.equal(
    hasPending,
    1,
    "Background agent with running task-chip should keep its spinner after compaction reconciliation",
  );
  
  // Also check the header badge shows working
  const headerState = await page.locator("#state-t").textContent();
  console.log(`Header state: ${headerState}`);
  assert.ok(
    headerState?.includes("Working"),
    `Header should show Working for background agent, got: ${headerState}`,
  );
  
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS background agent keeps spinner after compaction reconciliation");
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  fs.rmSync(data, { recursive: true, force: true });
}