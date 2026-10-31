// Module worker for ```arch diagrams (public/arch.js): routes all edges in one libavoid (WASM) orthogonal pass.
// libavoid's embind glue needs eval, so it runs here under this script's own CSP (server/index.ts), never in the page.
// Ported from brain/tools/pr-architecture/capture.mjs without its side-choice search: each edge takes its preferred
// sides. Request {requestId, boxes: Map id -> box, headers, edges}; reply {requestId, routes, labels} or {requestId, error}.
import { AvoidLib } from "./vendor/libavoid/index.js";

// Served as application/wasm by express.static, so Emscripten uses instantiateStreaming; it falls back to
// ArrayBuffer instantiation by itself when streaming fails.
const WASM_URL = new URL("./vendor/libavoid/libavoid.wasm", import.meta.url).href;
const avoidReady = AvoidLib.load(WASM_URL).then(() => AvoidLib.getInstance());

// Facing sides on the separated axis (capture.mjs candidates()[0]).
function preferredSides(source, target) {
  const across = source.l + source.r <= target.l + target.r ? ["r", "l"] : ["l", "r"];
  const down = source.t + source.b <= target.t + target.b ? ["b", "t"] : ["t", "b"];
  const separatedX = target.l >= source.r || source.l >= target.r;
  const separatedY = target.t >= source.b || source.t >= target.b;
  return separatedY && !separatedX ? down : across;
}

// Ends sharing a side sit symmetrically about its centre, GAP px apart, ordered by where the other box lies.
const GAP = 24;
function collectEnds(edges, sides, boxes) {
  const ends = new Map();
  for (const [edgeIndex, edge] of edges.entries()) {
    const pairs = [
      [edge.from, edge.to, sides[edgeIndex][0], 0],
      [edge.to, edge.from, sides[edgeIndex][1], 1],
    ];
    for (const [endId, otherId, side, slot] of pairs) {
      const key = `${endId}:${side}`;
      if (!ends.has(key)) ends.set(key, []);
      const other = boxes.get(otherId);
      const horizontal = side === "l" || side === "r";
      const aim = horizontal ? (other.t + other.b) / 2 : (other.l + other.r) / 2;
      ends.get(key).push({ edgeIndex, slot, box: boxes.get(endId), side, aim });
    }
  }
  return ends;
}

function spreadEnds(edges, sides, boxes) {
  const offsets = edges.map(() => [0.5, 0.5]);
  for (const list of collectEnds(edges, sides, boxes).values()) {
    const { box, side } = list[0];
    const length = side === "l" || side === "r" ? box.b - box.t : box.r - box.l;
    const gap = Math.min(GAP / Math.max(length, 1), 0.8 / Math.max(1, list.length - 1));
    list.sort((first, second) => first.aim - second.aim || first.edgeIndex - second.edgeIndex);
    for (const [position, end] of list.entries())
      offsets[end.edgeIndex][end.slot] = 0.5 + (position - (list.length - 1) / 2) * gap;
  }
  return offsets;
}

// Outward unit normal and libavoid ConnDirFlags (up 1, down 2, left 4, right 8) per side.
const NORMAL = { t: [0, -1, 1], b: [0, 1, 2], l: [-1, 0, 4], r: [1, 0, 8] };
const STUB = 20;

function sidePoint(box, side, offset) {
  if (side === "l" || side === "r")
    return [side === "l" ? box.l : box.r, box.t + offset * (box.b - box.t)];
  return [box.l + offset * (box.r - box.l), side === "t" ? box.t : box.b];
}

function pinPosition(side, offset) {
  if (side === "l") return [0, offset];
  if (side === "r") return [1, offset];
  return side === "t" ? [offset, 0] : [offset, 1];
}

// One router for one pass. Every value object (points, rectangles, ends) is tracked and freed in release(); the
// router owns shapes, pins and connectors and frees them when it is deleted.
function createRouter(Avoid, layout) {
  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
  const temps = [];
  const track = (value) => {
    temps.push(value);
    return value;
  };
  const point = (pointX, pointY) => track(new Avoid.Point(pointX, pointY));
  const rectangle = (box) => track(new Avoid.Rectangle(point(box.l, box.t), point(box.r, box.b)));
  const param = Avoid.RoutingParameter;
  router.setRoutingParameter(param.shapeBufferDistance, 18);
  router.setRoutingParameter(param.idealNudgingDistance, 14);
  router.setRoutingParameter(param.segmentPenalty, 40);
  router.setRoutingParameter(param.crossingPenalty, 400);
  router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true);
  router.setRoutingOption(Avoid.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true);
  const shapes = new Map();
  for (const box of layout.boxes.values())
    if (!box.group) shapes.set(box.id, new Avoid.ShapeRef(router, rectangle(box)));
  for (const header of layout.headers) new Avoid.ShapeRef(router, rectangle(header));
  const release = () => {
    for (const value of temps) value.delete();
    router.delete();
  };
  return { Avoid, router, shapes, point, track, release, pins: new Map(), nextPin: 1 };
}

// Groups are boundaries, not obstacles: their ends start just outside the border and get a stub afterwards.
// Pins are created on demand, one per distinct offset.
function connEnd(ctx, box, side, offset) {
  const { Avoid } = ctx;
  const shape = ctx.shapes.get(box.id);
  if (!shape) {
    const [pointX, pointY] = sidePoint(box, side, offset);
    const [normalX, normalY] = NORMAL[side];
    return ctx.track(
      new Avoid.ConnEnd(ctx.point(pointX + normalX * STUB, pointY + normalY * STUB)),
    );
  }
  const key = `${box.id}:${side}:${offset.toFixed(4)}`;
  if (!ctx.pins.has(key)) {
    const pin = ctx.nextPin++;
    const [pinX, pinY] = pinPosition(side, offset);
    new Avoid.ShapeConnectionPin(shape, pin, pinX, pinY, true, 0, NORMAL[side][2]).setExclusive(
      false,
    );
    ctx.pins.set(key, pin);
  }
  return ctx.track(new Avoid.ConnEnd(shape, ctx.pins.get(key)));
}

function readRoute(connector) {
  const line = connector.displayRoute();
  const points = [];
  for (let index = 0; index < line.size(); index++) {
    const point = line.at(index);
    points.push([Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10]);
    point.delete();
  }
  line.delete();
  return points;
}

const nearlyEqual = (first, second) => Math.abs(first - second) < 0.5;
const collinear = (before, middle, after) =>
  (nearlyEqual(before[0], middle[0]) && nearlyEqual(middle[0], after[0])) ||
  (nearlyEqual(before[1], middle[1]) && nearlyEqual(middle[1], after[1]));

function dropRedundantPoints(points) {
  const clean = [points[0]];
  for (const point of points.slice(1)) {
    const last = clean[clean.length - 1];
    if (nearlyEqual(point[0], last[0]) && nearlyEqual(point[1], last[1])) continue;
    if (clean.length >= 2 && collinear(clean[clean.length - 2], last, point)) clean.pop();
    clean.push(point);
  }
  return clean;
}

// Adds the border stub for group ends so every wire meets its box at 90 degrees.
function finishRoute(points, ends) {
  const [fromEnd, toEnd] = ends;
  const result = points.slice();
  if (fromEnd.box.group) result.unshift(sidePoint(fromEnd.box, fromEnd.side, fromEnd.offset));
  if (toEnd.box.group) result.push(sidePoint(toEnd.box, toEnd.side, toEnd.offset));
  return dropRedundantPoints(result);
}

/** Routes every edge in one libavoid transaction; returns one point list per edge (canvas coordinates). */
function routeEdges(Avoid, layout, edges) {
  const { boxes } = layout;
  const sides = edges.map((edge) => preferredSides(boxes.get(edge.from), boxes.get(edge.to)));
  const offsets = spreadEnds(edges, sides, boxes);
  const ctx = createRouter(Avoid, layout);
  try {
    const plans = edges.map((edge, index) => [
      { box: boxes.get(edge.from), side: sides[index][0], offset: offsets[index][0] },
      { box: boxes.get(edge.to), side: sides[index][1], offset: offsets[index][1] },
    ]);
    const connectors = plans.map(([fromEnd, toEnd]) => {
      const source = connEnd(ctx, fromEnd.box, fromEnd.side, fromEnd.offset);
      const target = connEnd(ctx, toEnd.box, toEnd.side, toEnd.offset);
      const connector = new Avoid.ConnRef(ctx.router, source, target);
      connector.setHateCrossings(true);
      return connector;
    });
    ctx.router.processTransaction();
    return connectors.map((connector, index) => finishRoute(readRoute(connector), plans[index]));
  } finally {
    ctx.release();
  }
}

// Point halfway along the polyline.
function midpoint(points) {
  const lengths = points
    .slice(1)
    .map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (const [index, length] of lengths.entries()) {
    if (remaining <= length && length > 0) {
      const share = remaining / length;
      const [start, end] = [points[index], points[index + 1]];
      return [start[0] + (end[0] - start[0]) * share, start[1] + (end[1] - start[1]) * share];
    }
    remaining -= length;
  }
  return points[0];
}

self.onmessage = async ({ data }) => {
  const { requestId, boxes, headers, edges } = data;
  try {
    const Avoid = await avoidReady;
    const started = performance.now();
    const routes = routeEdges(Avoid, { boxes, headers }, edges);
    const labels = routes.map((points) => (points.length ? midpoint(points) : null));
    self.postMessage({ requestId, routes, labels, routerMs: performance.now() - started });
  } catch (err) {
    self.postMessage({ requestId, error: String(err?.message || err) });
  }
};
