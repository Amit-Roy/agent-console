// Native typing must keep the focused line visible when the composer reaches its height limit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-composer-scroll-ui-"));
const port = Number(process.env.COMPOSER_SCROLL_UI_PORT || 17775),
  base = `http://127.0.0.1:${port}`;
const id = "composer-scroll";
fs.mkdirSync(path.join(data, "uploads"));
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id,
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: "Composer scroll",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  ]),
);
fs.writeFileSync(
  path.join(data, "logs", `${id}.jsonl`),
  JSON.stringify({ type: "user_input", text: "fixture" }) + "\n",
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: ["ignore", "pipe", "ignore"],
});
let browser;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server did not start")), 15000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("agent-console listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Scratch server exited: ${code}`));
    });
  });
  browser = await chromium.launch();
  for (const mobile of [true, false]) {
    const label = mobile ? "mobile" : "desktop";
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await context.addInitScript((id) => localStorage.setItem("ac_thread", id), id);
    if (process.env.COMPOSER_SCROLL_APP_JS) {
      const source = fs.readFileSync(process.env.COMPOSER_SCROLL_APP_JS, "utf8");
      await context.route("**/app.js", (route) =>
        route.fulfill({ contentType: "application/javascript", body: source }),
      );
    }
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(
      () =>
        document.getElementById("ttl")?.textContent === "Composer scroll" &&
        !(document.getElementById("input") as any)?.disabled,
    );
    const box = page.locator("#input");
    const caret = () =>
      box.evaluate((box: HTMLElement) => {
        const selection = getSelection()!,
          range = document.createRange();
        range.setStart(selection.focusNode!, selection.focusOffset);
        range.collapse(true);
        let rect = range.getBoundingClientRect();
        if (
          !rect.height &&
          selection.focusNode?.nodeType === Node.TEXT_NODE &&
          selection.focusNode.textContent?.[selection.focusOffset] === "\n"
        ) {
          range.setEnd(selection.focusNode, selection.focusOffset + 1);
          rect = range.getBoundingClientRect();
        }
        if (!rect.height) {
          const next =
            selection.focusNode?.nodeType === Node.ELEMENT_NODE
              ? selection.focusNode.childNodes[selection.focusOffset]
              : selection.focusNode?.nextSibling;
          if (next) {
            range.selectNode(next);
            rect = range.getBoundingClientRect();
          }
        }
        const bounds = box.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          boxTop: bounds.top,
          boxBottom: bounds.bottom,
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          clientHeight: box.clientHeight,
        };
      });
    const visible = async (step: string) => {
      const position = await caret();
      assert.ok(
        position.height > 0 &&
          position.top >= position.boxTop - 1 &&
          position.bottom <= position.boxBottom + 1,
        `${label}: ${step}: ${JSON.stringify(position)}`,
      );
    };
    await box.focus();
    let expected = "";
    for (let line = 0; line < 18; line++) {
      if (line) {
        await page.keyboard.press("Shift+Enter");
        expected += "\n";
      }
      for (const words of [
        `Line ${line + 1} keeps the `,
        "active caret visible while ",
        "the composer wraps text.",
      ]) {
        await page.keyboard.insertText(words);
        expected += words;
        await visible(`typing line ${line + 1}`);
      }
    }
    assert.equal(await box.evaluate((e: any) => e.value), expected);
    assert.ok(
      (await caret()).scrollHeight > (await caret()).clientHeight,
      "Fixture exceeds the composer height limit",
    );
    await page.keyboard.press("Shift+Enter");
    expected += "\n";
    await visible("final blank line");
    await page.keyboard.insertText("Last line.");
    expected += "Last line.";
    await visible("typing after a blank final line");
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, "height", { configurable: true, value: 360 });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(
      () => document.getElementById("app")!.getBoundingClientRect().height <= 360,
    );
    await visible("keyboard viewport resize");
    await box.evaluate((e: any) => {
      e.setSelectionRange(140, 140);
      e.scrollTop = 0;
    });
    await page.keyboard.insertText("[middle edit]");
    expected = expected.slice(0, 140) + "[middle edit]" + expected.slice(140);
    await visible("middle edit");
    const middle = await caret();
    assert.ok(
      middle.scrollTop + middle.clientHeight < middle.scrollHeight - 100,
      "Editing the middle must not jump to the end",
    );
    assert.equal(
      await box.evaluate((e: any) => e.value),
      expected,
      "Typing preserves the exact draft",
    );
    assert.equal(
      await page.evaluate((id) => localStorage.getItem(`ac_draft:${id}`), id),
      expected,
      "Persisted draft matches typed text",
    );
    if (mobile) {
      await box.fill("");
      for (let line = 0; line < 10; line++) {
        await page.keyboard.insertText(
          `Android line ${line + 1} stays visible when the keyboard adds a paragraph.`,
        );
        await visible(`Android typing line ${line + 1}`);
        await page.keyboard.press("Enter");
        await visible(`Android blank line ${line + 1}`);
      }
      assert.ok(
        await box.evaluate((e) => !!e.querySelector("div,br")),
        "Touch Enter exercises paragraph and placeholder line geometry",
      );
    }
    await page.screenshot({ path: `/tmp/ac-composer-scroll-${label}.png` });
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${label}: wrapped typing, newlines, keyboard resize, middle editing, exact draft${mobile ? ", touch Enter" : ""}`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  fs.rmSync(data, { recursive: true, force: true });
}
