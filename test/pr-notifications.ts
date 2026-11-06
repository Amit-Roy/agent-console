import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Notifications } from "../server/notifications.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pr-notices-"));
const key = Buffer.alloc(65, 1);
key[0] = 4;
const endpoint = "https://fcm.googleapis.com/fcm/send/pr";
const subscription = {
  endpoint,
  keys: { p256dh: key.toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") },
};
const sent: any[] = [];
const send = async (_subscription: any, payload: any) => {
  sent.push(JSON.parse(payload));
  return {} as any;
};
const card = { repo: "nefr0/agent-console", number: 421, title: "PR cockpit" };
try {
  const channel = new Notifications(directory, send);
  channel.subscribe(subscription, "https://console.test");
  await channel.notifyPr("shipped", "t1", card);
  assert.equal(sent.length, 0, "PR kinds are off by default");
  await channel.notify({ kind: "finished", thread: "t1", title: "Old kind" });
  assert.equal(sent.length, 1, "old kinds unaffected by opt-out");
  assert.equal(channel.setPrNotices("https://fcm.googleapis.com/none", true), false);
  assert.equal(channel.setPrNotices(endpoint, true), true);
  const labels = {
    shipped: "Shipped",
    checks_failed: "Checks failed",
    review_comment: "Review comment",
  } as const;
  for (const kind of Object.keys(labels) as (keyof typeof labels)[]) {
    await channel.notifyPr(kind, "t1", card, kind === "shipped" ? undefined : "lint");
  }
  const prNotices = sent.slice(1);
  assert.deepEqual(
    prNotices.map((notice) => notice.title),
    ["Shipped · Agent Console", "Checks failed · Agent Console", "Review comment · Agent Console"],
  );
  assert.equal(prNotices[0].body, "nefr0/agent-console#421 PR cockpit");
  assert.equal(prNotices[1].body, "nefr0/agent-console#421 PR cockpit · lint");
  assert.equal(prNotices[0].url, "https://console.test/#thread=t1");
  // Preference survives restart and re-subscribe; can be turned off again.
  channel.subscribe(subscription, "https://console.test");
  const restored = new Notifications(directory, send);
  await restored.notifyPr("shipped", "t1", card);
  assert.equal(sent.length, 5, "opt-in persists");
  restored.setPrNotices(endpoint, false);
  await restored.notifyPr("shipped", "t1", card);
  assert.equal(sent.length, 5, "opt-out stops PR kinds");
  console.log("pr-notifications: opt-in default, labels, bodies, persistence passed");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
