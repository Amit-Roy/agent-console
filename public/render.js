// Rendering helpers shared by the app (and importable on their own): DOM helpers, icons, copy-to-clipboard,
// markdown -> sanitised HTML -> enhanced DOM (code block headers, table wrappers). DOMPurify sanitises ALL markdown output;
// highlight.js only ever produces escaped <span class="hljs-*"> markup and the sanitiser runs over it anyway.
// Media (images, video, ```chart blocks) is built from the sanitised DOM: local files go through the authenticated, path-scoped
// /api/file-image and /api/file-media routes, Chart.js is imported lazily on the first chart.
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
import { frontmatterToMarkdown } from "./frontmatter.js";

for (const [n, l] of Object.entries({
  bash,
  javascript,
  typescript,
  json,
  python,
  css,
  xml,
  markdown,
  diff,
  yaml,
  sql,
  go,
  rust,
}))
  hljs.registerLanguage(n, l);

// Raw <video>/<source> from message HTML may only point at http(s) or the media route; nothing else is a valid media source.
const SAFE_MEDIA_SRC = /^(?:https?:\/\/|\/api\/file-media\?)/i;
DOMPurify.addHook("afterSanitizeAttributes", (n) => {
  if (
    (n.tagName === "VIDEO" || n.tagName === "SOURCE") &&
    n.hasAttribute("src") &&
    !SAFE_MEDIA_SRC.test(n.getAttribute("src").trim())
  )
    n.removeAttribute("src");
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
  try {
    ok = document.execCommand("copy");
  } catch {}
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
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A local file reference, never an HTTP URL, app route, or executable scheme. Paths stay relative until the server resolves them. */
export function parseFileRef(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let ref = value.trim();
  if (!ref || ref.startsWith("#") || ref.startsWith("//")) return null;
  let line = null,
    endLine = null,
    column = null;
  const hash = ref.indexOf("#");
  if (hash !== -1) {
    const range = /^#L(\d+)(?:-L?(\d+))?$/i.exec(ref.slice(hash));
    if (range) {
      line = Number(range[1]);
      endLine = Number(range[2] || range[1]);
    }
    ref = ref.slice(0, hash);
  }
  if (/^file:/i.test(ref)) {
    try {
      const url = new URL(ref);
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search)
        return null;
      ref = url.pathname;
    } catch {
      return null;
    }
  }
  try {
    ref = decodeURIComponent(ref);
  } catch {
    return null;
  }
  const position = /:(\d+)(?::(\d+))?$/.exec(ref);
  if (position) {
    if (line == null) {
      line = Number(position[1]);
      endLine = line;
      column = position[2] ? Number(position[2]) : null;
    }
    ref = ref.slice(0, position.index);
  }
  if (
    !ref ||
    /[\u0000-\u001f\u007f\\?]/.test(ref) ||
    /^[a-z][\w+.-]*:/i.test(ref) ||
    ref.startsWith("//")
  )
    return null;
  if (
    /^\/(?:api|uploads|export|vendor|fonts)(?:\/|$)/.test(ref) ||
    /^\/(?:dashboard|login|restart|manifest\.webmanifest|sw\.js|icon\.svg)\/?$/.test(ref)
  )
    return null;
  // Bare names with no extension are ambiguous; common repository documents remain useful file links.
  if (
    !ref.includes("/") &&
    !/\.[\w-]+$/.test(ref) &&
    !/^(?:README|LICENSE|LICENCE|COPYING|NOTICE|Dockerfile|Makefile|AGENTS|CLAUDE)$/i.test(ref)
  )
    return null;
  for (const n of [line, endLine, column])
    if (n != null && (!Number.isSafeInteger(n) || n < 1)) return null;
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
    if (lang && hljs.getLanguage(lang))
      html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {}
  html ??= esc(text);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}
const LABELS = {
  xml: "HTML",
  html: "HTML",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TypeScript",
  py: "Python",
  python: "Python",
  sh: "Shell",
  bash: "Bash",
  zsh: "Shell",
  shell: "Shell",
  json: "JSON",
  css: "CSS",
  md: "Markdown",
  markdown: "Markdown",
  yml: "YAML",
  yaml: "YAML",
  sql: "SQL",
  go: "Go",
  rust: "Rust",
  rs: "Rust",
  diff: "Diff",
  patch: "Diff",
};
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
    // Local images/videos carry only a data attribute here; enhance() turns it into a scoped URL after sanitising (nothing loads
    // from the inert fragment). Remote ones keep their http(s) src. Anything else (data: images...) uses marked's default.
    image({ href, title, text }) {
      const t = title ? ` title="${esc(title)}"` : "",
        alt = ` alt="${esc(text || "")}"`;
      const video = VIDEO_EXT.test(String(href).split(/[?#]/)[0]);
      if (HTTP_URL.test(href))
        return video
          ? `<video src="${esc(href)}"${alt}${t}></video>`
          : `<img src="${esc(href)}"${alt}${t}>`;
      const ref = parseFileRef(href);
      if (!ref) return false;
      return `<${video ? "video" : "img"} data-local-path="${esc(href)}"${alt}${t}${video ? "></video>" : ">"}`;
    },
    code({ text, lang }) {
      const l = (lang || "")
        .trim()
        .split(/\s+/)[0]
        .toLowerCase()
        .replace(/[^a-z0-9+#_-]/g, "");
      if (l === "chart") {
        const key = chartKey(text);
        if (key) return `<div class="chart" data-chart="${key}"></div>\n`;
      }
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

// ---------- media: images, video, charts ----------
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v)$/i;
const HTTP_URL = /^https?:\/\/[^\s<>"'`]{1,2000}$/i;
let threadOf = () => null;
/** app.js registers how to find the thread whose files local references are relative to. */
export const setFileScope = (fn) => {
  threadOf = fn;
};
const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).at(-1) || String(p);
/** Authenticated, path-scoped URL for a local file. `repos` widens to the fixed ~/repos root (same scope as the Files sidebar). */
function localUrl(kind, ref, repos) {
  const thread = threadOf();
  if (!repos && !thread) return null;
  const q = new URLSearchParams(
    repos ? { scope: "repos", path: ref.path } : { thread, path: ref.path },
  );
  return `/api/${kind === "video" ? "file-media" : "file-image"}?${q}`;
}
const absolute = (p) => p.startsWith("/") || p.startsWith("~/");

// Streaming re-renders the same message many times a second: reuse media nodes (and live charts) keyed by content instead of
// rebuilding them. `kept` is only set while renderMarkdown runs.
let kept = null;
const keep = (key, build) => {
  const node = kept?.get(key)?.shift() || build();
  node.dataset.keep = key;
  return node;
};

function failure(node, kind, label, open) {
  const box = el("span", "md-fail");
  box.append(
    icon("alert"),
    el("span", "md-fail-text", label || (kind === "video" ? "Video" : "Image")),
  );
  const a = el("a", "md-fail-open", "Open");
  if (open.local) {
    a.href = "#";
    a.dataset.fileRef = open.local;
  } else {
    a.href = open.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  box.append(a);
  box.dataset.keep = node.dataset.keep || "";
  node.replaceWith(box);
}

/** Lazy, zoomable image. Local refs load via /api/file-image; an absolute path outside the thread folder is retried once in the repos scope. */
function buildImage({ alt, title, src, local }) {
  const a = el("a", "md-img");
  const img = el("img", "md-img-el");
  img.alt = alt;
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  const label = alt || basename(local?.path || src);
  a.title = title || label;
  const set = (url) => {
    img.src = url;
    if (local) a.href = url;
  };
  let retried = false;
  if (local) {
    const url = localUrl("image", local, false);
    if (!url) {
      queueMicrotask(() => failure(a, "image", label, { local: local.raw }));
      return a;
    }
    a.dataset.viewerImage = "true"; // chat click handler opens the shared viewer (blob preview, Escape to close)
    set(url);
  } else {
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    img.src = src;
  }
  img.addEventListener("load", () => a.classList.add("loaded"));
  img.addEventListener("error", () => {
    if (local && !retried && absolute(local.path)) {
      retried = true;
      set(localUrl("image", local, true));
      return;
    }
    failure(a, "image", label, local ? { local: local.raw } : { url: src });
  });
  a.append(img);
  return a;
}

/** Zoomable preview of a local image file by path, for tool cards (a Read of a screenshot). */
export const localImage = (file) =>
  buildImage({ alt: basename(file), src: file, local: { path: file, raw: file } });
export const isImageFile = (file) =>
  typeof file === "string" && /\.(?:png|jpe?g|gif|webp)$/i.test(file);

/** Inline player. preload=metadata keeps phones from downloading whole files; the route supports Range so seeking works. */
function buildVideo({ alt, title, src, local }) {
  const box = el("span", "md-media");
  const video = el("video", "md-video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.setAttribute("aria-label", alt || basename(local?.path || src));
  if (title) video.title = title;
  let retried = false;
  const url = local ? localUrl("video", local, false) : src;
  if (!url) {
    queueMicrotask(() => failure(box, "video", alt, { local: local.raw }));
    return box;
  }
  video.src = url;
  video.addEventListener("error", () => {
    if (local && !retried && absolute(local.path)) {
      retried = true;
      video.src = localUrl("video", local, true);
      return;
    }
    failure(box, "video", alt || basename(local?.path || src), { url: video.currentSrc || url });
  });
  box.append(video);
  return box;
}

// -- charts --
const CHART_TYPES = new Set([
  "bar",
  "line",
  "pie",
  "doughnut",
  "scatter",
  "radar",
  "polarArea",
  "bubble",
]);
const RADIAL = new Set(["pie", "doughnut", "polarArea"]);
const MAX = { labels: 200, datasets: 8, points: 500, total: 2000 };
const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i;
const chartConfigs = new Map(); // key -> normalised config (or null) for the code renderer and the mount step
const str = (v, n) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const color = (v) => (typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : null);
function point(v, type) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && !Array.isArray(v) && (type === "scatter" || type === "bubble")) {
    const x = num(v.x) ?? (typeof v.x === "string" ? v.x.slice(0, 80) : null),
      y = num(v.y);
    if (x == null || y == null) return undefined;
    return type === "bubble" ? { x, y, r: Math.min(Math.max(num(v.r) ?? 5, 1), 40) } : { x, y };
  }
  return undefined; // invalid
}
function axis(v) {
  if (!v || typeof v !== "object") return {};
  const out = {};
  const title = str(v.title?.text ?? v.title, 80);
  if (title) out.title = title;
  if (typeof v.stacked === "boolean") out.stacked = v.stacked;
  if (typeof v.beginAtZero === "boolean") out.beginAtZero = v.beginAtZero;
  if (num(v.min) != null) out.min = v.min;
  if (num(v.max) != null) out.max = v.max;
  if (v.type === "linear" || v.type === "logarithmic" || v.type === "category") out.type = v.type;
  return out;
}
/** Strict JSON -> a small, validated config (never the raw object), or null while the JSON is incomplete or invalid. */
function normaliseChart(src) {
  let j;
  try {
    j = JSON.parse(src);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j) || !CHART_TYPES.has(j.type)) return null;
  const rawSets = j.data?.datasets;
  if (!Array.isArray(rawSets) || !rawSets.length || rawSets.length > MAX.datasets) return null;
  const labels = Array.isArray(j.data.labels)
    ? j.data.labels.slice(0, MAX.labels).map((l) => str(l, 60))
    : [];
  let total = 0;
  const datasets = [];
  for (const d of rawSets) {
    if (!d || typeof d !== "object" || !Array.isArray(d.data) || d.data.length > MAX.points)
      return null;
    const data = [];
    for (const v of d.data) {
      const p = point(v, j.type);
      if (p === undefined) return null;
      data.push(p);
    }
    total += data.length;
    const paint = (c) => (Array.isArray(c) ? c.slice(0, MAX.labels).map(color) : color(c));
    const bg = paint(d.backgroundColor),
      border = paint(d.borderColor);
    datasets.push({
      label: str(d.label, 80),
      data,
      bg: bg && [].concat(bg).every(Boolean) ? bg : null,
      border: border && [].concat(border).every(Boolean) ? border : null,
      fill: d.fill === true,
      tension: Math.min(Math.max(num(d.tension) ?? 0.25, 0), 1),
      stack: str(d.stack, 40) || undefined,
    });
  }
  if (total > MAX.total || !total) return null;
  const opts = j.options && typeof j.options === "object" ? j.options : {};
  const plugins = opts.plugins && typeof opts.plugins === "object" ? opts.plugins : {};
  return {
    type: j.type,
    labels,
    datasets,
    title: str(j.title ?? plugins.title?.text, 120),
    legend: plugins.legend?.display !== false,
    horizontal: opts.indexAxis === "y",
    x: axis(opts.scales?.x),
    y: axis(opts.scales?.y),
  };
}
function chartKey(src) {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
  const key = `${(h >>> 0).toString(36)}.${src.length}`;
  if (!chartConfigs.has(key)) {
    if (chartConfigs.size > 60) chartConfigs.delete(chartConfigs.keys().next().value);
    const cfg = normaliseChart(src);
    chartConfigs.set(key, cfg && { cfg, src });
  }
  return chartConfigs.get(key) ? key : null;
}

let chartLib;
const loadChart = () =>
  (chartLib ||= import("/vendor/chart.umd.min.js")
    .then(() => {
      if (!globalThis.Chart) throw new Error("Chart.js did not load");
      return globalThis.Chart;
    })
    .catch((e) => {
      chartLib = null;
      throw e;
    }));
const liveCharts = new Set();
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const alpha = (c, a) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  return m ? `rgba(${[0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(",")},${a})` : c;
};

function chartOptions(cfg) {
  const t2 = cssVar("--t2"),
    edge = cssVar("--edge"),
    still = matchMedia("(prefers-reduced-motion:reduce)").matches;
  const axisOpts = (a) => ({
    ...(a.stacked != null && { stacked: a.stacked }),
    ...(a.beginAtZero != null && { beginAtZero: a.beginAtZero }),
    ...(a.min != null && { min: a.min }),
    ...(a.max != null && { max: a.max }),
    ...(a.type && { type: a.type }),
    border: { color: edge },
    grid: { color: edge },
    ticks: { color: t2, maxRotation: 0, autoSkipPadding: 12 },
    title: a.title ? { display: true, text: a.title, color: t2 } : { display: false },
  });
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: still ? false : { duration: 240 },
    ...(cfg.horizontal && { indexAxis: "y" }),
    font: { family: cssVar("--font-ui") || "system-ui" },
    plugins: {
      legend: {
        display: cfg.legend && (cfg.datasets.length > 1 || RADIAL.has(cfg.type)),
        position: "bottom",
        labels: { color: t2, boxWidth: 10, boxHeight: 10, usePointStyle: true },
      },
      title: cfg.title
        ? {
            display: true,
            text: cfg.title,
            color: cssVar("--t1"),
            font: { size: 14, weight: 600 },
            padding: { bottom: 12 },
          }
        : { display: false },
      tooltip: {
        backgroundColor: cssVar("--pop"),
        titleColor: cssVar("--t1"),
        bodyColor: cssVar("--t2"),
        borderColor: cssVar("--edge-strong"),
        borderWidth: 1,
        padding: 10,
      },
    },
    ...(!RADIAL.has(cfg.type) &&
      cfg.type !== "radar" && { scales: { x: axisOpts(cfg.x), y: axisOpts(cfg.y) } }),
    ...(cfg.type === "radar" && {
      scales: {
        r: {
          angleLines: { color: edge },
          grid: { color: edge },
          pointLabels: { color: t2 },
          ticks: { color: t2, backdropColor: "transparent" },
        },
      },
    }),
  };
}
function chartData(cfg) {
  const palette = Array.from(
    { length: 6 },
    (_, i) => cssVar(`--viz-${i + 1}`) || cssVar("--accent"),
  );
  const surface = cssVar("--s1");
  return {
    labels: cfg.labels,
    datasets: cfg.datasets.map((d, i) => {
      const c = palette[i % palette.length];
      const radial = RADIAL.has(cfg.type);
      const cycle = cfg.labels.length ? cfg.labels : d.data;
      const fills = radial ? cycle.map((_, k) => palette[k % palette.length]) : null;
      const line = cfg.type === "line" || cfg.type === "radar";
      return {
        label: d.label || `Series ${i + 1}`,
        data: d.data,
        stack: d.stack,
        tension: d.tension,
        fill: d.fill || cfg.type === "radar",
        backgroundColor:
          d.bg ||
          fills ||
          (line
            ? alpha(c, 0.18)
            : cfg.type === "scatter" || cfg.type === "bubble"
              ? alpha(c, 0.7)
              : c),
        borderColor: d.border || (radial ? surface : c),
        borderWidth: radial ? 2 : line || cfg.type === "scatter" ? 2 : 0,
        ...(cfg.type === "bar" && { borderRadius: 4, maxBarThickness: 48 }),
        ...(line && { pointRadius: d.data.length > 40 ? 0 : 3, pointHoverRadius: 5 }),
      };
    }),
  };
}
/** Fallback / accessible data table: rows = labels (or points), columns = datasets. */
function chartTable(cfg) {
  const t = el("table");
  const head = el("tr");
  const scatter = cfg.type === "scatter" || cfg.type === "bubble";
  for (const h of scatter
    ? ["Series", "x", "y"]
    : ["", ...cfg.datasets.map((d, i) => d.label || `Series ${i + 1}`)])
    head.append(el("th", "", h));
  const thead = el("thead"),
    body = el("tbody");
  thead.append(head);
  t.append(thead, body);
  const rows = [];
  if (scatter)
    cfg.datasets.forEach((d, i) =>
      d.data.forEach((p) => p && rows.push([d.label || `Series ${i + 1}`, p.x, p.y])),
    );
  else
    for (let r = 0; r < Math.max(cfg.labels.length, ...cfg.datasets.map((d) => d.data.length)); r++)
      rows.push([cfg.labels[r] ?? r + 1, ...cfg.datasets.map((d) => d.data[r] ?? "")]);
  for (const r of rows.slice(0, 60)) {
    const tr = el("tr");
    r.forEach((v) => tr.append(el("td", "", String(v))));
    body.append(tr);
  }
  const w = el("div", "table-wrap");
  w.append(t);
  numericColumns(t);
  return w;
}
function chartFigure(key) {
  const { cfg, src } = chartConfigs.get(key);
  const fig = el("figure", "chart");
  fig.setAttribute("aria-busy", "true");
  const label = `${cfg.title || "Chart"}: ${cfg.type} chart, ${cfg.datasets.length} ${cfg.datasets.length === 1 ? "series" : "series"}`;
  const stage = el("div", "chart-stage");
  stage.dataset.shape = RADIAL.has(cfg.type) || cfg.type === "radar" ? "round" : "wide";
  const canvas = el("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);
  stage.append(canvas);
  const data = el("details", "chart-data");
  data.append(el("summary", "", "Data table"), chartTable(cfg));
  fig.append(stage, data);
  const draw = async () => {
    try {
      const Chart = await loadChart();
      fig.__chart?.destroy();
      fig.__chart = new Chart(canvas, {
        type: cfg.type,
        data: chartData(cfg),
        options: chartOptions(cfg),
      });
      liveCharts.add(fig);
      fig.removeAttribute("aria-busy");
    } catch {
      fig.__chart = null;
      liveCharts.delete(fig);
      fig.removeAttribute("aria-busy");
      const pre = document.createElement("pre"),
        code = el("code");
      code.innerHTML = DOMPurify.sanitize(highlight(src, "json"));
      pre.append(code);
      stage.replaceWith(el("p", "chart-note", "Chart unavailable. Showing the data instead."));
      data.open = true;
      fig.append(pre);
      codeBlock(pre);
    }
  };
  fig.__draw = draw; // theme changes re-draw the same figure
  return fig;
}
globalThis.matchMedia?.("(prefers-color-scheme:dark)").addEventListener?.("change", () => {
  for (const f of liveCharts) f.__draw();
});
function pruneCharts() {
  if (liveCharts.size < 24) return;
  for (const f of liveCharts)
    if (!f.isConnected) {
      f.__chart?.destroy();
      liveCharts.delete(f);
    }
}

// -- tables --
const NUMERIC = /^[\s$€£¥+\-−~≈<>]*\d[\d,.\s]*(?:[kKmMbBx×%]|ms|s|MB|GB|KB)?\s*$/;
function numericColumns(table) {
  const rows = [...table.querySelectorAll("tbody tr")];
  if (!rows.length) return;
  const cols = table.querySelectorAll("thead th").length || rows[0].cells.length;
  for (let c = 0; c < cols; c++) {
    const cells = rows.map((r) => r.cells[c]).filter(Boolean);
    if (
      cells.length &&
      cells.every((td) => !td.textContent.trim() || NUMERIC.test(td.textContent))
    ) {
      for (const td of [table.querySelector("thead tr")?.cells[c], ...cells])
        td?.classList.add("num");
    }
  }
}

// -- links in prose --
/** Bare URL or file path (with an extension) that is the whole content of an inline code span. */
function codeTarget(t) {
  if (!t || /\s/.test(t) || t.length > 2000 || t.startsWith("@")) return null; // `@AGENTS.md` is an import, not a path
  if (HTTP_URL.test(t)) {
    try {
      new URL(t);
      return { url: t };
    } catch {
      return null;
    }
  }
  if (
    !/^(?:file:\/\/|~\/|\.{1,2}\/|\/)?[^\s/][^\s]*\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?(?:#L\d+(?:-L?\d+)?)?$/.test(
      t,
    ) &&
    !/^(?:file:\/\/|~\/|\.{1,2}\/|\/)[^\s]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$/.test(t)
  )
    return null;
  const ref = parseFileRef(t);
  return ref ? { local: t, ref } : null;
}
function linkify(root) {
  for (const code of root.querySelectorAll(":not(pre) > code")) {
    if (code.closest("a")) continue;
    const t = code.textContent.trim(),
      target = codeTarget(t);
    if (!target) continue;
    const a = el("a", "code-link");
    if (target.url) {
      a.href = target.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    } else {
      a.href = "#";
      a.dataset.fileRef = target.local;
    }
    code.replaceWith(a);
    a.append(code);
  }
  // Links to video files get a player after their paragraph/item; the link stays as a tappable fallback.
  let players = 0;
  for (const a of root.querySelectorAll("a")) {
    if (players >= 8 || a.closest("pre, .md-media, .md-fail, .chart")) continue;
    const href = a.getAttribute("href") || "";
    let spec = null;
    if (a.dataset.fileRef) {
      const ref = parseFileRef(a.dataset.fileRef);
      if (ref && VIDEO_EXT.test(ref.path))
        spec = { local: { ...ref, raw: a.dataset.fileRef }, key: ref.path };
    } else if (HTTP_URL.test(href) && VIDEO_EXT.test(href.split(/[?#]/)[0]))
      spec = { src: href, key: href };
    if (!spec) continue;
    const block = a.closest("p, li, td, th, blockquote, h1, h2, h3, h4") || a.parentElement;
    if (
      !block ||
      [...block.querySelectorAll(".md-media")].some((m) => m.dataset.keep === `video:${spec.key}`)
    )
      continue;
    block.append(
      keep(`video:${spec.key}`, () => buildVideo({ alt: a.textContent.trim(), ...spec })),
    );
    players++;
  }
}

// -- placeholders -> nodes --
function mountMedia(root, mounts) {
  for (const node of root.querySelectorAll("img, video")) {
    const alt = node.getAttribute("alt") || "",
      title = node.getAttribute("title") || "";
    const raw = node.dataset.localPath,
      ref = raw ? parseFileRef(raw) : null,
      src = node.getAttribute("src");
    const isVideo = node.tagName === "VIDEO";
    if (!ref && !(src && HTTP_URL.test(src))) {
      if (isVideo && !src) node.remove();
      else if (isVideo) {
        node.controls = true;
        node.setAttribute("playsinline", "");
        node.setAttribute("preload", "metadata");
        node.classList.add("md-video");
      }
      continue; // data:/blob: images and same-origin URLs are left as sanitised
    }
    if (isVideo && node.closest(".md-media")) continue;
    const spec = { alt, title, src: ref ? null : src, local: ref && { ...ref, raw } };
    const key = `${isVideo ? "video" : "img"}:${ref ? `${threadOf()}:${ref.path}` : src}`;
    node.replaceWith(keep(key, () => (isVideo ? buildVideo(spec) : buildImage(spec))));
  }
  for (const holder of root.querySelectorAll(".chart[data-chart]")) {
    const key = holder.dataset.chart;
    if (!chartConfigs.get(key)) {
      holder.remove();
      continue;
    }
    const fig = keep(`chart:${key}`, () => {
      const f = chartFigure(key);
      mounts.push(f);
      return f;
    });
    holder.replaceWith(fig);
  }
}

/** Post-sanitise structure: code headers, scrollable tables, media, linked paths. Operates on already-sanitised DOM (or a fragment of it). */
export function enhance(root, mounts = []) {
  for (const pre of root.querySelectorAll("pre")) if (!pre.closest(".code")) codeBlock(pre);
  for (const t of root.querySelectorAll("table")) {
    if (t.parentElement?.classList.contains("table-wrap")) continue;
    const w = el("div", "table-wrap");
    t.replaceWith(w);
    w.append(t);
    numericColumns(t);
  }
  linkify(root);
  mountMedia(root, mounts);
}

/** Markdown source -> sanitised, highlighted, enhanced DOM inside `target`. Media/chart nodes survive re-renders (streaming) when unchanged. */
export function renderMarkdown(src, target) {
  const old = new Map();
  for (const n of target.querySelectorAll("[data-keep]")) {
    if (!old.has(n.dataset.keep)) old.set(n.dataset.keep, []);
    old.get(n.dataset.keep).push(n);
  }
  const content = frontmatterToMarkdown(src || "");
  const frag = DOMPurify.sanitize(md.parse(content), {
    RETURN_DOM_FRAGMENT: true,
    FORBID_ATTR: ["autoplay"],
  });
  const mounts = [];
  kept = old;
  try {
    enhance(frag, mounts);
  } finally {
    kept = null;
  }
  target.replaceChildren(frag);
  for (const list of old.values())
    for (const n of list) {
      n.__chart?.destroy();
      liveCharts.delete(n);
    }
  pruneCharts();
  for (const f of mounts) f.__draw();
  return target;
}

/** Highlight plain code into an existing <code> element (used for tool-card bodies). */
export function highlightInto(codeEl, text, lang) {
  codeEl.className = `hljs${lang ? ` language-${lang}` : ""}`;
  codeEl.innerHTML = DOMPurify.sanitize(highlight(text, lang));
}
export const langFromPath = (p, content = "") => {
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(p || ""))?.[1]?.toLowerCase();
  const shebang = /^#![^\n]*(?:\/|\s)(bash|sh|zsh|dash|ksh|python[\d.]*|node)(?:\s|$)/.exec(
    content.slice(0, 200),
  );
  if (shebang)
    return /^(bash|sh|zsh|dash|ksh)$/.test(shebang[1])
      ? "bash"
      : shebang[1].startsWith("python")
        ? "python"
        : "javascript";
  return (
    {
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      json: "json",
      py: "python",
      css: "css",
      html: "xml",
      xml: "xml",
      svg: "xml",
      md: "markdown",
      yml: "yaml",
      yaml: "yaml",
      sql: "sql",
      go: "go",
      rs: "rust",
      sh: "bash",
      bash: "bash",
      diff: "diff",
      patch: "diff",
    }[ext] || ""
  );
};
