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
          input: { description: "Background work", prompt: "Work in background" },
        },
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
        {
          type: "tool_use",
          id: "tool-agent-bg",
          name: "Agent",
          input: { description: "Background work", prompt: "Work in background" },
        },
      ],
    },
    ts: now + 100,
  },
  {
    type: "system",
    subtype: "task_started",
    tool_use_id: "tool-agent-bg",
    is_backgrounded: true,
    ts: now + 200,
  },
  // NO task_notification - agent completed but event was compacted away
];

fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    fixture("known-cache-1280", "claude"),
    fixture("known-cache-390", "claude"),
    fixture("unknown-cache", "codex"),
  ]),
);

process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const env = {
  ...process.env,
  PORT: "7073",
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_RUN: path.join(data, "run"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_HEADROOM: "0",
  AGENT_CONSOLE_WARM_MAX: "0",
  AGENT_CONSOLE_IDLE_COMPACT_CLAUDE_TTL_MS: "3600000",
};
delete env.AGENT_CONSOLE_PID_FILE;
delete env.AGENT_CONSOLE_IDLE_COMPACT_CODEX_TTL_MS;
const server = spawn(process.execPath, [process.env.TEST_SERVER_ENTRY || "server/index.ts"], {
  env,
  stdio: "ignore",
});
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
  const runToggle = async (width: number) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: "dark",
    });
    await context.addCookies([
      {
        name: "__Host-ac_session",
        value: makeToken(),
        domain: new URL(base).hostname,
        path: "/",
        secure: true,
      },
    ]);
    await context.addInitScript(
      (threadId) => localStorage.setItem("ac_thread", threadId),
      `known-cache-${width}`,
    );
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
  };

  // Exact counts and completed replay prevent empty history from passing.
  const lifecycleContexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const newLifecycleContext = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([
      {
        name: "__Host-ac_session",
        value: makeToken(),
        domain: new URL(base).hostname,
        path: "/",
        secure: true,
      },
    ]);
    await context.addInitScript(() => localStorage.setItem("ac_thread", "lifecycle"));
    lifecycleContexts.push(context);
    return context;
  };
  const runScenario = async (lifecycleContext: Awaited<ReturnType<typeof newLifecycleContext>>, scenario: string) => {
    const page = await lifecycleContext.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    let send!: (message: object) => void;
    const active = scenario === "active";
    const background = scenario === "background";
    const later = scenario === "delta" || scenario === "earlier";
    const live = scenario === "result" || scenario === "aborted";
    const history =
      scenario === "done-launch"
        ? [
            ...staleBgHistory,
            {
              type: "user",
              message: {
                content: [
                  { type: "tool_result", tool_use_id: "tool-agent-bg", content: "Launched" },
                ],
              },
              ts: now + 300,
            },
          ]
        : background
          ? [
              ...toolCardsHistory,
              {
                type: "system",
                subtype: "task_started",
                tool_use_id: "tool-agent-1",
                is_backgrounded: true,
                ts: now + 200,
              },
              ...staleBgHistory.slice(1),
            ]
          : toolCardsHistory;
    await page.routeWebSocket("**/ws", (socket) => {
      send = (message) => socket.send(JSON.stringify(message));
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t === "ping") send({ t: "pong" });
        if (request.t === "open")
          send({
            t: "history",
            thread: "lifecycle",
            request: request.request,
            events: live || later ? [] : history,
            start: 0,
            end: live || later ? 0 : history.length,
            workState: {
              version: 1,
              foreground: active ? ["tool-bash-1", "tool-agent-1"] : [],
              background: background ? ["tool-agent-1"] : [],
              backgroundCount: background ? 1 : 0,
            },
          });
      });
      send({
        t: "hello",
        threads: [
          {
            ...fixture("lifecycle", "mock"),
            status: active || live ? "running" : "idle",
            background: 0,
          },
        ],
        providers: [],
        dirs: [process.cwd()],
        tasks: [],
        questions: {},
        usage: {},
        queues: {},
        commands: {},
        features: {},
      });
    });
    await page.goto(base);
    await page
      .waitForFunction(
        () =>
          Reflect.get(window, "agentConsoleMetrics")?.thread === "lifecycle" &&
          document.querySelector("#chat")?.getAttribute("aria-busy") === "false",
      )
      .catch((error) => {
        throw new Error(
          `${scenario}: history did not finish; browser errors: ${errors.join("; ")}`,
          { cause: error },
        );
      });

    if (later) {
      send({
        t: "history",
        thread: "lifecycle",
        events: history,
        start: 0,
        end: history.length,
        ...(scenario === "delta" ? { delta: true } : { before: 1 }),
        workState: { version: 1, foreground: [], background: [], backgroundCount: 0 },
      });
    }
    if (live) {
      send({ t: "event", thread: "lifecycle", event: toolCardsHistory[1] });
      await page.waitForFunction(() => document.querySelectorAll(".msg.card.pending").length === 2);
      send({ t: "event", thread: "lifecycle", event: { type: scenario, ts: now + 500 } });
    }
    const count = scenario === "done-launch" ? 1 : background ? 3 : 2;
    await page.waitForFunction(
      ({ count, active, background }) =>
        document.querySelectorAll(".msg.card").length === count &&
        document.querySelectorAll(".msg.card.pending").length ===
          (active ? count : background ? 1 : 0),
      { count, active, background },
    );
    assert.equal(await page.locator(".msg.card").count(), count, `${scenario}: exact cards`);
    assert.equal(
      await page.locator(".task-chip.running").count(),
      background ? 1 : 0,
      `${scenario}: no orphan chips`,
    );
    assert.equal(
      await page.locator("#state-t").textContent(),
      active || background ? "Working · 1 agent" : "Working",
      `${scenario}: header count`,
    );
    if (!active && !background && scenario !== "done-launch")
      assert.equal(
        await page.locator(".msg.card .st .sr-only").filter({ hasText: "interrupted" }).count(),
        count,
        `${scenario}: interrupted status`,
      );
    if (background) {
      send({
        t: "thread",
        thread: {
          ...fixture("lifecycle", "mock"),
          workState: { version: 1, foreground: [], background: [], backgroundCount: 1 },
        },
      });
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".task-chip.running, .msg.card.pending").length === 0 &&
          document.querySelector("#state-t")?.textContent === "Working · 1 agent",
      );
      send({
        t: "thread",
        thread: {
          ...fixture("lifecycle", "mock"),
          workState: { version: 1, foreground: [], background: [], backgroundCount: 0 },
        },
      });
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".task-chip.running, .msg.card.pending").length === 0 &&
          document.querySelector("#state-t")?.textContent === "Working",
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS tool card lifecycle ${scenario}`);
  };
  // Toggle widths (own threads) and two scenario lanes (own contexts) run concurrently.
  const scenarios = process.env.AC_LIFECYCLE_CASE
    ? [process.env.AC_LIFECYCLE_CASE]
    : ["idle", "done-launch", "active", "background", "delta", "earlier", "result", "aborted"];
  const half = Math.ceil(scenarios.length / 2);
  const lanes = [scenarios.slice(0, half), scenarios.slice(half)].filter((lane) => lane.length);
  await Promise.all([
    ...(process.env.AC_LIFECYCLE_CASE ? [] : [1280, 390]).map(runToggle),
    ...lanes.map(async (lane) => {
      const context = await newLifecycleContext();
      for (const scenario of lane) await runScenario(context, scenario);
    }),
  ]);
  await Promise.all(lifecycleContexts.map((context) => context.close()));

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
