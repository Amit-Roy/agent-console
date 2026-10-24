// Search the rendered transcript without rewriting message nodes or disturbing copy/code handlers.
const SKIP_SELECTOR = "button,svg,.actions,.sr-only,.code-head,script,style,[hidden]";
const BLOCK_SELECTOR = "p,pre,li,td,th,h1,h2,h3,h4,h5,h6,summary,.bubble,.think-body";

function lookup(suffix) {
  return document.getElementById(`chat-search${suffix ? `-${suffix}` : ""}`);
}

function paintHighlights(ctx) {
  const all = new Highlight();
  for (const range of ctx.ranges) all.add(range);
  CSS.highlights.set("chat-search", all);
  CSS.highlights.set(
    "chat-search-active",
    new Highlight(...(ctx.ranges[ctx.index] ? [ctx.ranges[ctx.index]] : [])),
  );
}

function clearActiveMarks(ctx) {
  ctx.chat.querySelectorAll(".search-active").forEach((node) => {
    node.classList.remove("search-active");
  });
}

function countLabel(ctx) {
  const { ranges, index, query } = ctx;
  if (!query) return "Type to search";
  const loading = query && (ctx.history().older || ctx.history().busy);
  const position = ranges.length
    ? `${index + 1} of ${ranges.length}`
    : loading
      ? "Searching…"
      : "No matches";
  return `${position}${loading && ranges.length ? " · Searching…" : ""}`;
}

function paint(ctx) {
  if (ctx.supported) paintHighlights(ctx);
  clearActiveMarks(ctx);
  if (!ctx.supported)
    ctx.ranges[ctx.index]?.startContainer.parentElement
      ?.closest(".msg")
      ?.classList.add("search-active");
  ctx.count.textContent = countLabel(ctx);
  lookup("next").disabled = lookup("prev").disabled = !ctx.ranges.length;
}

function expandDetails(node, chat) {
  for (let parent = node; parent && parent !== chat; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
}

function expandToolOutput(node) {
  const output = node.closest(".tool-out");
  if (!output) return;
  output.classList.add("expanded");
  const more = output.querySelector(".more");
  if (more) {
    more.setAttribute("aria-expanded", "true");
    more.textContent = "Show less";
  }
}

function centerRange(ctx, range, ticket) {
  if (ticket !== ctx.generation || ctx.bar.hidden || !range.startContainer.isConnected) return;
  const rect = range.getBoundingClientRect(),
    box = ctx.chat.getBoundingClientRect();
  if (rect.height) ctx.chat.scrollTop += rect.top + rect.height / 2 - box.top - box.height / 2;
}

function reveal(ctx) {
  const range = ctx.ranges[ctx.index];
  if (!range) return;
  ctx.navigate();
  const node = range.startContainer.parentElement;
  expandDetails(node, ctx.chat);
  expandToolOutput(node);
  const ticket = ctx.generation;
  node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  requestAnimationFrame(() => centerRange(ctx, range, ticket));
}

function collectTextParts(message) {
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
  const parts = [];
  let text = "",
    lastBlock,
    node;
  while ((node = walker.nextNode())) {
    if (!node.data || node.parentElement.closest(SKIP_SELECTOR)) continue;
    const block = node.parentElement.closest(BLOCK_SELECTOR) || message;
    if (lastBlock && block !== lastBlock) text += "\n";
    parts.push({ node, start: text.length, end: text.length + node.length });
    text += node.data;
    lastBlock = block;
  }
  return { text, parts };
}

function appendMatchRanges(target, text, parts, pattern) {
  let firstIndex = 0,
    lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index,
      end = start + match[0].length;
    while (firstIndex < parts.length && parts[firstIndex].end <= start) firstIndex++;
    while (lastIndex < parts.length && parts[lastIndex].end < end) lastIndex++;
    const first = parts[firstIndex],
      last = parts[lastIndex];
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    target.push(range);
  }
}

function collectRanges(ctx) {
  ctx.prepare();
  const pattern = new RegExp(ctx.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const message of ctx.chat.querySelectorAll(":scope > .msg")) {
    const { text, parts } = collectTextParts(message);
    appendMatchRanges(ctx.ranges, text, parts, pattern);
  }
}

function nextIndex(ctx, previous, previousIndex) {
  const { ranges } = ctx;
  const preserved =
    previous &&
    ranges.findIndex(
      (range) =>
        range.startContainer === previous.startContainer &&
        range.startOffset === previous.startOffset,
    );
  if (!ranges.length) return -1;
  return preserved >= 0 ? preserved : Math.max(0, Math.min(previousIndex, ranges.length - 1));
}

function scan(ctx) {
  clearTimeout(ctx.timer);
  ctx.timer = 0;
  if (ctx.bar.hidden) return;
  if (!ctx.current()) return close(ctx, false);
  if (ctx.history().busy) return; // The history completion hooks resume the search.
  const previous = ctx.ranges[ctx.index],
    previousIndex = ctx.index;
  ctx.ranges = [];
  if (ctx.query) collectRanges(ctx);
  ctx.index = nextIndex(ctx, previous, previousIndex);
  paint(ctx);
  if (ctx.jump && ctx.ranges.length) {
    ctx.jump = false;
    reveal(ctx);
  }
  // Older history is fetched only while a nonempty search is open, one existing page at a time.
  if (ctx.query && ctx.history().older) ctx.loadEarlier();
}

function refresh(ctx) {
  if (ctx.bar.hidden || ctx.timer) return;
  ctx.timer = setTimeout(() => scan(ctx), 120);
}

function open(ctx) {
  if (!ctx.current()) return;
  if (ctx.bar.hidden) {
    ctx.bar.hidden = false;
    ctx.toggle.setAttribute("aria-expanded", "true");
    ctx.observer.observe(ctx.chat, { childList: true, subtree: true, characterData: true });
    refresh(ctx);
  }
  ctx.input.focus({ preventScroll: true });
  ctx.input.select();
}

function close(ctx, focus = true) {
  ctx.generation++;
  clearTimeout(ctx.timer);
  ctx.timer = 0;
  ctx.observer.disconnect();
  ctx.bar.hidden = true;
  ctx.toggle.setAttribute("aria-expanded", "false");
  ctx.input.value = ctx.query = "";
  ctx.ranges = [];
  ctx.index = -1;
  ctx.jump = false;
  if (ctx.supported) {
    CSS.highlights.delete("chat-search");
    CSS.highlights.delete("chat-search-active");
  }
  clearActiveMarks(ctx);
  if (focus) ctx.toggle.focus({ preventScroll: true });
}

function move(ctx, delta) {
  if (!ctx.ranges.length) return;
  ctx.index = (ctx.index + delta + ctx.ranges.length) % ctx.ranges.length;
  paint(ctx);
  reveal(ctx);
}

function handleInput(ctx) {
  ctx.generation++;
  ctx.query = ctx.input.value;
  ctx.ranges = [];
  ctx.index = -1;
  ctx.jump = true;
  paint(ctx);
  refresh(ctx);
}

function handleInputKey(ctx, event) {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    move(ctx, event.shiftKey ? -1 : 1);
  }
}

function isFindShortcut(ctx, event) {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "f" &&
    ctx.current()
  );
}

function handleDocumentKey(ctx, event) {
  if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
  if (isFindShortcut(ctx, event)) {
    event.preventDefault();
    open(ctx);
  } else if (event.key === "Escape" && !ctx.bar.hidden) {
    event.preventDefault();
    close(ctx);
  }
}

export function createChatSearch({ current, history, loadEarlier, prepare, navigate }) {
  const ctx = {
    current,
    history,
    loadEarlier,
    prepare,
    navigate,
    bar: lookup(""),
    input: lookup("input"),
    count: lookup("count"),
    toggle: lookup("toggle"),
    chat: document.getElementById("chat"),
    ranges: [],
    index: -1,
    query: "",
    timer: undefined,
    jump: false,
    generation: 0,
    supported: !!(globalThis.CSS?.highlights && globalThis.Highlight),
    observer: null,
  };
  ctx.observer = new MutationObserver(() => refresh(ctx));
  ctx.input.addEventListener("input", () => handleInput(ctx));
  ctx.input.addEventListener("keydown", (event) => handleInputKey(ctx, event));
  ctx.toggle.onclick = () => (ctx.bar.hidden ? open(ctx) : close(ctx));
  lookup("close").onclick = () => close(ctx);
  lookup("next").onclick = () => move(ctx, 1);
  lookup("prev").onclick = () => move(ctx, -1);
  document.addEventListener("keydown", (event) => handleDocumentKey(ctx, event));
  return {
    open: () => open(ctx),
    close: (focus) => close(ctx, focus),
    refresh: () => refresh(ctx),
    isOpen: () => !ctx.bar.hidden,
  };
}
