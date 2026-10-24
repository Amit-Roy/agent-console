// Rendering and metrics helpers for the file viewer. All state lives on the shared `viewer` context.
import {
  el as createElement,
  highlightInto,
  langFromPath,
  langLabel,
  renderMarkdown,
} from "/render.js";

export const metricThread = (request) =>
  request.scope === "repos" ? "viewer:repos" : request.thread;
export const scopeParams = (request) =>
  request.scope === "repos" ? { scope: "repos" } : { thread: request.thread };

export function paint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** True when a load/render finished after the viewer moved on or closed. */
export function isStale(viewer, token) {
  return token !== viewer.generation || !viewer.dialog.open;
}

export function revokeImage(viewer) {
  if (viewer.imageObjectUrl) URL.revokeObjectURL(viewer.imageObjectUrl);
  viewer.imageObjectUrl = null;
}

// A closed dialog keeps its body, so playback must stop explicitly.
export function stopMedia(viewer) {
  for (const media of viewer.body.querySelectorAll("audio, video")) media.pause();
}

export function record(viewer, sample) {
  const safe = { kind: sample.kind, thread: sample.thread };
  for (const [key, value] of Object.entries(sample))
    if (typeof value === "number" && Number.isFinite(value))
      safe[key] = Math.max(0, Math.round(value * 10) / 10);
  viewer.metrics.push(safe);
  if (viewer.metrics.length > 30) viewer.metrics.shift();
  viewer.report(safe);
  updatePerformance(viewer);
}

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function agoText(timestamp) {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return seconds < 86400
    ? `${Math.floor(seconds / 3600)} h ago`
    : `${Math.floor(seconds / 86400)} d ago`;
}

function metaRows(meta, chain, file) {
  const rows = [];
  if (meta)
    rows.push(
      ["Modified", new Date(meta.mtime).toLocaleString()],
      ["Size", `${meta.size.toLocaleString()} bytes`],
      ["Mode", meta.mode],
      ["Owner uid", String(meta.uid)],
      ["Links", String(meta.nlink)],
    );
  if (chain.length)
    rows.push(
      ["Opened as", chain[0].path],
      ["Target", chain.at(-1).to],
      ["Hops", String(chain.length)],
      ["Real path", file.path],
    );
  return rows;
}

export function applyMeta(viewer, file) {
  const meta = file?.meta,
    chain = meta?.symlink || [];
  viewer.linkPill.hidden = !chain.length;
  viewer.outsidePill.hidden = !chain.some((hop) => !hop.inside);
  viewer.extra.textContent = meta ? `· ${sizeText(meta.size)} · ${agoText(meta.mtime)}` : "";
  const rows = metaRows(meta, chain, file);
  if (file?.path)
    viewer.path.textContent = chain.length ? `${chain[0].path} → ${chain.at(-1).to}` : file.path;
  viewer.infoList.replaceChildren(
    ...rows.flatMap(([label, value]) => [
      createElement("dt", "", label),
      createElement("dd", "", value),
    ]),
  );
}

function timingText(sample) {
  return `${sample.kind.replace("viewer_", "")} · ${Math.round(sample.total_ms || 0)} ms total · ${Math.round(sample.roundtrip_ms || 0)} ms network · ${Math.round(sample.server_ms || 0)} ms server · ${Math.round(sample.decode_ms || 0)} ms decode · ${Math.round(sample.module_ms || 0)} ms module · ${Math.round(sample.render_ms || 0)} ms drawing · ${Math.round(sample.bytes || 0).toLocaleString()} bytes`;
}

export function updatePerformance(viewer) {
  if (viewer.performanceDetails.hidden) return;
  viewer.timingList.replaceChildren(
    ...viewer.metrics.slice(-3).map((sample) => createElement("div", "", timingText(sample))),
  );
}

/** Split highlighted DOM at newlines, retaining nested highlight spans without reparsing untrusted HTML. */
function addTextLines(lines, node, ancestors) {
  const parts = node.textContent.split("\n");
  for (let index = 0; index < parts.length; index++) {
    if (index) lines.push(document.createDocumentFragment());
    if (!parts[index]) continue;
    let target = lines.at(-1);
    for (const source of ancestors) {
      const span = source.cloneNode(false);
      target.append(span);
      target = span;
    }
    target.append(document.createTextNode(parts[index]));
  }
}

function walkHighlight(code, lines, node, ancestors) {
  if (node.nodeType === Node.TEXT_NODE) {
    addTextLines(lines, node, ancestors);
    return;
  }
  for (const child of node.childNodes)
    walkHighlight(code, lines, child, node === code ? ancestors : [...ancestors, node]);
}

function highlightedLines(text, lang) {
  const code = document.createElement("code");
  highlightInto(code, text, lang);
  const lines = [document.createDocumentFragment()];
  walkHighlight(code, lines, code, []);
  return lines;
}

function positionText(ref, selected, last) {
  if (!ref.line) return "";
  return `Line ${selected}${last > selected ? `–${last}` : ""}${ref.column ? `, column ${ref.column}` : ""}`;
}

function statusText(count, plain, lang) {
  return `${count.toLocaleString()} ${count === 1 ? "line" : "lines"} · ${plain ? "Plain text" : langLabel(lang)}`;
}

function setHeading(viewer, file) {
  viewer.title.textContent = file.name || file.path.split("/").at(-1);
  viewer.path.textContent = file.path;
  viewer.path.title = file.path;
}

function syncSourceButton(viewer, markdown) {
  const { source } = viewer;
  source.hidden = !markdown;
  source.setAttribute("aria-pressed", String(viewer.markdownSource));
  source.title = viewer.markdownSource ? "Show rendered Markdown" : "Show Markdown source";
}

function renderMarkdownBody(viewer, count) {
  const prose = createElement("div", "prose file-markdown");
  renderMarkdown(viewer.content, prose);
  viewer.body.classList.add("is-markdown");
  viewer.body.append(prose);
  viewer.status.textContent = `${count.toLocaleString()} lines · Markdown`;
  viewer.position.textContent = "";
  viewer.copy.disabled = false;
  viewer.wrap.disabled = true;
}

function renderPlain(viewer, lines, ref, range, token) {
  const { body, content } = viewer;
  const { selected, last } = range;
  const gutter = createElement(
    "pre",
    "file-plain-gutter",
    lines.map((_line, index) => index + 1).join("\n"),
  );
  gutter.setAttribute("aria-hidden", "true");
  const pre = createElement("pre", "file-plain-text");
  const code = document.createElement("code");
  code.textContent = content || "\n";
  pre.append(code);
  body.append(gutter, pre);
  body.classList.add("is-plain");
  if (ref.line) {
    const marker = createElement("div", "file-plain-selection");
    marker.setAttribute("aria-hidden", "true");
    marker.style.top = `calc(var(--file-line-height) * ${selected - 1})`;
    marker.style.height = `calc(var(--file-line-height) * ${last - selected + 1})`;
    body.append(marker);
  }
  requestAnimationFrame(() => {
    if (viewer.dialog.open && token === viewer.generation)
      body.scrollTop = Math.max(0, (selected - 5) * parseFloat(getComputedStyle(pre).lineHeight));
  });
}

function lineRow(text, index, ref, range) {
  const row = createElement("div", "file-line");
  row.dataset.line = String(index + 1);
  if (ref.line && index + 1 >= range.selected && index + 1 <= range.last)
    row.classList.add("is-selected");
  const numberCell = createElement("span", "file-line-number", index + 1);
  numberCell.setAttribute("aria-hidden", "true");
  const code = createElement("span", "file-line-text hljs");
  code.append(text);
  if (!code.hasChildNodes()) code.append(document.createTextNode("\u200b"));
  row.append(numberCell, code);
  return row;
}

function scrollToSelection(viewer, ref, selected, token) {
  const { body } = viewer;
  if (!viewer.dialog.open || token !== viewer.generation) return;
  const row = body.querySelector(`[data-line="${selected}"]`);
  if (row && ref.line) body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 3);
  // Point to the requested column while preserving the original text for copying.
  if (ref.column && row)
    body.scrollLeft = Math.max(
      0,
      (ref.column - 8) * parseFloat(getComputedStyle(row).fontSize) * 0.6,
    );
}

function renderCode(viewer, lang, ref, range, token) {
  const fragment = document.createDocumentFragment();
  const highlighted = highlightedLines(viewer.content, lang);
  for (let index = 0; index < highlighted.length; index++)
    fragment.append(lineRow(highlighted[index], index, ref, range));
  viewer.body.append(fragment);
  requestAnimationFrame(() => scrollToSelection(viewer, ref, range.selected, token));
}

export function renderFile(viewer, file, ref, token) {
  const { body } = viewer;
  body.replaceChildren();
  body.classList.remove("is-plain", "is-image", "is-markdown");
  viewer.content = file.content;
  setHeading(viewer, file);
  const lines = viewer.content.split("\n");
  const count = lines.length;
  body.style.setProperty("--gutter-ch", String(Math.max(2, String(count).length)));
  const lang = langFromPath(file.path, viewer.content);
  // Bound highlighting work and element count; very large files stay available as plain text.
  const plain = viewer.content.length > 128 * 1024 || count > 2000;
  const markdown = lang === "markdown" && !plain;
  syncSourceButton(viewer, markdown);
  if (markdown && !viewer.markdownSource) {
    renderMarkdownBody(viewer, count);
    return;
  }
  viewer.status.textContent = statusText(count, plain, lang);
  const selected = Math.min(ref.line || 1, count);
  const range = { selected, last: Math.min(ref.endLine || selected, count) };
  viewer.position.textContent = positionText(ref, selected, range.last);
  if (plain) renderPlain(viewer, lines, ref, range, token);
  else renderCode(viewer, lang, ref, range, token);
  viewer.copy.disabled = false;
  viewer.wrap.disabled = plain;
}

function checkedUrl(url, allowed, message) {
  const parsed = new URL(url, location.origin);
  if (parsed.origin !== location.origin || !allowed.test(parsed.pathname + parsed.search))
    throw new Error(message);
  return parsed.pathname + parsed.search;
}

export async function renderImage(viewer, url, name, token, signal) {
  const target = checkedUrl(url, /^\/(?:uploads\/|api\/file-image\?)/, "Invalid image URL.");
  const startedAt = performance.now();
  const response = await viewer.apiFetch(target, { signal });
  if (!response.ok) throw new Error("Could not open this image.");
  const blob = await response.blob(),
    receivedAt = performance.now();
  if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type) || blob.size > 5 * 1024 * 1024)
    throw new Error("This image format cannot be previewed.");
  if (isStale(viewer, token)) return {};
  viewer.imageObjectUrl = URL.createObjectURL(blob);
  const image = createElement("img", "file-viewer-image");
  image.alt = name;
  image.src = viewer.imageObjectUrl;
  const decodeAt = performance.now();
  await image.decode();
  if (isStale(viewer, token)) return {};
  const readyAt = performance.now();
  viewer.body.classList.add("is-image");
  viewer.body.append(image);
  viewer.status.textContent = `${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()} · Image`;
  return {
    bytes: blob.size,
    imageNetwork: receivedAt - startedAt,
    imageDecode: readyAt - decodeAt,
    readyAt,
    receivedAt,
  };
}

function mediaReady(media, signal, failure) {
  return new Promise((resolve, reject) => {
    media.addEventListener("loadedmetadata", resolve, { once: true });
    media.addEventListener("error", () => reject(new Error(failure)), { once: true });
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
}

function mediaStatus(media, video) {
  const length = Number.isFinite(media.duration) ? media.duration : 0;
  const clock = `${Math.floor(length / 60)}:${String(Math.floor(length % 60)).padStart(2, "0")}`;
  if (video && media.videoWidth)
    return `${media.videoWidth} × ${media.videoHeight} · ${clock} · Video`;
  return `${clock} · ${video ? "Video" : "Audio"}`;
}

export async function renderMedia(viewer, file, token, signal) {
  const target = checkedUrl(file.url, /^\/api\/file-media\?/, "Invalid media URL.");
  const video = /^video\//.test(file.media_type);
  const media = createElement(video ? "video" : "audio", "file-viewer-media");
  media.controls = true;
  media.preload = "metadata";
  media.playsInline = true;
  media.setAttribute("aria-label", file.name);
  const startedAt = performance.now();
  const ready = mediaReady(
    media,
    signal,
    video ? "This video cannot be played here." : "This audio cannot be played here.",
  );
  media.src = target;
  viewer.body.classList.add("is-image");
  viewer.body.append(media);
  await ready;
  if (isStale(viewer, token)) return {};
  const readyAt = performance.now();
  viewer.status.textContent = mediaStatus(media, video);
  return { bytes: file.bytes, imageNetwork: readyAt - startedAt, readyAt, receivedAt: readyAt };
}
