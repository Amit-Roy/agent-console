// Quick issue creator: ⋯ menu → pi drafts (stubbed `pi` binary) → review dialog → GitHub new-issue URL with the reviewed text.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const work = fs.mkdtempSync(path.join(os.homedir(), ".ac-issue-ui-"));
process.env.AGENT_CONSOLE_DATA = path.join(work, "data");
const { makeToken } = await import("../server/auth.ts");
// Ask the OS for a free port: CI runs this file in parallel with other UI suites that own fixed ports.
const port = String(await new Promise<number>(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); }));
const base = `http://127.0.0.1:${port}`;

const repo = path.join(work, "repo");
fs.mkdirSync(repo);
execFileSync("git", ["-C", repo, "init", "-q"]);
execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/Amit-Roy/agent-console.git"]);
const bin = path.join(work, "bin");
fs.mkdirSync(bin);
const answer = JSON.stringify({ title: "Preview pane crashes on large diffs", body: "## Problem\nCrash above 5,000 lines." });
const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${event}'\n`, { mode: 0o755 });

const server = spawn("node", ["server/index.ts"], {
  stdio: "ignore",
  env: { ...process.env, PORT: port, AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_WARM_MAX: "0", AGENT_CONSOLE_DATA: path.join(work, "data"), AGENT_CONSOLE_RUN: path.join(work, "run"), AGENT_CONSOLE_PID_FILE: "", PATH: `${bin}:${process.env.PATH}` },
});
const browser = await chromium.launch();
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate(async (cwd) => {
    const w = new WebSocket(location.origin.replace("http", "ws") + "/ws");
    await new Promise(r => (w.onopen = r));
    w.send(JSON.stringify({ t: "create", provider: "mock", cwd, mode: "default", title: "Issue demo" }));
    await new Promise(r => setTimeout(r, 800));
  }, repo);
  await page.reload();
  await page.waitForSelector("#threads li .t", { state: "attached" });
  await page.locator("#threads li .t").first().dispatchEvent("click");

  // Empty composer: no dialog.
  await page.click("#more");
  await page.getByRole("menuitem", { name: /Create GitHub issue/ }).click();
  assert.equal(await page.locator("#issue-review[open]").count(), 0, "empty composer does not open the dialog");

  await page.locator("#input").click();
  await page.keyboard.type("preview pane crashes on big diffs");
  await page.click("#more");
  const item = page.getByRole("menuitem", { name: /Create GitHub issue/ });
  assert.ok((await item.boundingBox())!.height >= 44, "menu entry is a 44px touch target");
  await item.click();
  await page.waitForSelector("#issue-review[open]");
  await page.waitForFunction(() => !(document.getElementById("issue-open") as HTMLButtonElement).disabled);
  assert.equal(await page.inputValue("#issue-title"), "Preview pane crashes on large diffs", "pi title is shown for review");
  assert.match(await page.inputValue("#issue-body"), /Crash above 5,000 lines/);
  assert.match(await page.textContent("#issue-note") || "", /Amit-Roy\/agent-console/);
  await page.fill("#issue-title", "Edited by owner");

  // Nothing opens before the owner confirms; the reviewed (edited) text is what GitHub receives.
  const opened: string[] = [];
  await ctx.route("https://github.com/**", route => { opened.push(route.request().url()); return route.fulfill({ body: "ok" }); });
  assert.equal(opened.length, 0);
  const [popup] = await Promise.all([ctx.waitForEvent("page"), page.click("#issue-open")]);
  await popup.waitForLoadState();
  const url = new URL(opened[0] || popup.url());
  assert.equal(url.origin + url.pathname, "https://github.com/Amit-Roy/agent-console/issues/new");
  assert.equal(url.searchParams.get("title"), "Edited by owner");
  assert.match(url.searchParams.get("body") || "", /Crash above 5,000 lines/);
  assert.equal(await page.locator("#issue-review[open]").count(), 0, "dialog closes after opening GitHub");
  console.log("issue-draft-ui passed");
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
