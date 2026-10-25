// Improve-prompt dialog: the server rewrites the draft, the user edits the result, compares rough effort
// estimates (session-total tokens, before vs after) and applies it. Nothing touches the composer until Use.
const PLACEHOLDER = /\[(?!\s*[xX]?\s*\])[^[\]\n]{2,60}\](?!\()/g; // mirrors server/prompt-improve.ts
const CLIENT_TIMEOUT_MS = 65_000;
const UNAVAILABLE = "estimate unavailable";

export function findPlaceholders(text) {
  return Array.from(text.matchAll(PLACEHOLDER), (hit) => ({
    text: hit[0],
    start: hit.index,
    end: hit.index + hit[0].length,
  }));
}

export function formatTokens(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
  if (count >= 1e4) return `${Math.round(count / 1e3)}k`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`;
  return String(Math.round(count));
}

const signedTokens = (delta) => `${delta < 0 ? "−" : "+"}${formatTokens(Math.abs(delta))}`;

function node(tag, className, text) {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text != null) made.textContent = text;
  return made;
}

async function postText(route, text, signal) {
  const res = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

function quoteCard(card, label, quote) {
  card.replaceChildren(node("h4", "", label));
  if (!quote) return card.append(node("p", "pi-pending", "…"));
  if (quote.status !== "ready") {
    const none = node("p", "pi-none", UNAVAILABLE);
    none.title = quote.reason || "";
    return card.append(none);
  }
  for (const [name, value] of [
    ["P50", quote.p50],
    ["P80", quote.p80],
  ]) {
    const row = node("p", "pi-row");
    row.append(node("span", "pi-key", name), node("span", "pi-val", formatTokens(value)));
    card.append(row);
  }
}

function differenceText(before, after) {
  if (before?.status !== "ready" || after?.status !== "ready") return "";
  if (after.p50 === before.p50 && after.p80 === before.p80) return "Same work, clearer wording";
  return `Change: P50 ${signedTokens(after.p50 - before.p50)}, P80 ${signedTokens(after.p80 - before.p80)} tokens`;
}

const byId = (id) => document.getElementById(id);

function drawQuotes(quotes) {
  quoteCard(byId("pi-before"), "Before", quotes.before);
  quoteCard(byId("pi-after"), "After", quotes.after);
  const diff = byId("pi-diff");
  diff.textContent = differenceText(quotes.before, quotes.after);
  for (const hint of quotes.hints ?? []) {
    const chip = node("span", "pi-hint", hint);
    Object.assign(chip.style, {
      marginLeft: "6px",
      padding: "0 6px",
      borderRadius: "8px",
      border: "1px solid currentColor",
      fontSize: "0.85em",
      whiteSpace: "nowrap",
    });
    diff.append(chip);
  }
  const level = [quotes.before, quotes.after].find((q) => q?.status === "ready")?.confidence;
  byId("pi-note").textContent =
    `Session-total tokens${level ? `, ${level}` : ""}. A guide, not a promise.`;
}

function drawChips(area, marks) {
  const list = byId("pi-chips");
  list.hidden = !marks.length;
  list.replaceChildren(
    ...marks.map((hit) => {
      const chip = node("button", "btn sm pi-chip", hit.text);
      chip.type = "button";
      chip.title = "Select this placeholder";
      chip.onclick = () => {
        area.focus();
        area.setSelectionRange(hit.start, hit.end);
      };
      return chip;
    }),
  );
}

// The textarea is transparent; this layer behind it repeats its text with <mark> around each placeholder.
function drawHighlights(area) {
  const text = area.value;
  const marks = findPlaceholders(text);
  const parts = [];
  let from = 0;
  for (const hit of marks) {
    parts.push(text.slice(from, hit.start), node("mark", "", hit.text));
    from = hit.end;
  }
  parts.push(text.slice(from), "\u200b");
  byId("pi-back").replaceChildren(...parts);
  drawChips(area, marks);
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

function showPhase(phase) {
  byId("pi-wait").hidden = phase !== "wait";
  byId("pi-result").hidden = phase !== "result";
  byId("pi-check").hidden = phase !== "result";
  byId("pi-use").hidden = phase !== "result";
  byId("pi-title").textContent = phase === "wait" ? "Improving prompt…" : "Improve prompt";
}

function showError(message) {
  byId("pi-error").textContent = message;
  byId("pi-error").hidden = !message;
}

/** Quote and rewrite run together; the quote shows first. Resolves to the improve result or throws. */
function runImprove(draft, signal, onQuote) {
  postText("/api/prompt/quote", draft, signal).then(onQuote, () => {});
  return postText("/api/prompt/improve", draft, signal);
}

/** deps: getText() current draft, apply(text) writes it back (and saves it). */
export function createPromptImprove(deps) {
  const dlg = byId("prompt-improve");
  const area = byId("pi-text");
  const quotes = { before: null, after: null };
  let seq = 0;
  let controller = null;

  async function start() {
    const mine = ++seq;
    controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CLIENT_TIMEOUT_MS);
    const onQuote = (quote) => {
      if (mine !== seq || quotes.before) return;
      quotes.before = quote;
      drawQuotes(quotes);
    };
    try {
      const result = await runImprove(deps.getText(), controller.signal, onQuote);
      if (mine !== seq) return;
      Object.assign(quotes, {
        before: result.quoteOld,
        after: result.quoteNew,
        hints: result.hints,
      });
      area.value = result.improved;
      showPhase("result");
      drawQuotes(quotes);
      drawHighlights(area);
      area.focus({ preventScroll: true });
    } catch (error) {
      if (mine !== seq) return;
      showPhase("failed");
      showError(timedOut ? "Timed out after 50 s. Your draft is unchanged." : error.message);
    } finally {
      clearTimeout(timer);
    }
  }

  function open() {
    const draft = deps.getText();
    if (!draft.trim() || dlg.open) return;
    Object.assign(quotes, { before: null, after: null, hints: [] });
    byId("pi-old").textContent = draft;
    showError("");
    showPhase("wait");
    drawQuotes(quotes);
    dlg.showModal();
    start();
  }

  async function check() {
    const mine = ++seq;
    const button = byId("pi-check");
    button.disabled = true;
    quotes.after = null;
    drawQuotes(quotes);
    showError("");
    controller = new AbortController();
    try {
      quotes.after = await postText("/api/prompt/quote", area.value, controller.signal);
    } catch (error) {
      if (mine !== seq) return;
      quotes.after = { status: "unavailable", reason: error.message };
      showError(error.message);
    }
    if (mine !== seq) return;
    button.disabled = false;
    drawQuotes(quotes);
    drawHighlights(area);
  }

  function use() {
    const unfilled = findPlaceholders(area.value).length;
    const noun = unfilled === 1 ? "placeholder" : "placeholders";
    if (unfilled && !confirm(`${unfilled} ${noun} not filled. Use anyway?`)) return;
    deps.apply(area.value);
    dlg.close();
  }

  dlg.addEventListener("close", () => {
    seq++;
    controller?.abort();
    controller = null;
    byId("pi-check").disabled = false;
  });
  area.addEventListener("input", () => drawHighlights(area));
  byId("pi-cancel").onclick = () => dlg.close();
  byId("pi-check").onclick = check;
  byId("pi-use").onclick = use;
  return { open };
}
