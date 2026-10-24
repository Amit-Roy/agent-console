// The composer must be richly editable (Chrome on Android only hands pasted images to such hosts, never to a
// <textarea> or plaintext-only) yet stay text-only. Real Ctrl+V through the browser clipboard, headless.
// Also covers the Improve prompt dialog (mock rewrite). PI_SCREENSHOTS=<dir> saves its phone/desktop evidence images.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { fixtureEffortModel } from "./fixtures/triage-effort.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-paste-ui-"));
const port = Number(process.env.PASTE_UI_PORT || 7076),
  base = `http://127.0.0.1:${port}`;
fs.mkdirSync(path.join(data, "uploads"));
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: "Paste",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  ]),
);
fs.writeFileSync(
  path.join(data, "logs", "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f.jsonl"),
  JSON.stringify({ type: "user_input", text: "fixture" }) + "\n",
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
const shots = process.env.PI_SCREENSHOTS;
const composerText = (page: Page) => page.locator("#input").evaluate((box: any) => box.value);

async function assertImproveFits(page: Page) {
  // layout settles over two frames after a viewport change (visualViewport resize feeds --viewport-height)
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const fit = await page.evaluate(() => {
    const dialog = document.getElementById("prompt-improve")!;
    for (const animation of dialog.getAnimations()) animation.finish();
    const box = dialog.getBoundingClientRect();
    const scroll = dialog.querySelector(".pi-scroll")!;
    const use = document.getElementById("pi-use")!.getBoundingClientRect();
    return {
      pageWide: document.documentElement.scrollWidth > innerWidth,
      scrollWide: scroll.scrollWidth > scroll.clientWidth,
      dialogOutside:
        box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight,
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

async function openImprove(page: Page) {
  await page.locator("#improve:not(:disabled)").waitFor();
  await page.locator("#improve").click();
  await page.locator("#pi-text").waitFor();
}

// Dialog open on the result view: phone fit (and long text), then optional evidence screenshots.
async function improveLayout(page: Page) {
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, "ui-desktop.png") });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const improved = await page.locator("#pi-text").inputValue();
  await page.locator("#pi-text").fill("x ".repeat(1500));
  await assertImproveFits(page);
  await page.locator("#pi-text").fill(improved);
  await assertImproveFits(page);
  if (shots) {
    await page.screenshot({ path: path.join(shots, "ui-phone.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(shots, "ui-phone-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function improveCases(page: Page) {
  await page.fill("#input", DRAFT);
  assert.equal(await page.locator("#improve").getAttribute("aria-label"), "Improve prompt");
  await openImprove(page);
  assert.match(await page.locator("#pi-before").innerText(), /P50/, "before quote renders");
  assert.match(await page.locator("#pi-after").innerText(), /P80/, "after quote renders");
  const mark = page.locator("#pi-back mark").first();
  assert.equal(await mark.innerText(), "[audience]");
  assert.equal(await mark.isVisible(), true, "placeholder mark is visible");
  assert.equal(await page.locator("#pi-chips button").count(), 1, "one placeholder chip");
  await improveLayout(page);
  await page.locator("#pi-chips button").click();
  const selected = await page
    .locator("#pi-text")
    .evaluate((box: HTMLTextAreaElement) => box.value.slice(box.selectionStart, box.selectionEnd));
  assert.equal(selected, "[audience]", "chip selects the placeholder");
  await page.keyboard.press("Escape");
  await page.locator("#prompt-improve").waitFor({ state: "hidden" });
  assert.equal(await composerText(page), DRAFT, "Escape leaves the draft untouched");

  // Use with an unfilled placeholder asks first; declining keeps the draft
  await openImprove(page);
  const asked: string[] = [];
  page.once("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.dismiss();
  });
  await page.locator("#pi-use").click();
  assert.deepEqual(asked, ["1 placeholder not filled. Use anyway?"]);
  assert.equal(await composerText(page), DRAFT, "declined confirm leaves the draft");

  // Edit the placeholder away: highlights follow, Check re-quotes, chips go
  const edited = "Write a landing page for freelance designers, three versions.";
  await page.locator("#pi-text").fill(edited);
  assert.equal(await page.locator("#pi-back mark").count(), 0, "highlights follow the edit");
  const requote = page.waitForResponse((res) => res.url().endsWith("/api/prompt/quote"));
  await page.locator("#pi-check").click();
  assert.equal((await requote).status(), 200, "Check re-quotes the edited text");
  await page.waitForFunction(() => /P50/.test(document.getElementById("pi-after")!.innerText));
  assert.equal(await page.locator("#pi-chips button").count(), 0, "chips gone");
  assert.match(await page.locator("#pi-diff").innerText(), /^Change: P50 .* tokens$/);

  await page.locator("#pi-use").click();
  await page.locator("#prompt-improve").waitFor({ state: "hidden" });
  assert.equal(await composerText(page), edited, "Use writes the edited text into the composer");
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.startsWith("ac_draft:"));
    return key ? localStorage.getItem(key) : null;
  });
  assert.equal(saved, edited, "Use saves the draft");
}

let browser: Browser;
try {
  await new Promise<void>((ok, bad) => {
    const t = setTimeout(() => bad(new Error("server did not start")), 15000);
    server.stdout.on("data", (c) => {
      if (String(c).includes("agent-console listening")) {
        clearTimeout(t);
        ok();
      }
    });
    server.once("exit", (c) => bad(new Error(`server exited ${c}`)));
  });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#threads li .t", { hasText: "Paste" }).click();
  await page.waitForFunction(
    () => document.getElementById("input")?.getAttribute("contenteditable") === "true",
  );
  const box = page.locator("#input");
  assert.equal(
    await box.evaluate(
      (e: HTMLElement) => e.isContentEditable && e.getAttribute("contenteditable"),
    ),
    "true",
    "composer is richly editable",
  );
  const value = () => box.evaluate((e: any) => e.value);
  const copy = (fn: string) => page.evaluate(fn);

  // image on the real clipboard -> attachment, not text
  await box.click();
  await page.evaluate(async () => {
    const c = Object.assign(document.createElement("canvas"), { width: 120, height: 80 });
    const g = c.getContext("2d")!;
    g.fillStyle = "#39f";
    g.fillRect(0, 0, 120, 80);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await page.keyboard.press("Control+V");
  await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 1);
  await page.waitForFunction(
    () => (document.getElementById("input") as any).value === "[Image #1] ",
  );
  assert.equal(await value(), "[Image #1] ", "image paste adds the label, not pixels");
  assert.equal(
    await box.evaluate((e: HTMLElement) => e.querySelector("img,canvas,svg") === null),
    true,
    "no image element inside the composer",
  );
  await page.locator("#thumbs .rm").click();
  await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 0);
  assert.equal(await value(), "", "removing the image removes its label");

  // Chrome on Android (keyboard media insertion) dispatches paste with a bare file built from bytes: no name, no type
  await box.click();
  const claimed = await page.evaluate(async () => {
    const c = Object.assign(document.createElement("canvas"), { width: 60, height: 40 });
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "", { type: "" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById("input")!.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert.equal(claimed, true, "untyped keyboard image paste is claimed");
  await page.waitForFunction(() => document.querySelectorAll("#thumbs li img").length === 1);
  assert.equal(await value(), "[Image #1] ", "untyped keyboard image becomes an image attachment");
  await page.locator("#thumbs .rm").click();
  await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 0);

  // rich HTML on the clipboard is flattened to its text
  await page.fill("#input", "");
  await box.click();
  await page.evaluate(async () => {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob(
          ['<b style="color:red">bold</b> and <a href="https://x.test">link</a><script>1</script>'],
          { type: "text/html" },
        ),
        "text/plain": new Blob(["bold and link"], { type: "text/plain" }),
      }),
    ]);
  });
  await page.keyboard.press("Control+V");
  assert.equal(await value(), "bold and link", "plain text only");
  assert.equal(
    await box.evaluate((e: HTMLElement) => e.querySelector("b,a,script,span") === null),
    true,
    "no markup inside the composer",
  );

  // typing, Enter inside a line, caret-aware label insert
  await page.fill("#input", "");
  await box.pressSequentially("one");
  await page.keyboard.press("Shift+Enter");
  await box.pressSequentially("two");
  assert.equal(await value(), "one\ntwo", "Shift+Enter makes a newline");
  await improveCases(page);
  assert.deepEqual(errors, []);
  console.log(
    "PASS composer: paste image -> attachment, rich HTML flattened, editable text; Improve prompt dialog",
  );
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
