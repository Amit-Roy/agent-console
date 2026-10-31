// Live step dialog for saving an iron-managed key. Drives the shared step timeline from an NDJSON stream
// (or from an /api/vault `ironJob` snapshot after a reload) and owns the Retry / Close buttons.
import { createStepTimeline } from "./step-timeline.js";

const $ = (id) => document.getElementById(id);
const DISMISSED_KEY = "vault-steps-dismissed";
const POLL_MS = 2000;

const setError = (text) => {
  $("vs-err").textContent = text || "";
  $("vs-err").hidden = !text;
};
const setNote = (text) => {
  $("vs-note").textContent = text || "";
  $("vs-note").hidden = !text;
};

function paintButtons(view) {
  $("vs-retry").hidden = view.running || view.ok || !view.retry;
  $("vs-retry").disabled = view.running;
  $("vs-close").disabled = view.running;
  $("vs-close").textContent = view.ok ? "Done" : "Close";
}

function begin(ctx, title) {
  $("vs-title").textContent = title || "Saving to iron-proxy";
  ctx.timeline.clear();
  setError("");
  setNote("");
  Object.assign(ctx.view, { running: true, retry: null, ok: false });
  paintButtons(ctx.view);
}

function open(ctx) {
  if (!ctx.dlg.open) ctx.dlg.showModal();
  ctx.timeline.start();
}

function stopTicking(ctx) {
  ctx.timeline.stop();
  clearTimeout(ctx.view.pollTimer);
  ctx.view.pollTimer = null;
}

function onDone(ctx, done) {
  const { view } = ctx;
  view.running = false;
  view.ok = !!done.ok;
  view.retry = done.ok ? null : done.retry || null;
  ctx.timeline.stop();
  if (done.warnings?.length) setNote(done.warnings.join(" "));
  paintButtons(view);
  if (done.ok) ctx.hooks.onFinished(done);
}

function onMessage(ctx, message) {
  if (message.t === "plan") {
    open(ctx);
    ctx.view.jobId = message.job;
  }
  message.at = performance.now();
  if (message.t === "done") return onDone(ctx, message);
  if (message.t === "error") return setError(message.error);
  ctx.timeline.handle(message);
  if (message.t === "ok" && message.id === "set") ctx.hooks.onSetOk();
}

function streamDied(ctx) {
  ctx.timeline.failActive();
  setError("Connection lost before the save finished. Reload the page to see where it stopped.");
  onDone(ctx, { ok: false });
}

/** Wraps onMessage so the caller can tell whether a `done` message arrived. */
function trackedSink(ctx, flag) {
  return (message) => {
    if (message.t === "done") flag.finished = true;
    onMessage(ctx, message);
  };
}

/** Runs `start(onMessage)`; resolves with its plain-JSON reply when the server did not stream. */
async function runSave(ctx, title, start) {
  begin(ctx, title);
  const flag = { finished: false };
  try {
    const plain = await start(trackedSink(ctx, flag));
    if (!ctx.dlg.open) return plain;
    if (!flag.finished) streamDied(ctx);
  } catch (error) {
    if (!ctx.dlg.open) throw error;
    ctx.timeline.failActive();
    setError(error.message);
    onDone(ctx, { ok: false });
  }
  return undefined;
}

function replaySnapshotStep(ctx, item, stamp) {
  if (item.state === "pending") return;
  const { timeline } = ctx;
  timeline.handle({ t: "step", id: item.id, at: stamp });
  if (item.state === "ok") timeline.handle({ t: "ok", id: item.id, at: stamp });
  else if (item.state === "skip") timeline.handle({ t: "skip", id: item.id, at: stamp });
  else if (item.state === "failed") {
    timeline.handle({ t: "fail", id: item.id, at: stamp, error: item.error || "Step failed." });
  }
}

function hideFakeDurations() {
  for (const time of $("vs-steps").querySelectorAll(".ap-time")) {
    if (!time.closest("[data-state='active']")) time.textContent = "";
  }
}

function showSnapshot(ctx, job) {
  open(ctx);
  begin(ctx, "Saving to iron-proxy");
  ctx.view.jobId = job.job;
  ctx.timeline.plan(job.steps.map(({ id, label }) => ({ id, label })));
  const stamp = performance.now();
  for (const item of job.steps) replaySnapshotStep(ctx, item, stamp);
  // durations are unknown for a reloaded job: hide the fake 0 s labels
  hideFakeDurations();
  if (job.done) onDone(ctx, { ok: !!job.ok, retry: job.retry });
  else watch(ctx);
}

function watch(ctx) {
  const { view } = ctx;
  clearTimeout(view.pollTimer);
  view.pollTimer = setTimeout(async () => {
    const job = await ctx.hooks.poll().catch(() => null);
    if (job?.job === view.jobId && ctx.dlg.open) showSnapshot(ctx, job);
    else if (ctx.dlg.open) watch(ctx);
  }, POLL_MS);
}

function dismiss(ctx) {
  const { view } = ctx;
  if (view.running) return;
  if (view.jobId && !view.ok) localStorage.setItem(DISMISSED_KEY, view.jobId);
  stopTicking(ctx);
  ctx.dlg.close();
  ctx.hooks.onDismiss();
}

async function retryVerify(ctx) {
  begin(ctx, $("vs-title").textContent);
  ctx.timeline.start();
  const flag = { finished: false };
  try {
    await ctx.hooks.retryVerify(trackedSink(ctx, flag));
    if (!flag.finished) streamDied(ctx);
  } catch (error) {
    ctx.timeline.failActive();
    setError(error.message);
    onDone(ctx, { ok: false, retry: "verify" });
  }
}

async function retry(ctx) {
  const { view } = ctx;
  if (view.running || !view.retry) return;
  if (view.retry !== "set") return retryVerify(ctx);
  dismiss(ctx);
  ctx.hooks.focusForm();
}

/**
 * hooks: { retryVerify(onMessage), onSetOk(), onFinished(done), onDismiss(), focusForm(), poll() -> ironJob|null }
 * Returns { run(title, start), showSnapshot(job) }.
 */
export function createVaultSteps(hooks) {
  const timeline = createStepTimeline($("vs-steps"), { idPrefix: "vs" });
  const view = { jobId: null, running: false, retry: null, ok: false, pollTimer: null };
  const ctx = { dlg: $("vs"), timeline, hooks, view };
  $("vs-close").addEventListener("click", () => dismiss(ctx));
  $("vs-retry").addEventListener("click", () => void retry(ctx));
  ctx.dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    dismiss(ctx);
  });
  return {
    run: (title, start) => runSave(ctx, title, start),
    showSnapshot: (job) => showSnapshot(ctx, job),
    dismissed: () => localStorage.getItem(DISMISSED_KEY),
  };
}
