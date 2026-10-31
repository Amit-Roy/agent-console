// Release-versioned assets (#400): rewritten pages, immutable headers, sibling releases, bad ids. Run: node test/static-assets.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const { createStaticAssets, moduleGraph } = await import("../server/static-assets.ts");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "ac-static-assets-"));
const OWN = "aaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbb";
const PRUNED = "cccccccccccc";

function writeTree(root: string, tag: string, release: boolean) {
  const pub = path.join(root, "public");
  fs.mkdirSync(path.join(pub, "fonts"), { recursive: true });
  fs.writeFileSync(
    path.join(pub, "index.html"),
    `<!doctype html><html><head><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/style.css"></head><body><a href="/dashboard">d</a><script type="module" src="/app.js"></script></body></html>`,
  );
  fs.writeFileSync(
    path.join(pub, "login.html"),
    `<html><head><link rel="stylesheet" href="/style.css"></head></html>`,
  );
  fs.writeFileSync(
    path.join(pub, "app.js"),
    `import { a } from "./a.js";\nimport("./lazy.js");\nconsole.log("${tag}");`,
  );
  fs.writeFileSync(path.join(pub, "a.js"), `import {\n  b,\n} from "./b.js";\nexport const a = 1;`);
  fs.writeFileSync(path.join(pub, "b.js"), `export const b = 2;`);
  fs.writeFileSync(path.join(pub, "lazy.js"), `export const lazy = 1;`);
  fs.writeFileSync(path.join(pub, "style.css"), "body{}");
  fs.writeFileSync(path.join(pub, "icon.svg"), "<svg/>");
  fs.writeFileSync(path.join(pub, "sw.js"), "// sw");
  fs.writeFileSync(path.join(pub, "secret-neighbor.txt"), "x");
  if (release)
    fs.writeFileSync(
      path.join(root, "RELEASE.json"),
      JSON.stringify({ sha: `${path.basename(root)}ffffffffffffffffffffffffffff` }),
    );
}

const releases = path.join(base, "releases");
const ownRoot = path.join(releases, OWN);
writeTree(ownRoot, "own", true);
writeTree(path.join(releases, OTHER), "other", true);
fs.mkdirSync(path.join(releases, PRUNED, "public"), { recursive: true }); // dir without RELEASE.json: not a release
fs.writeFileSync(path.join(releases, "secret.txt"), "top secret");

async function serve(root: string) {
  const assets = createStaticAssets({ root, publicDir: path.join(root, "public") });
  const app = express();
  app.use(assets.middleware);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { assets, server, url: `http://127.0.0.1:${port}` };
}

const own = await serve(ownRoot);
try {
  assert.equal(own.assets.prefix, `/r/${OWN}`);

  // Page: prefixed assets, modulepreload for the static graph only, root-only files untouched, login not rewritten.
  const page = await fetch(`${own.url}/`);
  const html = await page.text();
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.match(page.headers.get("etag") ?? "", new RegExp(`^"${OWN}-`));
  assert.match(html, new RegExp(`<script type="module" src="/r/${OWN}/app.js">`));
  assert.match(html, new RegExp(`href="/r/${OWN}/style.css"`));
  assert.match(html, new RegExp(`href="/r/${OWN}/icon.svg"`));
  assert.match(html, /href="\/manifest.webmanifest"/);
  assert.match(html, /href="\/dashboard"/);
  for (const mod of ["app.js", "a.js", "b.js"])
    assert.match(html, new RegExp(`<link rel="modulepreload" href="/r/${OWN}/${mod}">`));
  assert.doesNotMatch(html, /modulepreload" href="[^"]*lazy.js/);
  assert.equal(own.assets.pages.has("login.html"), false);
  assert.equal(
    (await fetch(`${own.url}/login`)).status,
    404,
    "login is left to the existing route",
  );
  // fetch() adds Cache-Control: max-age=0 to conditional requests, which defeats 304s, so use raw http here.
  const cachedStatus = await new Promise<number>((resolve) => {
    http.get(
      {
        host: "127.0.0.1",
        port: new URL(own.url).port,
        path: "/",
        headers: { "if-none-match": page.headers.get("etag") as string },
      },
      (res) => resolve(res.statusCode ?? 0),
    );
  });
  assert.equal(cachedStatus, 304);
  assert.equal((await fetch(`${own.url}/index.html`)).status, 200);
  assert.deepEqual(moduleGraph(path.join(ownRoot, "public"), ["app.js"]), [
    "app.js",
    "a.js",
    "b.js",
  ]);

  // Own release: immutable.
  const asset = await fetch(`${own.url}/r/${OWN}/app.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.match(await asset.text(), /own/);

  // Other release in a sibling dir: its own files, immutable.
  const other = await fetch(`${own.url}/r/${OTHER}/app.js`);
  assert.equal(other.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.match(await other.text(), /other/);

  // Pruned (no RELEASE.json) falls back to own files without immutable.
  const pruned = await fetch(`${own.url}/r/${PRUNED}/app.js`);
  assert.equal(pruned.status, 200);
  assert.equal(pruned.headers.get("cache-control"), "no-cache");
  assert.match(await pruned.text(), /own/);
  const missing = await fetch(`${own.url}/r/dddddddddddd/app.js`);
  assert.equal(missing.headers.get("cache-control"), "no-cache");

  // Bad ids, traversal and missing files never serve outside public.
  for (const bad of [
    "/r/dev/app.js",
    "/r/ZZZZZZZZZZZZ/app.js",
    "/r/abc/app.js",
    `/r/${OWN}/nope.js`,
    `/r/${OWN}/%2e%2e/secret.txt`,
    `/r/${OWN}/..%2f..%2fsecret.txt`,
    `/r/${OWN}/..%5c..%5csecret.txt`,
    `/r/..%2f${OWN}/app.js`,
    `/r/${OTHER}/%2e%2e/%2e%2e/secret.txt`,
    `/r/${OWN}/%00`,
    `/r/${OWN}/`,
  ]) {
    const res = await fetch(own.url + bad);
    assert.ok([400, 403, 404].includes(res.status), `${bad} -> ${res.status}`);
    assert.doesNotMatch(await res.text(), /top secret/);
  }
  const raw = await new Promise<number>((resolve) => {
    http.get(
      { host: "127.0.0.1", port: new URL(own.url).port, path: `/r/${OWN}/../../secret.txt` },
      (res) => resolve(res.statusCode ?? 0),
    );
  });
  assert.notEqual(raw, 200);
} finally {
  own.server.close();
}

// Dev tree (no RELEASE.json): /r/dev/ with no-cache.
const devRoot = path.join(base, "dev-tree");
writeTree(devRoot, "dev", false);
const dev = await serve(devRoot);
try {
  assert.equal(dev.assets.prefix, "/r/dev");
  assert.match(await (await fetch(`${dev.url}/`)).text(), /src="\/r\/dev\/app.js"/);
  const asset = await fetch(`${dev.url}/r/dev/app.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "no-cache");
  assert.equal(
    (await fetch(`${dev.url}/r/${OTHER}/app.js`)).headers.get("cache-control"),
    "no-cache",
  );
  assert.equal(
    dev.assets.unprefixed("/r/dev/vendor/libavoid/index.js"),
    "/vendor/libavoid/index.js",
  );
} finally {
  dev.server.close();
  fs.rmSync(base, { recursive: true, force: true });
}
console.log("static-assets ok");
