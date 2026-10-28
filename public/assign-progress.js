// Premium assignment progress: a timeline of the server's preparation steps, read live from the NDJSON response of
// POST /api/automation/assign (see server/automation/assign.ts ASSIGNMENT_STEPS). Each row expands to its command output.
import { $ } from "/render.js";
import { createStepTimeline, readNdjsonStream } from "/step-timeline.js";

function handleMessage(ctx, message) {
  if (message.t === "done") ctx.thread = message.thread;
  else if (message.t === "error")
    throw new Error(message.error || "Could not start a premium session.");
  else ctx.timeline.handle(message);
}

function showStreamFailure(ctx, failure) {
  ctx.failed = true;
  ctx.timeline.failActive();
  $("ap-title").textContent = "Assignment stopped";
  ctx.error.textContent = failure.message;
  ctx.error.hidden = false;
  ctx.open.textContent = "Back to settings";
  ctx.open.disabled = false;
}

/** Reads one assignment stream into the progress dialog. Resolves with the thread id; rejects with the server's error. */
export async function showAssignmentProgress(response, { title, onBack, onOpen }) {
  const ctx = {
    dlg: $("ap"),
    timeline: createStepTimeline($("ap-steps")),
    open: $("ap-open"),
    error: $("ap-error"),
    thread: null,
    failed: false,
  };
  $("ap-title").textContent = "Assigning to premium";
  $("ap-sub").textContent = title;
  ctx.error.hidden = true;
  ctx.timeline.clear();
  ctx.open.textContent = "See thread";
  ctx.open.disabled = true;
  ctx.open.onclick = () => {
    ctx.dlg.close();
    if (ctx.failed) onBack();
    else if (ctx.thread) onOpen(ctx.thread);
  };
  $("ap-close").onclick = () => ctx.dlg.close();
  if (!ctx.dlg.open) ctx.dlg.showModal();

  ctx.timeline.start();
  try {
    await readNdjsonStream(response, (message) => handleMessage(ctx, message));
    if (!ctx.thread) throw new Error("The connection closed before the session started.");
    $("ap-title").textContent = "Premium session started";
    ctx.open.disabled = false;
    if (ctx.dlg.open) ctx.open.focus();
    return ctx.thread;
  } catch (failure) {
    showStreamFailure(ctx, failure);
    throw failure;
  } finally {
    ctx.timeline.stop();
  }
}
