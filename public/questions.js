import { el, icon } from "/render.js";

// Question drafts belong to the request, so thread refreshes and socket reconnects cannot erase them.
// Secret answers stay in memory only and are never included in transcript summaries.
export function createQuestions({ send, root, changed }) {
  const entries = new Map(),
    pending = new Map();
  let connected = false,
    serial = 0;
  const key = (thread, id) => JSON.stringify([thread, id]);
  const storageKey = (thread, id) => `ac_question:${key(thread, id)}`;
  const values = (entry, q) => {
    const d = entry.drafts[q.id] || {};
    return [...(d.selected || []), ...(d.other && d.text?.trim() ? [d.text.trim()] : [])];
  };
  function save(entry) {
    try {
      const drafts = Object.fromEntries(
        entry.event.questions.filter((q) => !q.secret).map((q) => [q.id, entry.drafts[q.id] || {}]),
      );
      sessionStorage.setItem(
        storageKey(entry.thread, entry.event.id),
        JSON.stringify({ drafts, step: entry.step }),
      );
    } catch {}
  }
  function remember(thread, event) {
    const k = key(thread, event.id);
    let entry = entries.get(k);
    if (!entry) {
      let draft;
      try {
        draft = JSON.parse(sessionStorage.getItem(storageKey(thread, event.id)));
      } catch {}
      entry = {
        thread,
        event,
        drafts: Object.assign(Object.create(null), draft?.drafts || {}),
        step: draft?.step || 0,
        revision: 0,
        active: false,
      };
      entries.set(k, entry);
    }
    // A paged transcript may contain only the answer; retain richer question metadata if available.
    if (event.questions) entry.event = event;
    return entry;
  }
  function redraw(entry) {
    entry.revision++;
    refresh();
    changed?.();
  }
  function refresh(host = root()) {
    for (const card of host?.querySelectorAll(".question-card") || []) card.refresh?.();
  }
  function receive(thread, event, live = false) {
    const entry = remember(thread, event);
    if (event.type === "question" && live) {
      const ids = pending.get(thread) || new Set();
      ids.add(event.id);
      pending.set(thread, ids);
      entry.active = true;
      delete entry.answer;
    } else if (event.type === "question_answer") {
      entry.active = false;
      entry.busy = false;
      entry.answer = event;
      entry.error = "";
      pending.get(thread)?.delete(event.id);
      try {
        sessionStorage.removeItem(storageKey(thread, event.id));
      } catch {}
      entry.drafts = Object.create(null);
      entry.submitted = null;
    }
    entry.revision++;
    refresh();
    return entry;
  }
  function sync(thread, events = []) {
    const ids = new Set(events.map((e) => e.id));
    pending.set(thread, ids);
    for (const entry of entries.values())
      if (entry.thread === thread && entry.active && !ids.has(entry.event.id)) {
        entry.active = false;
        entry.busy = false;
        entry.revision++;
      }
    for (const event of events) {
      const entry = remember(thread, event);
      entry.active = true;
      entry.busy = false;
      delete entry.answer;
      entry.revision++;
    }
    refresh();
  }
  function setConnected(value) {
    connected = value;
    if (!value)
      for (const entry of entries.values())
        if (entry.active && entry.busy) {
          entry.busy = false;
          entry.error = "Connection lost. Your answer is saved here; send it after reconnecting.";
          entry.revision++;
        }
    for (const entry of entries.values()) if (entry.active) entry.revision++;
    refresh();
  }
  function reply(message) {
    const entry = entries.get(key(message.thread, message.id));
    if (!entry || (message.request != null && message.request !== entry.request)) return;
    entry.busy = false;
    if (message.t === "answer_error")
      entry.error = message.message || "Could not send your answer. Try again.";
    else {
      if (entry.answer) return; // The canonical transcript answer can arrive before its acknowledgment.
      const submitted = { ...entry.submitted };
      if (submitted.answers)
        submitted.answers = Object.fromEntries(
          Object.entries(submitted.answers).map(([id, values]) => [
            id,
            entry.event.questions?.find((q) => q.id === id)?.secret
              ? ["Answer sent privately"]
              : values,
          ]),
        );
      receive(message.thread, { type: "question_answer", id: message.id, ...submitted });
      return;
    }
    redraw(entry);
  }
  function submit(entry, skip = false) {
    if (entry.busy || !entry.active) return;
    const answers = Object.fromEntries(
      (entry.event.questions || []).map((q) => [q.id, values(entry, q)]),
    );
    entry.request = ++serial;
    entry.submitted = skip ? { skip: true } : { answers };
    if (
      !send({
        t: "answer",
        thread: entry.thread,
        id: entry.event.id,
        ...entry.submitted,
        request: entry.request,
      })
    ) {
      entry.error = "Reconnect to send your answer. Your choices are kept.";
    } else {
      entry.busy = true;
      entry.error = "";
    }
    redraw(entry);
  }
  function mount(thread, event) {
    const entry = remember(thread, event),
      card = el("section", "msg question-card");
    card.dataset.questionId = event.id;
    let version = -1;
    card.refresh = () => {
      if (version === entry.revision) return;
      version = entry.revision;
      render(card, entry);
    };
    card.refresh();
    return card;
  }
  function render(card, entry) {
    card.replaceChildren();
    card.classList.toggle("question-summary", !entry.active);
    card.setAttribute("aria-busy", String(!!entry.busy));
    const questions = entry.event.questions || [];
    if (!entry.active) {
      const answer = entry.answer;
      const title = answer?.cancelled
        ? "Question cancelled"
        : answer?.skip
          ? "Skipped"
          : answer
            ? "Answered"
            : "Question closed";
      const head = el("div", "question-summary-head");
      head.append(
        icon(answer && !answer.skip && !answer.cancelled ? "check" : "info"),
        el("span", "", title),
      );
      card.append(head);
      if (answer?.note) card.append(el("p", "question-answer-note", answer.note));
      if (answer?.answers && !answer.skip && !answer.cancelled) {
        const list = el("dl", "question-answers");
        const rows = questions.length
          ? questions
          : Object.keys(answer.answers).map((id) => ({ id, header: id }));
        for (const q of rows) {
          const raw = answer.answers[q.id];
          const text = q.secret
            ? "Answer sent privately"
            : Array.isArray(raw)
              ? raw.join(", ")
              : raw || "Skipped";
          list.append(el("dt", "", q.header || q.question || "Answer"), el("dd", "", text));
        }
        card.append(list);
      }
      return;
    }
    entry.step = Math.max(0, Math.min(entry.step, questions.length - 1));
    const q = questions[entry.step];
    if (!q) return;
    const draft = (entry.drafts[q.id] ||= { selected: [], other: !q.options?.length });
    draft.selected ||= [];
    const id = `question-${++serial}`;
    const head = el("div", "question-head");
    const status = el("span", "question-status", "Your input");
    head.append(status);
    if (questions.length > 1)
      head.append(
        el("span", "question-progress", `Question ${entry.step + 1} of ${questions.length}`),
      );
    card.append(head);
    const form = el("form", "question-form"),
      field = el("fieldset", "question-field");
    field.disabled = !!entry.busy;
    const legend = el("legend", "question-title", q.question);
    legend.id = `${id}-title`;
    card.setAttribute("aria-labelledby", legend.id);
    field.append(legend);
    const hint = el(
      "p",
      "question-hint",
      q.multiSelect
        ? "Choose any that apply."
        : q.options?.length
          ? "Choose one option."
          : "Write your answer below.",
    );
    hint.id = `${id}-hint`;
    field.setAttribute("aria-describedby", hint.id);
    field.append(hint);
    const choices = el("div", "question-choices");
    const otherControls = [];
    let next;
    const update = () => {
      const valid = values(entry, q).length > 0 && (!draft.other || !!draft.text?.trim());
      if (next) next.disabled = !valid || entry.busy || !connected;
      for (const [input, wrap] of otherControls) {
        input.checked = !!draft.other;
        wrap.hidden = !draft.other;
      }
      for (const input of choices.querySelectorAll("input[data-option]"))
        input.checked = draft.selected.includes(input.dataset.option);
      save(entry);
    };
    for (const option of q.options || []) {
      const label = el("label", "question-option"),
        input = el("input");
      input.type = q.multiSelect ? "checkbox" : "radio";
      input.name = id;
      input.value = option.label;
      input.dataset.option = option.label;
      input.checked = draft.selected.includes(option.label);
      const text = el("span", "question-option-text");
      text.append(el("span", "question-option-label", option.label));
      if (option.description)
        text.append(el("span", "question-option-description", option.description));
      input.onchange = () => {
        draft.selected = q.multiSelect
          ? input.checked
            ? [...draft.selected, option.label]
            : draft.selected.filter((v) => v !== option.label)
          : [option.label];
        if (!q.multiSelect) draft.other = false;
        update();
      };
      label.append(input, text);
      choices.append(label);
    }
    if (q.allowOther || !q.options?.length) {
      const wrap = el("div", "question-custom"),
        label = el("label", "question-custom-label", "Your answer");
      const input = el(q.secret ? "input" : "textarea", "question-text");
      input.id = `${id}-other`;
      label.htmlFor = input.id;
      if (q.secret) {
        input.type = "password";
        input.autocomplete = "off";
      } else {
        input.rows = 2;
        input.placeholder = "Tell the agent what you have in mind…";
      }
      input.value = draft.text || "";
      input.oninput = () => {
        draft.text = input.value;
        update();
      };
      wrap.append(label, input);
      if (q.options?.length) {
        const option = el("label", "question-option question-other"),
          toggle = el("input");
        toggle.type = q.multiSelect ? "checkbox" : "radio";
        toggle.name = id;
        toggle.checked = !!draft.other;
        toggle.onchange = () => {
          draft.other = toggle.checked;
          if (!q.multiSelect) draft.selected = [];
          update();
          if (toggle.checked) input.focus();
        };
        option.append(toggle, el("span", "question-option-label", "Something else"));
        choices.append(option);
        otherControls.push([toggle, wrap]);
      } else draft.other = true;
      wrap.hidden = !draft.other;
      choices.append(wrap);
    }
    field.append(choices);
    const error = el(
      "p",
      "question-error",
      entry.error || (!connected ? "Reconnecting… Your choices are kept." : ""),
    );
    error.hidden = !error.textContent;
    error.setAttribute("role", "status");
    form.append(field, error);
    const footer = el("div", "question-footer"),
      nav = el("div", "question-nav");
    const skip = el("button", "btn ghost question-skip", "Skip");
    skip.type = "button";
    skip.disabled = entry.busy || !connected;
    skip.title = "Skip this request and let the agent continue";
    skip.onclick = () => submit(entry, true);
    footer.append(skip);
    if (entry.step > 0) {
      const back = el("button", "btn ghost question-back", "Back");
      back.type = "button";
      back.disabled = !!entry.busy;
      back.onclick = () => {
        entry.step--;
        save(entry);
        redraw(entry);
        card.querySelector("legend")?.scrollIntoView({ block: "nearest" });
        card.querySelector("input,textarea")?.focus({ preventScroll: true });
      };
      nav.append(back);
    }
    next = el(
      "button",
      "btn primary question-next",
      entry.busy ? "Sending…" : entry.step < questions.length - 1 ? "Continue" : "Send answer",
    );
    next.type = "submit";
    nav.append(next);
    footer.append(nav);
    form.append(footer);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (next.disabled) return;
      if (entry.step < questions.length - 1) {
        entry.step++;
        save(entry);
        redraw(entry);
        card.querySelector("input,textarea")?.focus({ preventScroll: true });
      } else {
        const missing = questions.findIndex((item) => !values(entry, item).length);
        if (missing >= 0) {
          entry.step = missing;
          redraw(entry);
        } else submit(entry);
      }
    };
    card.append(form);
    update();
  }
  function ensure(thread, host = root()) {
    const ids = new Set(
      [...host.querySelectorAll(".question-card")].map((card) => card.dataset.questionId),
    );
    for (const id of pending.get(thread) || [])
      if (!ids.has(id)) {
        host.querySelector(":scope > .empty")?.remove();
        host.append(mount(thread, entries.get(key(thread, id)).event));
      }
    refresh(host);
  }
  return {
    mount,
    receive,
    sync,
    refresh,
    ensure,
    reply,
    setConnected,
    count: (thread) => pending.get(thread)?.size || 0,
  };
}
