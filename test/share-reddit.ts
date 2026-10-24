import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearRedditCache, redditDeps, redditProvider } from "../server/share/reddit.ts";

const realFetch = redditDeps.fetch;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-reddit-"));
const fixture = fs.readFileSync("test/fixtures/share-reddit/post.atom", "utf8");
const canonical = "https://www.reddit.com/r/aww/comments/abc123/";

function matchUrl(raw: string) {
  return redditProvider.match(new URL(raw));
}
function stageDir(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const reply = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

// ---- URL table
const table: [string, string | null][] = [
  ["https://www.reddit.com/r/aww/comments/abc123/cat_slug/?utm=x", canonical],
  ["https://old.reddit.com/r/aww/comments/abc123", canonical],
  ["https://np.reddit.com/r/aww/comments/abc123/x/", canonical],
  ["https://m.reddit.com/r/aww/comments/abc123/", canonical],
  ["https://reddit.com/comments/abc123", "https://www.reddit.com/comments/abc123/"],
  ["https://redd.it/abc123", "https://www.reddit.com/comments/abc123/"],
  ["https://www.reddit.com/r/aww/s/Ab3dEf9xYz", "https://www.reddit.com/r/aww/s/Ab3dEf9xYz"],
  ["https://reddit.com.evil.com/r/aww/comments/abc123/", null],
  ["https://evilreddit.com/r/aww/comments/abc123/", null],
  ["https://redd.it.evil.com/abc123", null],
  ["http://www.reddit.com/r/aww/comments/abc123/", null],
  ["https://user:pw@www.reddit.com/r/aww/comments/abc123/", null],
  ["https://www.reddit.com/r/aww/", null],
  ["https://redd.it/abc/def", null],
];
for (const [input, expected] of table) assert.equal(matchUrl(input)?.url ?? null, expected, input);

// ---- share link resolution via injected fetch
redditDeps.retryDelayMs = 1;
clearRedditCache();
redditDeps.fetch = (async (input: any, init: any) => {
  const url = String(input);
  if (url.includes("/s/")) {
    assert.equal(init.redirect, "manual");
    return reply(301, null, { location: "https://www.reddit.com/r/aww/comments/abc123/cat/" });
  }
  return reply(200, fixture);
}) as typeof fetch;
const shared = matchUrl("https://www.reddit.com/r/aww/s/Ab3dEf9xYz");
assert.ok(shared);
const resolved = await redditProvider.fetch(shared, stageDir("share"), {});
assert.match(fs.readFileSync(resolved.notePath, "utf8"), /abc123\//);

redditDeps.fetch = (async () =>
  reply(301, null, { location: "https://evil.example/x" })) as typeof fetch;
await assert.rejects(redditProvider.fetch(shared, stageDir("share-bad"), {}), /share link/);

// ---- fixture -> post.md; image download; 429 then success
clearRedditCache();
let feedCalls = 0;
redditDeps.fetch = (async (input: any) => {
  const url = String(input);
  if (url.endsWith(".rss")) {
    feedCalls++;
    return feedCalls === 1 ? reply(429, "slow down") : reply(200, fixture);
  }
  assert.equal(url, "https://i.redd.it/abc123.jpg", "only strict reddit media hosts fetched");
  return reply(200, Buffer.from("jpegdata"), { "content-type": "image/jpeg" });
}) as typeof fetch;
const link = matchUrl("https://www.reddit.com/r/aww/comments/abc123/cat/");
assert.ok(link);
const stage = stageDir("fixture");
const result = await redditProvider.fetch(link, stage, {});
assert.equal(feedCalls, 2, "retried once after 429");
assert.equal(result.kind, "images");
assert.deepEqual(result.missing, []);
assert.deepEqual(
  result.items.map((item) => item.name),
  ["image-1.jpg"],
);
const note = fs.readFileSync(result.notePath, "utf8");
assert.match(
  note,
  /^---\nprovider: reddit\nurl: "https:\/\/www.reddit.com\/r\/aww\/comments\/abc123\/"/,
);
assert.match(note, /title: "Cat: \\"friend\\" #1"/);
assert.match(note, /author: "\/u\/poster"/);
assert.match(note, /published: "2026-10-18T16:33:28\+00:00"/);
assert.match(note, /kind: images\nmissing: \[\]\n---/);
assert.match(note, /Look at this cat\n+Second line/);
assert.match(note, /Link: https:\/\/example.com\/article/);
assert.match(note, /\*\*\/u\/alice\*\*: Cute!/);
assert.match(note, /\*\*\/u\/bob\*\*: Agreed/);

// cache: second fetch within 60 s makes no feed call
await redditProvider.fetch(link, stageDir("cached"), {});
assert.equal(feedCalls, 2, "feed cached");

// ---- failed image becomes missing, not an error
clearRedditCache();
redditDeps.fetch = (async (input: any) =>
  String(input).endsWith(".rss") ? reply(200, fixture) : reply(404, "no")) as typeof fetch;
const partial = await redditProvider.fetch(link, stageDir("partial"), {});
assert.deepEqual(partial.missing, [1]);
assert.equal(partial.kind, "thread");

// ---- oEmbed fallback
clearRedditCache();
redditDeps.fetch = (async (input: any) => {
  const url = String(input);
  if (url.includes("/oembed?url="))
    return reply(200, JSON.stringify({ title: "Cat", author_name: "poster" }));
  return reply(429, "no");
}) as typeof fetch;
const fallback = await redditProvider.fetch(link, stageDir("oembed"), {});
assert.equal(fallback.kind, "thread");
const fallbackNote = fs.readFileSync(fallback.notePath, "utf8");
assert.match(fallbackNote, /title: "Cat"/);
assert.match(fallbackNote, /comments unavailable/);

clearRedditCache();
redditDeps.fetch = (async () => reply(403, "no")) as typeof fetch;
await assert.rejects(redditProvider.fetch(link, stageDir("dead"), {}), /Could not fetch/);

// ---- live probe
redditDeps.fetch = realFetch;
redditDeps.retryDelayMs = 2000;
clearRedditCache();
if (process.env.SHARE_LIVE !== "0") {
  const live = matchUrl("https://www.reddit.com/r/programming/comments/1x97lsb/");
  assert.ok(live);
  // reddit rate-limits rapid repeats (429 -> oEmbed fallback); retry a few times with a pause
  let liveNote = "";
  let liveKind = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    clearRedditCache();
    const liveResult = await redditProvider.fetch(live, stageDir(`live-${attempt}`), {});
    liveNote = fs.readFileSync(liveResult.notePath, "utf8");
    liveKind = liveResult.kind;
    if (!liveNote.includes("comments unavailable")) break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  assert.match(liveNote, /## Top comments\n\n\*\*\/u\//, "live post has at least one comment");
  console.log("live: ok", liveKind, liveNote.length, "bytes");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("share-reddit: ok");
