import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { setupNotifications } from "../public/notifications.js";

function browser(permission = "default") {
  const elements = new Map<string, any>();
  for (const id of ["notifications", "notifications-dialog", "notifications-toggle", "notifications-status"]) {
    elements.set(id, { textContent: "", disabled: false, setAttribute() {}, showModal() {} });
  }
  const requests: any[] = [];
  let subscription: any = null;
  let deniedRequest = false;
  let failed = false;
  const Notification = {
    permission,
    async requestPermission() { this.permission = deniedRequest ? "denied" : "granted"; return this.permission; },
  };
  const registration = { pushManager: {
    async getSubscription() { return subscription; },
    async subscribe(options: any) {
      assert.equal(options.userVisibleOnly, true);
      assert.deepEqual([...options.applicationServerKey], [1, 2, 3]);
      subscription = { endpoint: "https://push.example/sub", async unsubscribe() { subscription = null; return true; } };
      return subscription;
    },
  } };
  setupNotifications({
    document: { getElementById: id => elements.get(id) },
    navigator: { serviceWorker: { async register() {}, ready: Promise.resolve(registration) } },
    window: { isSecureContext: true, PushManager: class {} }, Notification,
    async apiFetch(url, options) {
      requests.push({ url, options });
      return { ok: !failed, status: failed ? 503 : 200, async json() { return { enabled: true, publicKey: "AQID" }; } };
    },
  });
  return { elements, requests, deny() { deniedRequest = true; }, fail() { failed = true; } };
}

const enabled = browser();
await enabled.elements.get("notifications").onclick();
await enabled.elements.get("notifications-toggle").onclick();
assert.match(enabled.elements.get("notifications-status").textContent, /On for this device/);
assert.equal(enabled.requests.at(-1).options.method, "POST");
await enabled.elements.get("notifications-toggle").onclick();
assert.equal(enabled.requests.at(-1).options.method, "DELETE");
assert.deepEqual(JSON.parse(enabled.requests.at(-1).options.body), { endpoint: "https://push.example/sub" });
assert.match(enabled.elements.get("notifications-status").textContent, /Off for this device/);

const denied = browser();
denied.deny();
await denied.elements.get("notifications-toggle").onclick();
assert.equal(denied.requests.length, 0);
assert.match(denied.elements.get("notifications-status").textContent, /blocked/);
assert.equal(denied.elements.get("notifications-toggle").disabled, true);

const failed = browser();
failed.fail();
await failed.elements.get("notifications-toggle").onclick();
assert.match(failed.elements.get("notifications-status").textContent, /503/);

const events = new Map<string, Function>();
const shown: any[] = [];
const messages: any[] = [];
let focused = 0;
let opened = 0;
const worker = {
  location: { origin: "https://console.example" },
  addEventListener(name: string, callback: Function) { events.set(name, callback); },
  registration: { async showNotification(title: string, options: any) { shown.push({ title, options }); } },
  clients: {
    async matchAll() { return [{ url: "https://console.example/#thread=other", postMessage(value: any) { messages.push(value); }, async focus() { focused++; } }]; },
    async openWindow() { opened++; },
  },
};
vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self: worker, URL });
async function dispatch(name: string, props: any) {
  let pending: Promise<unknown> = Promise.resolve();
  events.get(name)!({ ...props, waitUntil(value: Promise<unknown>) { pending = value; } });
  await pending;
}
for (const kind of ["finished", "failed", "needs_input"]) {
  await dispatch("push", { data: { json: () => ({ title: kind, kind, url: "/#thread=target", thread: "target" }) } });
}
assert.equal(shown.length, 3);
await dispatch("push", { data: { json: () => ({ kind: "finished", url: "https://evil.example/" }) } });
assert.equal(shown.length, 3);
await dispatch("notificationclick", { notification: { close() {}, data: shown[0].options.data } });
assert.equal(messages[0].url, "https://console.example/#thread=target");
assert.equal(focused, 1);
assert.equal(opened, 0);
await dispatch("notificationclick", { notification: { close() {}, data: { url: "https://evil.example/" } } });
assert.equal(focused, 1);
console.log("Notification permission, subscription, push, and thread click checks passed.");
