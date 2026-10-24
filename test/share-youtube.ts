import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-yt-"));
const binDir = path.join(root, "bin");
fs.mkdirSync(binDir, { recursive: true });
delete process.env.AGENT_CONSOLE_YTDLP;

const { youtubeProvider, createYoutubeProvider } = await import("../server/share/youtube.ts");
const { ShareError } = await import("../server/share/types.ts");

const VID = "dQw4w9WgXcQ";
const CANON = `https://www.youtube.com/watch?v=${VID}`;
const table: [string, string | null][] = [
  [`https://www.youtube.com/watch?v=${VID}&t=5s`, CANON],
  [`https://youtube.com/watch?v=${VID}`, CANON],
  [`https://m.youtube.com/watch?v=${VID}`, CANON],
  [`https://music.youtube.com/watch?v=${VID}`, CANON],
  [`https://www.youtube.com/shorts/${VID}`, CANON],
  [`https://www.youtube.com/live/${VID}?feature=share`, CANON],
  [`https://www.youtube.com/embed/${VID}`, CANON],
  [`https://youtu.be/${VID}?si=abc`, CANON],
  [`https://youtube.com.evil.com/watch?v=${VID}`, null],
  [`https://youtu.be.evil.com/${VID}`, null],
  [`https://evilyoutube.com/watch?v=${VID}`, null],
  [`http://www.youtube.com/watch?v=${VID}`, null],
  [`https://user@www.youtube.com/watch?v=${VID}`, null],
  ["https://www.youtube.com/watch?v=short", null],
  ["https://www.youtube.com/", null],
];
for (const [input, want] of table)
  assert.equal(youtubeProvider.match(new URL(input))?.url ?? null, want, input);
for (const input of [
  "https://www.youtube.com/playlist?list=PLabcdefghijk",
  "https://www.youtube.com/watch?list=PLabcdefghijk",
])
  assert.throws(() => youtubeProvider.match(new URL(input)), ShareError, input);
// v plus list is a single video
assert.equal(
  youtubeProvider.match(new URL(`https://www.youtube.com/watch?v=${VID}&list=PLx`))?.url,
  CANON,
);

// ---- fake yt-dlp
const fake = path.join(binDir, "yt-dlp");
fs.writeFileSync(
  fake,
  `#!/bin/sh
out=""; subs=""; vid=""
while [ $# -gt 0 ]; do
  [ "$1" = "-o" ] && out="$2"
  [ "$1" = "--write-auto-subs" ] && subs=1
  [ "$1" = "-f" ] && vid=1
  shift
done
dir=$(dirname "$out")
mode=$(cat "$(dirname "$0")/mode")
[ "$mode" = bot ] && { echo "ERROR: Sign in to confirm you're not a bot" >&2; exit 1; }
if [ -n "$subs" ]; then printf 'WEBVTT' > "$dir/sub.en.vtt"; exit 0; fi
if [ -n "$vid" ]; then
  [ "$mode" = nodl ] && { echo "ERROR: unavailable" >&2; exit 1; }
  printf 'fakevideo' > "$dir/video.mp4"; exit 0
fi
dur=60; [ "$mode" = long ] && dur=3600
printf '{"title":"T: x","description":"desc","channel":"Chan","upload_date":"20260102","duration":%s,"chapters":[{"start_time":0,"title":"Intro"}]}' "$dur" > "$dir/meta.info.json"
`,
  { mode: 0o755 },
);
process.env.AGENT_CONSOLE_YTDLP = fake;
const setMode = (mode: string) => fs.writeFileSync(path.join(binDir, "mode"), mode);
const stage = () => fs.mkdtempSync(path.join(root, "stage-"));
const fakeFetch = async () =>
  new Response(JSON.stringify({ title: "Oembed title", author_name: "Oembed Author" }));
const provider = createYoutubeProvider(fakeFetch as any);
const link = provider.match(new URL(CANON))!;

setMode("short");
const okStage = stage();
const ok = await provider.fetch(link, okStage, {});
assert.deepEqual(
  ok.items.map((item) => item.name),
  ["video.mp4"],
);
assert.deepEqual(ok.missing, []);
const note = fs.readFileSync(ok.notePath, "utf8");
assert.match(
  note,
  /^---\nprovider: youtube\nurl: https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ\ntitle: "T: x"/,
);
assert.match(note, /kind: video\nmissing: \[\]/);
assert.match(note, /Duration: 1:00/);
assert.match(note, /- 0:00 Intro/);
assert.ok(!note.includes("Video not attached"));

setMode("long");
const longRun = await provider.fetch(link, stage(), {});
assert.deepEqual(
  longRun.items.map((item) => item.name),
  ["transcript.vtt"],
);
assert.deepEqual(longRun.missing, [1]);
assert.match(fs.readFileSync(longRun.notePath, "utf8"), /Video not attached/);

setMode("nodl");
const noDl = await provider.fetch(link, stage(), {});
assert.deepEqual(
  noDl.items.map((item) => item.name),
  ["transcript.vtt"],
);

setMode("bot");
const bot = await provider.fetch(link, stage(), {});
assert.deepEqual(bot.items, []);
assert.deepEqual(bot.missing, [1]);
const botNote = fs.readFileSync(bot.notePath, "utf8");
assert.match(botNote, /title: "Oembed title"/);
assert.match(botNote, /author: "Oembed Author"/);
assert.match(botNote, /Video not attached/);

const failing = createYoutubeProvider((async () => new Response("no", { status: 500 })) as any);
await assert.rejects(failing.fetch(link, stage(), {}), ShareError);

// ---- live probe (SHARE_LIVE=0 to skip)
delete process.env.AGENT_CONSOLE_YTDLP;
if (process.env.SHARE_LIVE === "0") console.log("live probe skipped: SHARE_LIVE=0");
else {
  const liveLink = youtubeProvider.match(new URL("https://youtu.be/jNQXAC9IVRw"))!;
  const liveStage = stage();
  const live = await youtubeProvider.fetch(liveLink, liveStage, {}).catch((error) => error);
  if (live instanceof Error) console.log(`live probe skipped: ${live.message}`);
  else if (!live.items.some((item) => item.name === "video.mp4"))
    console.log("live probe skipped: bot check (fell back; no video.mp4)");
  else {
    assert.ok(fs.statSync(live.items[0].path).size > 0);
    assert.match(fs.readFileSync(live.notePath, "utf8"), /^---\nprovider: youtube/);
    console.log("live probe ok: video.mp4 + post.md");
  }
}
console.log("ok");
