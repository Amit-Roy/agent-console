import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type webpushModule from "web-push";

export type ThreadNotice = {
  kind: "finished" | "failed" | "needs_input" | PrNoticeKind;
  thread: string;
  title: string;
};
export type PrNoticeKind = "shipped" | "checks_failed" | "review_comment";
export type PrCard = { repo: string; number: number; title: string };
const PR_KINDS: readonly string[] = ["shipped", "checks_failed", "review_comment"];

// Compose a PR notice; the card title and optional detail become the push body.
export function prNotice(
  kind: PrNoticeKind,
  thread: string,
  card: PrCard,
  detail?: string,
): ThreadNotice {
  const head = `${card.repo}#${card.number} ${card.title}`;
  return { kind, thread, title: detail ? `${head} · ${detail}` : head };
}
type Subscription = { endpoint: string; keys: { p256dh: string; auth: string }; silent?: boolean };
type Device = {
  subscription: Subscription;
  origin: string;
  silent?: boolean;
  prNotices?: boolean;
};
type State = { publicKey: string; privateKey: string; devices: Device[] };
type Sender = typeof webpushModule.sendNotification;
// web-push takes ~100 ms to load; boot needs it only to make the first keys, deliveries load it on first use.
const webpush = (): typeof webpushModule => createRequire(import.meta.url)("web-push");

// Only browser push services can receive deliveries. Never fetch arbitrary submitted URLs.
export function validSubscription(value: any): value is Subscription {
  try {
    const url = new URL(value.endpoint);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !(
        host === "fcm.googleapis.com" ||
        host === "web.push.apple.com" ||
        host.endsWith(".push.services.mozilla.com") ||
        host.endsWith(".notify.windows.com")
      )
    )
      return false;
    const key = value.keys?.p256dh,
      auth = value.keys?.auth;
    return (
      (value.silent === undefined || typeof value.silent === "boolean") &&
      typeof key === "string" &&
      typeof auth === "string" &&
      /^[A-Za-z0-9_-]+$/.test(key) &&
      /^[A-Za-z0-9_-]+$/.test(auth) &&
      Buffer.from(key, "base64url").length === 65 &&
      Buffer.from(key, "base64url")[0] === 4 &&
      Buffer.from(auth, "base64url").length === 16 &&
      value.endpoint.length <= 4096
    );
  } catch {
    return false;
  }
}

export class Notifications {
  private state: State;
  private file: string;
  private send: Sender;

  constructor(directory: string, send: Sender = (...args) => webpush().sendNotification(...args)) {
    this.file = path.join(directory, "notifications.json");
    this.send = send;
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!this.state.publicKey || !this.state.privateKey || !Array.isArray(this.state.devices)) {
        throw new Error("Invalid notification storage.");
      }
      fs.chmodSync(this.file, 0o600);
    } else {
      this.state = { ...webpush().generateVAPIDKeys(), devices: [] };
      this.save();
    }
  }

  get publicKey() {
    return this.state.publicKey;
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }

  subscribe(value: unknown, origin: string) {
    if (!validSubscription(value)) throw new Error("Invalid browser push subscription.");
    const parsed = new URL(origin);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin !== origin)
      throw new Error("Invalid origin.");
    const previous = this.state.devices.find(
      (device) => device.subscription.endpoint === value.endpoint,
    );
    if (!previous && this.state.devices.length >= 32)
      throw new Error("Too many notification devices.");
    const device = {
      subscription: {
        endpoint: value.endpoint,
        keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
      },
      origin,
      silent: value.silent ?? previous?.silent ?? false,
      prNotices: previous?.prNotices ?? false,
    };
    this.state.devices = this.state.devices.filter(
      (device) => device.subscription.endpoint !== value.endpoint,
    );
    this.state.devices.push(device);
    this.save();
  }

  unsubscribe(endpoint: string, origin: string) {
    this.state.devices = this.state.devices.filter(
      (device) => device.subscription.endpoint !== endpoint || device.origin !== origin,
    );
    this.save();
  }

  // PR kinds are opt-in per device (off by default). Returns false for an unknown endpoint.
  setPrNotices(endpoint: string, enabled: boolean) {
    const device = this.state.devices.find((device) => device.subscription.endpoint === endpoint);
    if (!device) return false;
    device.prNotices = enabled === true;
    this.save();
    return true;
  }

  notifyPr(kind: PrNoticeKind, thread: string, card: PrCard, detail?: string) {
    return this.notify(prNotice(kind, thread, card, detail));
  }

  async notify(notice: ThreadNotice) {
    const labels = {
      finished: "Finished",
      failed: "Failed",
      needs_input: "Needs input",
      shipped: "Shipped",
      checks_failed: "Checks failed",
      review_comment: "Review comment",
    };
    const prKind = PR_KINDS.includes(notice.kind);
    await Promise.all(
      this.state.devices
        .filter((device) => !prKind || device.prNotices === true)
        .map(async (device) => {
          const payload = JSON.stringify({
            ...notice,
            title: `${labels[notice.kind]} · Agent Console`,
            body: notice.title.slice(0, 160),
            url: `${device.origin}/#thread=${encodeURIComponent(notice.thread)}`,
            tag: `thread-${notice.thread}`,
            silent: device.silent === true,
          });
          try {
            await this.send(device.subscription, payload, {
              vapidDetails: {
                subject: "https://github.com/nefr0/agent-console",
                publicKey: this.state.publicKey,
                privateKey: this.state.privateKey,
              },
              TTL: 3600,
              urgency: "high",
              timeout: 10_000,
            });
          } catch (error: any) {
            if (error?.statusCode === 404 || error?.statusCode === 410) {
              this.unsubscribe(device.subscription.endpoint, device.origin);
            } else {
              // Errors can contain subscription URLs and keys; keep logs free of credentials.
              console.warn("Browser notification delivery failed.");
            }
          }
        }),
    );
  }
}
