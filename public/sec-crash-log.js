// Process crash log for the "Process crashes (24 h)" security row. The server re-validates and redacts every field;
// all text still goes in through textContent. Each request owns its view so late responses cannot replace newer ones.
import { el } from "/render.js";

const REFRESH_MS = 10_000;
let current;
const button = (text, action) => {
  const b = el("button", "btn", text);
  b.type = "button";
  b.onclick = action;
  return b;
};
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

function crashCard(crash) {
  const card = el("details", "crash-card");
  card.append(
    el(
      "summary",
      "",
      [new Date(crash.at).toLocaleString(), crash.signal, crash.comm, crash.scope]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  card.append(el("p", "job-debug-meta", `pid ${crash.pid} · uid ${crash.uid} · ${crash.exe}`));
  card.append(el("code", "job-debug-record crash-cmdline", crash.cmdline || "No command line"));
  card.append(
    crash.frames.length
      ? el("pre", "job-debug-record", crash.frames.join("\n"))
      : el("p", "sub", "No stack trace recorded"),
  );
  return card;
}

async function investigate(btn) {
  btn.disabled = true;
  try {
    const response = await fetch("/api/automation/debug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, focus: "crashes" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    location.href = `/#thread=${encodeURIComponent(data.thread)}`;
  } catch (e) {
    alert(`Could not start the investigation: ${e.message}`);
    btn.disabled = false;
  }
}

export function openCrashLog(trigger) {
  current?.dialog.close();
  const dialog = el("dialog", "job-debug crash-log");
  dialog.id = "sec-crash-log";
  dialog.setAttribute("aria-labelledby", "crash-log-title");
  const title = el("h2", "", "Process crashes · last 24 h");
  title.id = "crash-log-title";
  const updated = el("p", "sub crash-updated");
  const body = el("div", "job-debug-body");
  const actions = el("div", "row job-debug-actions");
  const ask = button("Investigate with agent", () => investigate(ask));
  const refresh = button("Refresh", () => load());
  const close = button("Close", () => dialog.close());
  close.autofocus = true;
  actions.append(ask, refresh, close);
  dialog.append(title, updated, actions, body);
  const view = { dialog, request: null, timer: 0, trigger: trigger ?? document.activeElement };
  current = view;
  dialog.addEventListener("close", () => {
    clearInterval(view.timer);
    view.request?.abort();
    dialog.remove();
    if (current === view) {
      current = null;
      const back = view.trigger?.isConnected
        ? view.trigger
        : document.querySelector('[data-sec="crashes"] .crash-log-btn');
      back?.focus();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  load();
  view.timer = setInterval(() => {
    if (document.visibilityState === "visible") load(true);
  }, REFRESH_MS);

  async function load(quiet = false) {
    view.request?.abort();
    const request = (view.request = new AbortController());
    refresh.disabled = true;
    if (!quiet) {
      const loading = el("p", "sub", "Loading crash log…");
      loading.setAttribute("role", "status");
      body.replaceChildren(loading);
    }
    try {
      const response = await fetch("/api/security/crashes", {
        cache: "no-store",
        signal: request.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      if (current !== view || request !== view.request || !dialog.open) return;
      render(data);
    } catch (error) {
      if (request.signal.aborted || current !== view || request !== view.request) return;
      const message = el(
        "p",
        "job-debug-error",
        error.message || "The crash log could not be loaded.",
      );
      message.setAttribute("role", "alert");
      body.replaceChildren(
        message,
        button("Retry", () => load()),
      );
    } finally {
      if (current === view && request === view.request) refresh.disabled = false;
    }
  }

  function render(data) {
    updated.textContent = `Updated ${clock(Date.now())}`;
    if (!data.crashes.length) {
      body.replaceChildren(el("p", "sub", "No crashes in the last 24 h"));
      return;
    }
    const open = new Set(
      [...body.querySelectorAll("details[open]")].map((d) => d.dataset.key).filter(Boolean),
    );
    const cards = data.crashes.map((crash) => {
      const card = crashCard(crash);
      card.dataset.key = `${crash.at}-${crash.pid}`;
      card.open = open.has(card.dataset.key);
      return card;
    });
    const count =
      data.total > data.crashes.length
        ? `Showing the latest ${data.crashes.length} of ${data.total} crashes.`
        : `${data.total} crash${data.total === 1 ? "" : "es"}.`;
    body.replaceChildren(el("p", "sub", count), ...cards);
  }
}
