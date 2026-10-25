// Premium assignment progress: a timeline of the server's preparation steps, read live from the NDJSON response of
// POST /api/automation/assign (see server/automation/assign.ts ASSIGNMENT_STEPS). Each row expands to its command output.
import { $, el } from "/render.js";

const R = 8,
  ARC = 2 * Math.PI * R;
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const seconds = (ms) => {
  const s = ms / 1000;
  return s < 10
    ? `${s.toFixed(1)} s`
    : s < 60
      ? `${Math.round(s)} s`
      : `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
};

function node() {
  const ring = svg("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" });
  ring.append(
    svg("circle", { class: "track", cx: 10, cy: 10, r: R }),
    svg("circle", { class: "arc", cx: 10, cy: 10, r: R, "stroke-dasharray": ARC.toFixed(2) }),
  );
  const check = svg("svg", { viewBox: "0 0 20 20", class: "mark", "aria-hidden": "true" });
  check.append(
    svg("path", { class: "ok", d: "M6 10.5l2.6 2.6L14 7.5" }),
    svg("path", { class: "no", d: "M7 7l6 6M13 7l-6 6" }),
  );
  const n = el("span", "ap-node");
  n.append(ring, check);
  return n;
}

function planSteps(ctx, steps) {
  ctx.list.replaceChildren(
    ...steps.map(({ id, label }, index) => {
      const stepItem = el("li", "ap-step");
      stepItem.dataset.state = "pending";
      const row = el("button", "ap-row");
      row.type = "button";
      row.setAttribute("aria-expanded", "false");
      row.setAttribute("aria-controls", `ap-log-${id}`);
      const time = el("span", "ap-time");
      row.append(node(), el("span", "ap-label", label), time);
      const log = el("pre", "ap-log");
      log.id = `ap-log-${id}`;
      log.hidden = true;
      row.onclick = () => {
        log.hidden = !log.hidden;
        row.setAttribute("aria-expanded", String(!log.hidden));
      };
      stepItem.append(row, log);
      ctx.rows.set(id, { li: stepItem, row, time, log, start: 0, i: index });
      return stepItem;
    }),
  );
}

function showLiveTime(ctx) {
  if (ctx.active) ctx.active.time.textContent = seconds(performance.now() - ctx.active.clientStart);
}

function finishStep(ctx, stepRow, state, at) {
  stepRow.li.dataset.state = state;
  stepRow.time.textContent = seconds(Math.max(0, at - stepRow.start));
  if (ctx.active === stepRow) ctx.active = null;
}

function startStep(ctx, stepRow, message) {
  Object.assign(stepRow, { start: message.at, clientStart: performance.now() });
  stepRow.li.dataset.state = "active";
  ctx.active = stepRow;
  showLiveTime(ctx);
  // The newest step stays in view on short phone screens.
  stepRow.li.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function failStep(ctx, stepRow, message) {
  finishStep(ctx, stepRow, "failed", message.at);
  stepRow.log.append(`${message.error}\n`);
  stepRow.log.hidden = false;
  stepRow.row.setAttribute("aria-expanded", "true");
}

function appendStepLog(stepRow, message) {
  stepRow.log.append(`${message.text}\n`);
  if (!stepRow.log.hidden) stepRow.log.scrollTop = stepRow.log.scrollHeight;
}

function handleRowMessage(ctx, message, stepRow) {
  if (message.t === "step") startStep(ctx, stepRow, message);
  else if (message.t === "log") appendStepLog(stepRow, message);
  else if (message.t === "ok") finishStep(ctx, stepRow, "done", message.at);
  else if (message.t === "fail") failStep(ctx, stepRow, message);
}

function handleMessage(ctx, message) {
  const stepRow = ctx.rows.get(message.id);
  if (message.t === "plan") planSteps(ctx, message.steps);
  else if (message.t === "done") ctx.thread = message.thread;
  else if (message.t === "error")
    throw new Error(message.error || "Could not start a premium session.");
  else if (stepRow) handleRowMessage(ctx, message, stepRow);
}

async function readAssignmentStream(ctx, response) {
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value, { stream: !done });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) if (line.trim()) handleMessage(ctx, JSON.parse(line));
    if (done) break;
  }
  if (buf.trim()) handleMessage(ctx, JSON.parse(buf));
}

function showStreamFailure(ctx, failure) {
  ctx.failed = true;
  if (ctx.active)
    finishStep(
      ctx,
      ctx.active,
      "failed",
      ctx.active.start + performance.now() - ctx.active.clientStart,
    );
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
    list: $("ap-steps"),
    open: $("ap-open"),
    error: $("ap-error"),
    rows: new Map(),
    active: null,
    thread: null,
    failed: false,
  };
  $("ap-title").textContent = "Assigning to premium";
  $("ap-sub").textContent = title;
  ctx.error.hidden = true;
  ctx.list.replaceChildren();
  ctx.open.textContent = "See thread";
  ctx.open.disabled = true;
  ctx.open.onclick = () => {
    ctx.dlg.close();
    if (ctx.failed) onBack();
    else if (ctx.thread) onOpen(ctx.thread);
  };
  $("ap-close").onclick = () => ctx.dlg.close();
  if (!ctx.dlg.open) ctx.dlg.showModal();

  const tick = setInterval(() => showLiveTime(ctx), 100);
  try {
    await readAssignmentStream(ctx, response);
    if (!ctx.thread) throw new Error("The connection closed before the session started.");
    $("ap-title").textContent = "Premium session started";
    ctx.open.disabled = false;
    if (ctx.dlg.open) ctx.open.focus();
    return ctx.thread;
  } catch (failure) {
    showStreamFailure(ctx, failure);
    throw failure;
  } finally {
    clearInterval(tick);
  }
}
