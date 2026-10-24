// Browser push is the single notification channel for thread outcomes and questions.
const SILENT_KEY = "ac_notifications_silent";
const SUBSCRIPTIONS_URL = "/api/notifications/subscriptions";

function readSilent(ctx) {
  try {
    ctx.silent = ctx.storage?.getItem(SILENT_KEY) === "1";
  } catch {}
}

function updateControls(ctx) {
  ctx.toggle.disabled =
    ctx.busy || !ctx.supported || (!ctx.subscription && ctx.Notification?.permission === "denied");
  ctx.silentToggle.disabled = ctx.busy;
  ctx.silentToggle.checked = ctx.silent;
}

function statusMessage(ctx) {
  if (!ctx.supported)
    return "Push notifications are unavailable in this browser. On iPhone or iPad, open the installed Home Screen app.";
  if (ctx.Notification.permission === "denied")
    return "Notifications are blocked. Allow notifications in your browser or device settings, then reopen this dialog.";
  return ctx.subscription
    ? "On for this device. Finished, failed, and needs input alerts include a link to the thread."
    : "Off for this device. Enable alerts for finished, failed, and needs input. Each alert opens its thread.";
}

function render(ctx, message) {
  updateControls(ctx);
  ctx.toggle.textContent = ctx.subscription ? "Disable notifications" : "Enable notifications";
  ctx.launch.setAttribute("aria-label", `Notifications: ${ctx.subscription ? "on" : "off"}`);
  ctx.status.textContent = message || statusMessage(ctx);
}

async function request(ctx, url, options) {
  const response = await ctx.apiFetch(url, options);
  if (!response.ok) throw new Error(`Notification settings request failed (${response.status}).`);
  return response;
}

function jsonBody(value) {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

function subscriptionSettings(ctx, value) {
  const { subscription } = ctx;
  return {
    ...(subscription.toJSON ? subscription.toJSON() : subscription),
    silent: value,
  };
}

async function worker(ctx) {
  if (!ctx.registration) {
    await ctx.navigator.serviceWorker.register("/sw.js");
    ctx.registration = await ctx.navigator.serviceWorker.ready;
  }
  return ctx.registration;
}

function postSubscription(ctx, silent) {
  return request(ctx, SUBSCRIPTIONS_URL, {
    method: "POST",
    ...jsonBody(subscriptionSettings(ctx, silent)),
  });
}

async function refresh(ctx) {
  if (ctx.busy) return;
  readSilent(ctx);
  if (!ctx.supported) return render(ctx);
  ctx.busy = true;
  render(ctx, "Checking notification settings…");
  try {
    ctx.subscription = await (await worker(ctx)).pushManager.getSubscription();
    if (ctx.subscription && ctx.Notification.permission === "granted")
      await postSubscription(ctx, ctx.silent);
    render(ctx);
  } catch (error) {
    render(ctx, `${error.message} Reopen this dialog to retry.`);
  } finally {
    ctx.busy = false;
    updateControls(ctx);
  }
}

async function changeSilent(ctx) {
  if (ctx.busy) return;
  const nextSilent = ctx.silentToggle.checked;
  ctx.busy = true;
  render(ctx, "Saving notification preference…");
  try {
    if (ctx.subscription) await postSubscription(ctx, nextSilent);
    ctx.storage?.setItem(SILENT_KEY, nextSilent ? "1" : "0");
    ctx.silent = nextSilent;
    render(ctx);
  } catch (error) {
    render(ctx, `${error.message} Silent notification preference was not saved. Try again.`);
  } finally {
    ctx.busy = false;
    updateControls(ctx);
  }
}

function decodePublicKey(publicKey) {
  const padded = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (char) =>
    char.charCodeAt(0),
  );
}

async function disableSubscription(ctx) {
  await request(ctx, SUBSCRIPTIONS_URL, {
    method: "DELETE",
    ...jsonBody({ endpoint: ctx.subscription.endpoint }),
  });
  await ctx.subscription.unsubscribe();
  ctx.subscription = null;
}

// Resolves false when permission is refused, so the caller skips its final render.
async function enableSubscription(ctx, permission) {
  if ((await permission) !== "granted") {
    render(ctx);
    return false;
  }
  const config = await (await request(ctx, "/api/notifications")).json();
  if (!config.enabled || !config.publicKey)
    throw new Error("Push notifications are unavailable on this server.");
  ctx.subscription = await (await worker(ctx)).pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodePublicKey(config.publicKey),
  });
  try {
    await postSubscription(ctx, ctx.silent);
  } catch (error) {
    await ctx.subscription.unsubscribe().catch(() => {});
    ctx.subscription = null;
    throw error;
  }
  return true;
}

async function toggleSubscription(ctx) {
  if (ctx.busy) return;
  // Request permission directly from the click, before awaiting network or worker setup.
  const permission =
    !ctx.subscription && ctx.Notification.permission !== "granted"
      ? ctx.Notification.requestPermission()
      : Promise.resolve(ctx.Notification.permission);
  ctx.busy = true;
  render(ctx, ctx.subscription ? "Disabling notifications…" : "Enabling notifications…");
  try {
    if (ctx.subscription) await disableSubscription(ctx);
    else if (!(await enableSubscription(ctx, permission))) return;
    render(ctx);
  } catch (error) {
    render(ctx, `${error.message} Try again.`);
  } finally {
    ctx.busy = false;
    updateControls(ctx);
  }
}

export function setupNotifications({
  apiFetch,
  document = globalThis.document,
  navigator = globalThis.navigator,
  Notification = globalThis.Notification,
  window = globalThis.window,
  storage = globalThis.localStorage,
}) {
  const ctx = {
    apiFetch,
    navigator,
    Notification,
    storage,
    launch: document.getElementById("notifications"),
    dialog: document.getElementById("notifications-dialog"),
    toggle: document.getElementById("notifications-toggle"),
    status: document.getElementById("notifications-status"),
    silentToggle: document.getElementById("notifications-silent"),
    silent: false,
    subscription: null,
    registration: undefined,
    busy: false,
    supported:
      window.isSecureContext &&
      Notification &&
      "serviceWorker" in navigator &&
      "PushManager" in window,
  };
  readSilent(ctx);
  ctx.silentToggle.onchange = () => changeSilent(ctx);
  ctx.launch.onclick = async () => {
    ctx.dialog.showModal();
    await refresh(ctx);
  };
  ctx.toggle.onclick = () => toggleSubscription(ctx);
  render(ctx);
  // The sidebar menu reads the launcher's label before the dialog is ever opened.
  void refresh(ctx);
}
