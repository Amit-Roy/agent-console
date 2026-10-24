// Acode edit-grant handling for the file viewer. All state lives on the shared `viewer` context.
import { scopeParams } from "/file-viewer-render.js";

export function resetEdit(viewer) {
  clearTimeout(viewer.editTimer);
  viewer.editTicket = null;
  viewer.editPending = null;
  viewer.edit.hidden = true;
  viewer.edit.removeAttribute("href");
  viewer.edit.removeAttribute("aria-disabled");
}

function validGrant(grant) {
  return typeof grant.ticket === "string" && grant.endpoint && Number.isFinite(grant.expiresAt);
}

function scheduleRefresh(viewer, token, grant) {
  clearTimeout(viewer.editTimer);
  viewer.editTimer = setTimeout(
    () => {
      if (document.visibilityState === "visible") prepareEdit(viewer, token).catch(() => {});
    },
    Math.max(1000, grant.expiresAt - Date.now() - 15000),
  );
}

async function requestGrant(viewer, token, request, file) {
  const params = new URLSearchParams({ ...scopeParams(request), path: file.path });
  const response = await viewer.apiFetch(`/api/acode/edit?${params}`, {
    method: "POST",
    cache: "no-store",
  });
  const grant = await response.json();
  if (token !== viewer.generation || !viewer.dialog.open) return;
  if (!response.ok) throw new Error(grant.error || "Could not prepare Acode editing.");
  if (!validGrant(grant)) throw new Error("Could not prepare Acode editing.");
  viewer.editTicket = grant;
  const payload = {
    endpoint: grant.endpoint,
    ticket: grant.ticket,
    line: request.ref.line || 1,
    column: request.ref.column || 1,
  };
  viewer.edit.href = `acode://agent-console/edit/${encodeURIComponent(JSON.stringify(payload))}`;
  scheduleRefresh(viewer, token, grant);
}

export async function prepareEdit(viewer, token) {
  if (!viewer.currentTextFile || token !== viewer.generation || !viewer.dialog.open) return;
  if (viewer.editPending) return viewer.editPending;
  const pending = requestGrant(viewer, token, viewer.current, viewer.currentTextFile.file);
  viewer.editPending = pending;
  try {
    await pending;
  } finally {
    if (viewer.editPending === pending) viewer.editPending = null;
  }
}

function ticketReady(viewer) {
  const ticket = viewer.editTicket;
  return ticket && ticket.expiresAt > Date.now() + 1000 && viewer.edit.hasAttribute("href");
}

function finishPrepare(viewer, token, message) {
  if (token !== viewer.generation || !viewer.dialog.open) return;
  viewer.edit.removeAttribute("aria-disabled");
  viewer.status.textContent = message;
}

export function handleEditClick(viewer, event) {
  if (ticketReady(viewer)) {
    // A real anchor with a ready URL preserves Android's user gesture for app launch.
    viewer.editTicket = null;
    viewer.edit.removeAttribute("aria-disabled");
    viewer.status.textContent = "Opening Acode… Bridge plugin required once (Info → setup).";
    clearTimeout(viewer.editTimer);
    viewer.editTimer = setTimeout(
      () => prepareEdit(viewer, viewer.generation).catch(() => {}),
      1000,
    );
    return;
  }
  event.preventDefault();
  const token = viewer.generation;
  viewer.edit.setAttribute("aria-disabled", "true");
  viewer.status.textContent = "Preparing Acode…";
  prepareEdit(viewer, token)
    .then(() => finishPrepare(viewer, token, "Ready. Tap Edit to open Acode."))
    .catch((error) => finishPrepare(viewer, token, error.message));
}
