// Browser checks use fresh data, fake accounts, and CLI guards. No live sessions or prompts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-accounts-ui-"));
const home = path.join(scratch, "home"),
  data = path.join(scratch, "data"),
  bin = path.join(scratch, "bin");
for (const dir of [home, data, bin, path.join(home, "repos"), path.join(home, ".claude")])
  fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(home, ".claude", ".credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: "offline-fixture" } }),
);
for (const name of ["claude", "codex", "pi"])
  fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const now = Date.now();
const thread = (id: string, title: string, claudeAccount?: string) => ({
  id,
  title,
  provider: "claude",
  model: "sonnet",
  mode: "acceptEdits",
  cwd: path.join(home, "repos"),
  status: "idle",
  cost: 0,
  createdAt: now,
  updatedAt: now,
  ...(claudeAccount ? { claudeAccount } : {}),
});
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    thread("legacy-sunny", "Legacy Sunny"),
    thread("fixture-nefro", "Nefro account", "nefro"),
  ]),
);
fs.writeFileSync(path.join(data, "queues.json"), "{}");
fs.writeFileSync(path.join(data, "tasks.json"), "[]");
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const port = process.env.ACCOUNT_TEST_PORT || "17842",
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
async function fixtureUsage(page: Page) {
  let client: any;
  await page.routeWebSocket(/\/ws$/, (socket) => {
    client = socket;
    const upstream = socket.connectToServer();
    socket.onMessage((message) => upstream.send(message));
    upstream.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "hello")
        message.usage = {
          claude: {
            updatedAt: Date.now(),
            windows: [{ label: "5-hour", used: 21, limit: 100, unit: "%" }],
          },
          "claude:nefro": {
            updatedAt: Date.now(),
            windows: [{ label: "5-hour", used: 63, limit: 100, unit: "%" }],
          },
          codex: {
            updatedAt: Date.now(),
            windows: [{ label: "5-hour", used: 15, limit: 100, unit: "%" }],
          },
          pi: { updatedAt: Date.now(), windows: [{ label: "Free/day", used: 40, limit: 50 }] },
        };
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
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const pushUsage = await fixtureUsage(page);
    await page.goto(base);
    await page.waitForFunction(
      () => document.getElementById("ttl")?.textContent === "Legacy Sunny",
    );
    assert.match(await page.locator("#thread-account").innerText(), /Sunny/);
    if (name === "phone") await page.locator("#menu").click();
    const selector = page.locator("#usage-provider");
    await selector.waitFor();
    assert.equal(await selector.innerText(), "Claude · Sunny");
    assert.equal(await selector.getAttribute("aria-label"), "Usage account: Claude · Sunny");
    assert.equal(await selector.getAttribute("aria-haspopup"), "listbox");
    assert.equal(
      await selector.evaluate((button) => button.scrollWidth <= button.clientWidth),
      true,
      "Usage selector fits without overlapping labels.",
    );
    assert.equal(await page.locator("#usage .pct").first().innerText(), "21%");
    await page.screenshot({ path: path.join(out, `${name}-usage-closed.png`), fullPage: true });
    await selector.click();
    const usageMenu = page.getByRole("listbox", { name: "Usage account", exact: true });
    await usageMenu.waitFor();
    assert.deepEqual(await usageMenu.locator(".m-label").allTextContents(), [
      "Claude · Sunny",
      "Claude · Nefro",
      "OpenRouter",
      "Codex",
    ]);
    assert.match(await usageMenu.innerText(), /sunny\.amit\.roy@gmail\.com/);
    assert.match(await usageMenu.innerText(), /nefro\.amit\.roy@gmail\.com/);
    await page.screenshot({ path: path.join(out, `${name}-usage-open.png`), fullPage: true });
    if (name === "phone") {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: path.join(out, "phone-usage-open-dark.png"), fullPage: true });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await usageMenu.getByRole("option", { name: /Claude · Nefro/ }).click();
    assert.equal(await selector.innerText(), "Claude · Nefro");
    assert.equal(
      await page.locator("#usage .pct").first().innerText(),
      "63%",
      "Each Claude account has separate usage.",
    );
    const triggerNode = await selector.elementHandle();
    await selector.click();
    const menuNode = await usageMenu.elementHandle();
    pushUsage({
      t: "usage",
      provider: "claude:nefro",
      usage: {
        updatedAt: Date.now(),
        windows: [{ label: "5-hour", used: 64, limit: 100, unit: "%" }],
      },
    });
    await page.waitForFunction(() => document.querySelector("#usage .pct")?.textContent === "64%");
    assert.equal(
      await triggerNode!.evaluate((node) => node.isConnected),
      true,
      "Telemetry keeps the same selector node.",
    );
    assert.equal(
      await menuNode!.evaluate((node) => node.isConnected),
      true,
      "Telemetry keeps the open menu.",
    );
    assert.equal(await selector.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await usageMenu.waitFor({ state: "detached" });
    assert.equal(
      await selector.evaluate((node) => node === document.activeElement),
      true,
      "Escape returns focus to the selector.",
    );
    await selector.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    assert.equal(await selector.innerText(), "Codex", "Keyboard selects an account.");
    assert.equal(await page.locator("#usage .pct").first().innerText(), "15%");
    await selector.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    assert.equal(await selector.innerText(), "Claude · Sunny");
    assert.equal(await page.locator("#usage .pct").first().innerText(), "21%");
    await page.locator("#new").evaluate((el: HTMLElement) => el.click());
    await page.locator("#dlg").waitFor({ state: "visible" });
    await page.locator("#d-prov").click();
    await page.getByRole("option", { name: /Claude Code/ }).click();
    assert.equal(await page.locator("#account-field").isVisible(), true);
    assert.match(await page.locator("#d-account").innerText(), /Sunny/);
    await page.locator("#d-account").click();
    await page.getByRole("option", { name: /Nefro/ }).click();
    assert.equal(await page.locator("#d-ok").isDisabled(), true);
    assert.equal(
      await page.locator("#d-account-note").isVisible(),
      true,
      "Sign-in guidance stays visible on phones.",
    );
    assert.match(await page.locator("#d-account-note").innerText(), /Sign in/);
    assert.equal(
      await page.locator("#d-signin-go").isVisible(),
      true,
      "An unsigned account offers in-app sign-in.",
    );
    await page.screenshot({ path: path.join(out, `${name}-account-signin.png`), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "No horizontal page overflow.",
    );
    await page.locator("#d-prov").click();
    await page.getByRole("option", { name: /Mock/ }).click();
    assert.equal(
      await page.locator("#account-field").isVisible(),
      false,
      "Other providers have no Claude account picker.",
    );
    assert.equal(
      await page.locator("#d-ok").isDisabled(),
      false,
      "An unready Claude account cannot block another provider.",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#new").evaluate((el: HTMLElement) => el.click());
    await page.locator("#d-prov").click();
    await page.getByRole("option", { name: /Claude Code/ }).click();
    assert.match(
      await page.locator("#d-account").innerText(),
      /Sunny/,
      "Each new thread defaults to Sunny.",
    );
    assert.deepEqual(pageErrors, []);
    await context.close();
  }
  const nefro = path.join(home, ".claude-nefro");
  fs.mkdirSync(nefro);
  fs.writeFileSync(
    path.join(nefro, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "offline-fixture" } }),
  );
  fs.writeFileSync(
    path.join(nefro, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "nefro.amit.roy@gmail.com" } }),
  );
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "Legacy Sunny");
  await page.locator("#new").evaluate((el: HTMLElement) => el.click());
  await page.locator("#d-prov").click();
  await page.getByRole("option", { name: /Claude Code/ }).click();
  await page.locator("#d-account").click();
  await page.getByRole("option", { name: /Nefro/ }).click();
  assert.equal(await page.locator("#d-ok").isEnabled(), true);
  await page.locator("#d-ok").click();
  await page.waitForFunction(
    () => !!document.getElementById("thread-account")?.textContent?.includes("Nefro"),
  );
  const created = JSON.parse(fs.readFileSync(path.join(data, "threads.json"), "utf8")).find(
    (t: any) => !["legacy-sunny", "fixture-nefro"].includes(t.id),
  );
  assert.equal(created.claudeAccount, "nefro", "Create persists the selected account.");
  assert.equal(
    await page.locator("#usage-provider").innerText(),
    "Claude · Nefro",
    "Opening a Nefro thread selects its usage account.",
  );
  assert.equal(created.sessionId, undefined, "Creating a thread does not start a prompt.");
  await page.screenshot({ path: path.join(out, "desktop-nefro-thread.png"), fullPage: true });
  await context.close();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await phone.addCookies([
    {
      name: "__Host-ac_session",
      value: makeToken(),
      domain: new URL(base).hostname,
      path: "/",
      secure: true,
    },
  ]);
  const phonePage = await phone.newPage();
  await phonePage.goto(base);
  await phonePage.waitForFunction(
    () => !!document.getElementById("thread-account")?.textContent?.includes("Nefro"),
  );
  await phonePage.screenshot({ path: path.join(out, "phone-nefro-thread.png"), fullPage: true });
  await phone.close();
  console.log(
    `PASS Claude account UI: phone/desktop dropdown, separate meters, keyboard, Escape, telemetry stability, legacy Sunny, Nefro creation, account reset, provider isolation. Screenshots: ${out}`,
  );
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
