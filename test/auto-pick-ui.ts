// Browser checks for the New thread Auto button. Fresh data, fake accounts and usage, CLI guards; no live sessions or prompts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auto-pick-ui-"));
const home = path.join(scratch, "home"),
  data = path.join(scratch, "data"),
  bin = path.join(scratch, "bin");
for (const dir of [
  home,
  data,
  bin,
  path.join(home, "repos"),
  path.join(home, ".claude"),
  path.join(home, ".claude-nefro"),
])
  fs.mkdirSync(dir, { recursive: true });
for (const [dir, email] of [
  [".claude", "sunny.amit.roy@gmail.com"],
  [".claude-nefro", "nefro.amit.roy@gmail.com"],
]) {
  fs.writeFileSync(
    path.join(home, dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "offline-fixture" } }),
  );
  fs.writeFileSync(
    path.join(home, dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
}
for (const name of ["claude", "codex", "pi"])
  fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
fs.writeFileSync(path.join(data, "threads.json"), "[]");
fs.writeFileSync(path.join(data, "queues.json"), "{}");
fs.writeFileSync(path.join(data, "tasks.json"), "[]");
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const port = process.env.AUTO_TEST_PORT || "17843",
  base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    PATH: bin + path.delimiter + process.env.PATH,
    PORT: port,
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(scratch, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_WARM_MAX: "0",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let errors = "";
server.stderr?.on("data", (chunk) => (errors += chunk.toString()));

const min = 60_000;
const sample = (used: number, resetsIn: number) => ({
  updatedAt: Date.now(),
  windows: [
    { label: "5-hour", used, limit: 100, unit: "%", resetsAt: Date.now() + resetsIn * min },
    { label: "7-day", used: 20, limit: 100, unit: "%" },
  ],
});
// Sunny: 40% left, 30 min. Nefro: 60% left, 2 hours. Codex: 90% left, 290 min. Sunny wastes the most per minute.
const usage = { claude: sample(60, 30), "claude:nefro": sample(40, 120), codex: sample(10, 290) };
async function fixture(page: Page) {
  let client: any;
  await page.routeWebSocket(/\/ws$/, (socket) => {
    client = socket;
    const upstream = socket.connectToServer();
    socket.onMessage((message) => upstream.send(message));
    upstream.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "hello") {
        message.usage = usage;
        // The fake codex binary cannot report models; present the one Auto needs.
        const mock = message.providers.find((p: any) => p.id === "mock");
        message.providers = message.providers
          .filter((p: any) => p.id !== "codex")
          .concat({
            ...mock,
            id: "codex",
            label: "Codex",
            ok: true,
            models: ["gpt-6.1-sol"],
            defaultModel: "gpt-6.1-sol",
            modelDetails: {
              "gpt-6.1-sol": { label: "Sol 6.1", efforts: ["low", "medium", "high"] },
            },
          });
      }
      socket.send(JSON.stringify(message));
    });
  });
  return (message: unknown) => client.send(JSON.stringify(message));
}

let browser: Browser;
const out = process.env.OUT || path.join(scratch, "screenshots");
fs.mkdirSync(out, { recursive: true });
try {
  const ready = spawnSync("waitfor", ["-t", "20", "url", base], { encoding: "utf8" });
  assert.equal(ready.status, 0, "Scratch server starts: " + errors + ready.stderr);
  browser = await chromium.launch();
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    const context = await browser.newContext({
      viewport,
      isMobile: name === "phone",
      hasTouch: name === "phone",
    });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const push = await fixture(page);
    await page.goto(base);
    await page.waitForFunction(() => !!document.getElementById("new"));
    await page.waitForTimeout(300);
    await page.locator("#new").evaluate((el: HTMLElement) => el.click());
    await page.locator("#dlg").waitFor({ state: "visible" });
    assert.equal(await page.locator("#d-auto").isVisible(), true);
    assert.equal(
      await page.locator("#d-auto-note").isVisible(),
      true,
      "Auto guidance stays visible on phones.",
    );

    await page.locator("#d-auto").click();
    assert.match(await page.locator("#d-prov").innerText(), /Claude/);
    assert.match(
      await page.locator("#d-account").innerText(),
      /Sunny/,
      "40% left in 30 min beats 60% left in 2 hours.",
    );
    assert.match(await page.locator("#d-model").innerText(), /Sonnet/);
    assert.match(await page.locator("#d-effort").innerText(), /Medium/i);
    assert.match(
      await page.locator("#d-auto-note").innerText(),
      /Claude · Sunny · Sonnet · medium\. 40% left, resets in 30m/,
    );

    await page.locator("#d-auto-info").click();
    assert.equal(await page.locator("#d-auto-info").getAttribute("aria-expanded"), "true");
    const rows = page.locator("#d-auto-panel .auto-line:not(.hdr)");
    assert.equal(await rows.count(), 3);
    assert.match(await rows.nth(0).innerText(), /Claude · Sunny[\s\S]*40% left[\s\S]*30m/);
    assert.match(await rows.nth(1).innerText(), /Claude · Nefro[\s\S]*60% left[\s\S]*2h 0m/);
    assert.match(await rows.nth(2).innerText(), /Codex[\s\S]*90% left[\s\S]*4h 50m/);
    assert.equal(
      await page
        .locator("#d-auto-panel .best")
        .innerText()
        .then((t) => t.startsWith("Claude · Sunny")),
      true,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "No horizontal page overflow.",
    );
    await page.screenshot({ path: path.join(out, `${name}-auto-claude.png`) });
    if (name === "phone") {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: path.join(out, "phone-auto-claude-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
    }

    // Codex window about to expire with most of it unused: Auto switches agent and model.
    push({ t: "usage", provider: "codex", usage: sample(30, 20) });
    await page.waitForTimeout(100);
    await page.locator("#d-auto").click();
    assert.match(await page.locator("#d-prov").innerText(), /Codex/);
    assert.match(await page.locator("#d-model").innerText(), /Sol 6\.1/);
    assert.match(await page.locator("#d-effort").innerText(), /Medium/i);
    assert.equal(await page.locator("#account-field").isVisible(), false);
    assert.match(
      await page.locator("#d-auto-panel .best").innerText(),
      /^Codex/,
      "Open panel follows the new pick.",
    );
    await page.screenshot({ path: path.join(out, `${name}-auto-codex.png`) });

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#new").evaluate((el: HTMLElement) => el.click());
    assert.equal(
      await page.locator("#d-auto-panel").isVisible(),
      false,
      "Reopening the dialog closes the panel.",
    );
    assert.deepEqual(pageErrors, []);
    await context.close();
  }
  console.log(`auto-pick-ui: ok (${out})`);
} finally {
  await browser?.close();
  server.kill();
  if (!process.env.OUT) fs.rmSync(scratch, { recursive: true, force: true });
}
