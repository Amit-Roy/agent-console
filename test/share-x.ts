import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createXProvider,
  expandText,
  fromSyndication,
  fromVxTwitter,
  matchX,
  xProvider,
} from "../server/share/x.ts";

const table: [string, string | null][] = [
  ["https://x.com/jack/status/20", "https://x.com/jack/status/20"],
  ["https://twitter.com/jack/status/20?s=20&t=abc", "https://x.com/jack/status/20"],
  ["https://www.twitter.com/jack/status/20/photo/1", "https://x.com/jack/status/20"],
  ["https://mobile.twitter.com/jack/status/20", "https://x.com/jack/status/20"],
  ["https://mobile.x.com/jack/status/20", "https://x.com/jack/status/20"],
  ["https://www.x.com/jack/status/20/video/1", "https://x.com/jack/status/20"],
  ["https://x.com.evil.com/jack/status/20", null],
  ["https://evilx.com/jack/status/20", null],
  ["https://x.com@evil.com/jack/status/20", null],
  ["http://x.com/jack/status/20", null],
  ["https://x.com/i/web/status/20", null],
  ["https://x.com/jack/status/", null],
  ["https://x.com/jack/status/abc", null],
  ["https://x.com/jack/status/20abc", null],
  ["https://x.com/jack", null],
];
for (const [input, want] of table) assert.equal(matchX(new URL(input))?.url ?? null, want, input);

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/share-x/${name}`, import.meta.url), "utf8"));
const syn = fromSyndication(fixture("syndication.json"), "99");
assert.ok(syn);
assert.equal(syn.text, "Hello https://example.com/page\nbye");
assert.equal(syn.quoted?.handle, "other");
assert.equal(syn.likes, 12);
assert.equal(syn.media.length, 2);
assert.equal(fromSyndication({ __typename: "TweetTombstone" }, "1"), null);
assert.equal(
  expandText("a https://t.co/x", {
    urls: [{ url: "https://t.co/x", expanded_url: "https://e.com" }],
  }),
  "a https://e.com",
);
const vx = fromVxTwitter(fixture("vx.json"), "99");
assert.equal(vx?.handle, "jack");
assert.equal(vx?.media[0].type, "video");

// ---- injected fetch: photo + video with yt-dlp failing -> direct mp4 fallback
const bytes = (size: number) => new Response(Buffer.alloc(size, 1));
const seen: string[] = [];
const fakeFetch = (async (input: any) => {
  const url = String(input);
  seen.push(url);
  if (url.startsWith("https://cdn.syndication.twimg.com/"))
    return Response.json(fixture("syndication.json"));
  if (url.startsWith("https://pbs.twimg.com/media/a.jpg?name=orig"))
    return new Response("", { status: 404 });
  if (url.startsWith("https://pbs.twimg.com/media/a.jpg?name=large")) return bytes(10);
  if (url.startsWith("https://video.twimg.com/hi.mp4")) return bytes(20);
  return new Response("", { status: 404 });
}) as typeof fetch;
const provider = createXProvider({
  fetchFn: fakeFetch,
  ytdlp: async () => {
    throw new Error("yt-dlp down");
  },
});
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "share-x-"));
const result = await provider.fetch(
  provider.match(new URL("https://twitter.com/jack/status/99"))!,
  stage,
  {},
);
assert.equal(result.kind, "video");
assert.deepEqual(result.items.map((item) => item.name).sort(), ["image-1.jpg", "video.mp4"]);
assert.deepEqual(result.missing, []);
assert.ok(!seen.some((url) => url.includes("evil")));
const note = fs.readFileSync(result.notePath, "utf8");
assert.match(note, /^---\nprovider: x\nurl: "https:\/\/x.com\/jack\/status\/99"/);
assert.match(note, /kind: video\nmissing: \[\]\n---/);
assert.match(note, /> Quoted Other \(@other\)/);
assert.match(note, /12 likes, 3 replies/);

// ---- vx fallback + unavailable
const vxOnly = createXProvider({
  fetchFn: (async (input: any) => {
    const url = String(input);
    if (url.includes("syndication")) return new Response("", { status: 404 });
    return Response.json({ ...fixture("vx.json"), media_extended: [] });
  }) as typeof fetch,
  ytdlp: async () => {},
});
const vxStage = fs.mkdtempSync(path.join(os.tmpdir(), "share-x-"));
const vxResult = await vxOnly.fetch(
  { provider: "x", id: "99", url: "https://x.com/jack/status/99" },
  vxStage,
  {},
);
assert.equal(vxResult.kind, "thread");
const gone = createXProvider({
  fetchFn: (async () => new Response("", { status: 404 })) as typeof fetch,
  ytdlp: async () => {},
});
await assert.rejects(
  gone.fetch({ provider: "x", id: "1", url: "https://x.com/a/status/1" }, vxStage, {}),
  /That post is unavailable or private\./,
);

// ---- hostile media hosts are never fetched
const evilSeen: string[] = [];
const evil = createXProvider({
  fetchFn: (async (input: any) => {
    const url = String(input);
    evilSeen.push(url);
    if (url.includes("syndication"))
      return Response.json({
        ...fixture("syndication.json"),
        mediaDetails: [
          { type: "photo", media_url_https: "https://pbs.twimg.com.evil.com/media/a.jpg" },
        ],
      });
    return new Response("", { status: 404 });
  }) as typeof fetch,
  ytdlp: async () => {},
});
const evilResult = await evil.fetch(
  { provider: "x", id: "99", url: "https://x.com/jack/status/99" },
  vxStage,
  {},
);
assert.deepEqual(evilResult.missing, [1]);
assert.ok(!evilSeen.some((url) => url.includes("evil")));

// ---- live probe
if (process.env.SHARE_LIVE !== "0") {
  const live = async (id: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-x-live-"));
    const out = await xProvider.fetch(
      { provider: "x", id, url: `https://x.com/i/status/${id}` },
      dir,
      {},
    );
    assert.ok(fs.readFileSync(out.notePath, "utf8").startsWith("---\nprovider: x"));
    console.log(
      `live ${id}: kind=${out.kind} items=${out.items.map((item) => item.name).join(",")} missing=${out.missing}`,
    );
    return out;
  };
  assert.equal((await live("20")).kind, "thread");
  const media = await live("1585341984679469056");
  assert.equal(media.kind, "video");
}
console.log("share-x ok");
