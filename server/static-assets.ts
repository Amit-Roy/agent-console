// Release-versioned static assets (#400): app pages are rewritten to /r/<sha12>/... so assets cache as immutable,
// and every statically imported module is announced with modulepreload to flatten the serial import waterfall.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";

const SHA12 = /^[0-9a-f]{12}$/;
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";
// Only these asset kinds move under the prefix. sw.js (scope) and the manifest stay at the root.
const REWRITE_EXT = new Set([".js", ".css", ".svg", ".png", ".woff2", ".ico"]);
const ROOT_ONLY = new Set(["/sw.js"]);
// login.html is served before auth and stays on the unprefixed paths.
const UNPREFIXED_PAGES = new Set(["login.html"]);
const ATTR = /\b(src|href)="(\/[^"?#]*)([?#][^"]*)?"/g;
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^'"()]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;
const MODULE_SCRIPT = /<script[^>]*\btype="module"[^>]*\bsrc="(\/[^"?#]+)"/g;

const isFile = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

// First 12 hex chars of RELEASE.json's sha, or null when the tree is not a release.
export function readReleaseId(root: string): string | null {
  try {
    const sha = JSON.parse(fs.readFileSync(path.join(root, "RELEASE.json"), "utf8"))?.sha;
    const id = typeof sha === "string" ? sha.slice(0, 12).toLowerCase() : "";
    return SHA12.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Static (non-dynamic) module graph reachable from the entry files, as public-relative POSIX paths, entries first.
export function moduleGraph(publicDir: string, entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    const file = path.join(publicDir, rel);
    if (!isFile(file)) continue;
    seen.add(rel);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1]));
      if (!next.startsWith("../")) queue.push(next);
    }
  }
  return [...seen];
}

type Page = { body: string; etag: string };

export function rewritePage(publicDir: string, html: string, prefix: string): string {
  const rewritten = html.replace(ATTR, (whole, attr, url, tail = "") => {
    const ext = path.posix.extname(url);
    if (ROOT_ONLY.has(url) || !REWRITE_EXT.has(ext) || !isFile(path.join(publicDir, url)))
      return whole;
    return `${attr}="${prefix}${url}${tail}"`;
  });
  const entries = [...html.matchAll(MODULE_SCRIPT)].map((m) => m[1].slice(1));
  const links = moduleGraph(publicDir, entries)
    .map((rel) => `<link rel="modulepreload" href="${prefix}/${rel}">`)
    .join("");
  return links ? rewritten.replace("</head>", `${links}</head>`) : rewritten;
}

export function createStaticAssets(opts: { root: string; publicDir: string }) {
  const { root, publicDir } = opts;
  const releasesDir = path.dirname(root);
  const ownId = readReleaseId(root);
  const id = ownId ?? "dev";
  const prefix = `/r/${id}`;
  const ownCache = ownId ? IMMUTABLE : NO_CACHE;

  const pages = new Map<string, Page>();
  for (const name of fs.readdirSync(publicDir)) {
    if (!name.endsWith(".html") || UNPREFIXED_PAGES.has(name)) continue;
    const body = rewritePage(
      publicDir,
      fs.readFileSync(path.join(publicDir, name), "utf8"),
      prefix,
    );
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    pages.set(name, { body, etag: `"${id}-${hash}"` });
  }

  // Public dir and cache policy for the id in a /r/<id>/ URL, or null for an invalid id.
  function resolveDir(requested: string): { dir: string; cache: string } | null {
    if (requested === id) return { dir: publicDir, cache: ownCache };
    if (!SHA12.test(requested)) return null;
    const sibling = path.join(releasesDir, requested);
    if (isFile(path.join(sibling, "RELEASE.json")) && fs.existsSync(path.join(sibling, "public")))
      return { dir: path.join(sibling, "public"), cache: IMMUTABLE };
    return { dir: publicDir, cache: NO_CACHE }; // release pruned: best effort from the running tree
  }

  function sendPage(req: express.Request, res: express.Response, name: string): boolean {
    const page = pages.get(name);
    if (!page) return false;
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("ETag", page.etag);
    res.type("html");
    if (req.fresh) res.status(304).end();
    else res.send(page.body);
    return true;
  }

  const middleware: express.RequestHandler = (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const match = /^\/r\/([^/]+)\/(.+)$/.exec(req.path);
    if (match) {
      const target = resolveDir(match[1]);
      const rel = decodeRelative(match[2]);
      if (!target || rel === null) return void res.status(404).end();
      return void res.sendFile(
        rel,
        { root: target.dir, cacheControl: false, headers: { "Cache-Control": target.cache } },
        (err) => {
          if (err && !res.headersSent) res.status(404).end();
        },
      );
    }
    const slug = req.path === "/" ? "index" : req.path.replace(/^\//, "").replace(/\.html$/, "");
    if (/^[a-z0-9-]+$/.test(slug) && sendPage(req, res, `${slug}.html`)) return;
    next();
  };

  return {
    id,
    prefix,
    pages,
    middleware,
    resolveDir,
    sendPage: (req: express.Request, res: express.Response, name: string) =>
      sendPage(req, res, name),
    // "/r/<id>/x" -> "/x", for per-path rules (CSP) that name root paths.
    unprefixed: (urlPath: string) => urlPath.replace(/^\/r\/[^/]+(?=\/)/, ""),
  };
}

// Percent-decoded path under the asset root, or null if it is empty, has a NUL, or climbs out with "..".
function decodeRelative(raw: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!rel || rel.includes("\0") || rel.includes("\\")) return null;
  return rel.split("/").includes("..") ? null : rel;
}
