import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-insta-"));
const dataDir = path.join(root, "data");
const binDir = path.join(root, "bin");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
process.env.AGENT_CONSOLE_DATA = dataDir;

const { extractInstagramUrl, buildArgs, classifyError, downloadInstagram, BLOCKED_MESSAGE } =
  await import("../server/instagram.ts");

// ---- extraction table
const table: [string, string, string | null][] = [
  ["", "https://www.instagram.com/reel/ABCDE12345/", "https://www.instagram.com/reel/ABCDE12345/"],
  [
    "",
    "https://instagram.com/reels/ABCDE12345/?igsh=tracking&utm_source=x",
    "https://www.instagram.com/reel/ABCDE12345/",
  ],
  ["", "https://m.instagram.com/p/Cx_-1234567", "https://www.instagram.com/p/Cx_-1234567/"],
  ["", "https://www.instagram.com/tv/ABCDE12345/", "https://www.instagram.com/tv/ABCDE12345/"],
  [
    "look at this https://www.instagram.com/reel/ABCDE12345/?igsh=1 wow",
    "",
    "https://www.instagram.com/reel/ABCDE12345/",
  ],
  ["", "https://instagram.com.evil.com/reel/ABCDE12345/", null],
  ["", "https://evilinstagram.com/reel/ABCDE12345/", null],
  ["", "https://www.instagram.com.evil.com/reel/ABCDE12345/", null],
  ["", "http://www.instagram.com/reel/ABCDE12345/", null],
  ["", "https://www.instagram.com/stories/someone/12345/", null],
  ["", "https://user@www.instagram.com/reel/ABCDE12345/", null],
  ["", "https://www.instagram.com@evil.com/reel/ABCDE12345/", null],
  ["", "https://www.instagram.com/reel/abc/", null],
  ["", "https://www.instagram.com:8443/reel/ABCDE12345/", null],
  ["no link here", "", null],
];
for (const [text, url, want] of table)
  assert.equal(extractInstagramUrl(text, url)?.url ?? null, want, `${text} | ${url}`);

// ---- args and error classes
const args = buildArgs("https://www.instagram.com/reel/ABCDE12345/", "/tmp/out");
assert.equal(args.at(-1), "https://www.instagram.com/reel/ABCDE12345/");
assert.equal(args.at(-2), "--");
for (const flag of ["--ignore-config", "--no-cookies", "--no-progress", "--write-info-json"])
  assert.ok(args.includes(flag), flag);
assert.ok(!args.includes("--no-playlist"), "carousels need the playlist");
assert.equal(args[args.indexOf("--max-filesize") + 1], "100M");
assert.equal(args[args.indexOf("--playlist-end") + 1], "10");
assert.deepEqual(buildArgs("https://x/", "/tmp/out", [1, 8]).slice(3, 5), [
  "--playlist-items",
  "1,8",
]);
assert.equal(args[args.indexOf("-o") + 1], "/tmp/out/%(playlist_index|1)s.%(ext)s");
assert.equal(classifyError("ERROR: login required", 1), BLOCKED_MESSAGE);
assert.equal(classifyError("HTTP Error 429: rate-limit reached", 1), BLOCKED_MESSAGE);
assert.equal(classifyError("Video is not available", 1), BLOCKED_MESSAGE);
assert.match(classifyError("", "ETIMEDOUT"), /timed out/);
assert.match(classifyError("File is larger than max-filesize", 1), /too large/);
assert.match(classifyError("ERROR: Unsupported URL", 1), /valid Instagram link/);

// ---- fake yt-dlp
const fake = path.join(binDir, "yt-dlp");
fs.writeFileSync(
  fake,
  `#!/bin/sh
out=""
only=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  if [ "$1" = "--playlist-items" ]; then only="$2"; fi
  shift
done
dir=$(dirname "$out")
case "$(cat "$(dirname "$0")/mode" 2>/dev/null)" in
  blocked) echo "ERROR: [Instagram] login required" >&2; exit 1 ;;
  timeout) echo "ERROR: Read timed out" >&2; exit 1 ;;
  carousel)
    for i in 1 2 3; do printf "fakeslide$i" > "$dir/$i.mp4"; printf '{"description":"hello caption","uploader":"someone","secret":"RAWINFO"}' > "$dir/$i.info.json"; done
    printf 'fakeimage' > "$dir/4.jpg"
    exit 0 ;;
  flaky|gap)
    mode=$(cat "$(dirname "$0")/mode")
    for i in 1 2 3; do
      if [ -n "$only" ]; then case ",$only," in *",$i,"*) ;; *) continue ;; esac; fi
      if [ "$i" = 2 ]; then
        if [ "$mode" = gap ]; then rc=1; continue; fi
        if [ ! -f "$(dirname "$0")/seen" ]; then touch "$(dirname "$0")/seen"; rc=1; continue; fi
      fi
      printf "fakeslide$i" > "$dir/$i.mp4"
      printf '{"description":"hello caption","playlist_count":3}' > "$dir/$i.info.json"
    done
    echo "ERROR: unable to download video data" >&2
    [ "\${rc:-0}" = 1 ] && exit 1
    exit 0 ;;
esac
printf 'fakevideo' > "$dir/1.mp4"
printf '{"description":"hello caption","uploader":"someone","upload_date":"20260101","duration":12,"secret":"RAWINFO"}' > "$dir/1.info.json"
`,
  { mode: 0o755 },
);
process.env.AGENT_CONSOLE_YTDLP = fake;
const setMode = (mode: string) => fs.writeFileSync(path.join(binDir, "mode"), mode);
const link = (code: string) => extractInstagramUrl("", `https://www.instagram.com/reel/${code}/`)!;
const stageLeftovers = () => {
  const stageRoot = path.join(dataDir, "tmp");
  return fs.existsSync(stageRoot) ? fs.readdirSync(stageRoot) : [];
};

setMode("ok");
const good = await downloadInstagram(link("AAAAA11111"));
assert.deepEqual(
  good.items.map((item) => item.name),
  ["video.mp4"],
);
assert.equal(fs.readFileSync(good.items[0].path, "utf8"), "fakevideo");
const caption = fs.readFileSync(good.captionPath, "utf8");
assert.match(caption, /hello caption/);
assert.match(caption, /uploader: someone/);
assert.match(caption, /items: 1/);
assert.ok(!caption.includes("RAWINFO"), "raw info json must not leak");
good.cleanup();
assert.deepEqual(stageLeftovers(), []);

await assert.rejects(downloadInstagram(link("AAAAA11111")), /just requested/);

setMode("carousel");
const slides = await downloadInstagram(link("SLIDE11111"));
assert.deepEqual(
  slides.items.map((item) => item.name),
  ["slide-1.mp4", "slide-2.mp4", "slide-3.mp4", "slide-4.jpg"],
);
assert.equal(fs.readFileSync(slides.items[2].path, "utf8"), "fakeslide3");
const slideCaption = fs.readFileSync(slides.captionPath, "utf8");
assert.equal(slideCaption.match(/caption:/g)?.length, 1, "caption once");
assert.match(slideCaption, /items: 4/);
assert.ok(!slideCaption.includes("RAWINFO"));
slides.cleanup();

// a failed item is retried once and the post comes out whole
setMode("flaky");
const retried = await downloadInstagram(link("FLAKY11111"));
assert.deepEqual(
  retried.items.map((item) => item.name),
  ["slide-1.mp4", "slide-2.mp4", "slide-3.mp4"],
);
assert.ok(!fs.readFileSync(retried.captionPath, "utf8").includes("missing:"));
retried.cleanup();

// an item that never arrives is recorded, with the way to fetch it
setMode("gap");
const gapped = await downloadInstagram(link("GAPPY11111"));
assert.deepEqual(
  gapped.items.map((item) => item.name),
  ["slide-1.mp4", "slide-3.mp4"],
);
const gapCaption = fs.readFileSync(gapped.captionPath, "utf8");
assert.match(gapCaption, /downloaded: 2 of 3/);
assert.match(gapCaption, /^missing: 2$/m);
assert.match(
  gapCaption,
  /instagram-fetch https:\/\/www\.instagram\.com\/reel\/GAPPY11111\/ --items 2/,
);
gapped.cleanup();

// CLI: whole post, selected items, failure exit
const cliEnv = { ...process.env, AGENT_CONSOLE_YTDLP: fake };
const cliBin = path.join(process.cwd(), "bin", "instagram-fetch");
const cli = (...cliArgs: string[]) => spawnSync(cliBin, cliArgs, { env: cliEnv, encoding: "utf8" });
setMode("carousel");
const cliOut = path.join(root, "cli-out");
const cliRun = cli("https://www.instagram.com/p/CLIPOST1234/?igsh=x", "--out", cliOut);
assert.equal(cliRun.status, 0, cliRun.stderr);
const cliLines = cliRun.stdout.trim().split("\n");
assert.equal(cliLines.length, 5, "4 slides + caption");
assert.ok(cliLines[0].startsWith(`${cliOut}/slide-1.mp4 `), cliLines[0]);
assert.ok(cliLines.at(-1)!.startsWith(`${cliOut}/instagram.txt `));
assert.deepEqual(fs.readdirSync(cliOut).sort(), [
  "instagram.txt",
  "slide-1.mp4",
  "slide-2.mp4",
  "slide-3.mp4",
  "slide-4.jpg",
]);
const cliPartial = cli(
  "https://www.instagram.com/p/CLIPOST1234/",
  "--out",
  path.join(root, "cli-two"),
  "--items",
  "1,3",
);
assert.equal(cliPartial.status, 0, cliPartial.stderr);
setMode("blocked");
const cliBlocked = cli("https://www.instagram.com/p/CLIPOST1234/", "--out", path.join(root, "x"));
assert.equal(cliBlocked.status, 1);
assert.match(cliBlocked.stderr, /blocked anonymous download/);
assert.equal(cli("https://evil.com/p/CLIPOST1234/").status, 1);

setMode("blocked");
await assert.rejects(downloadInstagram(link("BBBBB22222")), { message: BLOCKED_MESSAGE });
setMode("timeout");
await assert.rejects(downloadInstagram(link("CCCCC33333")), /timed out/);
assert.deepEqual(stageLeftovers(), [], "staging removed on failure");

// ---- scratch server integration
const { makeToken } = await import("../server/auth.ts");
const port = 7300 + Math.floor(Math.random() * 500);
const fakeClaude = path.join(binDir, "claude");
fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
fs.writeFileSync(path.join(dataDir, "queues.json"), "{}");
setMode("ok");
const server: ChildProcess = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    PORT: String(port),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_RUN: path.join(root, "run"),
    AGENT_CONSOLE_BRAIN: path.join(root, "no-brain"),
  },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}`;
const cookie = `ac_session=${makeToken()}`;
const post = (origin: string, body: unknown) =>
  fetch(`${base}/api/share/instagram`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify(body),
  });
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await fetch(`${base}/login`).then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cross = await post("https://evil.example", {
    url: "https://www.instagram.com/reel/DDDDD44444/",
  });
  assert.equal(cross.status, 403);
  const bad = await post(base, { text: "nothing", url: "https://evil.com/reel/DDDDD44444/" });
  assert.equal(bad.status, 422);
  const shared = await post(base, {
    text: "",
    url: "https://www.instagram.com/reel/EEEEE55555/?igsh=1",
  });
  const body: any = await shared.json();
  assert.equal(shared.status, 200, JSON.stringify(body));
  const uploads = path.join(dataDir, "uploads", body.thread);
  assert.equal(fs.readdirSync(uploads).length, 2, "video + caption attached");
  const names = fs
    .readdirSync(uploads)
    .flatMap((uploadId) => fs.readdirSync(path.join(uploads, uploadId)));
  assert.deepEqual(names.sort(), ["instagram.txt", "video.mp4"]);
  assert.match(body.prompt, /Instagram reel/);
  assert.deepEqual(body.attachments.map((file: any) => file.name).sort(), [
    "instagram.txt",
    "video.mp4",
  ]);
  for (const file of body.attachments) {
    assert.ok(fs.existsSync(path.join(uploads, file.id, file.name)), file.name);
    assert.ok(file.size > 0 && file.kind && file.media_type);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "threads.json"), "utf8"));
  const thread = saved.find((entry: any) => entry.id === body.thread);
  assert.equal(thread.title, "Instagram reel EEEEE55555");
  assert.equal(thread.provider, "claude");
  const logFile = path.join(dataDir, "logs", `${body.thread}.jsonl`);
  assert.ok(
    !fs.existsSync(logFile) || !fs.readFileSync(logFile, "utf8").includes('"user_input"'),
    "share must not send a message",
  );
  const savedBefore = JSON.parse(fs.readFileSync(path.join(dataDir, "threads.json"), "utf8"));
  const intoExisting = await post(base, {
    url: "https://www.instagram.com/reel/GGGGG77777/",
    thread: body.thread,
  });
  const existingBody: any = await intoExisting.json();
  assert.equal(intoExisting.status, 200, JSON.stringify(existingBody));
  assert.equal(existingBody.thread, body.thread);
  assert.equal(fs.readdirSync(uploads).length, 4, "second video + caption attached to same thread");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "threads.json"), "utf8")).length,
    savedBefore.length,
    "no new thread when sharing into an existing one",
  );
  setMode("carousel");
  const multi = await post(base, { url: "https://www.instagram.com/p/CARO1234567/" });
  const multiBody: any = await multi.json();
  assert.equal(multi.status, 200, JSON.stringify(multiBody));
  assert.deepEqual(multiBody.attachments.map((file: any) => file.name).sort(), [
    "instagram.txt",
    "slide-1.mp4",
    "slide-2.mp4",
    "slide-3.mp4",
    "slide-4.jpg",
  ]);
  assert.match(multiBody.prompt, /post \(4 slides\)/);
  assert.match(multiBody.prompt, /instagram-fetch/);
  setMode("ok");
  for (const thread of ["nope", "00000000-0000-4000-8000-000000000000", 7]) {
    const unknown = await post(base, { url: "https://www.instagram.com/reel/HHHHH88888/", thread });
    assert.equal(unknown.status, 404, `thread ${thread}`);
  }
  setMode("blocked");
  const blocked = await post(base, { url: "https://www.instagram.com/reel/FFFFF66666/" });
  assert.equal(blocked.status, 422);
  assert.equal(((await blocked.json()) as any).error, BLOCKED_MESSAGE);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "threads.json"), "utf8")).length,
    2,
    "no thread on failure",
  );
  console.log("instagram-share: ok");
} finally {
  server.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
