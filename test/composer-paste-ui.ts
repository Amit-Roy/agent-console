// The composer must be richly editable (Chrome on Android only hands pasted images to such hosts, never to a
// <textarea> or plaintext-only) yet stay text-only. Real Ctrl+V through the browser clipboard, headless.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-paste-ui-"));
const port = Number(process.env.PASTE_UI_PORT || 7076), base = `http://127.0.0.1:${port}`;
fs.mkdirSync(path.join(data, "uploads")); fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([{ id: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", provider: "mock", model: "echo", mode: "acceptEdits", title: "Paste", cwd: os.tmpdir(), status: "idle", cost: 0, createdAt: 2, updatedAt: 2 }]));
fs.writeFileSync(path.join(data, "logs", "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f.jsonl"), JSON.stringify({ type: "user_input", text: "fixture" }) + "\n");
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, PORT: String(port), AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_RUN: path.join(data, "run"), AGENT_CONSOLE_BRAIN: path.join(data, "no-brain") }, stdio: ["ignore", "pipe", "inherit"] });
let browser;
try {
  await new Promise<void>((ok, bad) => { const t = setTimeout(() => bad(new Error("server did not start")), 15000); server.stdout.on("data", (c) => { if (String(c).includes("agent-console listening")) { clearTimeout(t); ok(); } }); server.once("exit", (c) => bad(new Error(`server exited ${c}`))); });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#threads li .t", { hasText: "Paste" }).click();
  await page.waitForFunction(() => document.getElementById("input")?.getAttribute("contenteditable") === "true");
  const box = page.locator("#input");
  assert.equal(await box.evaluate((e: HTMLElement) => e.isContentEditable && e.getAttribute("contenteditable")), "true", "composer is richly editable");
  const value = () => box.evaluate((e: any) => e.value);
  const copy = (fn: string) => page.evaluate(fn);

  // image on the real clipboard -> attachment, not text
  await box.click();
  await page.evaluate(async () => {
    const c = Object.assign(document.createElement("canvas"), { width: 120, height: 80 });
    const g = c.getContext("2d")!; g.fillStyle = "#39f"; g.fillRect(0, 0, 120, 80);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await page.keyboard.press("Control+V");
  await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 1);
  await page.waitForFunction(() => (document.getElementById("input") as any).value === "[Image #1] ");
  assert.equal(await value(), "[Image #1] ", "image paste adds the label, not pixels");
  assert.equal(await box.evaluate((e: HTMLElement) => e.querySelector("img,canvas,svg") === null), true, "no image element inside the composer");
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
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob(['<b style="color:red">bold</b> and <a href="https://x.test">link</a><script>1</script>'], { type: "text/html" }),
      "text/plain": new Blob(["bold and link"], { type: "text/plain" }),
    })]);
  });
  await page.keyboard.press("Control+V");
  assert.equal(await value(), "bold and link", "plain text only");
  assert.equal(await box.evaluate((e: HTMLElement) => e.querySelector("b,a,script,span") === null), true, "no markup inside the composer");

  // typing, Enter inside a line, caret-aware label insert
  await page.fill("#input", "");
  await box.pressSequentially("one");
  await page.keyboard.press("Shift+Enter");
  await box.pressSequentially("two");
  assert.equal(await value(), "one\ntwo", "Shift+Enter makes a newline");
  assert.deepEqual(errors, []);
  console.log("PASS composer paste: real Ctrl+V image -> attachment, rich HTML flattened, editable text semantics");
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
