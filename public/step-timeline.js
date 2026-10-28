// Reusable step timeline: one expandable row per server step, driven by NDJSON messages
// ({t:"plan"|"step"|"log"|"ok"|"fail"|"skip"}). Used by the assign dialog; mount it in any container.
import { el } from "/render.js";

const R = 8,
  ARC = 2 * Math.PI * R;
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** Formats a millisecond duration as "3.2 s", "42 s" or "1 m 5 s". */
export const seconds = (ms) => {
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
    svg("path", { class: "skip", d: "M6.5 10h7" }),
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
      row.setAttribute("aria-controls", `${ctx.prefix}-log-${id}`);
      const time = el("span", "ap-time");
      row.append(node(), el("span", "ap-label", label), time);
      const log = el("pre", "ap-log");
      log.id = `${ctx.prefix}-log-${id}`;
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

function skipStep(ctx, stepRow) {
  stepRow.li.dataset.state = "skipped";
  stepRow.time.textContent = "";
  if (ctx.active === stepRow) ctx.active = null;
}

function appendStepLog(stepRow, message) {
  stepRow.log.append(`${message.text}\n`);
  if (!stepRow.log.hidden) stepRow.log.scrollTop = stepRow.log.scrollHeight;
}

const ROW_HANDLERS = {
  step: (ctx, row, message) => startStep(ctx, row, message),
  log: (_ctx, row, message) => appendStepLog(row, message),
  ok: (ctx, row, message) => finishStep(ctx, row, "done", message.at),
  fail: (ctx, row, message) => failStep(ctx, row, message),
  skip: (ctx, row) => skipStep(ctx, row),
};

function handleRowMessage(ctx, message, stepRow) {
  ROW_HANDLERS[message.t]?.(ctx, stepRow, message);
}

/**
 * Mounts a timeline in `list` (an <ol>). `idPrefix` namespaces the log element ids.
 * Returns { plan(steps), handle(message), skip(id), failActive(), start(), stop(), clear() }.
 * `handle` routes plan/step/log/ok/fail/skip messages and ignores other types.
 */
export function createStepTimeline(list, { idPrefix = "ap" } = {}) {
  const ctx = { list, prefix: idPrefix, rows: new Map(), active: null };
  let tick = null;
  return {
    plan: (steps) => planSteps(ctx, steps),
    handle(message) {
      if (message.t === "plan") return planSteps(ctx, message.steps);
      const stepRow = ctx.rows.get(message.id);
      if (stepRow) handleRowMessage(ctx, message, stepRow);
    },
    skip(id) {
      const stepRow = ctx.rows.get(id);
      if (stepRow) skipStep(ctx, stepRow);
    },
    /** Marks the running step failed using the client clock (stream died mid-step). */
    failActive() {
      const act = ctx.active;
      if (act) finishStep(ctx, act, "failed", act.start + performance.now() - act.clientStart);
    },
    /** Starts the live elapsed-time tick for the active step. */
    start() {
      if (!tick) tick = setInterval(() => showLiveTime(ctx), 100);
    },
    stop() {
      clearInterval(tick);
      tick = null;
    },
    clear() {
      ctx.rows.clear();
      ctx.active = null;
      list.replaceChildren();
    },
  };
}

/** Reads an NDJSON response body, calling `onMessage(parsedLine)` per line. */
export async function readNdjsonStream(response, onMessage) {
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value, { stream: !done });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) if (line.trim()) onMessage(JSON.parse(line));
    if (done) break;
  }
  if (buf.trim()) onMessage(JSON.parse(buf));
}
