// Rendering helpers shared by the app (and importable on their own): DOM helpers, icons, copy-to-clipboard,
// markdown -> sanitised HTML -> enhanced DOM (code block headers, table wrappers). DOMPurify sanitises ALL markdown output;
// highlight.js only ever produces escaped <span class="hljs-*"> markup and the sanitiser runs over it anyway.
import { Marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
import hljs from "/vendor/hljs/core.js";
import bash from "/vendor/hljs/languages/bash.js";
import javascript from "/vendor/hljs/languages/javascript.js";
import typescript from "/vendor/hljs/languages/typescript.js";
import json from "/vendor/hljs/languages/json.js";
import python from "/vendor/hljs/languages/python.js";
import css from "/vendor/hljs/languages/css.js";
import xml from "/vendor/hljs/languages/xml.js";
import markdown from "/vendor/hljs/languages/markdown.js";
import diff from "/vendor/hljs/languages/diff.js";
import yaml from "/vendor/hljs/languages/yaml.js";
import sql from "/vendor/hljs/languages/sql.js";
import go from "/vendor/hljs/languages/go.js";
import rust from "/vendor/hljs/languages/rust.js";

for (const [n, l] of Object.entries({ bash, javascript, typescript, json, python, css, xml, markdown, diff, yaml, sql, go, rust })) hljs.registerLanguage(n, l);

DOMPurify.addHook("afterSanitizeAttributes", (n) => {
  if (n.tagName === "A") {
    if (n.hasAttribute("data-file-ref")) n.removeAttribute("target");
    else n.setAttribute("target", "_blank");
    n.setAttribute("rel", "noopener noreferrer");
  }
});

// ---------- DOM helpers ----------
export const $ = (id) => document.getElementById(id);
export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const SVG = "http://www.w3.org/2000/svg";
/** 16px stroke icon from the sprite in index.html. */
export function icon(name, cls = "") {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", cls ? `ico ${cls}` : "ico");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVG, "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}
/** Icon-only button: aria-label + title carry the tooltip. */
export function iconButton(name, label, cls = "btn icon sm ghost") {
  const b = el("button", cls);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name));
  return b;
}

// ---------- clipboard ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}
/** Copy `getText()` and show a "Copied" state on `btn` for 1.5 s (button keeps its label for icon-only ones via title/aria-label). */
export function wireCopy(btn, getText, label = "Copy") {
  const lab = btn.querySelector(".lab");
  let t = 0;
  btn.addEventListener("click", async () => {
    const ok = await copyText(getText());
    const done = ok ? "Copied" : "Copy failed";
    clearTimeout(t);
    btn.replaceChildren(icon(ok ? "check" : "alert"));
    if (lab) btn.append(el("span", "lab", done));
    btn.setAttribute("aria-label", done);
    btn.title = done;
    btn.dataset.copied = ok ? "1" : "0";
    const live = $("announce");
    if (live) live.textContent = done;
    t = setTimeout(() => {
      btn.replaceChildren(icon("copy"));
      if (lab) btn.append(el("span", "lab", label));
      btn.setAttribute("aria-label", label);
      btn.title = label;
      delete btn.dataset.copied;
      if (live) live.textContent = "";
    }, 1500);
  });
}

// ---------- highlighting ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A local file reference, never an HTTP URL, app route, or executable scheme. Paths stay relative until the server resolves them. */
export function parseFileRef(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let ref = value.trim();
  if (!ref || ref.startsWith("#") || ref.startsWith("//")) return null;
  let line = null, endLine = null, column = null;
  const hash = ref.indexOf("#");
  if (hash !== -1) {
    const range = /^#L(\d+)(?:-L?(\d+))?$/i.exec(ref.slice(hash));
    if (range) { line = Number(range[1]); endLine = Number(range[2] || range[1]); }
    ref = ref.slice(0, hash);
  }
  if (/^file:/i.test(ref)) {
    try {
      const url = new URL(ref);
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search) return null;
      ref = url.pathname;
    } catch { return null; }
  }
  try { ref = decodeURIComponent(ref); } catch { return null; }
  const position = /:(\d+)(?::(\d+))?$/.exec(ref);
  if (position) {
    if (line == null) { line = Number(position[1]); endLine = line; column = position[2] ? Number(position[2]) : null; }
    ref = ref.slice(0, position.index);
  }
  if (!ref || /[\u0000-\u001f\u007f\\?]/.test(ref) || /^[a-z][\w+.-]*:/i.test(ref) || ref.startsWith("//")) return null;
  if (/^\/(?:api|uploads|export|vendor|fonts)(?:\/|$)/.test(ref) || /^\/(?:dashboard|login|restart|manifest\.webmanifest|sw\.js|icon\.svg)\/?$/.test(ref)) return null;
  // Bare names with no extension are ambiguous; common repository documents remain useful file links.
  if (!ref.includes("/") && !/\.[\w-]+$/.test(ref) && !/^(?:README|LICENSE|LICENCE|COPYING|NOTICE|Dockerfile|Makefile|AGENTS|CLAUDE)$/i.test(ref)) return null;
  for (const n of [line, endLine, column]) if (n != null && (!Number.isSafeInteger(n) || n < 1)) return null;
  if (endLine != null && endLine < line) return null;
  return { path: ref, line, endLine, column };
}
const cache = new Map();
/** Highlighted HTML for `text` (escaped plain text when the language is unknown). Cached: streaming re-renders the same blocks. */
export function highlight(text, lang) {
  const key = `${lang}\0${text}`;
  let html = cache.get(key);
  if (html != null) return html;
  try {
    if (lang && hljs.getLanguage(lang)) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {}
  html ??= esc(text);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}
const LABELS = { xml: "HTML", html: "HTML", js: "JavaScript", javascript: "JavaScript", jsx: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript",
  py: "Python", python: "Python", sh: "Shell", bash: "Bash", zsh: "Shell", shell: "Shell", json: "JSON", css: "CSS", md: "Markdown", markdown: "Markdown",
  yml: "YAML", yaml: "YAML", sql: "SQL", go: "Go", rust: "Rust", rs: "Rust", diff: "Diff", patch: "Diff" };
export const langLabel = (l) => (l ? LABELS[l] || l : "Text");

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    link({ href, title, tokens }) {
      if (!parseFileRef(href)) return false;
      // DOMPurify deliberately blocks file://. Carry a validated reference as data, with an inert keyboard-accessible link.
      return `<a href="#" data-file-ref="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
    },
    code({ text, lang }) {
      const l = (lang || "").trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9+#_-]/g, "");
      return `<pre><code class="hljs${l ? ` language-${l}` : ""}">${highlight(text, l)}</code></pre>\n`;
    },
  },
});

/** Wrap a <pre><code> in a block with a header row (language, wrap toggle, copy). */
export function codeBlock(pre) {
  const code = pre.querySelector("code");
  const lang = (/language-([\w+#-]+)/.exec(code?.className || "") || [])[1] || "";
  const box = el("div", "code");
  const head = el("div", "code-head");
  const wrap = iconButton("wrap", "Wrap lines", "btn icon sm ghost");
  wrap.setAttribute("aria-pressed", "false");
  wrap.onclick = () => wrap.setAttribute("aria-pressed", String(box.classList.toggle("wrapped")));
  const copy = el("button", "btn sm ghost");
  copy.type = "button";
  copy.title = "Copy code";
  copy.setAttribute("aria-label", "Copy");
  copy.append(icon("copy"), el("span", "lab", "Copy"));
  wireCopy(copy, () => (code || pre).textContent.replace(/\n$/, ""));
  head.append(el("span", "lang", langLabel(lang)), wrap, copy);
  pre.replaceWith(box);
  box.append(head, pre);
  pre.tabIndex = 0; // keyboard-scrollable
  pre.setAttribute("role", "region");
  pre.setAttribute("aria-label", `${langLabel(lang)} code`);
}

/** Post-sanitise structure: code headers, scrollable tables. Operates on already-sanitised DOM. */
export function enhance(root) {
  for (const pre of root.querySelectorAll("pre")) if (!pre.closest(".code")) codeBlock(pre);
  for (const t of root.querySelectorAll("table")) {
    if (t.parentElement?.classList.contains("table-wrap")) continue;
    const w = el("div", "table-wrap");
    t.replaceWith(w);
    w.append(t);
  }
}

/** Markdown source -> sanitised, highlighted, enhanced DOM inside `target`. */
export function renderMarkdown(src, target) {
  target.innerHTML = DOMPurify.sanitize(md.parse(src || ""));
  enhance(target);
  return target;
}

/** Highlight plain code into an existing <code> element (used for tool-card bodies). */
export function highlightInto(codeEl, text, lang) {
  codeEl.className = `hljs${lang ? ` language-${lang}` : ""}`;
  codeEl.innerHTML = DOMPurify.sanitize(highlight(text, lang));
}
export const langFromPath = (p, content = "") => {
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(p || ""))?.[1]?.toLowerCase();
  const shebang = /^#![^\n]*(?:\/|\s)(bash|sh|zsh|dash|ksh|python[\d.]*|node)(?:\s|$)/.exec(content.slice(0, 200));
  if (shebang) return /^(bash|sh|zsh|dash|ksh)$/.test(shebang[1]) ? "bash" : shebang[1].startsWith("python") ? "python" : "javascript";
  return { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", py: "python", css: "css",
    html: "xml", xml: "xml", svg: "xml", md: "markdown", yml: "yaml", yaml: "yaml", sql: "sql", go: "go", rs: "rust", sh: "bash", bash: "bash", diff: "diff", patch: "diff" }[ext] || "";
};
