// Live step dialog for saving an iron-managed key. Drives the shared step timeline from an NDJSON stream
// (or from an /api/vault `ironJob` snapshot after a reload) and owns the Retry / Close buttons.
import { createStepTimeline } from "/step-timeline.js";

const $ = (id) => document.getElementById(id);
const DISMISSED_KEY = "vault-steps-dismissed";
const POLL_MS = 2000;

/**
 * hooks: { retryVerify(onMessage), onSetOk(), onFinished(done), onDismiss(), focusForm(), poll() -> ironJob|null }
 * Returns { run(title, start), showSnapshot(job) }.
 */
export function createVaultSteps(hooks) {
  const dlg = $("vs");
  const timeline = createStepTimeline($("vs-steps"), { idPrefix: "vs" });
  const view = { jobId: null, running: false, retry: null, ok: false, pollTimer: null };

  const setError = (text) => {
    $("vs-err").textContent = text || "";
    $("vs-err").hidden = !text;
  };
  const setNote = (text) => {
    $("vs-note").textContent = text || "";
    $("vs-note").hidden = !text;
  };
  function paintButtons() {
    $("vs-retry").hidden = view.running || view.ok || !view.retry;
    $("vs-retry").disabled = view.running;
    $("vs-close").disabled = view.running;
    $("vs-close").textContent = view.ok ? "Done" : "Close";
  }
  function begin(title) {
    $("vs-title").textContent = title || "Saving to iron-proxy";
    timeline.clear();
    setError("");
    setNote("");
    Object.assign(view, { running: true, retry: null, ok: false });
    paintButtons();
  }
  function open() {
    if (!dlg.open) dlg.showModal();
    timeline.start();
  }
  function stopTicking() {
    timeline.stop();
    clearTimeout(view.pollTimer);
    view.pollTimer = null;
  }
  function onDone(done) {
    view.running = false;
    view.ok = !!done.ok;
    view.retry = done.ok ? null : done.retry || null;
    timeline.stop();
    if (done.warnings?.length) setNote(done.warnings.join(" "));
    paintButtons();
    if (done.ok) hooks.onFinished(done);
  }
  function onMessage(message) {
    if (message.t === "plan") {
      open();
      view.jobId = message.job;
    }
    message.at = performance.now();
    if (message.t === "done") return onDone(message);
    if (message.t === "error") return setError(message.error);
    timeline.handle(message);
    if (message.t === "ok" && message.id === "set") hooks.onSetOk();
  }
  function streamDied() {
    timeline.failActive();
    setError("Connection lost before the save finished. Reload the page to see where it stopped.");
    onDone({ ok: false });
  }
  /** Runs `start(onMessage)`; resolves with its plain-JSON reply when the server did not stream. */
  async function run(title, start) {
    begin(title);
    let finished = false;
    try {
      const plain = await start((message) => {
        if (message.t === "done") finished = true;
        onMessage(message);
      });
      if (!dlg.open) return plain;
      if (!finished) streamDied();
    } catch (error) {
      if (!dlg.open) throw error;
      timeline.failActive();
      setError(error.message);
      onDone({ ok: false });
    }
    return undefined;
  }

  function showSnapshot(job) {
    open();
    begin("Saving to iron-proxy");
    view.jobId = job.job;
    timeline.plan(job.steps.map(({ id, label }) => ({ id, label })));
    const at = performance.now();
    for (const item of job.steps) {
      if (item.state === "pending") continue;
      timeline.handle({ t: "step", id: item.id, at });
      if (item.state === "ok") timeline.handle({ t: "ok", id: item.id, at });
      else if (item.state === "skip") timeline.handle({ t: "skip", id: item.id, at });
      else if (item.state === "failed") {
        timeline.handle({ t: "fail", id: item.id, at, error: item.error || "Step failed." });
      }
    }
    // durations are unknown for a reloaded job: hide the fake 0 s labels
    for (const time of $("vs-steps").querySelectorAll(".ap-time")) {
      if (!time.closest("[data-state='active']")) time.textContent = "";
    }
    if (job.done) onDone({ ok: !!job.ok, retry: job.retry });
    else watch();
  }
  function watch() {
    clearTimeout(view.pollTimer);
    view.pollTimer = setTimeout(async () => {
      const job = await hooks.poll().catch(() => null);
      if (job?.job === view.jobId && dlg.open) showSnapshot(job);
      else if (dlg.open) watch();
    }, POLL_MS);
  }

  function dismiss() {
    if (view.running) return;
    if (view.jobId && !view.ok) localStorage.setItem(DISMISSED_KEY, view.jobId);
    stopTicking();
    dlg.close();
    hooks.onDismiss();
  }
  async function retry() {
    if (view.running || !view.retry) return;
    if (view.retry === "set") {
      dismiss();
      hooks.focusForm();
      return;
    }
    const title = $("vs-title").textContent;
    begin(title);
    timeline.start();
    let finished = false;
    try {
      await hooks.retryVerify((message) => {
        if (message.t === "done") finished = true;
        onMessage(message);
      });
      if (!finished) streamDied();
    } catch (error) {
      timeline.failActive();
      setError(error.message);
      onDone({ ok: false, retry: "verify" });
    }
  }
  $("vs-close").addEventListener("click", dismiss);
  $("vs-retry").addEventListener("click", () => void retry());
  dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    dismiss();
  });
  return { run, showSnapshot, dismissed: () => localStorage.getItem(DISMISSED_KEY) };
}
