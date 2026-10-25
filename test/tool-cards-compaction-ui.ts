// Tool cards should not stay spinning after compaction.
// Real browser + isolated backend. No provider prompts or personal data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tool-cards-compaction-"));
const port = "7074";
assert.match(port, /^707[1-5]$/, "use an isolated scratch port, 7071–7075");
const base = `http://127.0.0.1:${port}`;
const now = Date.now();

// History with tool_use events but NO tool_result events (simulates compacted history)
const history = [
  {
    type: "user_input",
    text: "Run a bash command and spawn an agent",
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-bash-1",
          name: "Bash",
          input: { command: "echo hello", description: "Say hello" },
        },
        {
          type: "tool_use",
          id: "tool-agent-1",
          name: "Agent",
          input: { description: "Do something", prompt: "Work on something" },
        },
      ],
    },
  },
  // Note: NO user events with tool_result - this simulates compacted history
  // where tool_result events were summarized away
];

fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id: "tool-cards-test",
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: "Tool cards compaction test",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]),
);
fs.writeFileSync(
  path.join(data, "logs", "tool-cards-test.jsonl"),
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
  await context.addInitScript(() => localStorage.setItem("ac_thread", "tool-cards-test"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(base);
  await page.locator("#chat").waitFor({ state: "attached" });
  // Wait for history to render
  await page.waitForSelector(".msg.card.pending", { timeout: 5000 }).catch(() => {});
  // Check for cards with spinner (pending class)
  const pendingCards = await page.locator(".msg.card.pending").count();
  console.log(`Found ${pendingCards} pending cards`);
  // Wait a bit more for any async settling
  await page.waitForTimeout(1000);
  const pendingCardsAfter = await page.locator(".msg.card.pending").count();
  console.log(`Pending cards after 1s: ${pendingCardsAfter}`);
  // The bug: cards stay pending forever because no tool_result events exist
  // Expected: cards should be marked as interrupted/done after compaction reconciliation
  // This test FAILS initially because the fix doesn't exist yet
  assert.equal(
    pendingCardsAfter,
    0,
    "Tool cards should not stay pending after compaction reconciliation (no tool_result events in history)",
  );
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS tool cards compaction reconciliation");
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  fs.rmSync(data, { recursive: true, force: true });
}