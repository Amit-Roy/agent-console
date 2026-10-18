// Browser push is the single notification channel for thread outcomes and questions.
export function setupNotifications({ apiFetch, document = globalThis.document, navigator = globalThis.navigator, Notification = globalThis.Notification, window = globalThis.window }) {
  const launch = document.getElementById("notifications");
  const dialog = document.getElementById("notifications-dialog");
  const toggle = document.getElementById("notifications-toggle");
  const status = document.getElementById("notifications-status");
  let subscription = null;
  let registration;
  let busy = false;
  const supported = window.isSecureContext && Notification && "serviceWorker" in navigator && "PushManager" in window;

  function render(message) {
    toggle.disabled = busy || !supported || (!subscription && Notification?.permission === "denied");
    toggle.textContent = subscription ? "Disable notifications" : "Enable notifications";
    launch.setAttribute("aria-label", `Notifications: ${subscription ? "on" : "off"}`);
    status.textContent = message || (!supported ? "Push notifications are unavailable in this browser. On iPhone or iPad, open the installed Home Screen app." : Notification.permission === "denied" ? "Notifications are blocked. Allow notifications in your browser or device settings, then reopen this dialog." : subscription ? "On for this device. Finished, failed, and needs input alerts include a link to the thread." : "Off for this device. Enable alerts for finished, failed, and needs input. Each alert opens its thread.");
  }
  async function request(url, options) {
    const response = await apiFetch(url, options);
    if (!response.ok) throw new Error(`Notification settings request failed (${response.status}).`);
    return response;
  }
  const body = value => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  async function worker() {
    if (!registration) {
      await navigator.serviceWorker.register("/sw.js");
      registration = await navigator.serviceWorker.ready;
    }
    return registration;
  }
  async function refresh() {
    if (!supported) return render();
    busy = true;
    render("Checking notification settings…");
    try {
      subscription = await (await worker()).pushManager.getSubscription();
      if (subscription && Notification.permission === "granted") {
        await request("/api/notifications/subscriptions", { method: "POST", ...body(subscription) });
      }
      render();
    } catch (error) {
      render(`${error.message} Reopen this dialog to retry.`);
    } finally { busy = false; toggle.disabled = !supported || (!subscription && Notification.permission === "denied"); }
  }
  launch.onclick = async () => { dialog.showModal(); await refresh(); };
  toggle.onclick = async () => {
    if (busy) return;
    // Request permission directly from the click, before awaiting network or worker setup.
    const permission = !subscription && Notification.permission !== "granted" ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    busy = true;
    render(subscription ? "Disabling notifications…" : "Enabling notifications…");
    try {
      if (subscription) {
        await request("/api/notifications/subscriptions", { method: "DELETE", ...body({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
        subscription = null;
      } else {
        if (await permission !== "granted") { render(); return; }
        const config = await (await request("/api/notifications")).json();
        if (!config.enabled || !config.publicKey) throw new Error("Push notifications are unavailable on this server.");
        const padded = config.publicKey.replace(/-/g, "+").replace(/_/g, "/");
        const key = Uint8Array.from(atob(padded + "=".repeat((4 - padded.length % 4) % 4)), c => c.charCodeAt(0));
        subscription = await (await worker()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        try {
          await request("/api/notifications/subscriptions", { method: "POST", ...body(subscription) });
        } catch (error) {
          await subscription.unsubscribe().catch(() => {});
          subscription = null;
          throw error;
        }
      }
      render();
    } catch (error) { render(`${error.message} Try again.`); }
    finally { busy = false; toggle.disabled = !supported || (!subscription && Notification.permission === "denied"); }
  };
  render();
}
