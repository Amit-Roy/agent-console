// PR cockpit UI: header strip, detail sheet, log, re-run, ship confirm, attention. GET/POST pr routes and the WS push are mocked.
// Run: node test/pr-cockpit-ui.ts   (screenshots land in /tmp/pr-cockpit-shots)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type WebSocketRoute,
} from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pr-ui-"));
const port = process.env.PR_UI_PORT || "7074";
assert.match(port, /^707[1-5]$/, "use an isolated scratch port, 7071–7075");
const base = `http://127.0.0.1:${port}`;
const shots = process.env.OUT || "/tmp/pr-cockpit-shots";
const threadId = "cockpit-ui-main";
fs.mkdirSync(path.join(data, "uploads"));
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id: threadId,
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: "PR conversation",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
);
fs.writeFileSync(
  path.join(data, "logs", `${threadId}.jsonl`),
  `${JSON.stringify({ type: "user_input", text: "Ship it." })}\n`,
);

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const check = (name: string, status: string, conclusion: string | null, key: string) => ({
  name,
  status,
  conclusion,
  detailsUrl: null,
  jobId: `job-${key}`,
  runId: `run-${key}`,
});
const card = (over: object = {}) => ({
  key: "o/r#7",
  repo: "o/r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Add the PR cockpit <b>strip</b>",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  headSha: "abc",
  checks: [
    check("lint", "COMPLETED", "SUCCESS", "1"),
    check("unit tests", "COMPLETED", "FAILURE", "2"),
    check("e2e", "IN_PROGRESS", null, "3"),
    check("build", "COMPLETED", "SUCCESS", "4"),
  ],
  checkCounts: { total: 4, passed: 2, failed: 1, pending: 1, skipped: 0 },
  unresolvedThreads: 1,
  commentCount: 3,
  reviewCount: 1,
  images: ["http://127.0.0.1/evidence-a.png", "http://127.0.0.1/evidence-b.png"],
  deploy: { deployed: "abc1234", text: "Deployed abc1234 to production" },
  ...over,
});
const second = card({
  key: "o/r#8",
  number: 8,
  title: "Second PR",
  checks: [check("lint", "COMPLETED", "SUCCESS", "5")],
  checkCounts: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0 },
  commentCount: 0,
  images: [],
  deploy: null,
});

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
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_ENV_FILES: "/dev/null",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser: Browser | undefined;
let serverError = "";
server.stderr.on("data", (chunk) => {
  serverError += String(chunk);
});
const errors: string[] = [];

type Call = { method: string; path: string; body: any };
type View = { page: Page; context: BrowserContext; calls: Call[]; push: (cards: object[]) => void };
async function openView(
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  phone: boolean,
  initial: object[],
): Promise<View> {
  const context = await (browser as Browser).newContext({
    viewport,
    colorScheme: scheme,
    serviceWorkers: "block",
    ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
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
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const calls: Call[] = [];
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, (route) => {
    // The real server pushes its own (empty) PR cards after subscribe; only the mocked pushes may reach the page.
    const upstream = route.connectToServer();
    upstream.onMessage((message) => {
      if (typeof message !== "string" || !message.includes('"t":"pr"')) route.send(message);
    });
    sockets.push(route);
  });
  await page.route("**/evidence-*.png", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }),
  );
  await page.route("**/api/threads/*/pr**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const tail = (url.pathname.split(/\/pr(?=\/|$)/)[1] ?? "") + url.search;
    const body = request.postData() ? JSON.parse(request.postData() as string) : null;
    calls.push({ method: request.method(), path: tail, body });
    const json = (payload: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    if (request.method() === "GET" && tail.startsWith("/log"))
      return json({ lines: ["FAIL src/a.test.ts", "expected 1 got <script>2</script>"] });
    if (request.method() === "GET") return json({ cards: initial });
    return json({ ok: true });
  });
  await page.goto(`${base}/#thread=${threadId}`);
  await page.waitForFunction(
    () =>
      document.getElementById("ttl")?.textContent === "PR conversation" &&
      !(document.getElementById("input") as HTMLTextAreaElement)?.disabled,
  );
  const push = (cards: object[]) => {
    for (const socket of sockets) socket.send(JSON.stringify({ t: "pr", thread: threadId, cards }));
  };
  return { page, context, calls, push };
}
const callsTo = (view: View, method: string, tail: RegExp) =>
  view.calls.filter((call) => call.method === method && tail.test(call.path));

async function shoot(
  name: string,
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  phone: boolean,
) {
  const view = await openView(viewport, scheme, phone, [card(), second]);
  const { page } = view;
  await page.locator("#pr-strip .pr-chip").nth(1).waitFor();
  await page.screenshot({ path: path.join(shots, `${name}-strip.png`) });
  await page.locator("#pr-strip .pr-chip").first().click();
  await page.locator("#pr-sheet[open]").waitFor();
  await page.locator("#pr-sheet .pr-image img").first().waitFor();
  await page.locator("#pr-sheet .pr-check .btn", { hasText: "Log" }).click();
  await page.locator("#pr-sheet .pr-log").waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, `${name}-sheet.png`) });
  const box = await page.locator("#pr-sheet").boundingBox();
  assert.ok(box, `${name}: sheet has a box`);
  if (phone) {
    assert.ok(Math.abs(box.y + box.height - viewport.height) < 2, `${name}: bottom sheet`);
    assert.ok(Math.abs(box.height - viewport.height * 0.7) < 3, `${name}: 70vh`);
    for (const selector of [
      "#pr-sheet .pr-check .btn",
      "#pr-sheet .pr-ship-btn",
      "#pr-sheet-close",
    ]) {
      const target = await page.locator(selector).first().boundingBox();
      assert.ok(
        target && target.height >= 43.5 && target.width >= 43.5,
        `${name}: ${selector} is 44px (${target?.width}x${target?.height})`,
      );
    }
  } else {
    assert.ok(Math.abs(box.x + box.width - viewport.width) < 12, `${name}: right side panel`);
  }
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    `${name}: no horizontal overflow`,
  );
  await view.context.close();
}

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Scratch server did not start: ${serverError}`)),
      15000,
    );
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("agent-console listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Scratch server exited: ${code}: ${serverError}`));
    });
  });
  browser = await chromium.launch();
  fs.mkdirSync(shots, { recursive: true });

  // Zero cards: the strip is hidden, then a WS push shows it, then an empty push hides it again.
  const empty = await openView({ width: 1280, height: 860 }, "dark", false, []);
  await empty.page.waitForTimeout(300);
  assert.equal(
    await empty.page.locator("#pr-strip").isVisible(),
    false,
    "strip hidden with zero cards",
  );
  assert.ok(callsTo(empty, "GET", /^$/).length >= 1, "cards fetched on thread open");
  empty.push([card()]);
  await empty.page.locator("#pr-strip").waitFor({ state: "visible" });
  empty.push([]);
  await empty.page.locator("#pr-strip").waitFor({ state: "hidden" });
  await empty.context.close();

  const view = await openView({ width: 1280, height: 860 }, "dark", false, [card(), second]);
  const { page } = view;
  await page.locator("#pr-strip .pr-chip").nth(1).waitFor();
  const strip = await page.locator("#pr-strip").boundingBox();
  assert.ok(strip && strip.height < 40, `strip is one slim row (${strip?.height})`);
  const first = page.locator("#pr-strip .pr-chip").first();
  assert.match(
    (await first.getAttribute("aria-label")) || "",
    /#7, Failing, 2\/4 checks, 3 comments, mergeable/,
    "chip text carries state, not colour only",
  );
  assert.match(
    (await first.textContent()) || "",
    /#72\/43/,
    "chip shows number, checks and comments",
  );

  await first.click();
  await page.locator("#pr-sheet[open]").waitFor();
  assert.equal(callsTo(view, "POST", /^\/refresh$/).at(-1)?.body.key, "o/r#7", "refresh on open");
  assert.equal(
    await page.locator("#pr-sheet-title").textContent(),
    "#7 Add the PR cockpit <b>strip</b>",
    "title escaped",
  );
  assert.equal(await page.locator("#pr-sheet-title b").count(), 0, "no html injected");
  const link = page.locator("#pr-sheet-link");
  assert.equal(await link.getAttribute("href"), "https://github.com/o/r/pull/7");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match((await link.getAttribute("rel")) || "", /noopener/);
  const names = await page.locator("#pr-sheet .pr-check-name").allTextContents();
  assert.deepEqual(names, ["unit tests", "e2e", "lint", "build"], "failing first, then pending");
  assert.equal(
    await page.locator("#pr-sheet .pr-check .btn", { hasText: "Re-run" }).count(),
    1,
    "buttons only on failing checks",
  );
  assert.match((await page.locator("#pr-sheet .pr-merge-line").textContent()) || "", /Mergeable/);
  assert.match(
    (await page.locator("#pr-sheet .pr-deploy").textContent()) || "",
    /Deployed abc1234/,
  );
  assert.equal(await page.locator("#pr-sheet .pr-image").count(), 2, "evidence grid");
  assert.equal(await page.locator("#pr-sheet .pr-image").first().getAttribute("target"), "_blank");

  await page.locator("#pr-sheet .btn", { hasText: "Re-run" }).click();
  await page.waitForFunction(() => document.querySelector("#pr-sheet")); // let the request settle
  await page.waitForTimeout(100);
  assert.deepEqual(callsTo(view, "POST", /^\/rerun$/).at(-1)?.body, {
    key: "o/r#7",
    runId: "run-2",
  });
  await page.locator("#pr-sheet .btn", { hasText: "Log" }).click();
  await page.locator("#pr-sheet .pr-log").waitFor({ state: "visible" });
  assert.match(
    (await page.locator("#pr-sheet .pr-log").textContent()) || "",
    /<script>2<\/script>/,
    "log is text only",
  );
  assert.equal(await page.locator("#pr-sheet .pr-log script").count(), 0);
  assert.match(callsTo(view, "GET", /^\/log/).at(-1)?.path || "", /key=o%2Fr%237&job=job-2/);

  // Ship needs confirmation; cancel posts nothing.
  await page.locator("#pr-sheet .pr-ship-btn").click();
  await page.locator("#pr-ship-dialog[open]").waitFor();
  await page.click("#pr-ship-cancel");
  assert.equal(callsTo(view, "POST", /^\/ship$/).length, 0, "cancel does not ship");
  await page.locator("#pr-sheet .pr-ship-btn").click();
  await page.click("#pr-ship-go");
  await page
    .locator("#pr-ship-dialog[open]")
    .waitFor({ state: "detached" })
    .catch(() => {});
  await page.waitForFunction(
    () => !(document.getElementById("pr-ship-dialog") as HTMLDialogElement).open,
  );
  assert.deepEqual(callsTo(view, "POST", /^\/ship$/).at(-1)?.body, { key: "o/r#7", confirm: true });

  // Ship state arrives over the socket; attention offers "Ask agent to fix".
  view.push([card({ ship: { state: "running", line: "Merging", startedAt: 1 } }), second]);
  await page.locator("#pr-sheet .pr-ship-line.running").waitFor();
  assert.equal(
    await page.locator("#pr-sheet .pr-ship-btn").count(),
    0,
    "no second ship while running",
  );
  view.push([
    card({
      ship: {
        state: "attention",
        line: "Deploy needs a look <i>x</i>",
        code: "deploy",
        startedAt: 1,
      },
    }),
    second,
  ]);
  await page.locator("#pr-sheet .pr-ship-line.attention").waitFor();
  assert.equal(await page.locator("#pr-sheet .pr-ship-line i").count(), 0, "ship line is text");
  await page.locator("#pr-sheet .btn", { hasText: "Ask agent to fix" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(callsTo(view, "POST", /^\/ask-fix$/).at(-1)?.body, { key: "o/r#7" });
  await page.keyboard.press("Escape");
  await page
    .locator("#pr-sheet[open]")
    .waitFor({ state: "detached" })
    .catch(() => {});
  assert.equal(await page.locator("#pr-sheet").isVisible(), false, "Escape closes the sheet");
  await view.context.close();

  for (const scheme of ["light", "dark"] as const) {
    await shoot(`phone-${scheme}`, { width: 390, height: 844 }, scheme, true);
    await shoot(`desktop-${scheme}`, { width: 1440, height: 900 }, scheme, false);
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("pr-cockpit-ui ok");
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
