// Shared by the brain page and the thread graph page: lazy Cytoscape loader, theme tokens read from CSS, node base style and a safe localStorage.

export const store = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // private mode: the choice just is not remembered
    }
  },
};

export const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

// Glow is a translucent underlay in the node color; the light palette sets --graph-glow to 0.
export function symbolColor(token) {
  const color = css(token);
  const glow = Number(css("--graph-glow")) || 0;
  if (!glow) return { "background-color": color };
  return {
    "background-color": color,
    "underlay-color": color,
    "underlay-padding": glow,
    "underlay-opacity": 0.28,
    "underlay-shape": "ellipse",
  };
}

// Style rule every node starts from: ring in the canvas color, label to the right with a canvas-colored outline.
export function baseNodeStyle(canvas) {
  return {
    selector: "node",
    style: {
      "font-family": css("--font-ui") || "sans-serif",
      color: css("--graph-text"),
      "min-zoomed-font-size": 11,
      label: "data(label)",
      width: 24,
      height: 24,
      "border-width": 2,
      "border-color": canvas,
      "font-size": 12,
      "font-weight": 500,
      "text-halign": "right",
      "text-valign": "center",
      "text-margin-x": 6,
      "text-wrap": "ellipsis",
      "text-max-width": 110,
      "text-outline-color": canvas,
      "text-outline-width": 3,
      "text-outline-opacity": 1,
    },
  };
}

let cytoscapeLib = null;
export function ensureCytoscape() {
  cytoscapeLib ||= import("./vendor/cytoscape.esm.min.mjs").then((m) => m.default);
  return cytoscapeLib;
}
