import { el } from "./render.js";
import { toolName, toolSummary } from "./tool-display.js";

// A Claude tool-permission request, shown as a question card: three one-tap choices plus a "Deny with message" field.
// `submit(label, text)` answers with an option label, or with free text when `text` is set (a deny reason).

const CHOICES = [
  ["Allow once", "btn primary"],
  ["Allow for this thread", "btn"],
  ["Deny", "btn danger"],
];

function inputPreview(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? {}, null, 2);
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
}

function buildChoices(entry, submit) {
  const row = el("div", "permission-actions");
  for (const [label, classes] of CHOICES) {
    const button = el("button", `${classes} permission-choice`, label);
    button.type = "button";
    button.disabled = !!entry.busy;
    button.onclick = () => submit(label);
    row.append(button);
  }
  return row;
}

function buildDenyForm(entry, submit) {
  const form = el("form", "permission-deny");
  const text = el("input", "question-text permission-reason");
  text.type = "text";
  text.placeholder = "Deny with message";
  text.maxLength = 2000;
  text.setAttribute("aria-label", "Deny with message");
  const send = el("button", "btn permission-send", "Send");
  send.type = "submit";
  send.disabled = !!entry.busy;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (text.value.trim()) submit(undefined, text.value.trim());
  };
  form.append(text, send);
  return form;
}

export function renderPermission(ctx, card, entry, submit) {
  const { tool, input, blockedPath } = entry.event.permission;
  const head = el("div", "question-head");
  head.append(el("span", "question-status", "Permission needed"));
  card.append(head);
  card.append(el("div", "question-title", `Allow ${toolName(tool, input)}?`));
  const summary = toolSummary(tool, input);
  if (summary) card.append(el("p", "permission-summary", summary));
  if (blockedPath) card.append(el("p", "permission-summary", blockedPath));
  card.append(el("pre", "permission-input", inputPreview(input)));
  card.append(buildChoices(entry, submit), buildDenyForm(entry, submit));
  const error = el("p", "question-error", entry.error || (!ctx.connected ? "Reconnecting…" : ""));
  error.hidden = !error.textContent;
  error.setAttribute("role", "status");
  card.append(error);
}
