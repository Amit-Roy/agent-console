import { el, icon } from "/render.js";

// Question drafts belong to the request, so thread refreshes and socket reconnects cannot erase them.
// Secret answers stay in memory only and are never included in transcript summaries.

const CONNECTION_LOST_MESSAGE =
  "Connection lost. Your answer is saved here; send it after reconnecting.";

function entryKey(thread, questionId) {
  return JSON.stringify([thread, questionId]);
}

function storageKey(thread, questionId) {
  return `ac_question:${entryKey(thread, questionId)}`;
}

function answerValues(entry, question) {
  const draft = entry.drafts[question.id] || {};
  return [
    ...(draft.selected || []),
    ...(draft.other && draft.text?.trim() ? [draft.text.trim()] : []),
  ];
}

function saveEntry(entry) {
  try {
    const drafts = Object.fromEntries(
      entry.event.questions
        .filter((question) => !question.secret)
        .map((question) => [question.id, entry.drafts[question.id] || {}]),
    );
    sessionStorage.setItem(
      storageKey(entry.thread, entry.event.id),
      JSON.stringify({ drafts, step: entry.step }),
    );
  } catch {}
}

function loadDraft(thread, questionId) {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey(thread, questionId)));
  } catch {
    return undefined;
  }
}

function clearStoredDraft(thread, questionId) {
  try {
    sessionStorage.removeItem(storageKey(thread, questionId));
  } catch {}
}

function remember(ctx, thread, event) {
  const entryId = entryKey(thread, event.id);
  let entry = ctx.entries.get(entryId);
  if (!entry) {
    const draft = loadDraft(thread, event.id);
    entry = {
      thread,
      event,
      drafts: Object.assign(Object.create(null), draft?.drafts || {}),
      step: draft?.step || 0,
      revision: 0,
      active: false,
    };
    ctx.entries.set(entryId, entry);
  }
  // A paged transcript may contain only the answer; retain richer question metadata if available.
  if (event.questions) entry.event = event;
  return entry;
}

function refreshCards(ctx, host = ctx.root()) {
  for (const card of host?.querySelectorAll(".question-card") || []) card.refresh?.();
}

function redraw(ctx, entry) {
  entry.revision++;
  refreshCards(ctx);
  ctx.changed?.();
}

function activateLiveQuestion(ctx, thread, event, entry) {
  const ids = ctx.pending.get(thread) || new Set();
  ids.add(event.id);
  ctx.pending.set(thread, ids);
  entry.active = true;
  delete entry.answer;
}

function closeWithAnswer(ctx, thread, event, entry) {
  entry.active = false;
  entry.busy = false;
  entry.answer = event;
  entry.error = "";
  ctx.pending.get(thread)?.delete(event.id);
  clearStoredDraft(thread, event.id);
  entry.drafts = Object.create(null);
  entry.submitted = null;
}

function receive(ctx, thread, event, live = false) {
  const entry = remember(ctx, thread, event);
  if (event.type === "question" && live) activateLiveQuestion(ctx, thread, event, entry);
  else if (event.type === "question_answer") closeWithAnswer(ctx, thread, event, entry);
  entry.revision++;
  refreshCards(ctx);
  return entry;
}

function dropStaleEntries(ctx, thread, ids) {
  for (const entry of ctx.entries.values())
    if (entry.thread === thread && entry.active && !ids.has(entry.event.id)) {
      entry.active = false;
      entry.busy = false;
      entry.revision++;
    }
}

function sync(ctx, thread, events = []) {
  const ids = new Set(events.map((event) => event.id));
  ctx.pending.set(thread, ids);
  dropStaleEntries(ctx, thread, ids);
  for (const event of events) {
    const entry = remember(ctx, thread, event);
    entry.active = true;
    entry.busy = false;
    delete entry.answer;
    entry.revision++;
  }
  refreshCards(ctx);
}

function failBusyEntries(ctx) {
  for (const entry of ctx.entries.values())
    if (entry.active && entry.busy) {
      entry.busy = false;
      entry.error = CONNECTION_LOST_MESSAGE;
      entry.revision++;
    }
}

function setConnected(ctx, value) {
  ctx.connected = value;
  if (!value) failBusyEntries(ctx);
  for (const entry of ctx.entries.values()) if (entry.active) entry.revision++;
  refreshCards(ctx);
}

function maskSecretAnswers(entry, answers) {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answerList]) => [
      questionId,
      entry.event.questions?.find((question) => question.id === questionId)?.secret
        ? ["Answer sent privately"]
        : answerList,
    ]),
  );
}

function acknowledgeAnswer(ctx, message, entry) {
  if (entry.answer) return; // The canonical transcript answer can arrive before its acknowledgment.
  const submitted = { ...entry.submitted };
  if (submitted.answers) submitted.answers = maskSecretAnswers(entry, submitted.answers);
  receive(ctx, message.thread, { type: "question_answer", id: message.id, ...submitted });
}

function reply(ctx, message) {
  const entry = ctx.entries.get(entryKey(message.thread, message.id));
  if (!entry || (message.request != null && message.request !== entry.request)) return;
  entry.busy = false;
  if (message.t !== "answer_error") {
    acknowledgeAnswer(ctx, message, entry);
    return;
  }
  entry.error = message.message || "Could not send your answer. Try again.";
  redraw(ctx, entry);
}

function submit(ctx, entry, skip = false) {
  if (entry.busy || !entry.active) return;
  const answers = Object.fromEntries(
    (entry.event.questions || []).map((question) => [question.id, answerValues(entry, question)]),
  );
  entry.request = ++ctx.serial;
  entry.submitted = skip ? { skip: true } : { answers };
  const sent = ctx.send({
    t: "answer",
    thread: entry.thread,
    id: entry.event.id,
    ...entry.submitted,
    request: entry.request,
  });
  if (sent) {
    entry.busy = true;
    entry.error = "";
  } else entry.error = "Reconnect to send your answer. Your choices are kept.";
  redraw(ctx, entry);
}

function summaryTitle(answer) {
  if (answer?.cancelled) return "Question cancelled";
  if (answer?.skip) return "Skipped";
  return answer ? "Answered" : "Question closed";
}

function summaryAnswerText(question, raw) {
  if (question.secret) return "Answer sent privately";
  return Array.isArray(raw) ? raw.join(", ") : raw || "Skipped";
}

function buildAnswerList(questions, answer) {
  const list = el("dl", "question-answers");
  const rows = questions.length
    ? questions
    : Object.keys(answer.answers).map((rowId) => ({ id: rowId, header: rowId }));
  for (const question of rows) {
    const text = summaryAnswerText(question, answer.answers[question.id]);
    list.append(el("dt", "", question.header || question.question || "Answer"), el("dd", "", text));
  }
  return list;
}

function renderSummary(card, entry, questions) {
  const answer = entry.answer;
  const head = el("div", "question-summary-head");
  head.append(
    icon(answer && !answer.skip && !answer.cancelled ? "check" : "info"),
    el("span", "", summaryTitle(answer)),
  );
  card.append(head);
  if (answer?.note) card.append(el("p", "question-answer-note", answer.note));
  if (answer?.answers && !answer.skip && !answer.cancelled)
    card.append(buildAnswerList(questions, answer));
}

function buildHead(entry, questions) {
  const head = el("div", "question-head");
  head.append(el("span", "question-status", "Your input"));
  if (questions.length > 1)
    head.append(
      el("span", "question-progress", `Question ${entry.step + 1} of ${questions.length}`),
    );
  return head;
}

function hintText(question) {
  if (question.multiSelect) return "Choose any that apply.";
  return question.options?.length ? "Choose one option." : "Write your answer below.";
}

function updateForm(view) {
  const { entry, question, draft, choices } = view;
  const valid = answerValues(entry, question).length > 0 && (!draft.other || !!draft.text?.trim());
  if (view.next) view.next.disabled = !valid || entry.busy || !view.ctx.connected;
  for (const [input, wrap] of view.otherControls) {
    input.checked = !!draft.other;
    wrap.hidden = !draft.other;
  }
  for (const input of choices.querySelectorAll("input[data-option]"))
    input.checked = draft.selected.includes(input.dataset.option);
  saveEntry(entry);
}

function choiceSelection(view, input, option) {
  const { question, draft } = view;
  if (!question.multiSelect) return [option.label];
  return input.checked
    ? [...draft.selected, option.label]
    : draft.selected.filter((selected) => selected !== option.label);
}

function buildOption(view, option) {
  const { question, draft } = view;
  const label = el("label", "question-option"),
    input = el("input");
  input.type = question.multiSelect ? "checkbox" : "radio";
  input.name = view.fieldId;
  input.value = option.label;
  input.dataset.option = option.label;
  input.checked = draft.selected.includes(option.label);
  const text = el("span", "question-option-text");
  text.append(el("span", "question-option-label", option.label));
  if (option.description)
    text.append(el("span", "question-option-description", option.description));
  input.onchange = () => {
    draft.selected = choiceSelection(view, input, option);
    if (!question.multiSelect) draft.other = false;
    updateForm(view);
  };
  label.append(input, text);
  return label;
}

function buildCustomInput(view) {
  const { question, draft } = view;
  const input = el(question.secret ? "input" : "textarea", "question-text");
  input.id = `${view.fieldId}-other`;
  if (question.secret) {
    input.type = "password";
    input.autocomplete = "off";
  } else {
    input.rows = 2;
    input.placeholder = "Tell the agent what you have in mind…";
  }
  input.value = draft.text || "";
  input.oninput = () => {
    draft.text = input.value;
    updateForm(view);
  };
  return input;
}

function buildOtherToggle(view, input, wrap) {
  const { question, draft } = view;
  const option = el("label", "question-option question-other"),
    toggle = el("input");
  toggle.type = question.multiSelect ? "checkbox" : "radio";
  toggle.name = view.fieldId;
  toggle.checked = !!draft.other;
  toggle.onchange = () => {
    draft.other = toggle.checked;
    if (!question.multiSelect) draft.selected = [];
    updateForm(view);
    if (toggle.checked) input.focus();
  };
  option.append(toggle, el("span", "question-option-label", "Something else"));
  view.choices.append(option);
  view.otherControls.push([toggle, wrap]);
}

function appendCustomAnswer(view) {
  const { question, draft } = view;
  const wrap = el("div", "question-custom"),
    label = el("label", "question-custom-label", "Your answer");
  const input = buildCustomInput(view);
  label.htmlFor = input.id;
  wrap.append(label, input);
  if (question.options?.length) buildOtherToggle(view, input, wrap);
  else draft.other = true;
  wrap.hidden = !draft.other;
  view.choices.append(wrap);
}

function buildChoices(view) {
  const { question } = view;
  for (const option of question.options || []) view.choices.append(buildOption(view, option));
  if (question.allowOther || !question.options?.length) appendCustomAnswer(view);
  return view.choices;
}

function buildField(view) {
  const { card, entry, question, fieldId } = view;
  const field = el("fieldset", "question-field");
  field.disabled = !!entry.busy;
  const legend = el("legend", "question-title", question.question);
  legend.id = `${fieldId}-title`;
  card.setAttribute("aria-labelledby", legend.id);
  field.append(legend);
  const hint = el("p", "question-hint", hintText(question));
  hint.id = `${fieldId}-hint`;
  field.setAttribute("aria-describedby", hint.id);
  field.append(hint);
  field.append(buildChoices(view));
  return field;
}

function buildError(view) {
  const error = el(
    "p",
    "question-error",
    view.entry.error || (!view.ctx.connected ? "Reconnecting… Your choices are kept." : ""),
  );
  error.hidden = !error.textContent;
  error.setAttribute("role", "status");
  return error;
}

function buildSkipButton(view) {
  const skip = el("button", "btn ghost question-skip", "Skip");
  skip.type = "button";
  skip.disabled = view.entry.busy || !view.ctx.connected;
  skip.title = "Skip this request and let the agent continue";
  skip.onclick = () => submit(view.ctx, view.entry, true);
  return skip;
}

function buildBackButton(view) {
  const { ctx, card, entry } = view;
  const back = el("button", "btn ghost question-back", "Back");
  back.type = "button";
  back.disabled = !!entry.busy;
  back.onclick = () => {
    entry.step--;
    saveEntry(entry);
    redraw(ctx, entry);
    card.querySelector("legend")?.scrollIntoView({ block: "nearest" });
    card.querySelector("input,textarea")?.focus({ preventScroll: true });
  };
  return back;
}

function nextLabel(view) {
  if (view.entry.busy) return "Sending…";
  return view.entry.step < view.questions.length - 1 ? "Continue" : "Send answer";
}

function buildFooter(view) {
  const footer = el("div", "question-footer"),
    nav = el("div", "question-nav");
  footer.append(buildSkipButton(view));
  if (view.entry.step > 0) nav.append(buildBackButton(view));
  view.next = el("button", "btn primary question-next", nextLabel(view));
  view.next.type = "submit";
  nav.append(view.next);
  footer.append(nav);
  return footer;
}

function finishQuestions(view) {
  const { ctx, entry, questions } = view;
  const missing = questions.findIndex((item) => !answerValues(entry, item).length);
  if (missing >= 0) {
    entry.step = missing;
    redraw(ctx, entry);
  } else submit(ctx, entry);
}

function handleFormSubmit(view, event) {
  const { ctx, card, entry, questions } = view;
  event.preventDefault();
  if (view.next.disabled) return;
  if (entry.step < questions.length - 1) {
    entry.step++;
    saveEntry(entry);
    redraw(ctx, entry);
    card.querySelector("input,textarea")?.focus({ preventScroll: true });
  } else finishQuestions(view);
}

function renderForm(ctx, card, entry, questions, question) {
  const draft = (entry.drafts[question.id] ||= {
    selected: [],
    other: !question.options?.length,
  });
  draft.selected ||= [];
  const view = {
    ctx,
    card,
    entry,
    questions,
    question,
    draft,
    fieldId: `question-${++ctx.serial}`,
    choices: el("div", "question-choices"),
    otherControls: [],
    next: null,
  };
  card.append(buildHead(entry, questions));
  const form = el("form", "question-form");
  form.append(buildField(view), buildError(view));
  form.append(buildFooter(view));
  form.onsubmit = (event) => handleFormSubmit(view, event);
  card.append(form);
  updateForm(view);
}

function render(ctx, card, entry) {
  card.replaceChildren();
  card.classList.toggle("question-summary", !entry.active);
  card.setAttribute("aria-busy", String(!!entry.busy));
  const questions = entry.event.questions || [];
  if (!entry.active) {
    renderSummary(card, entry, questions);
    return;
  }
  entry.step = Math.max(0, Math.min(entry.step, questions.length - 1));
  const question = questions[entry.step];
  if (question) renderForm(ctx, card, entry, questions, question);
}

function mount(ctx, thread, event) {
  const entry = remember(ctx, thread, event),
    card = el("section", "msg question-card");
  card.dataset.questionId = event.id;
  let version = -1;
  card.refresh = () => {
    if (version === entry.revision) return;
    version = entry.revision;
    render(ctx, card, entry);
  };
  card.refresh();
  return card;
}

function ensure(ctx, thread, host = ctx.root()) {
  const ids = new Set(
    [...host.querySelectorAll(".question-card")].map((card) => card.dataset.questionId),
  );
  for (const questionId of ctx.pending.get(thread) || [])
    if (!ids.has(questionId)) {
      host.querySelector(":scope > .empty")?.remove();
      host.append(mount(ctx, thread, ctx.entries.get(entryKey(thread, questionId)).event));
    }
  refreshCards(ctx, host);
}

export function find(host, id) {
  return host?.querySelector(`.question-card[data-question-id="${CSS.escape(id)}"]`) || null;
}

export function createQuestions({ send, root, changed }) {
  const ctx = {
    entries: new Map(),
    pending: new Map(),
    connected: false,
    serial: 0,
    send,
    root,
    changed,
  };
  return {
    mount: (thread, event) => mount(ctx, thread, event),
    receive: (thread, event, live) => receive(ctx, thread, event, live),
    sync: (thread, events) => sync(ctx, thread, events),
    refresh: (host) => refreshCards(ctx, host),
    ensure: (thread, host) => ensure(ctx, thread, host),
    reply: (message) => reply(ctx, message),
    setConnected: (value) => setConnected(ctx, value),
    count: (thread) => ctx.pending.get(thread)?.size || 0,
  };
}
