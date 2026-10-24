// Improve-prompt dialog in a real browser (mock rewrite): quotes, highlights, Check, Use, Escape, phone fit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { fixtureEffortModel } from "./fixtures/triage-effort.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-improve-ui-"));
const port = Number(process.env.IMPROVE_UI_PORT || 7491);
const base = `http://127.0.0.1:${port}`;
const threadId = "7a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const shots = "/tmp/pr249";
fs.mkdirSync(shots, { recursive: true });
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
      title: "Improve",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  ]),
);
fs.writeFileSync(
  path.join(data, "logs", `${threadId}.jsonl`),
  `${JSON.stringify({ type: "user_input", text: "fixture" })}\n`,
);

// Quotes need an effort model: a flat tree model built from the shared fixture.
const leaf = (value: number) => ({ f: [0], t: [0], l: [-1], r: [-1], v: [value] });
const levels = ["p50", "p75", "p80", "p95", "p99"];
const byLevel = (make: (level: string, index: number) => unknown) =>
  Object.fromEntries(levels.map((level, index) => [level, make(level, index)]));
const fixture = fixtureEffortModel.status === "ready" ? fixtureEffortModel.model : null;
assert.ok(fixture, "fixture model loads");
const modelFile = path.join(data, "effort-model.json");
fs.writeFileSync(
  modelFile,
  JSON.stringify({
    ...structuredClone(fixture),
    workloadMetric: "totalTokens",
    tokenYieldBasis: "workload",
    workload: {
      ...fixture.workload,
      intercept: Math.log1p(8000),
      coefficients: [0, 0, 0, 0],
      missingCoefficients: [0, 0, 0, 0],
    },
    scenarios: fixture.scenarios.map((row) => ({
      ...row,
      logResidual: 0,
      inputPerWork: 0.8,
      outputPerWork: 0.2,
      freshInputPerWork: null,
      cachedInputPerWork: null,
      roundsPerWork: null,
    })),
    quantileModel: {
      features: ["size", "lines", "refs", "verbs"],
      quantiles: { p50: 0.5, p75: 0.75, p80: 0.8, p95: 0.95, p99: 0.99 },
      baseline: byLevel(() => 0),
      trees: byLevel((_level, index) => [leaf(Math.log(8000 * 2 ** (index * 1.4)))]),
      offsets: byLevel(() => 0),
      ceiling: 1_000_000,
    },
  }),
  { mode: 0o600 },
);

process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
    AGENT_CONSOLE_TRIAGE_EFFORT_MODEL: modelFile,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

const DRAFT = "Write a landing page for my app";
const input = (page: Page) => page.locator("#input");
const draftOf = (page: Page) => input(page).evaluate((box: any) => box.value);

async function newPage(
  browser: Browser,
  options: Parameters<Browser["newContext"]>[0],
): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext(options);
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  if (await page.locator("#menu").isVisible()) await page.locator("#menu").click();
  await page.locator("#threads li .t", { hasText: "Improve" }).click();
  await page.waitForFunction(
    () => document.getElementById("input")?.getAttribute("contenteditable") === "true",
  );
  return { page, context, errors };
}

async function openResult(page: Page, draft = DRAFT) {
  await page.fill("#input", draft);
  await page.locator("#improve:not(:disabled)").waitFor();
  await page.locator("#improve").click();
  await page.locator("#prompt-improve").waitFor();
  await page.locator("#pi-text").waitFor();
}

async function assertFits(page: Page) {
  const fit = await page.evaluate(() => {
    const dialog = document.getElementById("prompt-improve")!;
    for (const animation of dialog.getAnimations()) animation.finish();
    const box = dialog.getBoundingClientRect();
    const scroll = dialog.querySelector(".pi-scroll")!;
    const use = document.getElementById("pi-use")!.getBoundingClientRect();
    return {
      pageWide: document.documentElement.scrollWidth > innerWidth,
      scrollWide: scroll.scrollWidth > scroll.clientWidth,
      dialogOutside: box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight,
      useOutside: use.bottom > innerHeight || use.right > innerWidth,
    };
  });
  assert.deepEqual(fit, {
    pageWide: false,
    scrollWide: false,
    dialogOutside: false,
    useOutside: false,
  });
}

let browser: Browser | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    server.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("agent-console listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  browser = await chromium.launch();

  // desktop: behaviour
  const desktop = await newPage(browser, { viewport: { width: 1280, height: 800 } });
  const page = desktop.page;
  assert.equal(await page.locator("#improve").isDisabled(), true, "disabled with an empty draft");
  assert.equal(await page.locator("#improve").getAttribute("aria-label"), "Improve prompt");

  // Escape cancels: draft untouched
  await openResult(page);
  assert.match(await page.locator("#pi-before").innerText(), /P50/, "before quote renders");
  assert.match(await page.locator("#pi-after").innerText(), /P80/, "after quote renders");
  assert.equal(await page.locator("#pi-back mark").first().innerText(), "[audience]");
  assert.equal(await page.locator("#pi-back mark").first().isVisible(), true, "mark is visible");
  assert.equal(await page.locator("#pi-chips button").count(), 1, "one placeholder chip");
  await page.screenshot({ path: `${shots}/ui-desktop.png` });
  await page.locator("#pi-chips button").click();
  assert.equal(
    await page.locator("#pi-text").evaluate((box: HTMLTextAreaElement) =>
      box.value.slice(box.selectionStart, box.selectionEnd),
    ),
    "[audience]",
    "chip selects the placeholder",
  );
  await page.keyboard.press("Escape");
  await page.locator("#prompt-improve").waitFor({ state: "hidden" });
  assert.equal(await draftOf(page), DRAFT, "Escape leaves the draft untouched");

  // Use with an unfilled placeholder asks first; declining keeps the dialog and the draft
  await page.locator("#improve").click();
  await page.locator("#pi-text").waitFor();
  const asked: string[] = [];
  page.once("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.dismiss();
  });
  await page.locator("#pi-use").click();
  assert.deepEqual(asked, ["1 placeholder not filled. Use anyway?"]);
  assert.equal(await draftOf(page), DRAFT, "declined confirm leaves the draft");

  // Edit the placeholder away, Check refreshes the After quote and clears chips
  const edited = "Write a landing page for freelance designers, three versions.";
  await page.locator("#pi-text").fill(edited);
  assert.equal(await page.locator("#pi-back mark").count(), 0, "highlights follow the edit");
  const requote = page.waitForResponse((res) => res.url().endsWith("/api/prompt/quote"));
  await page.locator("#pi-check").click();
  assert.equal((await requote).status(), 200, "Check re-quotes the edited text");
  await page.waitForFunction(() => /P50/.test(document.getElementById("pi-after")!.innerText));
  assert.equal(await page.locator("#pi-chips button").count(), 0, "chips gone");
  assert.match(await page.locator("#pi-diff").innerText(), /^Change: P50 .* tokens$/);

  // Use writes the text and saves the draft
  await page.locator("#pi-use").click();
  await page.locator("#prompt-improve").waitFor({ state: "hidden" });
  assert.equal(await draftOf(page), edited, "Use writes the edited text into the composer");
  const saved = await page.evaluate((key) => localStorage.getItem(key), `ac_draft:${threadId}`);
  assert.equal(saved, edited, "Use saves the draft");
  assert.deepEqual(desktop.errors, []);
  await desktop.context.close();

  // phone: fit and screenshots, light and dark
  for (const scheme of ["light", "dark"] as const) {
    const phone = await newPage(browser, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      colorScheme: scheme,
    });
    await openResult(phone.page);
    await phone.page.screenshot({
      path: `${shots}/ui-phone${scheme === "dark" ? "-dark" : ""}.png`,
    });
    await assertFits(phone.page);
    if (scheme === "light") {
      await phone.page.locator("#pi-text").fill("x ".repeat(1500));
      await assertFits(phone.page);
    }
    assert.deepEqual(phone.errors, []);
    await phone.context.close();
  }
  console.log("PASS prompt improve UI: quotes, highlights, Check, Use, Escape, phone fit");
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
