// Minimal service worker: makes the app installable. Nothing is cached (live data only).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || !["finished", "failed", "needs_input"].includes(payload.kind)) return;
  let url;
  try {
    url = new URL(payload.url, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== "/") return;
  } catch { return; }
  event.waitUntil(self.registration.showNotification(payload.title || "Agent Console", {
    body: payload.body || "Open the thread for details.",
    tag: payload.tag || `thread-${payload.thread}`,
    icon: "/icon.svg",
    data: { url: url.href },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let url;
    try {
      url = new URL(event.notification.data?.url, self.location.origin);
      if (url.origin !== self.location.origin || url.pathname !== "/") return;
    } catch { return; }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find(client => {
      const current = new URL(client.url);
      return current.origin === url.origin && current.pathname === "/";
    });
    if (client) {
      client.postMessage({ type: "notification-open", url: url.href });
      await client.focus();
    } else await self.clients.openWindow(url.href);
  })());
});
