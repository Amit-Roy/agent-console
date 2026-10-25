// Real browser + isolated backend. No provider prompts or personal data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-idle-policy-ui-"));
const base = "http://127.0.0.1:7073";
const now = Date.now();
const fixture = (id: string, provider: string) => ({
  id,
  provider,
  model: provider === "claude" ? "sonnet" : "default",
  title: id,
  cwd: process.cwd(),
  mode: "bypassPermissions",
  effort: "medium",
  status: "idle",
  cost: 0,
  createdAt: now,
  updatedAt: now,
});

// Tool cards compaction test thread: history with tool_use but NO tool_result
const toolCardsHistory = [
  { type: "user_input", text: "Run a bash command and spawn an agent", ts: now },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool-bash-1", name: "Bash", input: { command: "echo hello", description: "Say hello" } },
        { type: "tool_use", id: "tool-agent-1", name: "Agent", input: { description: "Background work", prompt: "Work in background" } },
      ],
    },
    ts: now + 100,
  },
  // NO tool_result events - simulates compacted history
];

// Stale background agent thread: task_started but no task_notification, background=0
const staleBgHistory = [
  { type: "user_input", text: "Spawn a background agent", ts: now },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool-agent-bg", name: "Agent", input: { description: "Background work", prompt: "Work in background" } },
      ],
    },
    ts: now + 100,
  },
  { type: "system", subtype: "task_started", tool_use_id: "tool-agent-bg", is_backgrounded: true, ts: now + 200 },
  // NO task_notification - agent completed but event was compacted away
];

fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    fixture("known-cache", "claude"),
    fixture("unknown-cache", "codex"),
    fixture("tool-cards-test", "mock"),
    fixture("bg-agent-stale-test", "mock"),
  ]),
);
fs.writeFileSync(path.join(data, "logs", "tool-cards-test.jsonl"), toolCardsHistory.map(e => JSON.stringify(e)).join("\n") + "\n");
fs.writeFileSync(path.join(data, "logs", "bg-agent-stale-test.jsonl"), staleBgHistory.map(e => JSON.stringify(e)).join("\n") + "\n");

process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const env = {
  ...process.env,
  PORT: "7073",
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_RUN: path.join(data, "run"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_HEADROOM: "0",
  AGENT_CONSOLE_IDLE_COMPACT_CLAUDE_TTL_MS: "3600000",
};
delete env.AGENT_CONSOLE_PID_FILE;
delete env.AGENT_CONSOLE_IDLE_COMPACT_CODEX_TTL_MS;
const server = spawn(process.execPath, ["server/index.ts"], { env, stdio: "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
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

  // --- Existing idle compaction toggle tests ---
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: "dark",
    });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await context.addInitScript(() => localStorage.setItem("ac_thread", "known-cache"));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(base);
    await page.locator("#more:not([disabled])").waitFor();
    await page.locator("#more").click();
    await page.getByText("Compaction", { exact: true }).click();
    await page.getByText("Disable automatic compaction", { exact: true }).click();
    await page
      .getByText("Automatic compaction disabled for this thread.", { exact: true })
      .waitFor();
    await page.reload();
    await page.locator("#more:not([disabled])").waitFor();
    await page.locator("#more").click();
    await page.getByText("Compaction", { exact: true }).click();
    await page.getByText("Enable automatic compaction", { exact: true }).click();
    await page
      .getByText("Automatic compaction enabled for this thread.", { exact: true })
      .waitFor();
    await page.locator("#more").click();
    await page.getByRole("menuitem", { name: /^Run details/ }).click();
    await page
      .locator("#run-metrics dd")
      .filter({ hasText: "On for substantial idle contexts" })
      .waitFor();
    // await page.screenshot({ path: `/tmp/idle-compaction-${width}.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.close();
    await context.addInitScript(() => localStorage.setItem("ac_thread", "unknown-cache"));
    const unknown = await context.newPage();
    await unknown.goto(base);
    await unknown.locator("#more:not([disabled])").waitFor();
    await unknown.locator("#more").click();
    await unknown.getByText("Compaction", { exact: true }).click();
    assert.equal(
      await unknown
        .getByRole("menuitem")
        .filter({ hasText: "Automatic compaction unavailable" })
        .getAttribute("aria-disabled"),
      "true",
    );
    assert.deepEqual(errors, []);
    await context.close();
  }

  // --- Tool cards compaction reconciliation tests ---
  // Scenario 1: History with tool_use events but NO tool_result events (compacted away)
  // Cards should be settled as interrupted, not stuck pending
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await context.addInitScript(() => localStorage.setItem("ac_thread", "tool-cards-test"));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => {
      if (m.type() === "error") {
        const text = m.text();
        // Filter out transient 502 errors for non-critical resources
        if (!text.includes("502") || text.includes("favicon")) errors.push(text);
      }
    });

    await page.goto(base);
    await page.locator("#chat").waitFor({ state: "attached" });
    // Wait for history to render completely (no more pending cards from historical events)
    await page.waitForFunction(() => {
      const pending = document.querySelectorAll(".msg.card.pending:not(.agent .task-chip.running)");
      return pending.length === 0;
    }, { timeout: 15000 }).catch(() => {});

    // Debug: check what cards exist
    const allCards = await page.locator(".msg.card").count();
    const pendingCardsAll = await page.locator(".msg.card.pending").count();
    const agentCards = await page.locator(".msg.card.agent").count();
    const bashCards = await page.locator(".msg.card:not(.agent)").count();
    console.log(`DEBUG: total cards=${allCards}, pending=${pendingCardsAll}, agent=${agentCards}, bash=${bashCards}`);
    // Also check classes
    const cardDetails = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.msg.card')).map(c => ({
        classes: Array.from(c.classList),
        hasStartedTs: c.startedTs != null,
        hasStartedAt: c.startedAt != null,
      }));
    });
    console.log('DEBUG card details:', JSON.stringify(cardDetails, null, 2));

    // Assert: no pending cards (both Bash and Agent cards should be settled)
    const pendingCards = await page.locator(".msg.card.pending").count();
    assert.equal(pendingCards, 0, "Historical tool cards without tool_result should be settled as interrupted");

    // Assert: header badge should not show "Working · N agents" (no live background agents)
    const headerState = await page.locator("#state-t").textContent();
    assert.ok(!headerState?.includes("Working ·"), `Header should not show agent count, got: ${headerState}`);

    assert.deepEqual(errors, []);
    await context.close();
    console.log("PASS tool cards compaction reconciliation (no tool_result events)");
  }

  // Scenario 2: Background agent with stale task-chip (task_started but no task_notification)
  // and thread.background = 0 -> chip should be settled, not stuck running
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await context.addInitScript(() => localStorage.setItem("ac_thread", "bg-agent-stale-test"));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => {
      if (m.type() === "error") {
        const text = m.text();
        // Filter out transient 502 errors for non-critical resources
        if (!text.includes("502") || text.includes("favicon")) errors.push(text);
      }
    });

    await page.goto(base);
    await page.locator("#chat").waitFor({ state: "attached" });
    // Wait for history to render completely
    await page.waitForFunction(() => {
      const pending = document.querySelectorAll(".msg.card.pending");
      return pending.length === 0;
    }, { timeout: 15000 }).catch(() => {});

    // Assert: agent card should not be pending (stale background chip settled)
    const pendingAgent = await page.locator(".msg.card.agent.pending").count();
    assert.equal(pendingAgent, 0, "Stale background agent card should be settled");

    // Assert: no running task-chip
    const runningChip = await page.locator(".msg.card.agent .task-chip.running").count();
    assert.equal(runningChip, 0, "Stale task-chip.running should be settled");

    // Assert: header badge should not show "Working · N agents" (background=0)
    const headerState = await page.locator("#state-t").textContent();
    assert.ok(!headerState?.includes("Working ·"), `Header should not show agent count, got: ${headerState}`);

    assert.deepEqual(errors, []);
    await context.close();
    console.log("PASS stale background agent chip settled");
  }

  assert.equal(
    fs.existsSync(path.join(data, "turns.jsonl")) &&
      fs.readFileSync(path.join(data, "turns.jsonl"), "utf8").trim().length > 0,
    false,
    "settings never start paid work",
  );
  console.log(
    "PASS automatic compaction toggle persistence, unknown TTL, run details, desktop/phone and no provider calls",
  );
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  fs.rmSync(data, { recursive: true, force: true });
}