import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BYTE_BUDGET,
  buildDigest,
  type FetchFn,
  isAiText,
  readSeenUrls,
  renderText,
  type Section,
} from "../scripts/ai-digest.ts";

const dir = new URL("./fixtures/ai-digest/", import.meta.url);
const fix = (name: string) => readFileSync(new URL(name, dir), "utf8");
const NOW = Date.parse("2026-11-01T12:00:00Z");

function fakeFetch(map: Record<string, string | Error>): FetchFn {
  return async (url) => {
    const key = Object.keys(map).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response("nope", { status: 404 });
    const body = map[key];
    if (body instanceof Error) throw body;
    return new Response(body, { status: 200 });
  };
}

const base = {
  "https://github.com/trending": fix("trending.html"),
  "https://rss.arxiv.org/": fix("arxiv-full.xml"),
  "https://huggingface.co/api/daily_papers": fix("hf-daily.json"),
  "https://trends.google.com/": fix("trends.xml"),
};
const run = (map: Record<string, string | Error>, seen = new Set<string>()) =>
  buildDigest(fakeFetch(map), { now: NOW, seen, gapMs: 0 });
const byName = (sections: Section[], name: string) =>
  sections.find((section) => section.name === name)!;

assert.ok(
  isAiText("Claude agent") &&
    isAiText("RAG pipeline") &&
    !isAiText("football score") &&
    !isAiText("said grail"),
);

const full = await run(base);
const gh = byName(full, "GitHub").items;
assert.deepEqual(
  gh.map((item) => item.url),
  ["https://github.com/acme/agent-kit", "https://github.com/bar/tiny-gpt"],
);
assert.equal(gh[0].metric, "1,234 stars today");
const ax = byName(full, "arXiv").items;
assert.equal(ax.length, 1);
assert.equal(ax[0].metric, "42 upvotes");
const tr = byName(full, "Trends").items;
assert.equal(tr.length, 1);
assert.match(tr[0].metric, /200K\+/);

const atom = await run({
  ...base,
  "https://rss.arxiv.org/": fix("arxiv-empty.xml"),
  "https://export.arxiv.org/": fix("arxiv-atom.xml"),
});
assert.deepEqual(
  byName(atom, "arXiv").items.map((item) => item.url),
  ["https://arxiv.org/abs/2610.00003"],
);
assert.equal(byName(atom, "arXiv").items[0].metric, "7 upvotes");

const fallback = await run({
  ...base,
  "https://github.com/trending": new Error("down"),
  "https://api.github.com/": fix("search.json"),
});
assert.equal(byName(fallback, "GitHub").items[0].url, "https://github.com/zed/llm-lab");

const dir2 = mkdtempSync(join(tmpdir(), "digest-"));
const report = join(dir2, "report.md");
writeFileSync(
  report,
  "seen https://github.com/acme/agent-kit and (https://arxiv.org/abs/2610.00001)",
);
assert.equal(readSeenUrls(report).size, 2);
const deduped = await run(base, readSeenUrls(report));
assert.deepEqual(
  byName(deduped, "GitHub").items.map((item) => item.url),
  ["https://github.com/bar/tiny-gpt"],
);
assert.equal(byName(deduped, "arXiv").items.length, 0);

const partial = await run({ ...base, "https://rss.arxiv.org/": new Error("boom") });
const text = renderText(partial);
assert.match(text, /^error arxiv: boom$/m);
assert.match(text, /## GitHub/);
assert.match(text, /## Trends/);

const noTrends = await run({
  ...base,
  "https://trends.google.com/":
    "<rss><channel><item><title>football</title></item></channel></rss>",
});
assert.match(renderText(noTrends), /no AI trends today/);

const huge: Section[] = [
  {
    name: "GitHub",
    items: Array.from({ length: 2000 }, (_, idx) => ({
      title: `llm repo ${idx} ${"x".repeat(150)}`,
      url: `https://github.com/a/${idx}`,
      date: "2026-11-01",
      metric: "1 stars today",
      score: idx,
    })),
  },
];
assert.ok(Buffer.byteLength(renderText(huge)) <= BYTE_BUDGET);

console.log("ai-digest tests passed");
