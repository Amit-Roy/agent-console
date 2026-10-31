process.env.AGENT_CONSOLE_CAMOFOX_URL = "off";
process.env.AGENT_CONSOLE_CAMOFOX_AUTOSTART = "0";

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { runCamofoxFallback, pickMedia, pageExpression, defaultCamofoxDeps, isCdnUrl } =
  await import("../server/share/instagram-camofox.ts");
const { camofoxStartDeps, resetCamofoxStartState } = await import(
  "../server/share/camofox-start.ts"
);
const { camofoxCall, CamofoxUnavailableError } = await import("../server/share/camofox.ts");

const CODE = "DegFp34iI8Q";
const link = { provider: "instagram", url: `https://www.instagram.com/p/${CODE}/`, id: CODE };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(16)]);

const cdn = (index: number) => `https://scontent-1.cdninstagram.com/v/slide-${index}.jpg`;
const candidates = (index: number) => [
  { url: `${cdn(index)}?small`, width: 320 },
  { url: cdn(index), width: 1080 },
];
const slide = (index: number) => ({ image_versions2: { candidates: candidates(index) } });
const carouselPage = (count: number, code = CODE) =>
  JSON.stringify({
    items: [
      {
        code,
        caption: { text: "hello caption" },
        user: { username: "someone" },
        taken_at: 1700000000,
        carousel_media: Array.from({ length: count }, (_entry, offset) => slide(offset + 1)),
      },
      { code: "other", carousel_media: [slide(99), slide(98)] },
    ],
  });

// ---- pickMedia fixtures
const picked = pickMedia([carouselPage(13)], CODE)!;
assert.equal(picked.items.length, 13);
assert.equal(picked.items[0].image, cdn(1), "widest candidate");
assert.equal(picked.caption, "hello caption");
assert.equal(picked.username, "someone");
const byLargest = pickMedia([carouselPage(3, "zzz")], CODE)!;
assert.equal(byLargest.items.length, 3, "no code match falls back to largest carousel");
const preferred = pickMedia(
  [
    JSON.stringify({
      a: { code: CODE, carousel_media: [slide(1)] },
      b: { carousel_media: [slide(5), slide(6)] },
    }),
  ],
  CODE,
)!;
assert.equal(preferred.items.length, 1, "matching code preferred over larger carousel");
const single = pickMedia(
  [
    JSON.stringify({
      code: CODE,
      image_versions2: {
        candidates: [
          { url: "https://a.cdninstagram.com/x.jpg" },
          { url: "https://a.cdninstagram.com/y.jpg" },
        ],
      },
    }),
  ],
  CODE,
)!;
assert.deepEqual(
  single.items,
  [{ image: "https://a.cdninstagram.com/x.jpg", video: "" }],
  "no width: first candidate",
);
assert.equal(pickMedia(["not json", "{}"], CODE), null);

// ---- url checks
assert.ok(isCdnUrl("https://a.cdninstagram.com/x.jpg"));
assert.ok(isCdnUrl("https://scontent.fbcdn.net/x.jpg"));
for (const bad of [
  "http://a.cdninstagram.com/x",
  "https://evil.com/x",
  "https://a.cdninstagram.com:8443/x",
  "https://u:p@a.cdninstagram.com/x",
  "https://cdninstagram.com.evil.com/x",
  "https://xcdninstagram.com/x",
  "http://127.0.0.1/x",
])
  assert.equal(isCdnUrl(bad), false, bad);

// ---- mock camofox
let pageTexts: string[] = [];
let mode: "ok" | "evaluate500" | "empty-then-ok" = "ok";
const calls: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    calls.push(`${req.method} ${req.url?.split("?")[0]}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/tabs")
      return void res.end(JSON.stringify({ tabId: "t1" }));
    if (req.method === "DELETE") return void res.end("{}");
    if (req.url === "/tabs/t1/wait") {
      mode = "ok";
      return void res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/tabs/t1/evaluate") {
      if (mode === "evaluate500") {
        res.statusCode = 500;
        return void res.end("{}");
      }
      const expression = JSON.parse(body).expression as string;
      const doc = {
        querySelectorAll: () =>
          mode === "empty-then-ok" ? [] : pageTexts.map((textContent) => ({ textContent })),
      };
      const result = new Function("document", `return ${expression}`)(doc);
      return void res.end(JSON.stringify({ ok: true, result }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
process.env.AGENT_CONSOLE_CAMOFOX_URL = `http://127.0.0.1:${port}`;

const fetched: string[] = [];
const makeDeps = (
  override: Record<string, { url?: string; body: Buffer; status?: number }> = {},
) => ({
  call: camofoxCall,
  fetchMedia: async (url: string) => {
    fetched.push(url);
    const hit = override[url] ?? { body: JPEG };
    return { url: hit.url ?? url, status: hit.status ?? 200, body: hit.body };
  },
});
const stageDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ig-camofox-"));
const files = (dir: string) => fs.readdirSync(dir).sort();
const reset = () => {
  calls.length = 0;
  fetched.length = 0;
  mode = "ok";
};

// assertPublicHost resolves www.instagram.com; skip network-dependent cases when offline
const online = await import("node:dns").then((dns) =>
  dns.promises.lookup("www.instagram.com").then(
    () => true,
    () => false,
  ),
);
if (!online) console.log("share-instagram-camofox: offline, skipping runCamofoxFallback cases");
else {
  // 13-slide carousel
  reset();
  pageTexts = [carouselPage(13)];
  let dir = stageDir();
  await runCamofoxFallback(link, dir, {}, [], makeDeps());
  const names = files(dir);
  for (let num = 1; num <= 13; num++) assert.ok(names.includes(`${num}.jpg`), `${num}.jpg`);
  assert.equal(names.filter((name) => name.endsWith(".jpg")).length, 13);
  const info = JSON.parse(fs.readFileSync(path.join(dir, "1.info.json"), "utf8"));
  assert.equal(info.description, "hello caption");
  assert.equal(info.uploader, "someone");
  assert.equal(info.upload_date, "20231114");
  assert.equal(info.playlist_count, 13);
  assert.equal(fs.statSync(path.join(dir, "1.jpg")).mode & 0o777, 0o600);
  assert.ok(calls.includes("DELETE /tabs/t1"));
  assert.ok(!calls.some((call) => call.includes("cookies")));

  // existing info.json kept
  reset();
  dir = stageDir();
  fs.writeFileSync(path.join(dir, "1.info.json"), '{"description":"keep"}');
  await runCamofoxFallback(link, dir, {}, [1], makeDeps());
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "1.info.json"), "utf8")).description,
    "keep",
  );

  // wanted subset
  reset();
  dir = stageDir();
  await runCamofoxFallback(link, dir, {}, [2, 3], makeDeps());
  assert.deepEqual(
    files(dir).filter((name) => name.endsWith(".jpg")),
    ["2.jpg", "3.jpg"],
  );

  // non matching code but only unrelated carousels: largest is used, tiny page ignored when nothing
  reset();
  pageTexts = ["{}"];
  dir = stageDir();
  await runCamofoxFallback(link, dir, {}, [], makeDeps());
  assert.deepEqual(files(dir), [], "nothing found");

  // non-CDN urls never fetched or written
  reset();
  pageTexts = [
    JSON.stringify({
      code: CODE,
      carousel_media: [
        { image_versions2: { candidates: [{ url: "http://127.0.0.1/a.jpg", width: 1 }] } },
        { image_versions2: { candidates: [{ url: "https://evil.com/a.jpg", width: 1 }] } },
        {
          image_versions2: {
            candidates: [{ url: "https://a.cdninstagram.com:8443/a.jpg", width: 1 }],
          },
        },
        {
          image_versions2: {
            candidates: [{ url: "https://a.cdninstagram.com/redir.jpg", width: 1 }],
          },
        },
        {
          image_versions2: {
            candidates: [{ url: "https://a.cdninstagram.com/html.jpg", width: 1 }],
          },
        },
      ],
    }),
  ];
  dir = stageDir();
  await runCamofoxFallback(
    link,
    dir,
    {},
    [],
    makeDeps({
      "https://a.cdninstagram.com/redir.jpg": { url: "https://evil.com/final.jpg", body: JPEG },
      "https://a.cdninstagram.com/html.jpg": { body: Buffer.from("<html>nope</html>") },
    }),
  );
  assert.deepEqual(files(dir), [], "no file written");
  assert.deepEqual(fetched.sort(), [
    "https://a.cdninstagram.com/html.jpg",
    "https://a.cdninstagram.com/redir.jpg",
  ]);

  // video
  reset();
  pageTexts = [
    JSON.stringify({
      code: CODE,
      carousel_media: [
        { video_versions: [{ url: "https://v.cdninstagram.com/v.mp4" }], ...slide(1) },
      ],
    }),
  ];
  dir = stageDir();
  await runCamofoxFallback(
    link,
    dir,
    {},
    [],
    makeDeps({ "https://v.cdninstagram.com/v.mp4": { body: MP4 } }),
  );
  assert.deepEqual(
    files(dir).filter((name) => name.startsWith("1.") && !name.endsWith(".json")),
    ["1.mp4"],
  );

  // empty first evaluate, then wait, then ok
  reset();
  mode = "empty-then-ok";
  pageTexts = [carouselPage(2)];
  dir = stageDir();
  await runCamofoxFallback(link, dir, {}, [], makeDeps());
  assert.ok(calls.includes("POST /tabs/t1/wait"));
  assert.deepEqual(
    files(dir).filter((name) => name.endsWith(".jpg")),
    ["1.jpg", "2.jpg"],
  );

  // evaluate 500: quiet skip, tab deleted
  reset();
  mode = "evaluate500";
  dir = stageDir();
  await runCamofoxFallback(link, dir, {}, [], makeDeps());
  assert.deepEqual(files(dir), []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(calls.includes("DELETE /tabs/t1"), "DELETE after evaluate failure");

  // tabs timeout (simulated) and camofox down
  reset();
  dir = stageDir();
  await runCamofoxFallback(link, dir, {}, [], {
    ...makeDeps(),
    call: async () => {
      throw new CamofoxUnavailableError("timeout");
    },
  });
  assert.deepEqual(files(dir), []);
  process.env.AGENT_CONSOLE_CAMOFOX_URL = "http://127.0.0.1:1";
  await runCamofoxFallback(link, dir, {}, [], defaultCamofoxDeps);
  assert.deepEqual(files(dir), []);
  process.env.AGENT_CONSOLE_CAMOFOX_URL = `http://127.0.0.1:${port}`;
}

// ---- camofoxCall behavior
assert.deepEqual(await camofoxCall("/tabs", { method: "POST", body: "{}" }), { tabId: "t1" });
await assert.rejects(camofoxCall("/nope", {}), CamofoxUnavailableError);
process.env.AGENT_CONSOLE_CAMOFOX_URL = "off";
await assert.rejects(camofoxCall("/tabs", {}), CamofoxUnavailableError);
assert.match(pageExpression(CODE), /^\(\(\)=>\{function /);

// ---- autostart
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ig-camofox-repo-"));
  fs.writeFileSync(path.join(repo, "server.js"), "");
  const logFile = path.join(repo, "log", "server.log");
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const downPort = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  const lateServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tabId: "late" }));
  });
  const spawned: { command: string; args: string[]; options: any }[] = [];
  const realDeps = { ...camofoxStartDeps };
  Object.assign(camofoxStartDeps, {
    repoDir: () => repo,
    nodePath: () => "/fake/node",
    logPath: () => logFile,
    waitMs: 5000,
    cooldownMs: 60_000,
    spawn: (command: string, args: string[], options: any) => {
      spawned.push({ command, args, options });
      setTimeout(() => lateServer.listen(downPort, "127.0.0.1"), 300);
      return { unref() {} };
    },
  });
  const arm = (url: string, autostart = "1") => {
    spawned.length = 0;
    resetCamofoxStartState();
    process.env.AGENT_CONSOLE_CAMOFOX_URL = url;
    process.env.AGENT_CONSOLE_CAMOFOX_AUTOSTART = autostart;
  };

  arm(`http://127.0.0.1:${downPort}`);
  const results = await Promise.all([camofoxCall("/tabs", {}), camofoxCall("/tabs", {})]);
  assert.deepEqual(results, [{ tabId: "late" }, { tabId: "late" }]);
  assert.equal(spawned.length, 1, "concurrent callers share one spawn");
  assert.equal(spawned[0].command, "/fake/node");
  assert.deepEqual(spawned[0].args, ["server.js"]);
  assert.equal(spawned[0].options.cwd, repo);
  assert.equal(spawned[0].options.env.CAMOFOX_PORT, String(downPort));
  assert.equal(spawned[0].options.detached, true);
  assert.ok(fs.existsSync(path.dirname(logFile)), "log dir created");
  await new Promise((resolve) => lateServer.close(resolve));

  arm("off");
  await assert.rejects(camofoxCall("/tabs", {}), CamofoxUnavailableError);
  assert.equal(spawned.length, 0, "off never spawns");
  arm("http://192.0.2.1:9377");
  await assert.rejects(camofoxCall("/tabs", {}, undefined, 500), CamofoxUnavailableError);
  assert.equal(spawned.length, 0, "non-local url never spawns");
  arm(`http://127.0.0.1:${downPort}`, "0");
  await assert.rejects(camofoxCall("/tabs", {}), CamofoxUnavailableError);
  assert.equal(spawned.length, 0, "AUTOSTART=0 never spawns");

  Object.assign(camofoxStartDeps, realDeps);
  resetCamofoxStartState();
  process.env.AGENT_CONSOLE_CAMOFOX_AUTOSTART = "0";
  process.env.AGENT_CONSOLE_CAMOFOX_URL = "off";
  fs.rmSync(repo, { recursive: true, force: true });
}

server.close();
console.log("share-instagram-camofox: ok");
