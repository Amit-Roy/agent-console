// Minimal service worker: makes the app installable. Nothing is cached (live data only).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// While the server restarts, the Coder proxy answers page loads with 502 (or the fetch fails outright).
// Show a page that polls until the server answers, then reloads, instead of the proxy's error.
const DOWN = new Set([502, 503, 504]);
const RETRY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Console restarting</title><meta name="color-scheme" content="light dark">
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center}p{margin:.4em}small{opacity:.6}</style>
</head><body><div><p>Agent Console is restarting…</p><p><small id="s">Retrying</small></p></div><script>
const start = Date.now(), s = document.getElementById("s");
async function poll() {
  try {
    const r = await fetch(location.href, { cache: "no-store", redirect: "manual" });
    if (r.type === "opaqueredirect" || !${JSON.stringify([...DOWN])}.includes(r.status)) return location.reload();
  } catch {}
  const secs = Math.round((Date.now() - start) / 1000);
  s.textContent = secs < 60 ? "Retrying (" + secs + " s)" : "Still down after " + secs + " s. Check: agent-console status";
  setTimeout(poll, 1000);
}
setTimeout(poll, 1000);
</script></body></html>`;

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      const retry = () =>
        new Response(RETRY_PAGE, {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      try {
        const res = await fetch(event.request);
        return DOWN.has(res.status) ? retry() : res;
      } catch {
        return retry();
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!payload || !["finished", "failed", "needs_input"].includes(payload.kind)) return;
  let url;
  try {
    url = new URL(payload.url, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== "/") return;
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Agent Console", {
      body: payload.body || "Open the thread for details.",
      tag: payload.tag || `thread-${payload.thread}`,
      icon: "/icon.svg",
      silent: payload.silent === true,
      data: { url: url.href },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      let url;
      try {
        url = new URL(event.notification.data?.url, self.location.origin);
        if (url.origin !== self.location.origin || url.pathname !== "/") return;
      } catch {
        return;
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((client) => {
        const current = new URL(client.url);
        return current.origin === url.origin && current.pathname === "/";
      });
      if (client) {
        client.postMessage({ type: "notification-open", url: url.href });
        await client.focus();
      } else await self.clients.openWindow(url.href);
    })(),
  );
});
