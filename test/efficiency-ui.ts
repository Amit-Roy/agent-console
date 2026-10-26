// Offline browser verification: settings/forks do not start a real provider turn.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

const base = process.env.BASE || "http://127.0.0.1:7074";
const cookie = makeToken();
const messages: any[] = [];
const ws = new WebSocket(base.replace("http", "ws") + "/ws", {
  headers: { origin: base, cookie: `__Host-ac_session=${cookie}` },
});
ws.on("message", (data) => messages.push(JSON.parse(String(data))));
const wait = async (predicate: (m: any) => boolean) => {
  for (let i = 0; i < 200; i++) {
    const found = messages.findLast(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Expected efficiency UI update was not received");
};
await wait((m) => m.t === "hello");
ws.send(
  JSON.stringify({
    t: "create",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    cwd: process.cwd(),
    title: "efficiency controls fixture",
  }),
);
const original = (await wait((m) => m.t === "created")).thread;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
  });
  await context.addCookies([{ name: "__Host-ac_session", value: cookie, domain: new URL(base).hostname, path: "/", secure: true }]);
  await context.addInitScript((id) => localStorage.setItem("ac_thread", id), original.id);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  await page.locator("#model:not([disabled])").waitFor();
  await page.locator("#model").click();
  await page.getByText("Advisor · Off", { exact: true }).click();
  await wait((m) => m.t === "thread" && m.thread.id === original.id && m.thread.advisor === "off");
  await page.locator("#more").click();
  await page.getByText("Economy settings", { exact: true }).click();
  const economical = (
    await wait(
      (m) => m.t === "thread" && m.thread.id === original.id && m.thread.effort === "medium",
    )
  ).thread;
  assert.equal(economical.model, "sonnet");
  assert.equal(economical.advisor, "off");
  await page.locator("#more").click();
  await page.getByText("Fork…", { exact: true }).click();
  await page.locator("#dlg").waitFor({ state: "visible" });
  assert.equal(await page.locator("#dlg-title").innerText(), "Fork thread");
  assert.equal(
    await page.locator("#cwd-field").isVisible(),
    false,
    "A fork keeps the source folder.",
  );
  assert.match(
    await page.locator("#d-model").innerText(),
    /Sonnet/i,
    "The fork starts from the source model.",
  );
  assert.match(
    await page.locator("#d-effort").innerText(),
    /Medium/,
    "The fork starts from the source effort.",
  );
  await page.locator("#d-context").click();
  await page.getByRole("option", { name: /Recent context only/ }).click();
  await page.locator("#d-ok").click();
  const fork = (
    await wait(
      (m) =>
        m.t === "thread" &&
        m.thread.id !== original.id &&
        m.thread.title === original.title + " (fork)",
    )
  ).thread;
  assert.equal(fork.provider, "claude");
  assert.equal(fork.sessionId, undefined);
  assert.equal(fork.model, "sonnet");
  assert.equal(fork.effort, "medium");
  assert.equal(fork.forkFrom, undefined, "Recent context never resumes the native session.");
  assert.ok(!messages.some((m) => m.t === "event" && m.event.type === "user_input"));
  const day = new Date().toISOString().slice(0, 10);
  await page.route("**/api/dashboard?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        turns: [
          {
            ts: Date.now(),
            thread: "measured",
            provider: "codex",
            accounting: 2,
            in: 100,
            out: 10,
            cache: 80,
          },
          { ts: Date.now(), thread: "legacy", provider: "claude", in: 999, out: 99, cost: 99 },
        ],
        rtk: { daily: [{ date: day, saved_tokens: 50 }] },
        headroom: { daily: [{ timestamp: day, tokens_saved: 20 }] },
      }),
    }),
  );
  await page.goto(base + "/dashboard#1");
  await page.locator(".kpis").waitFor();
  const kpis = page.locator(".kpi");
  assert.match(await kpis.nth(1).innerText(), /1.2k/);
  assert.match(await kpis.nth(2).innerText(), /0\/2 turns priced/);
  assert.doesNotMatch(await page.locator("#dm").innerText(), /Savings rate/);
  await page.getByText("Show data as a table", { exact: true }).click();
  assert.match(await page.locator("details.table table").innerText(), /Day \(UTC\)/);
  assert.match(await page.locator("details.table table").innerText(), /Unknown/);
  assert.deepEqual(errors, []);
  console.log(
    "PASS phone advisor Off, economy model preservation, no-call short fork, unknown costs, token categories and UTC dashboard",
  );
  ws.send(JSON.stringify({ t: "delete", thread: original.id }));
  ws.send(JSON.stringify({ t: "delete", thread: fork.id }));
  await context.close();
} finally {
  ws.close();
  await browser.close();
}
