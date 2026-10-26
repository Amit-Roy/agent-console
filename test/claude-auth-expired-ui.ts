// Isolated browser regression: an expired Claude login in an existing thread shows as an error with a Sign in button
// that opens the new-thread dialog on that thread's account.
// Run: rtk proxy node test/claude-auth-expired-ui.ts   (OUT=dir saves screenshots)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright";

const port = process.env.AUTH_EXPIRED_TEST_PORT || "7075";
assert.match(port, /^707[1-5]$/, "use an isolated scratch port, 7071–7075");
const base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auth-data-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auth-home-"));
// Sunny looks signed in at page load, as it did before the CLI rejected its refresh token.
fs.mkdirSync(path.join(home, ".claude"));
fs.writeFileSync(
  path.join(home, ".claude", ".credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }),
);
fs.writeFileSync(
  path.join(home, ".claude.json"),
  JSON.stringify({ oauthAccount: { emailAddress: "sunny.amit.roy@gmail.com" } }),
);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auth-cwd-"));
const id = "55555555-5555-4555-8555-555555555555";
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    {
      id,
      provider: "claude",
      claudeAccount: "sunny",
      model: "claude-sonnet-5-5",
      effort: "medium",
      mode: "default",
      title: "Expired login",
      cwd,
      status: "idle",
      cost: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
);
fs.writeFileSync(path.join(data, "commands.json"), "{}");
const failure = "Failed to authenticate: OAuth session expired and could not be refreshed";
fs.writeFileSync(
  path.join(data, "logs", `${id}.jsonl`),
  [
    { type: "user_input", text: "Close the issue.", ts: Date.now() },
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: failure }],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result: failure,
      duration_ms: 569,
      total_cost_usd: 0,
      ts: Date.now(),
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: "",
    PORT: port,
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_PID_FILE: "",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_ENV_FILES: "/dev/null",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverError = "";
server.stderr.on("data", (b) => {
  serverError += String(b);
});
let browser: Browser | undefined;
const pass = (s: string) => console.log(`PASS ${s}`);

try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error(`scratch server exited (${server.exitCode}): ${serverError}`);
    try {
      if ((await fetch(`${base}/login`)).ok) break;
    } catch {}
    if (i === 99) throw new Error("scratch server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    serviceWorkers: "block",
    isMobile: true,
    hasTouch: true,
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
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  const chat = page.locator("#chat");
  const button = chat.locator("button", { hasText: "Sign in to Sunny" });
  await button.waitFor({ timeout: 10000 }).catch(async (e) => {
    console.log(
      errors,
      page.url(),
      await page
        .locator("#chat")
        .innerHTML()
        .catch(() => "no chat"),
      await page
        .locator("#threads")
        .innerText()
        .catch(() => "no threads"),
      serverError.slice(-800),
    );
    throw e;
  });
  const foot = await chat.locator(".foot").last().textContent();
  assert.match(foot!, /error/, "failed turn is labelled error");
  assert.doesNotMatch(foot!, /success/, "failed turn is not labelled success");
  pass('expired login result reads "error" with a Sign in button');
  if (process.env.OUT) {
    fs.mkdirSync(process.env.OUT, { recursive: true });
    await page.screenshot({ path: path.join(process.env.OUT, "thread.png") });
  }

  await button.click();
  await page.locator("#dlg[open]").waitFor();
  assert.ok(await page.locator("#account-field").isVisible(), "account picker shows");
  assert.ok(
    await page.locator("#d-signin").isVisible(),
    "Sign in button shows even though Sunny looked ready at page load",
  );
  assert.match((await page.locator("#d-account-note").textContent())!, /Sign in to this account/);
  pass("button opens the dialog on Sunny with its Sign in action");
  if (process.env.OUT) await page.screenshot({ path: path.join(process.env.OUT, "dialog.png") });
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.kill();
  for (const dir of [data, home, cwd]) fs.rmSync(dir, { recursive: true, force: true });
}
