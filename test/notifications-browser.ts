import assert from "node:assert/strict";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

// Run against an isolated server with AGENT_CONSOLE_MOCK=1 and matching AGENT_CONSOLE_DATA.
const base = process.env.BASE || "http://127.0.0.1:7074";
const socket = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { origin: base, cookie: `ac_session=${makeToken()}` } });
const inbox: any[] = [];
const waiters = new Set<() => void>();
socket.on("message", message => { inbox.push(JSON.parse(String(message))); for (const wake of waiters) wake(); });
function waitFor(predicate: (message: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error("Timed out waiting for mock thread event")); }, 10000);
    function check() {
      const index = inbox.findIndex(predicate);
      if (index < 0) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(inbox.splice(index, 1)[0]);
    }
    waiters.add(check);
    check();
  });
}
const browser = await chromium.launch();
const ids: string[] = [];
try {
  const hello = await waitFor(message => message.t === "hello");
  assert.ok(hello.providers.some((provider: any) => provider.id === "mock"), "Use an isolated mock server");
  for (const title of ["Notification target", "Other thread"]) {
    socket.send(JSON.stringify({ t: "create", provider: "mock", cwd: hello.dirs[0], title }));
    ids.push((await waitFor(message => message.t === "created")).thread.id);
  }
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    await context.grantPermissions(["notifications"], { origin: base });
    await context.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/#thread=${ids[0]}`);
    await page.getByRole("heading", { name: "Notification target", exact: true }).waitFor();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    assert.ok(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active));
    if (width === 390) await page.getByRole("button", { name: "Threads", exact: true }).click();
    await page.getByRole("button", { name: /^Notifications:/ }).click();
    const dialog = page.getByRole("dialog", { name: "Notifications", exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => !document.getElementById("notifications-status")!.textContent!.includes("Checking"));
    const blocked = await page.evaluate(() => Notification.permission === "denied");
    assert.match(await page.locator("#notifications-status").innerText(), blocked ? /blocked/ : /Off for this device/);
    assert.equal(await page.getByRole("button", { name: "Enable notifications", exact: true }).isEnabled(), !blocked);
    const silentToggle = page.getByRole("checkbox", { name: "Silent notifications", exact: true });
    assert.equal(await silentToggle.isChecked(), false);
    await silentToggle.check();
    await page.waitForFunction(() => localStorage.getItem("ac_notifications_silent") === "1");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.reload();
    await page.getByRole("heading", { name: "Notification target", exact: true }).waitFor();
    if (width === 390) await page.getByRole("button", { name: "Threads", exact: true }).click();
    await page.getByRole("button", { name: /^Notifications:/ }).click();
    await page.waitForFunction(() => !document.getElementById("notifications-status")!.textContent!.includes("Checking"));
    assert.equal(await silentToggle.isChecked(), true, "Silent notifications survive a page reload");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "denied", origin: base });
    await page.getByRole("button", { name: /^Notifications:/ }).click();
    await page.waitForFunction(() => document.getElementById("notifications-status")!.textContent!.includes("blocked"));
    assert.equal(await page.getByRole("button", { name: "Enable notifications", exact: true }).isDisabled(), true);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    if (width === 390) await page.locator("#scrim").click({ position: { x: 380, y: 500 } });
    // Exercise the actual service worker message listener used by notification clicks.
    await page.evaluate(url => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "notification-open", url } })), `${base}/#thread=${ids[1]}`);
    await page.getByRole("heading", { name: "Other thread", exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, `#thread=${ids[1]}`);
    assert.deepEqual(errors, []);
    await cdp.send("Browser.resetPermissions");
    await context.close();
  }
  console.log("Desktop/mobile notification dialog, silent preference, service worker, denied permission, and thread links passed.");
} finally {
  for (const thread of ids) socket.send(JSON.stringify({ t: "delete", thread }));
  socket.close();
  await browser.close();
}
