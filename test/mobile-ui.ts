// Isolated UI fixture: no real threads, credentials, or model requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mobile-ui-"));
const base = "http://127.0.0.1:7074",
  id = "mobile-review";
const initial = {
  id,
  provider: "mock",
  model: "echo",
  effort: "medium",
  mode: "bypassPermissions",
  title: "Agent Console performance, steering & privacy",
  cwd: "/home/coder/repos",
  status: "idle",
  cost: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  context: { used: 136000, max: 475000 },
  lastRun: {
    model: "default",
    effort: "medium",
    source: "Codex CLI configuration",
    duration_ms: 18000,
    input_tokens: 5000,
    output_tokens: 1000,
  },
};
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([initial]));
fs.mkdirSync(path.join(data, "logs"));
fs.mkdirSync(path.join(data, "uploads"));
const history: any[] = [
  { type: "user_input", text: "Make the mobile composer easier to use." },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "The conversation stays in focus. Model and effort are within reach, and the controls make room for steering while the agent works.",
        },
      ],
    },
  },
];
for (let i = 0; i < 6; i++)
  history.push(
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool" + i,
            name: "Bash",
            input: {
              command: "node test/mobile-ui.ts",
              description: [
                "Checking the mobile layout",
                "Testing model and effort choices",
                "Measuring touch targets",
                "Checking larger text",
                "Testing the keyboard layout",
                "Verifying light and dark appearance",
              ][i],
            },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool" + i, content: "Checks passed." }],
      },
    },
  );
fs.writeFileSync(
  path.join(data, "logs", id + ".jsonl"),
  history.map((e) => JSON.stringify(e) + "\n").join(""),
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const { fitTitle } = await import("../server/providers/title.ts");
const { threadTitle } = await import("../server/window-dispatch.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: "7074",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_RUN: path.join(data, "run"),
  },
  stdio: "ignore",
});
let browser: Browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  // Generated names must fit the actual sidebar, including its running indicator and selected font weight.
  for (const width of [412, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 915 },
      isMobile: width === 412,
      hasTouch: width === 412,
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
    const titles = [
      "Auth:fix redirect",
      "WWW:WWWWWWWWWWWWWWWW",
      "线程:修复标题显示布局过长溢出问题",
      "Mobile:keyboard",
      "Windows:resize panel",
      "Security:passkeys",
      "Threads:short names",
      "Models:rate limit",
      "History:load older",
      "Repo:clean worktree",
      "Tests:run checks",
      "UI:compact sidebar",
    ].map((raw) => {
      const [topic, feature] = raw.split(":");
      return fitTitle({ prefix: `${topic}:`, text: feature }).title;
    });
    titles.splice(
      1,
      0,
      threadTitle({ repo: "o/WWWWWWWWWW", number: 12345, title: "WWWW wide issue" }),
      threadTitle({ repo: "o/資料検索表示修正開発管理", number: 1234567, title: "fix" }),
    );
    assert.ok(titles.every(Boolean), "all layout fixtures produce valid generated names");
    await context.routeWebSocket("**/ws", (socket) => {
      const upstream = socket.connectToServer();
      upstream.onMessage((raw) => {
        const m = JSON.parse(String(raw));
        if (m.t === "hello")
          m.threads = titles.map((title, i) => ({ ...initial, id: "title-" + i, title }));
        socket.send(JSON.stringify(m));
      });
      socket.onMessage((raw) => upstream.send(raw));
    });
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForSelector("#threads li .t", { state: "attached" });
    await page.evaluate(() => document.fonts.ready);
    if (width === 412) {
      await page.locator("#menu").click();
      await page.waitForFunction(
        () => document.querySelector("#side")!.getBoundingClientRect().x >= -1,
      );
    }
    for (const running of [false, true]) {
      const clipped = await page.evaluate(
        (running) =>
          [...document.querySelectorAll<HTMLElement>("#threads li")].flatMap((row) => {
            row.classList.add("sel");
            row.querySelector(".dot")?.classList.toggle("running", running);
            const title = row.querySelector<HTMLElement>(".t")!;
            return title.scrollWidth > title.clientWidth
              ? [
                  {
                    title: title.textContent,
                    available: title.clientWidth,
                    required: title.scrollWidth,
                  },
                ]
              : [];
          }),
        running,
      );
      assert.deepEqual(
        clipped,
        [],
        `${width}px generated titles fit ${running ? "running" : "idle"} selected rows`,
      );
    }
    if (process.env.OUT) {
      await page.evaluate(() =>
        document.querySelectorAll("#threads li").forEach((row, i) => {
          row.classList.toggle("sel", i === 0);
        }),
      );
      fs.mkdirSync(process.env.OUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OUT, `thread-titles-${width}.png`) });
    }
    console.log(`PASS ${width}px: 14 generated titles fit idle/running selected rows`);
    await context.close();
  }

  for (const colorScheme of ["dark", "light"] as const) {
    for (const width of [320, 390, 430, 600]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme,
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
      await context.addInitScript((id) => localStorage.setItem("ac_thread", id), id);
      let client: any;
      let thread = { ...initial };
      const sent: any[] = [];
      await context.routeWebSocket("**/ws", (socket) => {
        client = socket;
        const upstream = socket.connectToServer();
        upstream.onMessage((raw) => {
          const m = JSON.parse(String(raw));
          if (m.t === "hello") {
            m.threads = [thread];
            const p = m.providers.find((p: any) => p.id === "mock");
            p.modelDetails = {
              echo: {
                label: "CLI default",
                efforts: ["low", "medium", "high"],
                defaultEffort: "medium",
              },
            };
          }
          socket.send(JSON.stringify(m));
        });
        socket.onMessage((raw) => {
          const m = JSON.parse(String(raw));
          if (["send", "abort", "update", "steer_queued"].includes(m.t)) {
            sent.push(m);
            if (m.t === "update") {
              thread = { ...thread, ...m };
              socket.send(JSON.stringify({ t: "thread", thread }));
            }
          } else upstream.send(raw);
        });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base);
      await page.waitForFunction(() => !!(window as any).agentConsoleMetrics);
      const layout = () =>
        page.evaluate(() => {
          const card = document.querySelector("#cbox")!.getBoundingClientRect();
          const buttons = [...document.querySelectorAll<HTMLButtonElement>(".toolbar button")]
            .filter((b) => b.getBoundingClientRect().width > 0)
            .map((b) => {
              const r = b.getBoundingClientRect();
              return {
                id: b.id,
                x: r.x,
                y: r.y,
                right: r.right,
                bottom: r.bottom,
                width: r.width,
                height: r.height,
                label: b.getAttribute("aria-label") || b.textContent,
              };
            });
          return {
            height: card.height,
            buttons,
            overflow: document.documentElement.scrollWidth > innerWidth,
            inside: buttons.every(
              (b) => b.x >= card.x && b.right <= card.right + 1 && b.bottom <= innerHeight + 1,
            ),
          };
        });
      const idle = await layout();
      assert.ok(!idle.overflow && idle.inside, JSON.stringify(idle));
      assert.ok(idle.height <= 130, JSON.stringify(idle));
      assert.ok(
        idle.buttons.every((b) => b.width >= 43.5 && b.height >= 43.5),
        JSON.stringify(idle),
      );
      assert.ok(
        Math.max(...idle.buttons.map((b) => b.y)) - Math.min(...idle.buttons.map((b) => b.y)) < 1,
        "Idle controls stay in one row",
      );
      assert.ok(idle.buttons.some((b) => b.id === "effort"));
      await page.locator("#effort").click();
      await page.getByRole("option", { name: "Effort · High", exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector("#effort")?.getAttribute("aria-label")?.includes("High"),
      );
      await page.locator("#mode").click();
      await page.waitForSelector(".menu [role=option]");
      await page.keyboard.press("Escape");
      await page.locator("#more").click();
      await page.getByRole("menuitem", { name: /Run details/ }).click();
      await page.waitForSelector("#run-details[open]");
      assert.match(
        (await page.locator("#run-metrics").textContent()) || "",
        /5000 in · 0 from cache · 1000 out/,
      );
      await page.getByRole("button", { name: "Done", exact: true }).click();
      assert.equal(await page.locator("#run-details").isVisible(), false);
      thread = { ...thread, status: "running" };
      client.send(JSON.stringify({ t: "thread", thread }));
      await page.waitForSelector("#cbox.running");
      const running = await layout();
      assert.ok(running.height <= 175, JSON.stringify(running));
      assert.ok(running.inside && !running.overflow, JSON.stringify(running));
      for (const id of ["model", "effort", "mode"]) {
        assert.ok(
          running.buttons.some((b) => b.id === id),
          `${id} remains visible during a run`,
        );
        assert.ok(
          await page.locator("#" + id).isDisabled(),
          `${id} stays locked during the current run`,
        );
      }
      assert.ok(running.buttons.every((b) => b.width >= 43.5 && b.height >= 43.5));
      thread = { ...thread, context: undefined as any };
      client.send(JSON.stringify({ t: "thread", thread }));
      await page.waitForFunction(() => document.querySelector("#ctx")!.hasAttribute("hidden"));
      const noContext = await layout();
      assert.ok(noContext.inside && !noContext.overflow, JSON.stringify(noContext));
      const sendButton = noContext.buttons.find((b) => b.id === "send" || b.id === "stop")!; // empty composer mid-run shows Stop in Send's placeassert.ok(sendButton.right>=Math.max(...noContext.buttons.map(b=>b.right))-1,'Run actions stay at the trailing edge without context telemetry');thread={...thread,context:initial.context};client.send(JSON.stringify({t:'thread',thread}));await page.waitForFunction(()=>!document.querySelector('#ctx')!.hasAttribute('hidden'));
      await page.fill("#input", "Focus on the mobile layout.");
      await page.locator("#send").click();
      assert.equal(sent.at(-1).t, "send");
      assert.equal(sent.at(-1).mode, undefined);
      // single Send button: mid-run Send queues (no mode); on touch, Steer on the queued card hands it to the agent now
      client.send(
        JSON.stringify({
          t: "queue",
          thread: thread.id,
          items: [{ id: "q-steer", text: "Use this right away." }],
        }),
      );
      const steer = page.getByRole("button", { name: "Steer", exact: true });
      await steer.waitFor();
      const sb = (await steer.boundingBox())!;
      assert.ok(sb.height >= 43.5, "Steer is a 44px touch target " + JSON.stringify(sb));
      await steer.click();
      assert.deepEqual(sent.at(-1), { t: "steer_queued", thread: thread.id, id: "q-steer" });
      client.send(JSON.stringify({ t: "queue", thread: thread.id, items: [] }));
      await steer.waitFor({ state: "detached" });
      await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
      const scaled = await layout();
      assert.ok(!scaled.overflow && scaled.inside, JSON.stringify(scaled));
      thread = { ...thread, status: "idle" };
      client.send(JSON.stringify({ t: "thread", thread }));
      await page.waitForFunction(
        () => !document.querySelector("#cbox")!.classList.contains("running"),
      );
      const scaledIdle = await layout();
      assert.ok(!scaledIdle.overflow && scaledIdle.inside, JSON.stringify(scaledIdle));
      thread = { ...thread, status: "running" };
      client.send(JSON.stringify({ t: "thread", thread }));
      await page.waitForSelector("#cbox.running");
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
      if (width === 390) {
        await page.screenshot({
          path: `${process.env.OUT || os.tmpdir()}/ac-mobile-${colorScheme}-running.png`,
        });
        await page.setViewportSize({ width, height: 360 });
        await page.fill(
          "#input",
          Array(12).fill("A longer message above the keyboard.").join("\n"),
        );
        assert.ok((await layout()).inside, "Actions stay above the reduced viewport edge");
        await page.evaluate(() => {
          Object.defineProperty(visualViewport!, "height", { configurable: true, value: 260 });
          visualViewport!.dispatchEvent(new Event("resize"));
        });
        await page.waitForFunction(
          () => document.querySelector("#app")!.getBoundingClientRect().height <= 260,
        );
        assert.ok((await layout()).inside);
        assert.ok(
          (await page.locator("#send").boundingBox())!.y +
            (await page.locator("#send").boundingBox())!.height <=
            260,
          JSON.stringify(
            await page.evaluate(() =>
              Object.fromEntries(
                ["app", "head", "chat", "composer", "cbox", "input", "send"].map((id) => {
                  const r = document.getElementById(id)!.getBoundingClientRect();
                  return [id, { top: r.top, bottom: r.bottom, height: r.height }];
                }),
              ),
            ),
          ),
        );
        await page.evaluate(() => {
          Object.defineProperty(visualViewport!, "scale", { configurable: true, value: 2 });
          visualViewport!.dispatchEvent(new Event("resize"));
        });
        await page.waitForFunction(
          () => !document.documentElement.style.getPropertyValue("--viewport-height"),
        );
        await page.evaluate(() => {
          delete (visualViewport as any).height;
          delete (visualViewport as any).scale;
          visualViewport!.dispatchEvent(new Event("resize"));
        });
        await page.setViewportSize({ width, height: 844 });
        await page.fill("#input", "");
        thread = { ...thread, status: "idle" };
        client.send(JSON.stringify({ t: "thread", thread }));
        await page.waitForFunction(
          () => !document.querySelector("#cbox")!.classList.contains("running"),
        );
        await page.screenshot({
          path: `${process.env.OUT || os.tmpdir()}/ac-mobile-${colorScheme}-idle.png`,
        });
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${colorScheme} ${width}px: idle ${Math.round(idle.height)}px / running ${Math.round(running.height)}px; 44px targets, effort/mode menus, run details, steer/queue and 200% text`,
      );
      await context.close();
    }
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((r) => server.once("exit", () => r()));
  }
  fs.rmSync(data, { recursive: true, force: true });
}
