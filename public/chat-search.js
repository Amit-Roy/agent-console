// Search the rendered transcript without rewriting message nodes or disturbing copy/code handlers.
export function createChatSearch({ current, history, loadEarlier, prepare, navigate }) {
  const get = id => document.getElementById(`chat-search${id ? `-${id}` : ""}`);
  const bar = get(""), input = get("input"), count = get("count"), toggle = get("toggle");
  const chat = document.getElementById("chat");
  let ranges = [], index = -1, query = "", timer, jump = false, generation = 0;
  const supported = !!(globalThis.CSS?.highlights && globalThis.Highlight);
  const skip = "button,svg,.actions,.sr-only,.code-head,script,style,[hidden]";
  const blocks = "p,pre,li,td,th,h1,h2,h3,h4,h5,h6,summary,.bubble,.think-body";

  function paint() {
    if (supported) {
      const all = new Highlight();
      for (const range of ranges) all.add(range);
      CSS.highlights.set("chat-search", all);
      CSS.highlights.set("chat-search-active", new Highlight(...(ranges[index] ? [ranges[index]] : [])));
    }
    chat.querySelectorAll(".search-active").forEach(node => node.classList.remove("search-active"));
    if (!supported) ranges[index]?.startContainer.parentElement?.closest(".msg")?.classList.add("search-active");
    const loading = query && (history().older || history().busy);
    count.textContent = !query ? "Type to search" : `${ranges.length ? `${index + 1} of ${ranges.length}` : loading ? "Searching…" : "No matches"}${loading && ranges.length ? " · Searching…" : ""}`;
    get("next").disabled = get("prev").disabled = !ranges.length;
  }

  function reveal() {
    const range = ranges[index];
    if (!range) return;
    navigate();
    const node = range.startContainer.parentElement;
    for (let parent = node; parent && parent !== chat; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    const output = node.closest(".tool-out");
    if (output) {
      output.classList.add("expanded");
      const more = output.querySelector(".more");
      if (more) { more.setAttribute("aria-expanded", "true"); more.textContent = "Show less"; }
    }
    const ticket = generation;
    node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    requestAnimationFrame(() => {
      if (ticket !== generation || bar.hidden || !range.startContainer.isConnected) return;
      const rect = range.getBoundingClientRect(), box = chat.getBoundingClientRect();
      if (rect.height) chat.scrollTop += rect.top + rect.height / 2 - box.top - box.height / 2;
    });
  }

  function scan() {
    clearTimeout(timer);
    timer = 0;
    if (bar.hidden) return;
    if (!current()) return close(false);
    if (history().busy) return; // The history completion hooks resume the search.
    const previous = ranges[index], previousIndex = index;
    ranges = [];
    if (query) {
      prepare();
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const message of chat.querySelectorAll(":scope > .msg")) {
        const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
        const parts = [];
        let text = "", lastBlock, node;
        while ((node = walker.nextNode())) {
          if (!node.data || node.parentElement.closest(skip)) continue;
          const block = node.parentElement.closest(blocks) || message;
          if (lastBlock && block !== lastBlock) text += "\n";
          parts.push({ node, start: text.length, end: text.length + node.length });
          text += node.data;
          lastBlock = block;
        }
        let firstIndex = 0, lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const start = match.index, end = start + match[0].length;
          while (firstIndex < parts.length && parts[firstIndex].end <= start) firstIndex++;
          while (lastIndex < parts.length && parts[lastIndex].end < end) lastIndex++;
          const first = parts[firstIndex], last = parts[lastIndex];
          if (!first || !last) continue;
          const range = document.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          ranges.push(range);
        }
      }
    }
    const preserved = previous && ranges.findIndex(range => range.startContainer === previous.startContainer && range.startOffset === previous.startOffset);
    index = ranges.length ? preserved >= 0 ? preserved : Math.max(0, Math.min(previousIndex, ranges.length - 1)) : -1;
    paint();
    if (jump && ranges.length) { jump = false; reveal(); }
    // Older history is fetched only while a nonempty search is open, one existing page at a time.
    if (query && history().older) loadEarlier();
  }

  function refresh() {
    if (bar.hidden || timer) return;
    timer = setTimeout(scan, 120);
  }
  const observer = new MutationObserver(refresh);

  function open() {
    if (!current()) return;
    if (bar.hidden) {
      bar.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      observer.observe(chat, { childList: true, subtree: true, characterData: true });
      refresh();
    }
    input.focus({ preventScroll: true });
    input.select();
  }
  function close(focus = true) {
    generation++;
    clearTimeout(timer);
    timer = 0;
    observer.disconnect();
    bar.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    input.value = query = "";
    ranges = []; index = -1; jump = false;
    if (supported) { CSS.highlights.delete("chat-search"); CSS.highlights.delete("chat-search-active"); }
    chat.querySelectorAll(".search-active").forEach(node => node.classList.remove("search-active"));
    if (focus) toggle.focus({ preventScroll: true });
  }
  function move(delta) {
    if (!ranges.length) return;
    index = (index + delta + ranges.length) % ranges.length;
    paint();
    reveal();
  }
  input.addEventListener("input", () => {
    generation++;
    query = input.value;
    ranges = []; index = -1; jump = true;
    paint();
    refresh();
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
  });
  toggle.onclick = () => bar.hidden ? open() : close();
  get("close").onclick = () => close();
  get("next").onclick = () => move(1);
  get("prev").onclick = () => move(-1);
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && current()) {
      event.preventDefault(); open();
    } else if (event.key === "Escape" && !bar.hidden) {
      event.preventDefault(); close();
    }
  });
  return { open, close, refresh, isOpen: () => !bar.hidden };
}
