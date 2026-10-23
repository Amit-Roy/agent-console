import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { setupNotifications } from "../public/notifications.js";

function browser(permission = "default", preferences = new Map<string, string>()) {
  const elements = new Map<string, any>();
  for (const id of [
    "notifications",
    "notifications-dialog",
    "notifications-toggle",
    "notifications-status",
    "notifications-silent",
  ]) {
    elements.set(id, {
      textContent: "",
      disabled: false,
      checked: false,
      setAttribute() {},
      showModal() {},
    });
  }
  const requests: any[] = [];
  let subscription: any = null;
  let deniedRequest = false;
  let failed = false;
  const Notification = {
    permission,
    async requestPermission() {
      this.permission = deniedRequest ? "denied" : "granted";
      return this.permission;
    },
  };
  const registration = {
    pushManager: {
      async getSubscription() {
        return subscription;
      },
      async subscribe(options: any) {
        assert.equal(options.userVisibleOnly, true);
        assert.deepEqual([...options.applicationServerKey], [1, 2, 3]);
        subscription = {
          endpoint: "https://push.example/sub",
          toJSON() {
            return { endpoint: this.endpoint, keys: { p256dh: "fixture", auth: "fixture" } };
          },
          async unsubscribe() {
            subscription = null;
            return true;
          },
        };
        return subscription;
      },
    },
  };
  setupNotifications({
    document: { getElementById: (id) => elements.get(id) },
    navigator: { serviceWorker: { async register() {}, ready: Promise.resolve(registration) } },
    window: { isSecureContext: true, PushManager: class {} },
    Notification,
    storage: {
      getItem: (key) => preferences.get(key) ?? null,
      setItem: (key, value) => preferences.set(key, value),
    },
    async apiFetch(url, options) {
      requests.push({ url, options });
      return {
        ok: !failed,
        status: failed ? 503 : 200,
        async json() {
          return { enabled: true, publicKey: "AQID" };
        },
      };
    },
  });
  return {
    elements,
    requests,
    deny() {
      deniedRequest = true;
    },
    fail() {
      failed = true;
    },
  };
}

const enabled = browser();
assert.equal(enabled.elements.get("notifications-silent").checked, false);
await enabled.elements.get("notifications").onclick();
await enabled.elements.get("notifications-toggle").onclick();
assert.match(enabled.elements.get("notifications-status").textContent, /On for this device/);
assert.equal(enabled.requests.at(-1).options.method, "POST");
await enabled.elements.get("notifications-toggle").onclick();
assert.equal(enabled.requests.at(-1).options.method, "DELETE");
assert.deepEqual(JSON.parse(enabled.requests.at(-1).options.body), {
  endpoint: "https://push.example/sub",
});
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

const preferences = new Map<string, string>();
const silent = browser("default", preferences);
silent.elements.get("notifications-silent").checked = true;
await silent.elements.get("notifications-silent").onchange();
assert.equal(preferences.get("ac_notifications_silent"), "1");
assert.equal(silent.requests.length, 0, "Unsubscribed preferences save locally without a request");
const restored = browser("default", preferences);
assert.equal(restored.elements.get("notifications-silent").checked, true);
await restored.elements.get("notifications-toggle").onclick();
assert.deepEqual(JSON.parse(restored.requests.at(-1).options.body), {
  endpoint: "https://push.example/sub",
  keys: { p256dh: "fixture", auth: "fixture" },
  silent: true,
});
await restored.elements.get("notifications").onclick();
assert.equal(
  JSON.parse(restored.requests.at(-1).options.body).silent,
  true,
  "Refreshing preserves the preference",
);
restored.elements.get("notifications-silent").checked = false;
await restored.elements.get("notifications-silent").onchange();
assert.equal(JSON.parse(restored.requests.at(-1).options.body).silent, false);
assert.equal(preferences.get("ac_notifications_silent"), "0");
preferences.set("ac_notifications_silent", "1");
await restored.elements.get("notifications").onclick();
assert.equal(
  JSON.parse(restored.requests.at(-1).options.body).silent,
  true,
  "Dialog refresh rereads another tab's saved preference",
);
assert.equal(restored.elements.get("notifications-silent").checked, true);
restored.elements.get("notifications-silent").checked = false;
await restored.elements.get("notifications-silent").onchange();
restored.fail();
restored.elements.get("notifications-silent").checked = true;
await restored.elements.get("notifications-silent").onchange();
assert.equal(JSON.parse(restored.requests.at(-1).options.body).silent, true);
assert.equal(
  preferences.get("ac_notifications_silent"),
  "0",
  "A rejected request must not persist the new preference",
);
assert.equal(
  restored.elements.get("notifications-silent").checked,
  false,
  "A rejected request restores the checkbox",
);
assert.match(restored.elements.get("notifications-status").textContent, /503.*not saved/);

const events = new Map<string, Function>();
const shown: any[] = [];
const messages: any[] = [];
let focused = 0;
let opened = 0;
const worker = {
  location: { origin: "https://console.example" },
  addEventListener(name: string, callback: Function) {
    events.set(name, callback);
  },
  registration: {
    async showNotification(title: string, options: any) {
      shown.push({ title, options });
    },
  },
  clients: {
    async matchAll() {
      return [
        {
          url: "https://console.example/#thread=other",
          postMessage(value: any) {
            messages.push(value);
          },
          async focus() {
            focused++;
          },
        },
      ];
    },
    async openWindow() {
      opened++;
    },
  },
};
vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
  self: worker,
  URL,
});
async function dispatch(name: string, props: any) {
  let pending: Promise<unknown> = Promise.resolve();
  events.get(name)!({
    ...props,
    waitUntil(value: Promise<unknown>) {
      pending = value;
    },
  });
  await pending;
}
for (const kind of ["finished", "failed", "needs_input"]) {
  await dispatch("push", {
    data: { json: () => ({ title: kind, kind, url: "/#thread=target", thread: "target" }) },
  });
}
assert.equal(shown.length, 3);
assert.equal(shown[0].options.silent, false, "Default notifications allow sound and vibration");
assert.equal("vibrate" in shown[0].options, false);
await dispatch("push", {
  data: { json: () => ({ kind: "finished", url: "/#thread=target", silent: true }) },
});
assert.equal(shown.at(-1).options.silent, true);
assert.equal("vibrate" in shown.at(-1).options, false);
await dispatch("push", {
  data: { json: () => ({ kind: "finished", url: "/#thread=target", silent: "true" }) },
});
assert.equal(
  shown.at(-1).options.silent,
  false,
  "Only a boolean true enables silent notifications",
);
await dispatch("push", {
  data: { json: () => ({ kind: "finished", url: "https://evil.example/" }) },
});
assert.equal(shown.length, 5);
await dispatch("notificationclick", { notification: { close() {}, data: shown[0].options.data } });
assert.equal(messages[0].url, "https://console.example/#thread=target");
assert.equal(focused, 1);
assert.equal(opened, 0);
await dispatch("notificationclick", {
  notification: { close() {}, data: { url: "https://evil.example/" } },
});
assert.equal(focused, 1);
console.log("Notification permission, subscription, push, and thread click checks passed.");
