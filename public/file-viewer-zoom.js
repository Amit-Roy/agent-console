// Zoom for the file viewer: pinch/wheel/pan on images (Panzoom, lazy-loaded) and a persisted font scale for text.
const TEXT_MIN = 0.7,
  TEXT_MAX = 2,
  TEXT_STEP = 0.1,
  IMAGE_MAX = 8,
  IMAGE_TAP_SCALE = 2.5,
  DOUBLE_TAP_MS = 300,
  STORE_KEY = "file-viewer-zoom";

let panzoomModule;
const loadPanzoom = () => (panzoomModule ||= import("./vendor/panzoom.js").then((m) => m.default));

const clampText = (value) => Math.min(TEXT_MAX, Math.max(TEXT_MIN, Math.round(value * 10) / 10));

function zoomMode(viewer) {
  if (viewer.panzoom) return "image";
  return viewer.currentTextFile ? "text" : "none";
}

/** Show or hide the toolbar group and refresh the percentage and disabled state of its buttons. */
export function syncZoomControls(viewer) {
  const mode = zoomMode(viewer);
  viewer.zoomGroup.hidden = mode === "none";
  const value = mode === "image" ? viewer.imageScale || 1 : viewer.textZoom || 1;
  const [min, max] = mode === "image" ? [1, IMAGE_MAX] : [TEXT_MIN, TEXT_MAX];
  viewer.zoomLevel.textContent = `${Math.round(value * 100)}%`;
  viewer.zoomOut.disabled = value <= min + 0.001;
  viewer.zoomIn.disabled = value >= max - 0.001;
}

export function setTextZoom(viewer, value, persist = true) {
  viewer.textZoom = clampText(value);
  viewer.dialog.style.setProperty("--file-zoom", String(viewer.textZoom));
  if (persist)
    try {
      localStorage.setItem(STORE_KEY, String(viewer.textZoom));
    } catch {}
  syncZoomControls(viewer);
}

export function restoreTextZoom(viewer) {
  let stored = NaN;
  try {
    stored = parseFloat(localStorage.getItem(STORE_KEY));
  } catch {}
  setTextZoom(viewer, Number.isFinite(stored) ? stored : 1, false);
}

export function detachImageZoom(viewer) {
  viewer.zoomCleanup?.();
  viewer.zoomCleanup = undefined;
  viewer.panzoom?.destroy();
  viewer.panzoom = undefined;
  viewer.imageScale = 1;
  syncZoomControls(viewer);
}

function toggleScale(instance, point) {
  if (instance.getScale() > 1.01) instance.reset({ animate: false });
  else instance.zoomToPoint(IMAGE_TAP_SCALE, point, { animate: true });
}

/** Hand-rolled double-tap: Panzoom claims touch pointer events, so dblclick never fires on phones. */
function tapHandler(instance) {
  let last = { time: 0, x: 0, y: 0 };
  return (event) => {
    if (event.pointerType === "mouse") return;
    const now = performance.now(),
      near = Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30;
    if (now - last.time < DOUBLE_TAP_MS && near) {
      toggleScale(instance, { clientX: event.clientX, clientY: event.clientY });
      last = { time: 0, x: 0, y: 0 };
    } else last = { time: now, x: event.clientX, y: event.clientY };
  };
}

function bindImageEvents(viewer, instance, image, stage) {
  const onZoom = () => {
    viewer.imageScale = instance.getScale();
    syncZoomControls(viewer);
  };
  const onWheel = (event) => instance.zoomWithWheel(event);
  const onDouble = (event) =>
    toggleScale(instance, { clientX: event.clientX, clientY: event.clientY });
  const onTap = tapHandler(instance);
  image.addEventListener("panzoomzoom", onZoom);
  image.addEventListener("panzoomreset", onZoom);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("dblclick", onDouble);
  stage.addEventListener("pointerup", onTap);
  return () => {
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("dblclick", onDouble);
    stage.removeEventListener("pointerup", onTap);
  };
}

export async function attachImageZoom(viewer, image) {
  const Panzoom = await loadPanzoom();
  const stage = image.parentElement;
  if (!stage || !image.isConnected) return;
  detachImageZoom(viewer);
  const instance = Panzoom(image, {
    maxScale: IMAGE_MAX,
    minScale: 1,
    contain: "outside",
    pinchAndPan: true,
    step: 0.4,
    cursor: "grab",
    touchAction: "none",
  });
  viewer.panzoom = instance;
  viewer.imageScale = 1;
  viewer.zoomCleanup = bindImageEvents(viewer, instance, image, stage);
  syncZoomControls(viewer);
}

export function stepZoom(viewer, direction) {
  const mode = zoomMode(viewer);
  if (mode === "image") {
    if (direction > 0) viewer.panzoom.zoomIn({ step: 0.5, animate: true });
    else viewer.panzoom.zoomOut({ step: 0.5, animate: true });
  } else if (mode === "text") setTextZoom(viewer, viewer.textZoom + direction * TEXT_STEP);
}

export function resetZoom(viewer) {
  const mode = zoomMode(viewer);
  if (mode === "image") viewer.panzoom.reset({ animate: false });
  else if (mode === "text") setTextZoom(viewer, 1);
}

const KEY_ACTIONS = {
  "=": (viewer) => stepZoom(viewer, 1),
  "+": (viewer) => stepZoom(viewer, 1),
  "-": (viewer) => stepZoom(viewer, -1),
  _: (viewer) => stepZoom(viewer, -1),
  0: (viewer) => resetZoom(viewer),
};

/** Ctrl/Cmd + = + - 0. Returns true when the key was consumed (the browser page zoom is suppressed). */
export function handleZoomKey(viewer, event) {
  const action = KEY_ACTIONS[event.key];
  if (!action || !(event.ctrlKey || event.metaKey) || zoomMode(viewer) === "none") return false;
  event.preventDefault();
  action(viewer);
  return true;
}

/** Ctrl/Cmd + wheel zooms text; plain wheel keeps scrolling. Images handle wheel themselves. */
export function handleZoomWheel(viewer, event) {
  if (!(event.ctrlKey || event.metaKey) || zoomMode(viewer) !== "text") return;
  event.preventDefault();
  stepZoom(viewer, event.deltaY < 0 ? 1 : -1);
}
