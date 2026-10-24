import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { genericProvider, parsePage, buildNote, isVideoHost } = await import(
  "../server/share/generic.ts"
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-share-generic-"));

// ---- matching
assert.equal(genericProvider.match(new URL("https://example.com/post"))?.provider, "generic");
assert.ok(genericProvider.match(new URL("http://example.com/")));
assert.equal(genericProvider.match(new URL("ftp://example.com/")), null);
assert.equal(genericProvider.match(new URL("https://user:pw@example.com/")), null);
assert.equal(genericProvider.match(new URL("https://example.com:8443/")), null);
assert.ok(isVideoHost("player.vimeo.com") && isVideoHost("www.tiktok.com"));
assert.ok(!isVideoHost("notvimeo.com"));

// ---- fixture HTML -> meta + markdown -> post.md
const paragraph =
  "Readable sentences about markdown parsing and sharing links to the console. ".repeat(8);
const html = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Fixture &quot;Title&quot;">
<meta property="og:description" content="A fixture page">
<meta property="og:image" content="/img/cover.png">
<meta property="og:site_name" content="Fixture Site">
<meta name="author" content="Ada Lovelace">
<meta property="article:published_time" content="2026-10-01T10:00:00Z">
</head><body><nav>menu menu menu</nav><article><h1>Fixture Title</h1>
<p>${paragraph}</p><h2>Second part</h2><p>${paragraph}</p></article><footer>footer</footer></body></html>`;
const page = await parsePage(html, "https://fixture.example/articles/one");
assert.equal(page.meta.title, 'Fixture "Title"');
assert.equal(page.meta.description, "A fixture page");
assert.equal(page.meta.image, "https://fixture.example/img/cover.png");
assert.equal(page.meta.author, "Ada Lovelace");
assert.equal(page.meta.published, "2026-10-01T10:00:00Z");
assert.equal(page.meta.siteName, "Fixture Site");
assert.equal(page.meta.video, "");
assert.match(page.markdown, /Second part/);
assert.match(page.markdown, /Readable sentences/);
assert.doesNotMatch(page.markdown, /menu menu menu/);

const link = genericProvider.match(new URL("https://fixture.example/articles/one"))!;
const note = buildNote(page, link, "article", [2]);
const [, front, body] = note.split(/^---$/m);
assert.match(front, /^provider: "generic"$/m);
assert.match(front, /^url: "https:\/\/fixture.example\/articles\/one"$/m);
assert.match(front, /^title: "Fixture \\"Title\\""$/m);
assert.match(front, /^author: "Ada Lovelace"$/m);
assert.match(front, /^published: "2026-10-01T10:00:00Z"$/m);
assert.match(front, /^kind: "article"$/m);
assert.match(front, /^missing: \[2\]$/m);
assert.match(body, /Second part/);
const huge = buildNote({ ...page, markdown: "y".repeat(300_000) }, link, "article", []);
assert.ok(huge.length < 201_000 && huge.includes("[truncated]"));

// front matter cannot be broken out of by hostile titles
const hostile = buildNote(
  { ...page, meta: { ...page.meta, title: 'x"\n---\nprovider: evil' } },
  link,
  "article",
  [],
);
assert.equal(hostile.split(/^---$/m).length, 3);

// ---- private targets are refused before any request
await assert.rejects(
  genericProvider.fetch(genericProvider.match(new URL("http://127.0.0.1/"))!, root, {}),
  /private or blocked/,
);

// ---- live probe: a real article
const liveDir = fs.mkdtempSync(path.join(root, "live-"));
const liveLink = genericProvider.match(new URL("https://en.wikipedia.org/wiki/Markdown"))!;
const result = await genericProvider.fetch(liveLink, liveDir, {});
assert.equal(result.kind, "article");
const post = fs.readFileSync(result.notePath, "utf8");
const liveBody = post.split(/^---$/m).slice(2).join("---");
const words = liveBody.split(/\s+/).filter(Boolean).length;
assert.ok(words > 500, `live body has ${words} words`);
assert.match(post, /^title: ".*Markdown.*"$/m);
console.log(
  `share-generic ok (live: ${words} words, items ${result.items.map((item) => item.name).join(",") || "none"}, missing [${result.missing}])`,
);
fs.rmSync(root, { recursive: true, force: true });
