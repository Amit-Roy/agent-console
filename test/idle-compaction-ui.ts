// Real browser + isolated backend. No provider prompts or personal data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-idle-policy-ui-"));
const base = "http://127.0.0.1:7073";
const now = Date.now();
const fixture = (id: string, provider: string) => ({
  id,
  provider,
  model: provider === "claude" ? "sonnet" : "default",
  title: id,
  cwd: process.cwd(),
  mode: "bypassPermissions",
  effort: "medium",
  status: "idle",
  cost: 0,
  createdAt: now,
  updatedAt: now,
});
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([fixture("known-cache", "claude"), fixture("unknown-cache", "codex")]),
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const env = {
  ...process.env,
  PORT: "7073",
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_RUN: path.join(data, "run"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_HEADROOM: "0",
  AGENT_CONSOLE_IDLE_COMPACT_CLAUDE_TTL_MS: "3600000",
};
delete env.AGENT_CONSOLE_PID_FILE;
delete env.AGENT_CONSOLE_IDLE_COMPACT_CODEX_TTL_MS;
const server = spawn(process.execPath, ["server/index.ts"], { env, stdio: "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode != null) throw Error("Scratch server exited before readiness");
    try {
      if ((await fetch(base)).status < 500) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "scratch backend ready");
  browser = await chromium.launch();
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: "dark",
    });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await context.addInitScript(() => localStorage.setItem("ac_thread", "known-cache"));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(base);
    await page.locator("#more:not([disabled])").waitFor();
    await page.locator("#more").click();
    await page.getByText("Compaction", { exact: true }).click();
    await page.getByText("Disable automatic compaction", { exact: true }).click();
    await page
      .getByText("Automatic compaction disabled for this thread.", { exact: true })
      .waitFor();
    await page.reload();
    await page.locator("#more:not([disabled])").waitFor();
    await page.locator("#more").click();
    await page.getByText("Compaction", { exact: true }).click();
    await page.getByText("Enable automatic compaction", { exact: true }).click();
    await page
      .getByText("Automatic compaction enabled for this thread.", { exact: true })
      .waitFor();
    await page.locator("#more").click();
    await page.getByRole("menuitem", { name: /^Run details/ }).click();
    await page
      .locator("#run-metrics dd")
      .filter({ hasText: "On for substantial idle contexts" })
      .waitFor();
    await page.screenshot({ path: `/tmp/idle-compaction-${width}.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.close();
    await context.addInitScript(() => localStorage.setItem("ac_thread", "unknown-cache"));
    const unknown = await context.newPage();
    await unknown.goto(base);
    await unknown.locator("#more:not([disabled])").waitFor();
    await unknown.locator("#more").click();
    await unknown.getByText("Compaction", { exact: true }).click();
    assert.equal(
      await unknown
        .getByRole("menuitem")
        .filter({ hasText: "Automatic compaction unavailable" })
        .getAttribute("aria-disabled"),
      "true",
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.equal(
    fs.existsSync(path.join(data, "turns.jsonl")) &&
      fs.readFileSync(path.join(data, "turns.jsonl"), "utf8").trim().length > 0,
    false,
    "settings never start paid work",
  );
  console.log(
    "PASS automatic compaction toggle persistence, unknown TTL, run details, desktop/phone and no provider calls",
  );
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  fs.rmSync(data, { recursive: true, force: true });
}
