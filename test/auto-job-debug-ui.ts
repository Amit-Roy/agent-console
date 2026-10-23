// Browser integration uses the real app and dialog with a local HTTP/WebSocket fixture. No providers or user data are accessed.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { diagnoseJob } from "../server/automation/job.ts";

const root = path.resolve(import.meta.dirname, "..");
const out = process.env.OUT || "/tmp/auto-job-debug-ui";
fs.mkdirSync(out, { recursive: true });
const now = Date.now();
const issue = { repo: "Amit-Roy/agent-console", number: 7 };
const thread = (id: string, title: string, provider = "codex", extra = {}) => ({
  id,
  title,
  provider,
  model: provider === "claude" ? "opus" : "gpt-6.1-sol",
  effort: "high",
  mode: "acceptEdits",
  cwd: "/fixture/repos/agent-console",
  status: "idle",
  cost: 0,
  createdAt: now,
  updatedAt: now,
  ...extra,
});
const initialThreads = [
  thread("archived-worker", "Archived issue #8", "codex", {
    archived: true,
    issueRun: { ...issue, number: 8, key: "Amit-Roy/agent-console#8", role: "work", effort: "bau" },
  }),
  thread("failed-worker", "Issue #7 worker stopped", "codex", {
    issueRun: { ...issue, key: "Amit-Roy/agent-console#7", role: "work", effort: "bau" },
  }),
  thread("failed-review", "Issue #7 review stopped", "claude", {
    issueRun: { ...issue, key: "Amit-Roy/agent-console#7", role: "review", effort: "bau", pr: 95 },
  }),
];
const provider = (id: string, label: string, model: string) => ({
  id,
  label,
  ok: true,
  models: [model],
  defaultModel: model,
  modes: ["plan", "acceptEdits", "bypassPermissions"],
  defaultMode: "acceptEdits",
  modelDetails: {
    [model]: {
      label: id === "claude" ? "Opus" : "Sol 6.1",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  },
});
const providers = [
  {
    ...provider("claude", "Claude Code", "opus"),
    accounts: [
      { id: "sunny", label: "Sunny", ready: true },
      { id: "nefro", label: "Nefro", ready: true },
    ],
  },
  provider("codex", "Codex", "gpt-6.1-sol"),
  provider("pi", "Pi", "free-model"),
];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    res.end("{}");
    return;
  }
  const vendors: Record<string, string> = {
    "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
    "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  };
  const file = path.resolve(
    root,
    vendors[url.pathname] || `public${url.pathname === "/" ? "/index.html" : url.pathname}`,
  );
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader(
    "content-type",
    file.endsWith(".html")
      ? "text/html"
      : file.endsWith(".css")
        ? "text/css"
        : /\.(js|mjs)$/.test(file)
          ? "application/javascript"
          : "application/octet-stream",
  );
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
const diagnostic = (number = 7) =>
  diagnoseJob(
    { v: 1, ...issue, number },
    {
      now: () => now,
      lastError: () => ({
        ts: now,
        message: "Quota exceeded <script>window.debugInjected=true</script>",
        type: "provider_error",
      }),
      threads: () => [
        {
          ...initialThreads[2],
          issueRun: { ...initialThreads[2].issueRun, number, reviews: 3, outcome: "no-verdict" },
          lastRun: { duration_ms: 4231 },
        },
      ],
      events: () => [
        {
          seq: 1,
          ts: now - 9000,
          step: "worker",
          kind: "ok",
          ref: `Amit-Roy/agent-console#${number}`,
          run: "work:failed-worker",
          msg: "Worker finished its turn.",
        },
        {
          seq: 2,
          ts: now - 8000,
          step: "pr",
          kind: "ok",
          ref: `Amit-Roy/agent-console#${number}`,
          msg: "Found open PR #95.",
        },
        {
          seq: 3,
          ts: now - 1000,
          step: "review",
          kind: "fail",
          ref: `Amit-Roy/agent-console#${number}`,
          run: "review:failed-review",
          msg: "Review exited: quota exceeded <img src=x onerror=window.debugInjected=true>",
        },
      ],
    },
  );
async function openDebug(page: Page, mobile: boolean, number = 7) {
  if (mobile && !(await page.locator("body").evaluate((body) => body.classList.contains("nav"))))
    await page.locator("#menu").click();
  await page.locator("#lane-auto").click();
  if (number === 8 && !(await page.locator("#auto-archived").isVisible()))
    await page.locator("#auto-archive-toggle").click();
  await page
    .locator(`.auto-group[data-issue="amit-roy/agent-console#${number}"] .auto-group-more`)
    .click();
  await page.getByRole("menuitem", { name: "Debug", exact: true }).click();
  await page.locator("#auto-job-debug").waitFor({ state: "visible", timeout: 3000 });
}
try {
  for (const [device, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const)
    for (const colorScheme of ["dark", "light"] as const) {
      const name = `${device}-${colorScheme}`,
        mobile = device === "phone";
      const context = await browser.newContext({
        viewport,
        colorScheme,
        isMobile: mobile,
        hasTouch: mobile,
        serviceWorkers: "block",
        recordVideo: { dir: out, size: viewport },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors: string[] = [],
        requests: any[] = [],
        messages: any[] = [];
      let mode = "error",
        release!: () => void;
      let gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.routeWebSocket(/\/ws$/, (ws) => {
        ws.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          messages.push(message);
          if (message.t === "open")
            ws.send(
              JSON.stringify({
                t: "history",
                thread: message.thread,
                request: message.request,
                events: [],
                start: 0,
                end: 0,
              }),
            );
          if (message.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
        });
        ws.send(
          JSON.stringify({
            t: "hello",
            threads: initialThreads,
            providers,
            dirs: ["/fixture/repos/agent-console"],
            tasks: [],
            questions: {},
            usage: {},
            queues: {},
            commands: {},
            features: {},
          }),
        );
      });
      await page.route("**/api/automation/job?**", async (route) => {
        requests.push(route.request());
        const requestMode = mode;
        if (requestMode === "error" || requestMode === "stale") await gate;
        if (requestMode === "error")
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Diagnostics temporarily unavailable." }),
          });
        const number = Number(new URL(route.request().url()).searchParams.get("number"));
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(diagnostic(number)),
          })
          .catch(() => {});
      });
      await page.goto(base);
      await page.waitForFunction(() => document.getElementById("ttl")?.textContent);
      await openDebug(page, mobile);
      const dialog = page.locator("#auto-job-debug");
      await dialog.getByRole("status").waitFor();
      await page.screenshot({ path: path.join(out, `${name}-loading.png`) });
      await page.waitForTimeout(650);
      release();
      await dialog.getByRole("alert").waitFor();
      assert.match(await dialog.innerText(), /Diagnostics temporarily unavailable/);
      await page.screenshot({ path: path.join(out, `${name}-error.png`) });
      await page.waitForTimeout(650);
      mode = "success";
      await dialog.getByRole("button", { name: "Retry", exact: true }).click();
      await dialog.locator(".job-debug-workflow").waitFor();
      assert.match(
        await dialog.locator(".job-debug-summary").innerText(),
        /Review exited: quota exceeded/,
      );
      assert.match(
        await dialog.locator(".job-debug-workflow").innerText(),
        /Triage[\s\S]*Dispatcher[\s\S]*Worker[\s\S]*Premium review[\s\S]*Merge[\s\S]*Apply/,
      );
      assert.match(await dialog.innerText(), /No retained event for this step/);
      assert.equal(await dialog.locator(".job-debug-workflow > li").count(), 11);
      await page.screenshot({ path: path.join(out, `${name}-workflow.png`) });
      await page.waitForTimeout(900);
      const details = dialog.locator(".job-debug-runs details").first();
      if (!(await details.getAttribute("open"))) await details.locator("summary").click();
      assert.match(await details.innerText(), /failed-review/);
      assert.match(await details.innerText(), /Quota exceeded/);
      assert.match(
        await dialog.locator(".job-debug-events").innerText(),
        /Review exited: quota exceeded/,
      );
      assert.equal(
        await page.evaluate(() => (window as any).debugInjected),
        undefined,
        "Untrusted diagnostic text remains escaped",
      );
      await details
        .getByRole("button", { name: "Open thread", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `${name}-evidence.png`) });
      await page.waitForTimeout(850);
      await details.getByRole("button", { name: "Open thread", exact: true }).click();
      await page.waitForFunction(
        () => document.getElementById("ttl")?.textContent === "Issue #7 review stopped",
      );
      assert.equal(await dialog.isVisible(), false);
      await openDebug(page, mobile, 8);
      await dialog.locator(".job-debug-workflow").waitFor();
      assert.match(await dialog.innerText(), /agent-console#8/);
      await page.screenshot({ path: path.join(out, `${name}-archived.png`) });
      mode = "stale";
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
      await dialog.getByRole("status").waitFor();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      mode = "success";
      await openDebug(page, mobile, 7);
      await dialog.locator(".job-debug-workflow").waitFor();
      release();
      await page.waitForTimeout(350);
      assert.match(await dialog.innerText(), /agent-console#7/);
      assert.doesNotMatch(await dialog.innerText(), /agent-console#8/);
      assert.equal(
        requests.every((req) => req.method() === "GET"),
        true,
        "Diagnostics are read-only",
      );
      assert.equal(
        messages.some((message) => ["create", "fork", "send", "task_save"].includes(message.t)),
        false,
      );
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const video = page.video();
      await context.close();
      assert.ok(video);
      await video.saveAs(path.join(out, `${name}-debug-interaction.webm`));
    }
  console.log(
    "PASS Auto Debug: loading, retry, workflow, failure evidence, escaped text, linked thread, archived jobs, refresh and stale-response guard; desktop/phone dark/light.",
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
