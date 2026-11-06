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

export function createPrCockpit(deps) {
  const model = { thread: null, cards: [], open: null, logs: new Map(), busy: false };
  const stripEl = () => $("pr-strip");
  const sheet = () => $("pr-sheet");
  const base = () => `/api/threads/${encodeURIComponent(model.thread)}/pr`;
  const cardOf = (key) => model.cards.find((card) => card.key === key);

  async function post(path, body) {
    const res = await deps.apiFetch(`${base()}/${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} failed (${res.status})`);
    return res.json().catch(() => ({}));
  }

  function chip(card) {
    const tone = toneOf(card);
    const button = el("button", `pr-chip ${tone}`);
    button.type = "button";
    button.dataset.key = card.key;
    const counts = card.checkCounts || { passed: 0, total: 0 };
    const parts = [`#${card.number}`, TONE_WORD[tone], `${counts.passed}/${counts.total} checks`];
    if (card.commentCount) parts.push(`${card.commentCount} comments`);
    if (card.mergeable === "MERGEABLE") parts.push("mergeable");
    button.setAttribute("aria-label", `Pull request ${parts.join(", ")}`);
    button.title = card.title || card.key;
    button.append(
      el("span", "pr-num", `#${card.number}`),
      icon(TONE_ICON[tone], `pr-state ${tone}`),
    );
    button.append(el("span", "pr-checks", `${counts.passed}/${counts.total}`));
    if (card.commentCount) {
      const comments = el("span", "pr-meta");
      comments.append(icon("compose"), el("span", "", String(card.commentCount)));
      button.append(comments);
    }
    if (card.mergeable === "MERGEABLE") {
      const merge = el("span", "pr-meta pr-merge");
      merge.append(icon("fork"));
      button.append(merge);
    }
    button.addEventListener("click", () => openSheet(card.key, button));
    return button;
  }

  function renderStrip() {
    const strip = stripEl();
    if (!strip) return;
    strip.replaceChildren(...model.cards.map(chip));
    strip.hidden = model.cards.length === 0;
  }

  function actionButton(label, onClick, cls = "btn sm") {
    const button = el("button", cls, label);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await onClick();
      } catch (error) {
        deps.toast(error.message);
      }
      button.disabled = false;
    });
    return button;
  }

  function checkRow(card, check) {
    const row = el("li", "pr-check");
    const failed = isFailed(check);
    const head = el("div", "pr-check-head");
    const pending = check.status !== "COMPLETED";
    const word = failed
      ? "Failed"
      : pending
        ? "Pending"
        : (check.conclusion || "done").toLowerCase();
    head.append(
      icon(
        failed ? "alert" : pending ? "clock" : "check",
        `pr-state ${failed ? "bad" : pending ? "warn" : "ok"}`,
      ),
      el("span", "pr-check-name", check.name),
      el("span", "pr-check-word", word),
    );
    row.append(head);
    if (failed) {
      const actions = el("div", "pr-check-actions");
      const logId = `${card.key}|${check.jobId || check.name}`;
      const pre = el("pre", "pr-log");
      pre.hidden = !model.logs.has(logId);
      pre.textContent = model.logs.get(logId) || "";
      actions.append(
        actionButton("Re-run", async () => {
          await post("rerun", { key: card.key, runId: check.runId });
          deps.toast("Re-run requested");
        }),
        actionButton("Log", async () => {
          const res = await deps.apiFetch(
            `${base()}/log?key=${encodeURIComponent(card.key)}&job=${encodeURIComponent(check.jobId || "")}`,
          );
          if (!res.ok) throw new Error(`Log failed (${res.status})`);
          const data = await res.json();
          model.logs.set(logId, (data.lines || []).join("\n") || "(empty log)");
          pre.textContent = model.logs.get(logId);
          pre.hidden = false;
        }),
      );
      row.append(actions, pre);
    }
    return row;
  }

  function evidence(card) {
    const wrap = el("div", "pr-images");
    for (const src of card.images || []) {
      const url = safeUrl(src);
      if (!url) continue;
      const link = el("a", "pr-image");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      const img = el("img");
      img.src = url;
      img.alt = "Evidence image";
      img.loading = "lazy";
      link.append(img);
      wrap.append(link);
    }
    return wrap;
  }

  function shipSection(card) {
    const box = el("div", "pr-ship");
    const ship = card.ship;
    if (ship) {
      const line = el("p", `pr-ship-line ${ship.state}`);
      line.setAttribute("role", "status");
      line.append(
        el("strong", "", `Ship ${ship.state}`),
        el("span", "", ship.line ? `: ${ship.line}` : ""),
      );
      box.append(line);
    }
    if (ship?.state === "attention") {
      box.append(
        actionButton(
          "Ask agent to fix",
          async () => {
            await post("ask-fix", { key: card.key });
            deps.toast("Asked the agent to fix");
          },
          "btn primary",
        ),
      );
    }
    if (card.state === "OPEN" && ship?.state !== "running") {
      const shipButton = el("button", "btn primary pr-ship-btn", "Ship");
      shipButton.type = "button";
      shipButton.addEventListener("click", () => confirmShip(card.key));
      box.append(shipButton);
    }
    return box;
  }

  function renderSheet() {
    const card = cardOf(model.open);
    const body = $("pr-sheet-body");
    if (!card) {
      if (sheet().open) sheet().close();
      return;
    }
    $("pr-sheet-title").textContent = `#${card.number} ${card.title || ""}`;
    const link = $("pr-sheet-link");
    const url = safeUrl(card.url);
    link.hidden = !url;
    if (url) link.href = url;
    const checks = el("ul", "pr-checks-list");
    checks.setAttribute("aria-label", "Checks");
    for (const check of sortChecks(card.checks)) checks.append(checkRow(card, check));
    const counts = card.checkCounts || { passed: 0, total: 0 };
    const sections = [
      el(
        "p",
        "pr-merge-line",
        `${mergeText(card)}${card.reviewDecision ? ` · ${card.reviewDecision.replaceAll("_", " ").toLowerCase()}` : ""}${card.unresolvedThreads ? ` · ${card.unresolvedThreads} unresolved` : ""}`,
      ),
      el("h3", "pr-h", `Checks ${counts.passed}/${counts.total}`),
      checks,
    ];
    if (card.deploy?.text) sections.push(el("p", "pr-deploy", `Deploy: ${card.deploy.text}`));
    if (card.images?.length) sections.push(el("h3", "pr-h", "Evidence"), evidence(card));
    sections.push(shipSection(card));
    body.replaceChildren(...sections);
  }

  async function refresh(key) {
    try {
      await post("refresh", { key });
    } catch (error) {
      deps.toast(error.message);
    }
  }

  function openSheet(key, opener) {
    model.open = key;
    model.opener = opener;
    renderSheet();
    if (!sheet().open) sheet().showModal();
    refresh(key);
  }

  function confirmShip(key) {
    const card = cardOf(key);
    if (!card) return;
    $("pr-ship-sub").textContent = `Merge and deploy #${card.number} ${card.title || ""}?`;
    $("pr-ship-error").textContent = "";
    $("pr-ship-go").disabled = false;
    $("pr-ship-dialog").dataset.key = key;
    $("pr-ship-dialog").showModal();
  }

  async function doShip() {
    const dialog = $("pr-ship-dialog");
    $("pr-ship-go").disabled = true;
    try {
      await post("ship", { key: dialog.dataset.key, confirm: true });
      dialog.close();
    } catch (error) {
      $("pr-ship-error").textContent = error.message;
      $("pr-ship-go").disabled = false;
    }
  }

  async function load() {
    const id = model.thread;
    if (!id) return;
    try {
      const res = await deps.apiFetch(`${base()}`);
      if (!res.ok || id !== model.thread) return;
      const data = await res.json();
      if (id === model.thread) setCards(data.cards || []);
    } catch {
      // The strip keeps whatever the socket pushed.
    }
  }

  function setCards(cards) {
    model.cards = Array.isArray(cards) ? cards : [];
    renderStrip();
    if (model.open) renderSheet();
  }

  function wire() {
    $("pr-sheet-close").addEventListener("click", () => sheet().close());
    $("pr-ship-cancel").addEventListener("click", () => $("pr-ship-dialog").close());
    $("pr-ship-go").addEventListener("click", doShip);
    sheet().addEventListener("close", () => {
      model.open = null;
      model.opener?.focus?.();
    });
    sheet().addEventListener("click", (event) => {
      if (event.target === sheet()) sheet().close();
    });
  }
  wire();

  return {
    /** WS {t:"pr"} message. */
    onMessage(message) {
      if (message.thread === model.thread) setCards(message.cards);
    },
    /** Called on every head render; a thread switch clears the strip and refetches. */
    renderThread(thread) {
      const id = thread?.id || null;
      if (id === model.thread) return;
      model.thread = id;
      model.logs.clear();
      if (sheet().open) sheet().close();
      setCards([]);
      load();
    },
  };
}
