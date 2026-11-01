// Codemap service, job queue and HTTP routes (issue #405). Run: node test/codemap-http.ts
// Temp data dir + temp repos root; scan is real, describe is fake. Gate mirrors the app's cookie check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { heuristicArchitecture } from "../server/codemap/assemble.ts";
import { mountMaps } from "../server/codemap/http.ts";
import { createMapsService } from "../server/codemap/service.ts";
import type { MapView } from "../server/codemap/types.ts";

const { validateArch } = await import("../public/arch.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-http-"));
const dataDir = path.join(tmp, "data");
const reposRoot = path.join(tmp, "repos");
const fixture = path.join(reposRoot, "fixture");
process.env.AGENT_CONSOLE_DATA = dataDir;

function write(rel: string, body: string): void {
  const file = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
write(
  "server/main.ts",
  'import { helper } from "./util.ts";\nexport const run = () => helper();\n',
);
write("server/util.ts", "export const helper = () => 1;\n");
write("web/app.ts", 'import { run } from "../server/main.ts";\nrun();\n');
write("README.md", "# fixture\n");
execFileSync("git", ["init", "-q"], { cwd: fixture });
execFileSync("git", ["add", "."], { cwd: fixture });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], {
  cwd: fixture,
});

let describeCalls = 0;
let describeFails = false;
const fakeDescribe = async (input: { scan: any }) => {
  describeCalls += 1;
  if (describeFails) throw new Error("model offline");
  const arch = heuristicArchitecture(input.scan, "fixture");
  arch.project.summary = "Fake described fixture project.";
  return arch;
};

const service = createMapsService({ base: dataDir, reposRoot, describe: fakeDescribe as any });
const app = express();
app.use((req, res, next) => {
  if (req.headers.cookie === "auth=ok") return next();
  res.status(401).json({ error: "auth" });
});
const sameOrigin: express.RequestHandler = (req, res, next) => {
  try {
    if (new URL(String(req.headers.origin)).host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: "Cross-site request refused." });
};
mountMaps(app, sameOrigin, service);
const server: http.Server = await new Promise((resolve) => {
  const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;

async function call(
  method: string,
  url: string,
  body?: unknown,
  opts: { cookie?: boolean; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.cookie !== false) headers.cookie = "auth=ok";
  if (opts.origin !== null) headers.origin = opts.origin ?? base;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { status: res.status, json, raw };
}

async function ready(slug: string): Promise<any> {
  await service.jobs.idle();
  const res = await call("GET", `/api/maps/${slug}`);
  assert.equal(res.status, 200);
  return res.json;
}

try {
  assert.equal((await call("GET", "/api/maps", undefined, { cookie: false })).status, 401);
  assert.equal(
    (await call("POST", "/api/maps", { source: fixture }, { origin: "http://evil.example" }))
      .status,
    403,
  );
  assert.equal(
    (await call("POST", "/api/maps", { source: fixture }, { origin: null })).status,
    403,
  );
  assert.equal((await call("POST", "/api/maps", {})).status, 400);
  assert.equal((await call("POST", "/api/maps", { source: "/etc" })).status, 400);
  assert.equal((await call("GET", "/api/maps/Bad_Slug")).status, 400);
  assert.equal((await call("GET", "/api/maps/nope")).status, 404);
  assert.equal((await call("GET", "/api/maps/nope/view")).status, 404);

  const added = await call("POST", "/api/maps", { source: fixture });
  assert.equal(added.status, 202);
  assert.equal(added.json.slug, "fixture");
  assert.equal(added.json.status, "queued");
  const done = await ready("fixture");
  assert.equal(done.status, "ready", done.error);
  assert.equal(done.described, true);
  assert.ok(done.files >= 3 && done.modules >= 1 && done.commit);
  assert.equal(describeCalls, 1);

  const list = await call("GET", "/api/maps");
  assert.deepEqual(
    list.json.maps.map((m: any) => m.slug),
    ["fixture"],
  );

  const view: MapView = (await call("GET", "/api/maps/fixture/view")).json;
  assert.deepEqual(validateArch(view.spec), []);
  const drillTarget = Object.values(view.drill)[0];
  assert.ok(drillTarget, "overview has a drillable module");
  const modView: MapView = (await call("GET", `/api/maps/fixture/view?node=${drillTarget}`)).json;
  assert.deepEqual(validateArch(modView.spec), []);
  assert.equal((await call("GET", "/api/maps/fixture/view?node=zzz")).status, 404);

  const brief = await call("GET", "/api/maps/fixture/brief");
  assert.equal(brief.status, 200);
  assert.ok(brief.raw.split("\n").length <= 60);
  console.log(`--- map show fixture ---\n${brief.raw}\n---`);
  assert.match(brief.raw, /^fixture: Fake described fixture project\./);
  assert.match(brief.raw, /described: yes/);
  const nodeBrief = await call("GET", `/api/maps/fixture/brief?node=${drillTarget}`);
  assert.ok(nodeBrief.raw.split("\n").length <= 60);
  assert.match(nodeBrief.raw, /Top files by LOC/);

  // Refresh: same top-level dirs and already described -> no new describe call.
  assert.equal((await call("POST", "/api/maps/fixture/refresh", {})).status, 202);
  assert.equal((await ready("fixture")).status, "ready");
  assert.equal(describeCalls, 1, "plain refresh reuses architecture");
  assert.equal((await call("POST", "/api/maps/fixture/refresh", { describe: true })).status, 202);
  await ready("fixture");
  assert.equal(describeCalls, 2, "describe:true re-describes");

  // Describe failure keeps the heuristic map viewable and ready with an error note.
  describeFails = true;
  await call("POST", "/api/maps/fixture/refresh", { describe: true });
  const failed = await ready("fixture");
  assert.equal(failed.status, "ready");
  assert.equal(failed.described, false);
  assert.match(failed.error, /^AI description failed: model offline/);
  assert.deepEqual(
    validateArch(((await call("GET", "/api/maps/fixture/view")).json as MapView).spec),
    [],
  );
  describeFails = false;

  // Interrupted jobs are marked failed on service start.
  const metaFile = path.join(dataDir, "maps", "fixture", "meta.json");
  const stuck = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  fs.writeFileSync(metaFile, JSON.stringify({ ...stuck, status: "scanning" }));
  const restarted = createMapsService({ base: dataDir, reposRoot, describe: fakeDescribe as any });
  const after = await restarted.status("fixture");
  assert.equal(after.status, "failed");
  assert.equal(after.error, "interrupted");

  assert.equal(
    (await call("DELETE", "/api/maps/fixture", undefined, { origin: "http://evil.example" }))
      .status,
    403,
  );
  assert.equal((await call("DELETE", "/api/maps/fixture")).status, 204);
  assert.equal(fs.existsSync(path.join(dataDir, "maps", "fixture")), false);
  assert.equal((await call("GET", "/api/maps/fixture")).status, 404);

  // Real scan of this checkout (fake describe): print overview edge count.
  const realService = createMapsService({
    base: path.join(tmp, "real"),
    reposRoot: path.dirname(repoRoot),
    describe: fakeDescribe as any,
  });
  const summary = await realService.add(repoRoot);
  await realService.jobs.idle();
  const final = await realService.status(summary.slug);
  assert.equal(final.status, "ready", final.error);
  const overview = await realService.view(summary.slug);
  assert.deepEqual(validateArch(overview.spec), []);
  console.log(
    `real overview: ${final.files} files, ${final.modules} modules, ${(overview.spec as any).edges.length} edges`,
  );
  console.log("codemap-http ok");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
