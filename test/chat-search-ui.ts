// In-chat search uses isolated mock history, including messages outside the first page.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-chat-search-ui-"));
const port = process.env.CHAT_SEARCH_UI_PORT || "7074";
assert.match(port, /^707[1-5]$/, "use an isolated scratch port, 7071–7075");
const base = `http://127.0.0.1:${port}`;
const shots = process.env.OUT || "/tmp/ac-chat-search-shots";
const ids = ["chat-search-history", "chat-search-other"];
fs.mkdirSync(path.join(data, "uploads"));
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify(
    ids.map((id, i) => ({
      id,
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: i ? "Other conversation" : "Search conversation",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 2 - i,
      updatedAt: 2 - i,
    })),
  ),
);
const history: object[] = [];
for (let i = 0; i < 20; i++) {
  history.push({
    type: "user_input",
    text:
      i === 0
        ? "Oldest orchard message, outside the initial history page."
        : i === 18
          ? "Literal [x].* characters stay literal."
          : `Question ${i + 1}: describe this task.`,
  });
  history.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            i === 8
              ? "Middle ORCHARD reply uses capitals."
              : i === 17
                ? "A phrase across **inline formatting** stays searchable. Live beacon is ready."
                : i === 19
                  ? "Latest Orchard reply closes the conversation."
                  : `Reply ${i + 1}: finished the requested task.`,
        },
      ],
    },
  });
}
history.push({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "search-fixture-tool",
        name: "Bash",
        input: { command: "printf hidden-search-command", description: "Inspect fixture" },
      },
    ],
  },
});
history.push({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "search-fixture-tool", content: "Fixture inspected." },
    ],
  },
});
fs.writeFileSync(
  path.join(data, "logs", `${ids[0]}.jsonl`),
  history.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
fs.writeFileSync(
  path.join(data, "logs", `${ids[1]}.jsonl`),
  JSON.stringify({ type: "user_input", text: "A separate conversation with no fruit." }) + "\n",
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
let browser: Browser | undefined;
let serverError = "";
server.stderr.on("data", (chunk) => {
  serverError += String(chunk);
});
const errors: string[] = [];
const count = async (page: Page) => {
  const value = (await page.locator("#chat-search-count").textContent()) || "";
  const match = value.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
  assert.ok(match, `search status includes current and total matches: ${value}`);
  return [Number(match[1]), Number(match[2])];
};
const search = async (page: Page, query: string, total: number) => {
  await page.fill("#chat-search-input", query);
  await page.waitForFunction((expected) => {
    const text = document.getElementById("chat-search-count")?.textContent || "";
    const match = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
    return match
      ? Number(match[2]) === expected && !/Searching/i.test(text)
      : expected === 0 && /no (?:results|matches)|^0(?: matches)?$/i.test(text.trim());
  }, total);
};
const highlight = async (page: Page) =>
  page.evaluate(() => {
    const highlights = (CSS as any).highlights;
    const all = highlights?.get("chat-search");
    const active = highlights?.get("chat-search-active");
    if (all && active) return { all: all.size as number, active: active.size as number };
    return {
      all: document.querySelectorAll("#chat mark").length,
      active: document.querySelectorAll(
        '#chat mark.chat-search-active, #chat mark.active, #chat mark[data-active="true"]',
      ).length,
    };
  });
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
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    serviceWorkers: "block",
  });
  await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(
    () =>
      document.getElementById("ttl")?.textContent === "Search conversation" &&
      !(document.getElementById("input") as HTMLTextAreaElement)?.disabled,
  );
  assert.equal(
    await page
      .locator("#chat")
      .getByText("Oldest orchard message, outside the initial history page.", { exact: true })
      .count(),
    0,
    "older history starts unloaded",
  );
  await page.click("#chat-search-toggle");
  await page.locator("#chat-search-input").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#chat-search-input").evaluate((input) => input === document.activeElement),
    true,
    "opening search focuses its input",
  );
  await search(page, "orchard", 3);
  assert.equal(
    await page
      .locator("#chat")
      .getByText("Oldest orchard message, outside the initial history page.", { exact: true })
      .count(),
    1,
    "search loads matches from older history",
  );
  assert.equal((await count(page))[1], 3, "search ignores case");
  assert.deepEqual(
    await highlight(page),
    { all: 3, active: 1 },
    "all matches and active match are highlighted",
  );
  const first = (await count(page))[0];
  await page.click("#chat-search-next");
  assert.equal((await count(page))[0], (first % 3) + 1, "next advances and wraps");
  await page.waitForFunction(() => {
    const range = [...((CSS as any).highlights?.get("chat-search-active") || [])][0] as
      | Range
      | undefined;
    if (!range) return false;
    const rect = range.getBoundingClientRect(),
      box = document.getElementById("chat")!.getBoundingClientRect();
    return rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom;
  });
  await page.click("#chat-search-prev");
  assert.equal((await count(page))[0], first, "previous returns to the prior match");
  await page.click("#chat-search-prev");
  assert.equal((await count(page))[0], ((first + 1) % 3) + 1, "previous wraps");
  await page.click("#chat-search-next");
  assert.equal((await count(page))[0], first, "next wraps back");
  await page.locator("#chat-search-input").focus();
  await page.keyboard.press("Enter");
  assert.equal((await count(page))[0], (first % 3) + 1, "Enter selects the next match");
  await page.keyboard.press("Shift+Enter");
  assert.equal((await count(page))[0], first, "Shift+Enter selects the previous match");
  await search(page, "[x].*", 1);
  assert.deepEqual(
    await highlight(page),
    { all: 1, active: 1 },
    "regex characters are literal text",
  );
  await search(page, "across inline formatting stays", 1);
  assert.deepEqual(
    await highlight(page),
    { all: 1, active: 1 },
    "a phrase spans inline Markdown elements",
  );
  const tool = page.locator("#chat details.card", {
    has: page.locator(".sum", { hasText: "Inspect fixture" }),
  });
  assert.equal(await tool.count(), 1, "the hidden-command tool fixture renders");
  assert.equal(await tool.getAttribute("open"), null, "tool card starts closed");
  await search(page, "hidden-search-command", 1);
  assert.equal(
    await tool.evaluate((card: HTMLDetailsElement) => card.open),
    true,
    "matching a hidden tool command opens its card",
  );
  await search(page, "live beacon", 1);
  await page.evaluate(() => {
    const message = document.createElement("div");
    message.className = "msg asst";
    const paragraph = document.createElement("p");
    paragraph.textContent = "A new live beacon arrives while search stays open.";
    message.append(paragraph);
    document.getElementById("chat")!.append(message);
  });
  await page.waitForFunction(() =>
    /\d+ of 2/.test(document.getElementById("chat-search-count")?.textContent || ""),
  );
  assert.deepEqual(
    await highlight(page),
    { all: 2, active: 1 },
    "new message updates open search highlights",
  );
  await search(page, "stream marker", 0);
  await page.evaluate(() => {
    const message = document.createElement("div");
    message.className = "msg asst";
    const paragraph = document.createElement("p");
    message.append(paragraph);
    document.getElementById("chat")!.append(message);
    let chunks = 0;
    (window as any).__searchStreaming = true;
    const stream = setInterval(() => {
      paragraph.textContent = `Stream marker chunk ${++chunks}`;
      if (chunks === 20) {
        clearInterval(stream);
        (window as any).__searchStreaming = false;
      }
    }, 50);
  });
  await page.waitForFunction(
    () =>
      /1 of 1/.test(document.getElementById("chat-search-count")?.textContent || "") &&
      (window as any).__searchStreaming,
    null,
    { timeout: 850 },
  );
  assert.deepEqual(
    await highlight(page),
    { all: 1, active: 1 },
    "search updates before ongoing streaming ends",
  );
  await page.waitForFunction(() => !(window as any).__searchStreaming);
  await search(page, "there is no such phrase", 0);
  assert.equal(
    await page.locator("#chat-search-next").isDisabled(),
    true,
    "no matches disables next",
  );
  assert.equal(
    await page.locator("#chat-search-prev").isDisabled(),
    true,
    "no matches disables previous",
  );
  assert.equal((await highlight(page)).all, 0, "no results clears highlights");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#chat-search-input").isVisible(), false, "Escape closes search");
  await page.click("#more");
  await page.getByRole("menuitem", { name: "Search in chat", exact: true }).click();
  assert.equal(
    await page.locator("#chat-search-input").isVisible(),
    true,
    "thread menu opens search",
  );
  await page.click("#chat-search-close");
  await page.keyboard.press("Control+f");
  assert.equal(await page.locator("#chat-search-input").isVisible(), true, "Ctrl+f opens search");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+f");
  assert.equal(await page.locator("#chat-search-input").isVisible(), true, "Cmd+f opens search");
  await search(page, "orchard", 3);
  await page.locator("#threads li .t", { hasText: "Other conversation" }).click();
  await page.waitForFunction(
    () => document.getElementById("ttl")?.textContent === "Other conversation",
  );
  assert.equal(
    await page.locator("#chat-search-input").isVisible(),
    false,
    "switching threads closes search",
  );
  assert.equal((await highlight(page)).all, 0, "switching threads clears highlights");
  await page.click("#chat-search-toggle");
  assert.equal(
    await page.inputValue("#chat-search-input"),
    "",
    "switching threads clears the query",
  );
  await context.close();

  for (const mobile of [false, true])
    for (const colorScheme of ["light", "dark"] as const) {
      const visual = await browser.newContext({
        viewport: mobile ? { width: 412, height: 915 } : { width: 1280, height: 900 },
        colorScheme,
        serviceWorkers: "block",
        isMobile: mobile,
        hasTouch: mobile,
      });
      await visual.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
      const shot = await visual.newPage();
      shot.on("pageerror", (error) => errors.push(error.message));
      await shot.goto(base);
      await shot.waitForFunction(
        () =>
          document.getElementById("ttl")?.textContent === "Search conversation" &&
          !(document.getElementById("input") as HTMLTextAreaElement)?.disabled,
      );
      await shot.click("#chat-search-toggle");
      await search(shot, "orchard", 3);
      assert.equal(
        await shot.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${mobile ? "mobile" : "desktop"} ${colorScheme} has no horizontal overflow`,
      );
      for (const id of [
        "chat-search-input",
        "chat-search-count",
        "chat-search-next",
        "chat-search-prev",
        "chat-search-close",
      ]) {
        const box = await shot.locator(`#${id}`).boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= (mobile ? 412 : 1280),
          `${id} fits ${mobile ? "mobile" : "desktop"} viewport`,
        );
      }
      await shot.screenshot({
        path: path.join(shots, `${mobile ? "mobile" : "desktop"}-${colorScheme}.png`),
      });
      await visual.close();
    }
  assert.deepEqual(errors, [], "search causes no browser errors");
  console.log(
    "PASS chat search: old history, case, literal text, highlight, navigation, empty results, shortcuts, menu, reset, responsive themes",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  fs.rmSync(data, { recursive: true, force: true });
}
