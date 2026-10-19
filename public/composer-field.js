// The composer is a plaintext-only contenteditable, not a <textarea>: Chrome on Android (Gboard clipboard, keyboard
// stickers) only delivers pasted images to editable hosts, and answers "Chrome does not support image pasting here"
// for a textarea. This gives the element the textarea surface app.js uses: value, disabled, placeholder, selection.
// Typing and paste keep "\n" inside text nodes; programmatic inserts (and some IMEs) wrap lines in <div>s. Read both.
const BLOCK = new Set(["DIV", "P"]);
const text = (root, stop, stopOffset) => {
  let out = "", seen = false, done = false;
  const walk = (n) => {
    if (done) return;
    if (n === stop && n.nodeType === 1) {
      for (let i = 0; i < stopOffset && i < n.childNodes.length; i++) walk(n.childNodes[i]);
      done = true;
      return;
    }
    if (n.nodeType === 3) {
      seen = true;
      if (n === stop) { out += n.data.slice(0, stopOffset); done = true; } else out += n.data;
    } else if (n.nodeName === "BR") {
      if (n.parentNode.childNodes.length > 1) { out += "\n"; seen = true; }
    } else if (n.nodeType === 1) {
      if (BLOCK.has(n.nodeName)) { if (seen) out += "\n"; seen = true; }
      for (const c of n.childNodes) walk(c);
    }
  };
  walk(root);
  return out;
};

export function composerField(box) {
  const offset = (node, off) => (box.contains(node) ? text(box, node, off).length : null);
  const locate = (pos) => {
    let left = pos;
    const it = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (left <= n.data.length) return [n, left];
      left -= n.data.length;
    }
    return [box, box.childNodes.length];
  };
  Object.defineProperties(box, {
    value: {
      get: () => text(box),
      set(v) { box.textContent = v; },
    },
    disabled: {
      get: () => box.getAttribute("contenteditable") === "false",
      set(v) {
        box.setAttribute("contenteditable", v ? "false" : "plaintext-only");
        box.setAttribute("aria-disabled", String(!!v));
      },
    },
    placeholder: {
      get: () => box.dataset.placeholder ?? "",
      set(v) { box.dataset.placeholder = v; },
    },
    selectionStart: { get: () => { const s = getSelection(); return s.rangeCount ? offset(s.anchorNode, s.anchorOffset) : null; } },
    selectionEnd: { get: () => { const s = getSelection(); return s.rangeCount ? offset(s.focusNode, s.focusOffset) : null; } },
  });
  box.setSelectionRange = (a, b) => {
    const r = document.createRange();
    r.setStart(...locate(a));
    r.setEnd(...locate(b));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  };
  box.setAttribute("contenteditable", "plaintext-only");
  box.setAttribute("role", "combobox");
  return box;
}
