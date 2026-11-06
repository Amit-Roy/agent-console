// PR cockpit: header strip of PR chips plus a detail sheet (checks, logs, evidence, ship).
// The server pushes {t:"pr", thread, cards}; actions go through /api/threads/:id/pr/*. All text is set with textContent.
import { $, el, icon } from "./render.js";

const JSON_HEADERS = { "content-type": "application/json" };
const SAFE_URL = /^https?:\/\//i;
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const OK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const safeUrl = (url) => (typeof url === "string" && SAFE_URL.test(url) ? url : null);

/** Overall tone of a card: bad, warn or ok. Always shown with a word and icon too. */
export function toneOf(card) {
  const counts = card.checkCounts || {};
  if (counts.failed > 0 || card.mergeable === "CONFLICTING" || card.ship?.state === "failed")
    return "bad";
  if (
    counts.pending > 0 ||
    card.isDraft ||
    card.ship?.state === "attention" ||
    card.mergeable === "UNKNOWN"
  )
    return "warn";
  return "ok";
}
const TONE_WORD = { ok: "Ready", warn: "Pending", bad: "Failing" };
const TONE_ICON = { ok: "check", warn: "clock", bad: "alert" };

/** Failing checks first, then pending, then the rest. */
export function sortChecks(checks = []) {
  const rank = (check) => {
    if (FAILED.has(check.conclusion)) return 0;
    if (check.status !== "COMPLETED") return 1;
    return OK_CONCLUSIONS.has(check.conclusion) ? 2 : 1;
  };
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => rank(a.check) - rank(b.check) || a.index - b.index)
    .map((entry) => entry.check);
}
const isFailed = (check) => FAILED.has(check.conclusion);

function mergeText(card) {
  if (card.state === "MERGED") return "Merged";
  if (card.state === "CLOSED") return "Closed";
  if (card.mergeable === "MERGEABLE") return `Mergeable (${card.mergeStateStatus || "clean"})`;
  if (card.mergeable === "CONFLICTING") return "Merge conflicts";
  return "Mergeability unknown";
}

// The cockpit state and collaborators travel as one `cockpit` object so each piece below stays small.
const stripEl = () => $("pr-strip");
const sheet = () => $("pr-sheet");
const base = (cockpit) => `/api/threads/${encodeURIComponent(cockpit.model.thread)}/pr`;
const cardOf = (cockpit, key) => cockpit.model.cards.find((card) => card.key === key);
const countsOf = (card) => card.checkCounts || { passed: 0, total: 0 };

async function post(cockpit, path, body) {
  const res = await cockpit.deps.apiFetch(`${base(cockpit)}/${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.json().catch(() => ({}));
}

function chipLabel(card, tone) {
  const counts = countsOf(card);
  const parts = [`#${card.number}`, TONE_WORD[tone], `${counts.passed}/${counts.total} checks`];
  if (card.commentCount) parts.push(`${card.commentCount} comments`);
  if (card.mergeable === "MERGEABLE") parts.push("mergeable");
  return `Pull request ${parts.join(", ")}`;
}

function chipMeta(card) {
  const metas = [];
  if (card.commentCount) {
    const comments = el("span", "pr-meta");
    comments.append(icon("compose"), el("span", "", String(card.commentCount)));
    metas.push(comments);
  }
  if (card.mergeable === "MERGEABLE") {
    const merge = el("span", "pr-meta pr-merge");
    merge.append(icon("fork"));
    metas.push(merge);
  }
  return metas;
}

function chip(cockpit, card) {
  const tone = toneOf(card);
  const counts = countsOf(card);
  const button = el("button", `pr-chip ${tone}`);
  button.type = "button";
  button.dataset.key = card.key;
  button.setAttribute("aria-label", chipLabel(card, tone));
  button.title = card.title || card.key;
  button.append(
    el("span", "pr-num", `#${card.number}`),
    icon(TONE_ICON[tone], `pr-state ${tone}`),
    el("span", "pr-checks", `${counts.passed}/${counts.total}`),
    ...chipMeta(card),
  );
  button.addEventListener("click", () => openSheet(cockpit, card.key, button));
  return button;
}

function renderStrip(cockpit) {
  const strip = stripEl();
  if (!strip) return;
  strip.replaceChildren(...cockpit.model.cards.map((card) => chip(cockpit, card)));
  strip.hidden = cockpit.model.cards.length === 0;
}

function actionButton(cockpit, label, onClick, cls = "btn sm") {
  const button = el("button", cls, label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await onClick();
    } catch (error) {
      cockpit.deps.toast(error.message);
    }
    button.disabled = false;
  });
  return button;
}

function checkPhase(check) {
  if (isFailed(check)) return { word: "Failed", iconName: "alert", tone: "bad" };
  if (check.status !== "COMPLETED") return { word: "Pending", iconName: "clock", tone: "warn" };
  return { word: (check.conclusion || "done").toLowerCase(), iconName: "check", tone: "ok" };
}

async function fetchLog(cockpit, card, check, logId, pre) {
  const res = await cockpit.deps.apiFetch(
    `${base(cockpit)}/log?key=${encodeURIComponent(card.key)}&job=${encodeURIComponent(check.jobId || "")}`,
  );
  if (!res.ok) throw new Error(`Log failed (${res.status})`);
  const data = await res.json();
  cockpit.model.logs.set(logId, (data.lines || []).join("\n") || "(empty log)");
  pre.textContent = cockpit.model.logs.get(logId);
  pre.hidden = false;
}

function failedCheckActions(cockpit, card, check) {
  const { logs } = cockpit.model;
  const logId = `${card.key}|${check.jobId || check.name}`;
  const actions = el("div", "pr-check-actions");
  const pre = el("pre", "pr-log");
  pre.hidden = !logs.has(logId);
  pre.textContent = logs.get(logId) || "";
  actions.append(
    actionButton(cockpit, "Re-run", async () => {
      await post(cockpit, "rerun", { key: card.key, runId: check.runId });
      cockpit.deps.toast("Re-run requested");
    }),
    actionButton(cockpit, "Log", () => fetchLog(cockpit, card, check, logId, pre)),
  );
  return [actions, pre];
}

function checkRow(cockpit, card, check) {
  const row = el("li", "pr-check");
  const head = el("div", "pr-check-head");
  const phase = checkPhase(check);
  head.append(
    icon(phase.iconName, `pr-state ${phase.tone}`),
    el("span", "pr-check-name", check.name),
    el("span", "pr-check-word", phase.word),
  );
  row.append(head);
  if (isFailed(check)) row.append(...failedCheckActions(cockpit, card, check));
  return row;
}

function evidenceImage(url) {
  const link = el("a", "pr-image");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  const img = el("img");
  img.src = url;
  img.alt = "Evidence image";
  img.loading = "lazy";
  link.append(img);
  return link;
}

function evidence(card) {
  const wrap = el("div", "pr-images");
  const urls = (card.images || []).map(safeUrl).filter(Boolean);
  wrap.append(...urls.map(evidenceImage));
  return wrap;
}

function shipLine(ship) {
  const line = el("p", `pr-ship-line ${ship.state}`);
  line.setAttribute("role", "status");
  line.append(
    el("strong", "", `Ship ${ship.state}`),
    el("span", "", ship.line ? `: ${ship.line}` : ""),
  );
  return line;
}

function shipSection(cockpit, card) {
  const box = el("div", "pr-ship");
  const ship = card.ship;
  if (ship) box.append(shipLine(ship));
  if (ship?.state === "attention") {
    const askFix = async () => {
      await post(cockpit, "ask-fix", { key: card.key });
      cockpit.deps.toast("Asked the agent to fix");
    };
    box.append(actionButton(cockpit, "Ask agent to fix", askFix, "btn primary"));
  }
  if (card.state === "OPEN" && ship?.state !== "running") {
    const shipButton = el("button", "btn primary pr-ship-btn", "Ship");
    shipButton.type = "button";
    shipButton.addEventListener("click", () => confirmShip(cockpit, card.key));
    box.append(shipButton);
  }
  return box;
}

function mergeLine(card) {
  const decision = card.reviewDecision
    ? ` · ${card.reviewDecision.replaceAll("_", " ").toLowerCase()}`
    : "";
  const unresolved = card.unresolvedThreads ? ` · ${card.unresolvedThreads} unresolved` : "";
  return el("p", "pr-merge-line", `${mergeText(card)}${decision}${unresolved}`);
}

function checksList(cockpit, card) {
  const checks = el("ul", "pr-checks-list");
  checks.setAttribute("aria-label", "Checks");
  for (const check of sortChecks(card.checks)) checks.append(checkRow(cockpit, card, check));
  return checks;
}

function sheetHeader(card) {
  $("pr-sheet-title").textContent = `#${card.number} ${card.title || ""}`;
  const link = $("pr-sheet-link");
  const url = safeUrl(card.url);
  link.hidden = !url;
  if (url) link.href = url;
}

function sheetSections(cockpit, card) {
  const counts = countsOf(card);
  const sections = [
    mergeLine(card),
    el("h3", "pr-h", `Checks ${counts.passed}/${counts.total}`),
    checksList(cockpit, card),
  ];
  if (card.deploy?.text) sections.push(el("p", "pr-deploy", `Deploy: ${card.deploy.text}`));
  if (card.images?.length) sections.push(el("h3", "pr-h", "Evidence"), evidence(card));
  sections.push(shipSection(cockpit, card));
  return sections;
}

function renderSheet(cockpit) {
  const card = cardOf(cockpit, cockpit.model.open);
  if (!card) {
    if (sheet().open) sheet().close();
    return;
  }
  sheetHeader(card);
  $("pr-sheet-body").replaceChildren(...sheetSections(cockpit, card));
}

async function refresh(cockpit, key) {
  try {
    await post(cockpit, "refresh", { key });
  } catch (error) {
    cockpit.deps.toast(error.message);
  }
}

function openSheet(cockpit, key, opener) {
  cockpit.model.open = key;
  cockpit.model.opener = opener;
  renderSheet(cockpit);
  if (!sheet().open) sheet().showModal();
  refresh(cockpit, key);
}

function confirmShip(cockpit, key) {
  const card = cardOf(cockpit, key);
  if (!card) return;
  $("pr-ship-sub").textContent = `Merge and deploy #${card.number} ${card.title || ""}?`;
  $("pr-ship-error").textContent = "";
  $("pr-ship-go").disabled = false;
  $("pr-ship-dialog").dataset.key = key;
  $("pr-ship-dialog").showModal();
}

async function doShip(cockpit) {
  const dialog = $("pr-ship-dialog");
  $("pr-ship-go").disabled = true;
  try {
    await post(cockpit, "ship", { key: dialog.dataset.key, confirm: true });
    dialog.close();
  } catch (error) {
    $("pr-ship-error").textContent = error.message;
    $("pr-ship-go").disabled = false;
  }
}

async function load(cockpit) {
  const { model, deps } = cockpit;
  const loadingThread = model.thread;
  if (!loadingThread) return;
  try {
    const res = await deps.apiFetch(`${base(cockpit)}`);
    if (!res.ok || loadingThread !== model.thread) return;
    const data = await res.json();
    if (loadingThread === model.thread) setCards(cockpit, data.cards || []);
  } catch {
    // The strip keeps whatever the socket pushed.
  }
}

function setCards(cockpit, cards) {
  cockpit.model.cards = Array.isArray(cards) ? cards : [];
  renderStrip(cockpit);
  if (cockpit.model.open) renderSheet(cockpit);
}

function wire(cockpit) {
  $("pr-sheet-close").addEventListener("click", () => sheet().close());
  $("pr-ship-cancel").addEventListener("click", () => $("pr-ship-dialog").close());
  $("pr-ship-go").addEventListener("click", () => doShip(cockpit));
  sheet().addEventListener("close", () => {
    cockpit.model.open = null;
    cockpit.model.opener?.focus?.();
  });
  sheet().addEventListener("click", (event) => {
    if (event.target === sheet()) sheet().close();
  });
}

export function createPrCockpit(deps) {
  const cockpit = {
    deps,
    model: { thread: null, cards: [], open: null, logs: new Map(), busy: false },
  };
  const { model } = cockpit;
  wire(cockpit);
  return {
    /** WS {t:"pr"} message. */
    onMessage(message) {
      if (message.thread === model.thread) setCards(cockpit, message.cards);
    },
    /** Called on every head render; a thread switch clears the strip and refetches. */
    renderThread(thread) {
      const threadId = thread?.id || null;
      if (threadId === model.thread) return;
      model.thread = threadId;
      model.logs.clear();
      if (sheet().open) sheet().close();
      setCards(cockpit, []);
      load(cockpit);
    },
  };
}
