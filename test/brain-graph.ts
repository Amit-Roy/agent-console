// Brain graph: runs the brain CLI without a shell, caches the graph until a page changes, serves raw page markdown from wiki|ops|tags only,
// and answers 503 when the CLI predates `graph --json`. Unit checks on BrainGraph, then the real routes on a scratch server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrainGraph, BrainGraphError } from "../server/brain-graph.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-brain-graph-"));

const FIXTURE_GRAPH = {
  v: 1,
  pages: [
    {
      slug: "agent-console",
      layer: "wiki",
      type: "project",
      description: "Personal agent PWA",
      updated: "2026-10-24",
      tags: ["pwa", "agents"],
      links: ["agent-console-ui"],
      path: "wiki/agent-console.md",
    },
    {
      slug: "agent-console-ui",
      layer: "wiki",
      type: "project",
      description: "UI topics",
      updated: "2026-10-20",
      tags: ["pwa"],
      links: [],
      path: "wiki/agent-console-ui.md",
    },
    {
      slug: "nightly-run",
      layer: "ops",
      type: "ops",
      description: "Nightly maintenance log",
      updated: "2026-10-22",
      tags: ["agents"],
      links: [],
      path: "ops/nightly-run.md",
    },
  ],
  tags: [
    { name: "pwa", description: "Progressive web apps", aliases: [], count: 2 },
    { name: "agents", description: "Coding agents", aliases: ["agent"], count: 2 },
  ],
  edges: [
    { source: "page:agent-console", target: "tag:pwa", kind: "tag" },
    { source: "page:agent-console", target: "tag:agents", kind: "tag" },
    { source: "page:agent-console-ui", target: "tag:pwa", kind: "tag" },
    { source: "page:nightly-run", target: "tag:agents", kind: "tag" },
    { source: "page:agent-console", target: "page:agent-console-ui", kind: "link" },
  ],
};
const FIXTURE_SEARCH = [
  {
    path: "wiki/agent-console.md",
    slug: "agent-console",
    layer: "wiki",
    score: 4.2,
    snippet: "Personal agent PWA",
  },
];

// A stub brain checkout: bin/brain answers from fixture JSON and counts every run.
function makeBrain(name: string, withGraph: boolean) {
  const root = path.join(scratchDir, name);
  for (const dir of ["bin", "wiki", "ops", "tags"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "wiki", "agent-console.md"), "# Agent console\n\nbody\n");
  fs.writeFileSync(path.join(root, "ops", "nightly-run.md"), "# Nightly\n");
  fs.writeFileSync(path.join(root, "tags", "pwa.md"), "# pwa tag\n");
  fs.writeFileSync(path.join(root, "secret.md"), "outside the layers\n");
  fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify(FIXTURE_GRAPH));
  fs.writeFileSync(path.join(root, "search.json"), JSON.stringify(FIXTURE_SEARCH));
  const bin = path.join(root, "bin", "brain");
  const runs = path.join(root, "runs");
  const script = withGraph
    ? `#!/bin/sh
echo "$@" >> "${runs}"
case "$1" in
  graph) cat "${root}/graph.json" ;;
  search) cat "${root}/search.json" ;;
  *) echo "unknown command: $1" >&2; exit 2 ;;
esac
`
    : `#!/bin/sh
echo "$@" >> "${runs}"
case "$1" in
  search) echo "wiki/agent-console.md:1: plain grep line" ;;
  *) echo "usage: brain ..." >&2; exit 2 ;;
esac
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const count = (sub?: string) =>
    fs.existsSync(runs)
      ? fs
          .readFileSync(runs, "utf8")
          .split("\n")
          .filter((line) => line && (!sub || line.startsWith(sub))).length
      : 0;
  return { root, bin, count };
}

const rejects = async (promise: Promise<unknown>, status: number, message?: string) => {
  await assert.rejects(promise, (failure: any) => {
    assert.ok(failure instanceof BrainGraphError);
    assert.equal(failure.status, status);
    if (message) assert.equal(failure.message, message);
    return true;
  });
};

try {
  const good = makeBrain("good", true);
  const brain = new BrainGraph({ bin: good.bin, root: good.root });

  const first = await brain.graph();
  assert.equal(first.v, 1);
  assert.equal(first.pages.length, 3);
  assert.ok(!Number.isNaN(Date.parse(first.generatedAt)), "generatedAt is an ISO timestamp");
  console.log("PASS  graph: CLI JSON passes through with generatedAt");

  const second = await brain.graph();
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(good.count("graph"), 1, "unchanged brain reuses the cached graph");
  const [left, right] = await Promise.all([brain.graph(), brain.graph()]);
  assert.equal(left.generatedAt, right.generatedAt);
  assert.equal(good.count("graph"), 1);
  console.log("PASS  graph: cache reused while wiki/ ops/ tags/ are unchanged");

  // an edit of an existing file (directory mtime does not move) and a new file both invalidate
  const edited = path.join(good.root, "wiki", "agent-console.md");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(edited, later, later);
  await brain.graph();
  assert.equal(good.count("graph"), 2, "an in-place page edit refreshes the graph");
  fs.writeFileSync(path.join(good.root, "ops", "new-page.md"), "# New\n");
  await brain.graph();
  assert.equal(good.count("graph"), 3, "a new page refreshes the graph");
  console.log("PASS  graph: cache invalidated by edits and new pages");

  // search proxies the CLI with terms as separate argv entries (no shell) and drops option-like terms
  const hits = await brain.search("agent --json; touch /scratchDir/pwned $(id)");
  assert.deepEqual(hits, FIXTURE_SEARCH);
  const lastArgs = fs.readFileSync(path.join(good.root, "runs"), "utf8").trim().split("\n").pop();
  assert.equal(lastArgs, "search agent touch /scratchDir/pwned $(id) --json");
  assert.ok(!fs.existsSync("/scratchDir/pwned"));
  await rejects(brain.search("   "), 400);
  await rejects(brain.search("--json -x"), 400);
  console.log("PASS  search: argv only, no shell, option-like terms dropped, empty query 400");

  // pages: three layers, nothing else
  assert.deepEqual(brain.page("agent-console"), {
    slug: "agent-console",
    layer: "wiki",
    markdown: "# Agent console\n\nbody\n",
  });
  assert.equal(brain.page("nightly-run").layer, "ops");
  assert.equal(brain.page("pwa").layer, "tags");
  for (const bad of [
    "secret",
    "../secret",
    "..",
    "../../etc/passwd",
    "a/b",
    "A",
    "-x",
    "",
    "x.md",
    "wiki/agent-console",
    "%2e%2e%2fsecret",
    "a\0b",
  ])
    await rejects(
      Promise.resolve().then(() => brain.page(bad)),
      404,
    );
  await rejects(
    Promise.resolve().then(() => brain.page("does-not-exist")),
    404,
  );
  // a symlink inside a layer must not read outside it
  fs.symlinkSync(path.join(good.root, "secret.md"), path.join(good.root, "wiki", "linked.md"));
  await rejects(
    Promise.resolve().then(() => brain.page("linked")),
    404,
  );
  console.log("PASS  page: wiki|ops|tags only, traversal and symlink escapes are 404");

  // an old CLI: unknown command or non-JSON output is a 503 with one message
  const old = makeBrain("old", false);
  const oldBrain = new BrainGraph({ bin: old.bin, root: old.root });
  await rejects(oldBrain.graph(), 503, "brain CLI lacks graph support");
  await rejects(oldBrain.search("agent"), 503, "brain CLI lacks graph support");
  await rejects(
    new BrainGraph({ bin: path.join(scratchDir, "nope"), root: scratchDir }).graph(),
    503,
  );
  console.log("PASS  old CLI: unknown command, plain-text output and missing binary are 503");

  // the real routes, behind real auth
  const freePort = async () => {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const free = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    return free;
  };
  let origin = "";
  const password = randomBytes(24).toString("base64url");
  const serveOnce = async (bin: string) => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["server/index.ts"], {
      cwd: repo,
      env: {
        ...process.env,
        PORT: String(port),
        AGENT_CONSOLE_DATA: path.join(scratchDir, "data"),
        AGENT_CONSOLE_RUN: path.join(scratchDir, "run"),
        AGENT_CONSOLE_MOCK: "1",
        AGENT_CONSOLE_AUTH: "password",
        AGENT_CONSOLE_PASSWORD: password,
        AGENT_CONSOLE_BRAIN: bin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => process.env.BG_DEBUG && process.stderr.write(chunk));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Scratch server startup timed out.")),
        20_000,
      );
      child.once("exit", (code) => reject(new Error(`Scratch server exited: ${code}`)));
      let output = "";
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-2048);
        if (output.includes("agent-console listening on")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return { child, cookie: login.headers.get("set-cookie")!.split(";")[0] };
  };
  const stop = async (child: ReturnType<typeof spawn>) => {
    child.removeAllListeners("exit");
    child.kill();
    await once(child, "exit");
  };

  // A boot slower than 5 s (loaded CI host) makes the server exit before it listens; retry that, nothing else.
  const serve = async (bin: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await serveOnce(bin);
      } catch (failure) {
        if (attempt >= 3 || !/Scratch server exited/.test(String(failure))) throw failure;
      }
    }
  };
  let server = await serve(good.bin);
  try {
    const get = (route: string, cookie: string | undefined = server.cookie) =>
      fetch(origin + route, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal((await get("/api/brain/graph", "")).status, 401);
    assert.equal((await get("/api/brain/page/agent-console", "")).status, 401);
    assert.equal((await get("/api/brain/search?q=agent", "")).status, 401);
    const graph = await get("/api/brain/graph");
    assert.equal(graph.status, 200);
    assert.equal(graph.headers.get("cache-control"), "no-store");
    const body = await graph.json();
    assert.equal(body.pages.length, 3);
    assert.ok(body.generatedAt);
    const page = await get("/api/brain/page/nightly-run");
    assert.deepEqual(await page.json(), {
      slug: "nightly-run",
      layer: "ops",
      markdown: "# Nightly\n",
    });
    for (const bad of ["secret", "..%2Fsecret", "%2e%2e%2fsecret", "UPPER", "nope"])
      assert.equal((await get(`/api/brain/page/${bad}`)).status, 404, bad);
    assert.deepEqual(await (await get("/api/brain/search?q=agent%20pwa")).json(), FIXTURE_SEARCH);
    assert.equal((await get("/api/brain/search")).status, 400);
    console.log("PASS  routes: auth required, graph/page/search served, traversal 404");
  } finally {
    await stop(server.child);
  }
  server = await serve(old.bin);
  try {
    for (const route of ["/api/brain/graph", "/api/brain/search?q=agent"]) {
      const reply = await fetch(origin + route, { headers: { Cookie: server.cookie } });
      assert.equal(reply.status, 503, route);
      assert.deepEqual(await reply.json(), { error: "brain CLI lacks graph support" });
    }
    console.log("PASS  routes: old CLI answers 503 with the upgrade message");
  } finally {
    await stop(server.child);
  }
  console.log("\nall brain graph checks passed");
} finally {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
