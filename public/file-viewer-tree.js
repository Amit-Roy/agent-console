// Project file tree for the file viewer. All state lives on the shared `viewer` context.

import { metricThread, paint, record, scopeParams } from "./file-viewer-render.js";
import { el as createElement } from "./render.js";

export function showTree(viewer) {
  viewer.sidebar.hidden = !viewer.treeShown;
  viewer.files.setAttribute("aria-expanded", String(viewer.treeShown));
  viewer.files.setAttribute("aria-label", viewer.treeShown ? "Hide files" : "Show files");
}

export function markSelected(viewer) {
  for (const node of viewer.tree.querySelectorAll("button[data-path]")) {
    const selected = node.dataset.path === viewer.current?.ref.path;
    node.classList.toggle("is-selected", selected);
    if (selected) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
}

export function abortTreeRequests(viewer) {
  for (const request of viewer.treeControllers) request.abort();
  viewer.treeControllers.clear();
}

/** Drop every cached folder and invalidate in-flight tree loads. */
export function resetTree(viewer) {
  abortTreeRequests(viewer);
  viewer.treeGeneration++;
  viewer.treeThread = null;
  viewer.treeRoot = null;
  viewer.treeEntries = 0;
  viewer.directories.clear();
  viewer.tree.replaceChildren();
}

export function ensureTree(viewer) {
  if (!viewer.treeShown || !viewer.dialog.open) return;
  if (viewer.treeThread !== metricThread(viewer.current) || !viewer.tree.hasChildNodes()) {
    resetTree(viewer);
    viewer.treeThread = metricThread(viewer.current);
    directory(viewer, viewer.tree, ".");
  } else markSelected(viewer);
}

function entryOrder(left, right) {
  return (
    (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1) ||
    left.name.localeCompare(right.name)
  );
}

function entryButton(entry, depth) {
  const button = createElement("button", "file-tree-entry");
  button.type = "button";
  button.dataset.path = entry.path;
  button.title = entry.name;
  button.style.paddingLeft = `${12 + depth * 14}px`;
  if (entry.link) button.title = `${entry.name} → ${entry.link}`;
  button.append(
    createElement(
      "span",
      "file-tree-symbol",
      entry.kind === "directory" ? "▸" : entry.link ? "↪" : "·",
    ),
    createElement("span", "file-tree-name", entry.name),
  );
  if (entry.link) button.append(createElement("span", "file-tree-link", `→ ${entry.link}`));
  return button;
}

function wireFolder(viewer, item, button, entry, depth) {
  button.setAttribute("aria-expanded", "false");
  const children = createElement("div", "file-tree-children");
  children.hidden = true;
  item.append(children);
  button.onclick = () => {
    children.hidden = !children.hidden;
    button.setAttribute("aria-expanded", String(!children.hidden));
    button.firstChild.textContent = children.hidden ? "▸" : "▾";
    if (!children.hidden && !children.hasChildNodes())
      directory(viewer, children, entry.path, "", depth + 1);
  };
  if (viewer.current.ref.path.startsWith(entry.path + "/")) button.click();
}

function wireFile(viewer, button, entry) {
  button.onclick = () => {
    viewer.current = {
      ...viewer.current,
      ref: { path: entry.path },
      openedAt: undefined,
      module_ms: 0,
    };
    viewer.load(viewer.current);
    if (matchMedia("(max-width:640px)").matches) {
      viewer.treeShown = false;
      showTree(viewer);
    }
  };
}

function entryItem(viewer, entry, depth) {
  const item = createElement("div", "file-tree-item");
  const button = entryButton(entry, depth);
  item.append(button);
  if (entry.kind === "directory") wireFolder(viewer, item, button, entry, depth);
  else wireFile(viewer, button, entry);
  return item;
}

function entriesFragment(viewer, result, depth) {
  const fragment = document.createDocumentFragment();
  const remaining = Math.max(0, 2400 - viewer.treeEntries);
  const visibleEntries = result.entries.slice(0, remaining);
  viewer.treeEntries += visibleEntries.length;
  for (const entry of visibleEntries.sort(entryOrder))
    fragment.append(entryItem(viewer, entry, depth));
  return fragment;
}

function appendFooter(viewer, ctx, result) {
  const { group } = ctx;
  if (viewer.treeEntries >= 2400 || result.limit_reached) {
    group.append(
      createElement(
        "p",
        "file-tree-note",
        "File list limit reached. Close and reopen the viewer to browse another folder.",
      ),
    );
  } else if (result.cursor) {
    const more = createElement("button", "file-tree-more", "Load more");
    more.type = "button";
    more.onclick = () => {
      more.remove();
      directory(viewer, ctx.parent, ctx.directoryPath, result.cursor, ctx.depth);
    };
    group.append(more);
  }
}

async function loadDirectory(viewer, ctx, controller) {
  const { group, directoryPath, token, startedAt } = ctx;
  const params = new URLSearchParams({ ...scopeParams(viewer.current), path: directoryPath });
  if (ctx.cursor) params.set("cursor", ctx.cursor);
  const response = await viewer.apiFetch(`/api/files?${params}`, {
    signal: controller.signal,
    cache: "no-store",
  });
  const raw = await response.text(),
    receivedAt = performance.now(),
    result = JSON.parse(raw),
    decodedAt = performance.now();
  if (!response.ok) throw new Error(result.error || "Could not load files.");
  if (token !== viewer.treeGeneration || !viewer.dialog.open) return;
  viewer.treeRoot ||= result.root;
  if (directoryPath === ".") {
    viewer.treeTitle.textContent = result.root.split("/").at(-1) || "Project files";
    viewer.treeTitle.title = result.root;
  }
  group.append(entriesFragment(viewer, result, ctx.depth));
  ctx.loading.remove();
  appendFooter(viewer, ctx, result);
  markSelected(viewer);
  await paint();
  if (token === viewer.treeGeneration)
    record(viewer, {
      kind: "viewer_tree",
      thread: metricThread(viewer.current),
      total_ms: performance.now() - startedAt,
      wait_ms: receivedAt - startedAt,
      roundtrip_ms: receivedAt - startedAt,
      server_ms: result.read_ms || 0,
      decode_ms: decodedAt - receivedAt,
      render_ms: performance.now() - decodedAt,
      bytes: result.bytes || 0,
      events: result.entries.length,
    });
}

function showDirectoryError(viewer, ctx, failure) {
  ctx.loading.remove();
  if (failure.name === "AbortError" || ctx.token !== viewer.treeGeneration) return;
  const retry = createElement("button", "file-tree-more", "Retry files");
  retry.type = "button";
  retry.title = failure.message;
  retry.onclick = () => {
    retry.remove();
    viewer.directories.delete(ctx.directoryPath);
    ctx.group.remove();
    directory(viewer, ctx.parent, ctx.directoryPath, ctx.cursor, ctx.depth);
  };
  ctx.group.append(retry);
}

/** Reuse a cached folder group, or return null when the folder was attached from cache or capped. */
function claimGroup(viewer, parent, directoryPath, cursor) {
  const existing = viewer.directories.get(directoryPath);
  if (!cursor && existing) {
    parent.append(existing);
    return null;
  }
  if (!cursor && viewer.directories.size >= 24) {
    parent.append(
      createElement("p", "file-tree-note", "Close and reopen the viewer to browse more folders."),
    );
    return null;
  }
  const group = existing || createElement("div", "file-tree-group");
  if (!existing) {
    viewer.directories.set(directoryPath, group);
    parent.append(group);
  }
  return group;
}

export async function directory(viewer, parent, directoryPath, cursor = "", depth = 0) {
  if (!viewer.dialog.open || !viewer.treeShown || depth > 32) return;
  const group = claimGroup(viewer, parent, directoryPath, cursor);
  if (!group) return;
  const controller = new AbortController();
  viewer.treeControllers.add(controller);
  const loading = createElement("span", "file-tree-note", "Loading…");
  group.append(loading);
  const ctx = {
    parent,
    directoryPath,
    cursor,
    depth,
    group,
    loading,
    token: viewer.treeGeneration,
    startedAt: performance.now(),
  };
  try {
    await loadDirectory(viewer, ctx, controller);
  } catch (failure) {
    showDirectoryError(viewer, ctx, failure);
  } finally {
    viewer.treeControllers.delete(controller);
  }
}
