import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webpush from "web-push";
import { Notifications, validSubscription } from "../server/notifications.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-notifications-"));
const key = Buffer.alloc(65, 1);
key[0] = 4;
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test",
  keys: { p256dh: key.toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") },
};
const sent: { payload: any; options: any }[] = [];
let fail = 0;
const send = async (_subscription: any, payload: any, options: any) => {
  if (fail) throw { statusCode: fail };
  sent.push({ payload: JSON.parse(payload), options });
  return {} as any;
};
try {
  const channel = new Notifications(directory, send);
  const publicKey = channel.publicKey;
  assert.equal(fs.statSync(path.join(directory, "notifications.json")).mode & 0o777, 0o600);
  assert.ok(validSubscription(subscription));
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://evil.test/x",
    "https://user@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
  ]) {
    assert.equal(validSubscription({ ...subscription, endpoint }), false, endpoint);
  }
  assert.equal(
    validSubscription({ ...subscription, keys: { ...subscription.keys, auth: "bad" } }),
    false,
  );
  assert.equal(validSubscription({ ...subscription, silent: "true" }), false);
  assert.throws(() => channel.subscribe(subscription, "https://console.test/path"));
  channel.subscribe(subscription, "https://console.test");
  channel.subscribe(subscription, "https://console.test");
  const restored = new Notifications(directory, send);
  assert.equal(restored.publicKey, publicKey, "VAPID keys survive restarts");
  for (const kind of ["finished", "failed", "needs_input"] as const) {
    await restored.notify({ kind, thread: "thread/with space", title: "Test thread" });
  }
  assert.equal(sent.length, 3, "subscription updates do not duplicate deliveries");
  assert.deepEqual(
    sent.map((s) => s.payload.kind),
    ["finished", "failed", "needs_input"],
  );
  assert.equal(sent[0].payload.url, "https://console.test/#thread=thread%2Fwith%20space");
  assert.equal(sent[0].payload.body, "Test thread");
  assert.equal(
    sent[0].payload.silent,
    false,
    "existing subscriptions respect device sound defaults",
  );
  assert.equal(sent[0].payload.tag, sent[2].payload.tag, "one notification per thread");
  assert.equal(sent[0].options.vapidDetails.publicKey, publicKey);
  restored.unsubscribe(subscription.endpoint, "https://other.test");
  await restored.notify({ kind: "finished", thread: "t", title: "Still subscribed" });
  assert.equal(sent.length, 4, "other origins cannot remove this subscription");
  fail = 410;
  await restored.notify({ kind: "failed", thread: "t", title: "Expired" });
  fail = 0;
  await new Notifications(directory, send).notify({
    kind: "finished",
    thread: "t",
    title: "Removed",
  });
  assert.equal(sent.length, 4, "expired endpoints are removed from disk");
  restored.subscribe(subscription, "https://console.test");
  restored.unsubscribe(subscription.endpoint, "https://console.test");
  await restored.notify({ kind: "finished", thread: "t", title: "Disabled" });
  assert.equal(sent.length, 4);
  // The maintained library must accept generated keys for an actual encrypted request.
  const vapid = webpush.generateVAPIDKeys();
  const crypto = await import("node:crypto");
  const browser = crypto.createECDH("prime256v1");
  browser.generateKeys();
  const request = webpush.generateRequestDetails(
    {
      ...subscription,
      keys: { ...subscription.keys, p256dh: browser.getPublicKey().toString("base64url") },
    },
    "test",
    {
      vapidDetails: { ...vapid, subject: "https://github.com/example-owner/agent-console" },
    },
  );
  assert.ok(request.headers.Authorization);
  assert.ok(request.body.length > 0);
  const quietDirectory = path.join(directory, "quiet-devices");
  const quiet = new Notifications(quietDirectory, send);
  quiet.subscribe({ ...subscription, silent: true }, "https://console.test");
  quiet.subscribe(
    { ...subscription, endpoint: subscription.endpoint + "-second", silent: false },
    "https://console.test",
  );
  // Older clients that omit the new field must not erase an existing preference.
  quiet.subscribe(subscription, "https://console.test");
  await new Notifications(quietDirectory, send).notify({
    kind: "needs_input",
    thread: "t",
    title: "Silent question",
  });
  assert.deepEqual(
    sent
      .slice(-2)
      .map((s) => s.payload.silent)
      .sort(),
    [false, true],
    "sound preferences are per device and survive restarts",
  );
  quiet.subscribe({ ...subscription, silent: false }, "https://console.test");
  await quiet.notify({ kind: "finished", thread: "t", title: "Sound restored" });
  assert.deepEqual(
    sent.slice(-2).map((s) => s.payload.silent),
    [false, false],
    "silent mode can be disabled",
  );
  console.log("notifications: storage, delivery, links, endpoint validation and expiry passed");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
