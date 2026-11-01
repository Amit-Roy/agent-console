// Codemap assembly + arch views (issue #405). Run: node test/codemap-spec.ts
// Scans this checkout with the vendored floorplan scanner, builds heuristic and described maps, and checks every
// generated view spec against public/arch.js validateArch plus the readability caps.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleMap,
  heuristicArchitecture,
  type Scan,
  validateArchitecture,
} from "../server/codemap/assemble.ts";
import {
  flowView,
  MODULE_EDGE_CAP,
  MODULE_NODE_CAP,
  moduleView,
  OVERVIEW_EDGE_CAP,
  overviewView,
} from "../server/codemap/spec.ts";
import type { Architecture, CodeMap, MapView } from "../server/codemap/types.ts";

const { validateArch } = await import("../public/arch.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(repoRoot, "server/vendor/floorplan/scan.mjs");
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-spec-"));

function scanRepo(root: string): Scan {
  const out = path.join(scratchDir, `${path.basename(root)}.json`);
  execFileSync(process.execPath, [scanner, root, "--out", out], { stdio: "ignore" });
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

type Item = { id?: string; group?: string; items?: Item[] };
const leafIds = (items: Item[]): string[] =>
  items.flatMap((item) => (item.items ? leafIds(item.items) : [item.id ?? ""]));
const allIds = (items: Item[]): string[] =>
  items.flatMap((item) => [
    ...(item.id ? [item.id] : []),
    ...(item.items ? allIds(item.items) : []),
  ]);

function checkView(view: MapView, map: CodeMap, where: string) {
  const spec = view.spec as { items: Item[]; edges?: unknown[] };
  assert.deepEqual(validateArch(spec), [], `${where}: spec passes validateArch`);
  const ids = new Set(allIds(spec.items));
  const archIds = new Set(map.architecture.nodes.map((node) => node.id));
  for (const [specId, nodeId] of Object.entries(view.drill)) {
    assert.ok(ids.has(specId), `${where}: drill key ${specId} is a spec item`);
    assert.ok(archIds.has(nodeId), `${where}: drill target ${nodeId} is an architecture node`);
    assert.ok((map.stats[nodeId]?.files ?? 0) > 0, `${where}: drill target ${nodeId} has files`);
  }
  assert.equal(view.crumbs[0].id, null, `${where}: first crumb is the overview`);
  assert.ok(view.details.title, `${where}: details title`);
  assert.deepEqual(
    view.flows.map((flow) => flow.id),
    map.architecture.flows.map((flow) => flow.id),
  );
  return spec;
}

function checkMap(map: CodeMap, label: string) {
  const overview = checkView(overviewView(map), map, `${label} overview`);
  assert.ok((overview.edges ?? []).length <= OVERVIEW_EDGE_CAP, `${label}: overview edge cap`);
  const leaves = map.architecture.nodes.filter(
    (node) => (map.stats[node.id]?.files ?? 0) > 0 && node.kind !== "system",
  );
  for (const node of leaves) {
    const spec = checkView(moduleView(map, node.id), map, `${label} module ${node.id}`);
    const fileNodes = leafIds(spec.items).filter(
      (itemId) => itemId.startsWith("file:") || itemId === "more-files",
    );
    assert.ok(fileNodes.length <= MODULE_NODE_CAP, `${label} module ${node.id}: node cap`);
    assert.ok((spec.edges ?? []).length <= MODULE_EDGE_CAP, `${label} module ${node.id}: edge cap`);
  }
  for (const flow of map.architecture.flows)
    checkView(flowView(map, flow.id), map, `${label} flow ${flow.id}`);
  return overview;
}

try {
  // agent-console itself: heuristic first pass, then the described fixture.
  const scan = scanRepo(repoRoot);
  const files = scan.files.map((file) => file.path);
  const heuristic = heuristicArchitecture(scan, "agent-console");
  assert.deepEqual(
    validateArchitecture(heuristic, files),
    [],
    "heuristic architecture validates clean",
  );
  const heuristicMap = assembleMap({
    slug: "agent-console",
    commit: null,
    scan,
    architecture: heuristic,
    described: false,
  });
  assert.equal(Object.keys(heuristicMap.fileModule).length, files.length, "every file assigned");
  assert.ok(
    !heuristicMap.architecture.nodes.some((node) => node.id === "other"),
    "heuristic leaves no file unclaimed",
  );
  const overview = checkMap(heuristicMap, "heuristic");
  assert.ok(overview.edges && overview.edges.length > 0, "overview shows module links");
  console.log(
    `PASS  heuristic: ${heuristic.nodes.length} nodes, ${overview.edges?.length} overview edges`,
  );

  const described: Architecture = JSON.parse(
    fs.readFileSync(new URL("fixtures/codemap/architecture.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(validateArchitecture(described, files), [], "described fixture validates");
  const describedMap = assembleMap({
    slug: "agent-console",
    commit: "abc",
    scan,
    architecture: described,
    described: true,
  });
  const flowsSeen = checkMap(describedMap, "described");
  assert.ok((flowsSeen.edges ?? []).length <= OVERVIEW_EDGE_CAP);
  assert.ok(
    describedMap.links.some((link) => link.kind === "http"),
    "HTTP links aggregated",
  );
  console.log(
    `PASS  described: ${describedMap.architecture.nodes.length} nodes, ${described.flows.length} flows`,
  );

  // validateArchitecture feedback for the describe pass.
  const broken = structuredClone(described);
  broken.nodes.push({ ...broken.nodes[1] });
  broken.nodes.push({
    id: "x.y",
    parent: "web.chat",
    label: "L".repeat(41),
    kind: "bogus" as never,
    summary: "",
    paths: ["nope/**"],
  });
  broken.flows[0].steps.push({ node: "missing", note: "n" });
  const errors = validateArchitecture(broken, files).join("\n");
  for (const pattern of [
    /duplicate id/,
    /must be a system node/,
    /kind must be one of/,
    /40 characters/,
    /summary must be/,
    /matches no file/,
    /node missing does not exist/,
  ])
    assert.match(errors, pattern);
  console.log(
    "PASS  validateArchitecture reports ids, parents, kinds, lengths, globs and flow steps",
  );

  // A tiny flat repo (no folders, one external host) still renders.
  const flat = path.join(scratchDir, "flat-repo");
  fs.mkdirSync(flat);
  fs.writeFileSync(
    path.join(flat, "main.py"),
    "import util\nURL = 'https://api.stripe.com/v1'\nprint(util.VALUE)\n",
  );
  fs.writeFileSync(path.join(flat, "util.py"), "VALUE = 1\n");
  fs.writeFileSync(path.join(flat, "README.md"), "# flat\n");
  const flatScan = scanRepo(flat);
  const flatArch = heuristicArchitecture(flatScan, "flat-repo");
  const flatFiles = flatScan.files.map((file) => file.path);
  assert.deepEqual(
    validateArchitecture(flatArch, flatFiles),
    [],
    "flat repo architecture validates",
  );
  checkMap(
    assembleMap({
      slug: "flat",
      commit: null,
      scan: flatScan,
      architecture: flatArch,
      described: false,
    }),
    "flat",
  );
  console.log(
    `PASS  flat repo: ${flatFiles.length} files -> ${flatArch.nodes.map((node) => node.label).join(", ")}`,
  );
  console.log("codemap-spec ok");
} finally {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
