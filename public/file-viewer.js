// Loaded after the conversation is painted and the browser is idle, or when a file link is first opened.
import {
  el,
  highlightInto,
  icon,
  iconButton,
  langFromPath,
  langLabel,
  parseFileRef,
  renderMarkdown,
  wireCopy,
} from "/render.js";

let style;
export function prepare() {
  return (style ||= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/file-viewer.css";
    link.onload = resolve;
    link.onerror = () => {
      link.remove();
      style = null;
      reject(new Error("Could not load the file viewer. Try again."));
    };
    document.head.append(link);
  }));
}

/** Split highlighted DOM at newlines, retaining nested highlight spans without reparsing untrusted HTML. */
function highlightedLines(text, lang) {
  const code = document.createElement("code");
  highlightInto(code, text, lang);
  const lines = [document.createDocumentFragment()];
  const walk = (node, ancestors = []) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = node.textContent.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i) lines.push(document.createDocumentFragment());
        if (!parts[i]) continue;
        let target = lines.at(-1);
        for (const source of ancestors) {
          const span = source.cloneNode(false);
          target.append(span);
          target = span;
        }
        target.append(document.createTextNode(parts[i]));
      }
    } else
      for (const child of node.childNodes)
        walk(child, node === code ? ancestors : [...ancestors, node]);
  };
  walk(code);
  return lines;
}

export function createFileViewer(apiFetch, report = () => {}) {
  const dialog = el("dialog", "file-viewer");
  dialog.id = "file-viewer";
  dialog.setAttribute("aria-labelledby", "file-viewer-title");
  const header = el("header", "file-viewer-head");
  const heading = el("div", "file-viewer-heading");
  const title = el("h2");
  title.id = "file-viewer-title";
  const path = el("p", "file-viewer-path");
  path.id = "file-viewer-path";
  const copyPath = iconButton("copy", "Copy path");
  const pathRow = el("div", "file-viewer-path-row");
  pathRow.style.cssText = "display:flex;align-items:center;gap:var(--sp-2);";
  pathRow.append(path, copyPath);
  const meta = el("div", "file-viewer-meta");
  const status = el("span");
  status.id = "file-viewer-status";
  status.setAttribute("role", "status");
  meta.append(status);
  heading.append(title, pathRow, meta);
  const close = iconButton("x", "Close file viewer");
  close.autofocus = true;
  header.append(heading, close);
  const toolbar = el("div", "file-viewer-toolbar");
  const wrap = el("button", "btn sm ghost");
  wrap.type = "button";
  wrap.setAttribute("aria-label", "Wrap lines");
  wrap.setAttribute("aria-pressed", "false");
  wrap.append(icon("wrap"), el("span", "", "Wrap"));
  const copy = el("button", "btn sm ghost");
  copy.type = "button";
  copy.setAttribute("aria-label", "Copy file");
  copy.title = "Copy file";
  copy.append(icon("copy"), el("span", "lab", "Copy file"));
  const position = el("span", "file-viewer-position");
  const source = el("button", "btn sm ghost", "Source");
  source.type = "button";
  source.hidden = true;
  source.setAttribute("aria-pressed", "false");
  source.title = "Show Markdown source";
  const files = el("button", "btn sm ghost", "Files");
  files.type = "button";
  files.setAttribute("aria-label", "Show files");
  files.setAttribute("aria-controls", "file-viewer-tree");
  const timings = el("button", "btn sm ghost", "Info");
  timings.type = "button";
  timings.setAttribute("aria-expanded", "false");
  timings.setAttribute("aria-controls", "file-viewer-performance");
  const edit = el("a", "btn sm ghost", "Edit");
  edit.id = "file-viewer-edit";
  edit.hidden = true;
  edit.title = "Edit in Acode";
  edit.setAttribute("aria-label", "Edit");
  toolbar.append(files, edit, source, wrap, copy, timings, position);
  const performanceDetails = el("div", "file-viewer-performance");
  performanceDetails.id = "file-viewer-performance";
  performanceDetails.hidden = true;
  const infoList = el("dl", "file-viewer-info"),
    timingList = el("div", "file-viewer-timings");
  performanceDetails.append(infoList, timingList);
  const setup = el("a", "", "Set up Acode editing");
  setup.href = "/acode-setup";
  setup.target = "_blank";
  setup.rel = "noopener";
  performanceDetails.append(setup);
  const linkPill = el("span", "file-viewer-readonly", "Symlink");
  linkPill.hidden = true;
  const outsidePill = el("span", "file-viewer-readonly file-viewer-warn", "Outside repo");
  outsidePill.hidden = true;
  const extra = el("span");
  meta.append(linkPill, outsidePill, extra);
  const workspace = el("div", "file-viewer-workspace");
  const sidebar = el("nav", "file-viewer-tree");
  sidebar.id = "file-viewer-tree";
  sidebar.setAttribute("aria-label", "Project files");
  const treeTitle = el("div", "file-tree-title", "Project files");
  const tree = el("div", "file-tree-list");
  sidebar.append(treeTitle, tree);
  const main = el("div", "file-viewer-main");
  const body = el("div", "file-viewer-code");
  body.id = "file-viewer-code";
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", "File contents");
  const error = el("div", "file-viewer-error");
  error.hidden = true;
  const retry = el("button", "btn", "Retry");
  retry.type = "button";
  error.append(retry);
  main.append(error, body);
  workspace.append(sidebar, main);
  dialog.append(header, toolbar, performanceDetails, workspace);
  document.body.append(dialog);
  let controller,
    current,
    content = "",
    restoreFocus,
    generation = 0,
    imageObjectUrl;
  let currentTextFile,
    markdownSource = false;
  let editTicket, editTimer, editPending;
  let treeGeneration = 0,
    treeThread,
    treeRoot,
    treeEntries = 0,
    treeShown = !matchMedia("(max-width:640px)").matches;
  const directories = new Map(),
    treeControllers = new Set();
  const metrics = (window.agentConsoleViewerMetrics ||= []);
  const metricThread = (request) => (request.scope === "repos" ? "viewer:repos" : request.thread);
  const scopeParams = (request) =>
    request.scope === "repos" ? { scope: "repos" } : { thread: request.thread };
  function resetEdit() {
    clearTimeout(editTimer);
    editTicket = null;
    editPending = null;
    edit.hidden = true;
    edit.removeAttribute("href");
    edit.removeAttribute("aria-disabled");
  }
  async function prepareEdit(token) {
    if (!currentTextFile || token !== generation || !dialog.open) return;
    if (editPending) return editPending;
    const request = current,
      file = currentTextFile.file;
    const pending = (async () => {
      const params = new URLSearchParams({ ...scopeParams(request), path: file.path });
      const response = await apiFetch(`/api/acode/edit?${params}`, {
        method: "POST",
        cache: "no-store",
      });
      const grant = await response.json();
      if (token !== generation || !dialog.open) return;
      if (!response.ok) throw new Error(grant.error || "Could not prepare Acode editing.");
      if (typeof grant.ticket !== "string" || !grant.endpoint || !Number.isFinite(grant.expiresAt))
        throw new Error("Could not prepare Acode editing.");
      editTicket = grant;
      const payload = {
        endpoint: grant.endpoint,
        ticket: grant.ticket,
        line: request.ref.line || 1,
        column: request.ref.column || 1,
      };
      edit.href = `acode://agent-console/edit/${encodeURIComponent(JSON.stringify(payload))}`;
      clearTimeout(editTimer);
      editTimer = setTimeout(
        () => {
          if (document.visibilityState === "visible") prepareEdit(token).catch(() => {});
        },
        Math.max(1000, grant.expiresAt - Date.now() - 15000),
      );
    })();
    editPending = pending;
    try {
      await pending;
    } finally {
      if (editPending === pending) editPending = null;
    }
  }
  edit.onclick = (event) => {
    if (editTicket && editTicket.expiresAt > Date.now() + 1000 && edit.hasAttribute("href")) {
      // A real anchor with a ready URL preserves Android's user gesture for app launch.
      editTicket = null;
      edit.removeAttribute("aria-disabled");
      status.textContent = "Opening Acode… Bridge plugin required once (Info → setup).";
      clearTimeout(editTimer);
      editTimer = setTimeout(() => prepareEdit(generation).catch(() => {}), 1000);
      return;
    }
    event.preventDefault();
    const token = generation;
    edit.setAttribute("aria-disabled", "true");
    status.textContent = "Preparing Acode…";
    prepareEdit(token)
      .then(() => {
        if (token === generation && dialog.open) {
          edit.removeAttribute("aria-disabled");
          status.textContent = "Ready. Tap Edit to open Acode.";
        }
      })
      .catch((error) => {
        if (token === generation && dialog.open) {
          edit.removeAttribute("aria-disabled");
          status.textContent = error.message;
        }
      });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !dialog.open || !currentTextFile) return;
    // Refresh content and access after returning from the native editor.
    load({ ...current, openedAt: performance.now(), module_ms: 0 });
  });
  function record(sample) {
    const safe = { kind: sample.kind, thread: sample.thread };
    for (const [key, value] of Object.entries(sample))
      if (typeof value === "number" && Number.isFinite(value))
        safe[key] = Math.max(0, Math.round(value * 10) / 10);
    metrics.push(safe);
    if (metrics.length > 30) metrics.shift();
    report(safe);
    updatePerformance();
  }
  const sizeText = (n) =>
    n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
  const agoText = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    return s < 60
      ? "just now"
      : s < 3600
        ? `${Math.floor(s / 60)} min ago`
        : s < 86400
          ? `${Math.floor(s / 3600)} h ago`
          : `${Math.floor(s / 86400)} d ago`;
  };
  function applyMeta(file) {
    const m = file?.meta,
      chain = m?.symlink || [];
    linkPill.hidden = !chain.length;
    outsidePill.hidden = !chain.some((hop) => !hop.inside);
    extra.textContent = m ? `· ${sizeText(m.size)} · ${agoText(m.mtime)}` : "";
    const rows = [];
    if (m)
      rows.push(
        ["Modified", new Date(m.mtime).toLocaleString()],
        ["Size", `${m.size.toLocaleString()} bytes`],
        ["Mode", m.mode],
        ["Owner uid", String(m.uid)],
        ["Links", String(m.nlink)],
      );
    if (chain.length)
      rows.push(
        ["Opened as", chain[0].path],
        ["Target", chain.at(-1).to],
        ["Hops", String(chain.length)],
        ["Real path", file.path],
      );
    if (file?.path)
      path.textContent = chain.length ? `${chain[0].path} → ${chain.at(-1).to}` : file.path;
    infoList.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", "", k), el("dd", "", v)]));
  }
  function updatePerformance() {
    if (performanceDetails.hidden) return;
    timingList.replaceChildren(
      ...metrics
        .slice(-3)
        .map((m) =>
          el(
            "div",
            "",
            `${m.kind.replace("viewer_", "")} · ${Math.round(m.total_ms || 0)} ms total · ${Math.round(m.roundtrip_ms || 0)} ms network · ${Math.round(m.server_ms || 0)} ms server · ${Math.round(m.decode_ms || 0)} ms decode · ${Math.round(m.module_ms || 0)} ms module · ${Math.round(m.render_ms || 0)} ms drawing · ${Math.round(m.bytes || 0).toLocaleString()} bytes`,
          ),
        ),
    );
  }
  timings.onclick = () => {
    performanceDetails.hidden = !performanceDetails.hidden;
    timings.setAttribute("aria-expanded", String(!performanceDetails.hidden));
    updatePerformance();
  };
  function showTree() {
    sidebar.hidden = !treeShown;
    files.setAttribute("aria-expanded", String(treeShown));
    files.setAttribute("aria-label", treeShown ? "Hide files" : "Show files");
  }
  showTree();
  files.onclick = () => {
    treeShown = !treeShown;
    showTree();
    if (treeShown) ensureTree();
  };
  const paint = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  wireCopy(copy, () => content, "Copy file");
  wireCopy(copyPath, () => path.textContent, "Copy path");
  source.onclick = async () => {
    if (!currentTextFile) return;
    const token = generation,
      at = performance.now();
    markdownSource = !markdownSource;
    body.scrollTop = 0;
    body.scrollLeft = 0;
    renderFile(currentTextFile.file, currentTextFile.ref, token);
    await paint();
    if (token === generation && dialog.open)
      record({
        kind: "viewer_open",
        thread: metricThread(current),
        total_ms: performance.now() - at,
        render_ms: performance.now() - at,
        bytes: currentTextFile.file.bytes || 0,
        events: 1,
      });
  };
  function openMarkdownLink(event) {
    if (event.type === "auxclick" && event.button !== 1) return;
    if (!body.classList.contains("is-markdown")) return;
    const link = event.target.closest?.("a");
    const ref = link && parseFileRef(link.dataset.fileRef || link.getAttribute("href"));
    if (!ref) return;
    event.preventDefault();
    if (!ref.path.startsWith("/") && !ref.path.startsWith("~/"))
      ref.path = decodeURIComponent(
        new URL(ref.path, new URL(currentTextFile.file.path, location.origin)).pathname,
      );
    current = { ...current, ref, openedAt: undefined, module_ms: 0 };
    load(current);
  }
  body.addEventListener("click", openMarkdownLink);
  body.addEventListener("auxclick", openMarkdownLink);
  const setWrapped = (on) => {
    wrap.setAttribute("aria-pressed", String(dialog.classList.toggle("is-wrapped", on)));
    try {
      localStorage.setItem("file-viewer-wrap", on ? "1" : "0");
    } catch {}
  };
  wrap.onclick = () => setWrapped(!dialog.classList.contains("is-wrapped"));
  try {
    if (localStorage.getItem("file-viewer-wrap") === "1") setWrapped(true);
  } catch {}
  close.onclick = () => dialog.close();
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [
      ...dialog.querySelectorAll("button:not(:disabled), a[href], [tabindex='0']"),
    ].filter((node) => node.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      dialog.close();
  });
  dialog.addEventListener("close", () => {
    resetEdit();
    controller?.abort();
    generation++;
    treeGeneration++;
    for (const request of treeControllers) request.abort();
    treeControllers.clear();
    if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl);
    imageObjectUrl = null;
    stopMedia();
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  });
  retry.onclick = () => {
    if (current) {
      current = { ...current, openedAt: performance.now(), module_ms: 0 };
      load(current);
    }
  };

  function renderFile(file, ref, token) {
    body.replaceChildren();
    body.classList.remove("is-plain", "is-image", "is-markdown");
    content = file.content;
    title.textContent = file.name || file.path.split("/").at(-1);
    path.textContent = file.path;
    path.title = file.path;
    const lines = content.split("\n");
    const count = lines.length;
    body.style.setProperty("--gutter-ch", String(Math.max(2, String(count).length)));
    const lang = langFromPath(file.path, content);
    // Bound highlighting work and element count; very large files stay available as plain text.
    const plain = content.length > 128 * 1024 || count > 2000;
    const markdown = lang === "markdown" && !plain;
    source.hidden = !markdown;
    source.setAttribute("aria-pressed", String(markdownSource));
    source.title = markdownSource ? "Show rendered Markdown" : "Show Markdown source";
    if (markdown && !markdownSource) {
      const prose = el("div", "prose file-markdown");
      renderMarkdown(content, prose);
      body.classList.add("is-markdown");
      body.append(prose);
      status.textContent = `${count.toLocaleString()} lines · Markdown`;
      position.textContent = "";
      copy.disabled = false;
      wrap.disabled = true;
      return;
    }
    status.textContent = `${count.toLocaleString()} ${count === 1 ? "line" : "lines"} · ${plain ? "Plain text" : langLabel(lang)}`;
    const selected = Math.min(ref.line || 1, count);
    const last = Math.min(ref.endLine || selected, count);
    position.textContent = ref.line
      ? `Line ${selected}${last > selected ? `–${last}` : ""}${ref.column ? `, column ${ref.column}` : ""}`
      : "";
    if (plain) {
      const gutter = el("pre", "file-plain-gutter", lines.map((_, i) => i + 1).join("\n"));
      gutter.setAttribute("aria-hidden", "true");
      const pre = el("pre", "file-plain-text");
      const code = document.createElement("code");
      code.textContent = content || "\n";
      pre.append(code);
      body.append(gutter, pre);
      body.classList.add("is-plain");
      if (ref.line) {
        const marker = el("div", "file-plain-selection");
        marker.setAttribute("aria-hidden", "true");
        marker.style.top = `calc(var(--file-line-height) * ${selected - 1})`;
        marker.style.height = `calc(var(--file-line-height) * ${last - selected + 1})`;
        body.append(marker);
      }
      requestAnimationFrame(() => {
        if (dialog.open && token === generation)
          body.scrollTop = Math.max(
            0,
            (selected - 5) * parseFloat(getComputedStyle(pre).lineHeight),
          );
      });
    } else {
      const highlighted = highlightedLines(content, lang);
      const fragment = document.createDocumentFragment();
      highlighted.forEach((text, i) => {
        const row = el("div", "file-line");
        row.dataset.line = String(i + 1);
        if (ref.line && i + 1 >= selected && i + 1 <= last) row.classList.add("is-selected");
        const n = el("span", "file-line-number", i + 1);
        n.setAttribute("aria-hidden", "true");
        const code = el("span", "file-line-text hljs");
        code.append(text);
        if (!code.hasChildNodes()) code.append(document.createTextNode("\u200b"));
        row.append(n, code);
        fragment.append(row);
      });
      body.append(fragment);
      requestAnimationFrame(() => {
        if (!dialog.open || token !== generation) return;
        const row = body.querySelector(`[data-line="${selected}"]`);
        if (row && ref.line) body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 3);
        // Point to the requested column while preserving the original text for copying.
        if (ref.column && row)
          body.scrollLeft = Math.max(
            0,
            (ref.column - 8) * parseFloat(getComputedStyle(row).fontSize) * 0.6,
          );
      });
    }
    copy.disabled = false;
    wrap.disabled = plain;
  }

  function markSelected() {
    for (const node of tree.querySelectorAll("button[data-path]")) {
      const selected = node.dataset.path === current?.ref.path;
      node.classList.toggle("is-selected", selected);
      if (selected) node.setAttribute("aria-current", "true");
      else node.removeAttribute("aria-current");
    }
  }
  async function directory(parent, directoryPath, cursor = "", depth = 0) {
    if (!dialog.open || !treeShown || depth > 32) return;
    const existing = directories.get(directoryPath);
    if (!cursor && existing) {
      parent.append(existing);
      return;
    }
    if (!cursor && directories.size >= 24) {
      parent.append(
        el("p", "file-tree-note", "Close and reopen the viewer to browse more folders."),
      );
      return;
    }
    const controller = new AbortController();
    treeControllers.add(controller);
    const token = treeGeneration,
      at = performance.now();
    const group = existing || el("div", "file-tree-group");
    if (!existing) {
      directories.set(directoryPath, group);
      parent.append(group);
    }
    const loading = el("span", "file-tree-note", "Loading…");
    group.append(loading);
    try {
      const params = new URLSearchParams({ ...scopeParams(current), path: directoryPath });
      if (cursor) params.set("cursor", cursor);
      const response = await apiFetch(`/api/files?${params}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const raw = await response.text(),
        receivedAt = performance.now(),
        result = JSON.parse(raw),
        decodedAt = performance.now();
      if (!response.ok) throw new Error(result.error || "Could not load files.");
      if (token !== treeGeneration || !dialog.open) return;
      treeRoot ||= result.root;
      if (directoryPath === ".") {
        treeTitle.textContent = result.root.split("/").at(-1) || "Project files";
        treeTitle.title = result.root;
      }
      const fragment = document.createDocumentFragment();
      const remaining = Math.max(0, 2400 - treeEntries);
      const visibleEntries = result.entries.slice(0, remaining);
      treeEntries += visibleEntries.length;
      for (const entry of visibleEntries.sort(
        (a, b) =>
          (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) ||
          a.name.localeCompare(b.name),
      )) {
        const item = el("div", "file-tree-item");
        const button = el("button", "file-tree-entry");
        button.type = "button";
        button.dataset.path = entry.path;
        button.title = entry.name;
        button.style.paddingLeft = `${12 + depth * 14}px`;
        if (entry.link) button.title = `${entry.name} → ${entry.link}`;
        button.append(
          el("span", "file-tree-symbol", entry.kind === "directory" ? "▸" : entry.link ? "↪" : "·"),
          el("span", "file-tree-name", entry.name),
        );
        if (entry.link) button.append(el("span", "file-tree-link", `→ ${entry.link}`));
        item.append(button);
        fragment.append(item);
        if (entry.kind === "directory") {
          button.setAttribute("aria-expanded", "false");
          const children = el("div", "file-tree-children");
          children.hidden = true;
          item.append(children);
          button.onclick = () => {
            children.hidden = !children.hidden;
            button.setAttribute("aria-expanded", String(!children.hidden));
            button.firstChild.textContent = children.hidden ? "▸" : "▾";
            if (!children.hidden && !children.hasChildNodes())
              directory(children, entry.path, "", depth + 1);
          };
          if (current.ref.path.startsWith(entry.path + "/")) button.click();
        } else
          button.onclick = () => {
            current = { ...current, ref: { path: entry.path }, openedAt: undefined, module_ms: 0 };
            load(current);
            if (matchMedia("(max-width:640px)").matches) {
              treeShown = false;
              showTree();
            }
          };
      }
      group.append(fragment);
      loading.remove();
      if (treeEntries >= 2400 || result.limit_reached)
        group.append(
          el(
            "p",
            "file-tree-note",
            "File list limit reached. Close and reopen the viewer to browse another folder.",
          ),
        );
      else if (result.cursor) {
        const more = el("button", "file-tree-more", "Load more");
        more.type = "button";
        more.onclick = () => {
          more.remove();
          directory(parent, directoryPath, result.cursor, depth);
        };
        group.append(more);
      }
      markSelected();
      await paint();
      if (token === treeGeneration)
        record({
          kind: "viewer_tree",
          thread: metricThread(current),
          total_ms: performance.now() - at,
          wait_ms: receivedAt - at,
          roundtrip_ms: receivedAt - at,
          server_ms: result.read_ms || 0,
          decode_ms: decodedAt - receivedAt,
          render_ms: performance.now() - decodedAt,
          bytes: result.bytes || 0,
          events: result.entries.length,
        });
    } catch (e) {
      loading.remove();
      if (e.name !== "AbortError" && token === treeGeneration) {
        const retry = el("button", "file-tree-more", "Retry files");
        retry.type = "button";
        retry.title = e.message;
        retry.onclick = () => {
          retry.remove();
          directories.delete(directoryPath);
          group.remove();
          directory(parent, directoryPath, cursor, depth);
        };
        group.append(retry);
      }
    } finally {
      treeControllers.delete(controller);
    }
  }
  function ensureTree() {
    if (!treeShown || !dialog.open) return;
    if (treeThread !== metricThread(current) || !tree.hasChildNodes()) {
      for (const request of treeControllers) request.abort();
      treeControllers.clear();
      treeGeneration++;
      treeThread = metricThread(current);
      treeRoot = null;
      treeEntries = 0;
      directories.clear();
      tree.replaceChildren();
      directory(tree, ".");
    } else markSelected();
  }
  async function renderImage(url, name, token, signal) {
    const parsed = new URL(url, location.origin);
    if (
      parsed.origin !== location.origin ||
      !/^\/(?:uploads\/|api\/file-image\?)/.test(parsed.pathname + parsed.search)
    )
      throw new Error("Invalid image URL.");
    const at = performance.now();
    const response = await apiFetch(parsed.pathname + parsed.search, { signal });
    if (!response.ok) throw new Error("Could not open this image.");
    const blob = await response.blob(),
      receivedAt = performance.now();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type) || blob.size > 5 * 1024 * 1024)
      throw new Error("This image format cannot be previewed.");
    if (token !== generation || !dialog.open) return {};
    imageObjectUrl = URL.createObjectURL(blob);
    const image = el("img", "file-viewer-image");
    image.alt = name;
    image.src = imageObjectUrl;
    const decodeAt = performance.now();
    await image.decode();
    if (token !== generation || !dialog.open) return {};
    const readyAt = performance.now();
    body.classList.add("is-image");
    body.append(image);
    status.textContent = `${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()} · Image`;
    return {
      bytes: blob.size,
      imageNetwork: receivedAt - at,
      imageDecode: readyAt - decodeAt,
      readyAt,
      receivedAt,
    };
  }
  // A closed dialog keeps its body, so playback must stop explicitly.
  function stopMedia() {
    for (const media of body.querySelectorAll("audio, video")) media.pause();
  }
  async function renderMedia(file, token, signal) {
    const parsed = new URL(file.url, location.origin);
    if (
      parsed.origin !== location.origin ||
      !/^\/api\/file-media\?/.test(parsed.pathname + parsed.search)
    )
      throw new Error("Invalid media URL.");
    const video = /^video\//.test(file.media_type);
    const media = el(video ? "video" : "audio", "file-viewer-media");
    media.controls = true;
    media.preload = "metadata";
    media.playsInline = true;
    media.setAttribute("aria-label", file.name);
    const at = performance.now();
    const ready = new Promise((resolve, reject) => {
      media.addEventListener("loadedmetadata", resolve, { once: true });
      media.addEventListener(
        "error",
        () =>
          reject(
            new Error(
              video ? "This video cannot be played here." : "This audio cannot be played here.",
            ),
          ),
        { once: true },
      );
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
    media.src = parsed.pathname + parsed.search;
    body.classList.add("is-image");
    body.append(media);
    await ready;
    if (token !== generation || !dialog.open) return {};
    const readyAt = performance.now(),
      length = Number.isFinite(media.duration) ? media.duration : 0;
    const clock = `${Math.floor(length / 60)}:${String(Math.floor(length % 60)).padStart(2, "0")}`;
    status.textContent =
      video && media.videoWidth
        ? `${media.videoWidth} × ${media.videoHeight} · ${clock} · Video`
        : `${clock} · ${video ? "Video" : "Audio"}`;
    return { bytes: file.bytes, imageNetwork: readyAt - at, readyAt, receivedAt: readyAt };
  }
  async function load(request) {
    resetEdit();
    controller?.abort();
    controller = new AbortController();
    const token = ++generation,
      at = request.openedAt || performance.now();
    if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl);
    imageObjectUrl = null;
    stopMedia();
    content = "";
    currentTextFile = null;
    source.hidden = true;
    copy.disabled = true;
    wrap.disabled = true;
    title.textContent = request.ref.path.split("/").at(-1) || request.ref.path;
    path.textContent = request.ref.imageUrl ? "Attached image" : request.ref.path;
    path.title = path.textContent;
    status.textContent = "Loading…";
    position.textContent = "";
    applyMeta(null);
    error.hidden = true;
    body.hidden = false;
    body.replaceChildren();
    body.classList.remove("is-plain", "is-image", "is-markdown");
    body.scrollTop = 0;
    body.scrollLeft = 0;
    dialog.setAttribute("aria-busy", "true");
    try {
      let file,
        receivedAt = performance.now(),
        decodedAt = receivedAt,
        decode_ms = 0,
        roundtrip_ms = 0,
        imageStats = {};
      const requestAt = performance.now();
      if (request.ref.imageUrl) {
        imageStats = await renderImage(
          request.ref.imageUrl,
          title.textContent,
          token,
          controller.signal,
        );
        receivedAt = imageStats.receivedAt || requestAt;
        decodedAt = imageStats.readyAt || performance.now();
        roundtrip_ms = imageStats.imageNetwork || 0;
        decode_ms = imageStats.imageDecode || 0;
      } else {
        const params = new URLSearchParams({ ...scopeParams(request), path: request.ref.path });
        const response = await apiFetch(`/api/file?${params}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const raw = await response.text();
        receivedAt = performance.now();
        file = JSON.parse(raw);
        decodedAt = performance.now();
        roundtrip_ms = receivedAt - requestAt;
        decode_ms = decodedAt - receivedAt;
        if (!response.ok) throw new Error(file.error || "Could not open this file.");
        if (token !== generation || !dialog.open) return;
        if (typeof file.path !== "string") throw new Error("The server returned an invalid file.");
        current.ref.path = file.path;
        if (file.kind === "image") {
          imageStats = await renderImage(file.url, file.name, token, controller.signal);
          applyMeta(file);
          receivedAt = imageStats.receivedAt || receivedAt;
          decodedAt = imageStats.readyAt || performance.now();
          roundtrip_ms += imageStats.imageNetwork || 0;
          decode_ms += imageStats.imageDecode || 0;
        } else if (file.kind === "media") {
          imageStats = await renderMedia(file, token, controller.signal);
          applyMeta(file);
          receivedAt = imageStats.receivedAt || receivedAt;
          decodedAt = imageStats.readyAt || performance.now();
          roundtrip_ms += imageStats.imageNetwork || 0;
        } else {
          if (typeof file.content !== "string")
            throw new Error("The server returned an invalid file.");
          currentTextFile = { file, ref: request.ref };
          markdownSource = !!request.ref.line;
          renderFile(file, request.ref, token);
          applyMeta(file);
          edit.hidden = false;
          prepareEdit(token).catch(() => {});
        }
      }
      if (token !== generation || !dialog.open) return;
      await paint();
      if (token !== generation || !dialog.open) return;
      record({
        kind: "viewer_open",
        thread: metricThread(request),
        total_ms: performance.now() - at,
        module_ms: request.module_ms || 0,
        wait_ms: receivedAt - at,
        roundtrip_ms,
        server_ms: file?.read_ms || 0,
        decode_ms,
        render_ms: performance.now() - decodedAt,
        bytes: imageStats.bytes || file?.bytes || 0,
        events: 1,
      });
      ensureTree();
    } catch (e) {
      if (token !== generation || e.name === "AbortError" || !dialog.open) return;
      status.textContent = e.message || "Could not open this file.";
      body.hidden = true;
      error.hidden = false;
      record({
        kind: "viewer_open",
        thread: metricThread(request),
        total_ms: performance.now() - at,
        events: 0,
      });
      await paint();
      if (token === generation && dialog.open) ensureTree();
    } finally {
      if (token === generation) dialog.setAttribute("aria-busy", "false");
    }
  }
  return {
    record,
    openWorkspace({ opener, openedAt, module_ms }) {
      resetEdit();
      controller?.abort();
      generation++;
      for (const request of treeControllers) request.abort();
      treeControllers.clear();
      treeGeneration++;
      treeThread = null;
      treeRoot = null;
      treeEntries = 0;
      tree.replaceChildren();
      directories.clear();
      treeTitle.textContent = "repos";
      treeTitle.title = "~/repos";
      if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl);
      imageObjectUrl = null;
      current = { scope: "repos", ref: { path: "" } };
      content = "";
      currentTextFile = null;
      markdownSource = false;
      title.textContent = "Files";
      path.textContent = "~/repos";
      path.title = "~/repos";
      status.textContent = "";
      position.textContent = "";
      source.hidden = true;
      copy.disabled = true;
      wrap.disabled = true;
      error.hidden = true;
      body.hidden = false;
      body.classList.remove("is-plain", "is-image", "is-markdown");
      body.replaceChildren(el("p", "file-tree-note", "Select a file to preview."));
      body.scrollTop = 0;
      body.scrollLeft = 0;
      performanceDetails.hidden = true;
      timings.setAttribute("aria-expanded", "false");
      dialog.setAttribute("aria-busy", "false");
      restoreFocus = opener || document.activeElement;
      if (!dialog.open) dialog.showModal();
      treeShown = true;
      showTree();
      ensureTree();
      record({
        kind: "viewer_open",
        thread: "viewer:repos",
        total_ms: performance.now() - openedAt,
        module_ms,
        events: 0,
      });
    },
    open({ thread, ref, opener, openedAt, module_ms }) {
      const wasOpen = dialog.open;
      current = { thread, ref, openedAt, module_ms };
      if (!wasOpen) {
        restoreFocus = opener || document.activeElement;
        dialog.showModal();
        tree.replaceChildren();
        directories.clear();
      }
      load(current);
    },
  };
}
