// Shared contracts for the codemap feature (issue #405).
// The architecture shape is a subset of floorplan's architecture.json.

export type ArchKind = "system" | "feature" | "service" | "data" | "external" | "tooling" | "tests";

export interface ArchNode {
  id: string; // dotted, e.g. "server.core"; parent prefix not required
  parent?: string; // id of a "system" node
  label: string; // <= 40 chars
  kind: ArchKind;
  summary: string; // <= 200 chars, plain English
  paths: string[]; // repo-relative globs (floorplan compileGlob syntax); empty for external/system
}

export interface FlowStep {
  node: string; // ArchNode id
  note: string; // <= 120 chars
}

export interface ArchFlow {
  id: string;
  title: string;
  steps: FlowStep[];
}

export interface Architecture {
  project: { name: string; summary: string };
  nodes: ArchNode[];
  flows: ArchFlow[];
}

export interface ModuleStats {
  files: number;
  loc: number;
}

// Persisted as map.json: everything views need, no raw scan.
export interface CodeMap {
  slug: string;
  commit: string | null;
  described: boolean; // true once the Claude naming pass succeeded
  architecture: Architecture;
  fileModule: Record<string, string>; // repo-relative file -> leaf ArchNode id
  fileLoc: Record<string, number>;
  links: Array<{ from: string; to: string; kind: "import" | "http" | "external"; count: number }>; // module-level, aggregated
  stats: Record<string, ModuleStats>;
}

// Response of GET /api/maps/:slug/view
export interface MapView {
  spec: unknown; // arch JSON spec, passes public/arch.js validateArch
  drill: Record<string, string>; // spec item id -> ArchNode id to open on click
  crumbs: Array<{ id: string | null; label: string }>; // null id = overview
  details: { title: string; summary: string; files: Array<{ path: string; loc: number }> };
  flows: Array<{ id: string; title: string }>;
}
