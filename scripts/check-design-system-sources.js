/**
 * Scheduled design-system suggestions. Reads popular design posts from a fixed list of sources (SOURCES),
 * triages each one (triage), and files one GitHub issue per approved suggestion. Every run writes a file:
 * a dry run writes the proposed issues to <out>/drafts.json; a real run writes <out>/runs/<time>.json with
 * what it created and what it skipped and why. Already-filed links are read back from the repo's issues.
 *
 *   node scripts/check-design-system-sources.js --dry-run   # drafts only, creates nothing
 *   node scripts/check-design-system-sources.js             # creates the approved issues
 *   options: --out DIR (default logs/design-system), --repo OWNER/NAME (default nefr0/agent-console)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const VERSION = 1;
const USER_AGENT = "agent-console-design-system/0.2 (+https://github.com/nefr0/agent-console)";
const LABELS = ["design-system", "enhancement"];
const DAY_MS = 86_400_000;
export const RULES = { maxAgeDays: 90, maxIssuesPerRun: 3 };

const HN_ORIGIN = "https://hn.algolia.com/api/v1/search";
const HN_POINTS = 100;
const HN_QUERIES = [
  "design system",
  "design tokens",
  "dark mode",
  "typography",
  "accessibility",
  "color contrast",
];
const hnUrl = (query, now) => {
  const since = Math.floor((now - RULES.maxAgeDays * DAY_MS) / 1000);
  const params = new URLSearchParams({
    query,
    tags: "story",
    numericFilters: `points>=${HN_POINTS},created_at_i>${since}`,
    hitsPerPage: "20",
  });
  return `${HN_ORIGIN}?${params}`;
};

// The only places a run reads. Popularity is the community's own vote count.
export const SOURCES = [
  {
    name: "Hacker News",
    origin: HN_ORIGIN,
    unit: "points",
    minScore: HN_POINTS,
    urls: (now) => HN_QUERIES.map((query) => hnUrl(query, now)),
    parse: (body) =>
      (body?.hits ?? []).map((hit) => ({
        title: hit.title,
        url: hit.url,
        discussion: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        score: hit.points,
        comments: hit.num_comments,
        postedAt: hit.created_at,
      })),
  },
  {
    name: "Lobsters",
    origin: "https://lobste.rs/t/",
    unit: "votes",
    minScore: 20,
    urls: () => ["https://lobste.rs/t/design,css,a11y.json"],
    parse: (body) =>
      (Array.isArray(body) ? body : []).map((post) => ({
        title: post.title,
        url: post.url,
        discussion: post.short_id_url,
        score: post.score,
        comments: post.comment_count,
        postedAt: post.created_at,
      })),
  },
];

// Title words -> the docs/design-system.md section the suggestion would change. First match wins.
const TOPICS = [
  { section: "Colors", words: ["color", "colour", "contrast", "dark mode", "theme", "palette"] },
  { section: "Typography", words: ["typograph", "font", "typeface", "type scale"] },
  { section: "Spacing", words: ["spacing", "layout", "density"] },
  { section: "Animation Durations", words: ["animation", "motion", "transition"] },
  { section: "Icon-Pack Style Constraint", words: ["icon"] },
  {
    section: "Usage Guidelines",
    words: ["accessib", "a11y", "focus", "keyboard", "screen reader"],
  },
  {
    section: "Components",
    words: ["design system", "design token", "component", "button", "dialog", "modal"],
  },
];
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const topicOf = (title) =>
  TOPICS.find(({ words }) =>
    words.some((word) => new RegExp(`\\b${escapeRegex(word)}`, "i").test(title)),
  )?.section;

/** One suggestion -> { verdict: "approve" | "skip", reason, section }. `known` holds links already filed. */
export function triage(item, { now, known }) {
  const { source } = item;
  const section = topicOf(item.title);
  const skip = (reason) => ({ verdict: "skip", reason, section });
  if (known.has(item.url)) return skip("already filed as an issue");
  if (!section) return skip("off-topic: no design-system topic in the title");
  if (!(item.score >= source.minScore))
    return skip(`below popularity: ${item.score} < ${source.minScore} ${source.unit}`);
  if (!(now - Date.parse(item.postedAt) <= RULES.maxAgeDays * DAY_MS))
    return skip(`older than ${RULES.maxAgeDays} days`);
  return {
    verdict: "approve",
    section,
    reason: `on topic for ${section}, ${item.score} >= ${source.minScore} ${source.unit}, posted in the last ${RULES.maxAgeDays} days`,
  };
}

// External titles go into issue text: drop control characters and break @mentions so nobody gets pinged.
const clean = (text, max) =>
  String(text ?? "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .replace(/@(?=\w)/g, "@\u200b")
    .trim()
    .slice(0, max);
const httpUrl = (value) => (/^https?:\/\/\S+$/.test(String(value ?? "")) ? value : null);
// Titles are quoted as plain text in the issue body: escape markdown so a title cannot embed links or images.
const plainMarkdown = (text) => text.replace(/[\\`*_[\]<>!#|~]/g, "\\$&");

function draftIssue(item, verdict) {
  const posted = String(item.postedAt).slice(0, 10);
  return {
    title: `Design system (${verdict.section}): ${clean(item.title, 100)}`,
    labels: LABELS,
    body: [
      `Popular on ${item.source.name}: ${item.score} ${item.source.unit}, ${item.comments ?? 0} comments, posted ${posted}.`,
      "",
      `> ${plainMarkdown(clean(item.title, 300))}`,
      "",
      `Link: ${item.url}`,
      `Discussion: ${item.discussion}`,
      "",
      `Triage: approved, ${verdict.reason}.`,
      "",
      `Next: read the post and decide whether it changes the ${verdict.section} section of docs/design-system.md. ` +
        "If it does, change the token layer in public/style.css and run `node scripts/build-design-system.js`.",
      "",
      "Filed by the scheduled task scripts/check-design-system-sources.js.",
    ].join("\n"),
  };
}

async function readSource(source, { fetch: fetchFn, now }, errors) {
  const items = [];
  for (const url of source.urls(now)) {
    try {
      const response = await fetchFn(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const raw of source.parse(await response.json())) {
        const discussion = httpUrl(raw.discussion);
        const link = httpUrl(raw.url) ?? discussion;
        if (link && raw.title)
          items.push({ ...raw, url: link, discussion: discussion ?? link, source });
      }
    } catch (error) {
      errors.push(`${source.name} ${url}: ${error.message}`);
    }
  }
  return items;
}

// All sources, one entry per post (the same post found by two queries of one source counts once).
async function collect(request, errors) {
  const posts = new Map();
  for (const source of SOURCES)
    for (const item of await readSource(source, request, errors))
      posts.set(`${source.name} ${item.discussion}`, item);
  return [...posts.values()].sort((left, right) => right.score - left.score);
}

function knownLinks(gh, errors) {
  try {
    const links = gh
      .list()
      .flatMap((issue) => String(issue.body ?? "").match(/https?:\/\/\S+/g) ?? []);
    return { known: new Set(links), listed: true };
  } catch (error) {
    errors.push(`listing existing issues failed: ${error.message}`);
    return { known: new Set(), listed: false };
  }
}

function decide(items, now, known) {
  const approved = [];
  const skipped = [];
  const inRun = new Set();
  for (const item of items) {
    const entry = { source: item.source.name, title: item.title, url: item.url, score: item.score };
    if (inRun.has(item.url)) {
      skipped.push({ ...entry, reason: "same link already in this run" });
      continue;
    }
    inRun.add(item.url);
    const verdict = triage(item, { now, known });
    if (verdict.verdict === "skip") skipped.push({ ...entry, reason: verdict.reason });
    else if (approved.length >= RULES.maxIssuesPerRun)
      skipped.push({ ...entry, reason: `over the per-run cap of ${RULES.maxIssuesPerRun}` });
    else approved.push({ ...entry, draft: draftIssue(item, verdict) });
  }
  return { approved, skipped };
}

function fileIssues(approved, gh, listed, outcome) {
  for (const suggestion of approved) {
    const entry = { source: suggestion.source, title: suggestion.title, url: suggestion.url };
    if (!listed) {
      outcome.skipped.push({
        ...entry,
        reason: "approved but not created: existing issues unknown",
      });
      continue;
    }
    try {
      outcome.created.push({ ...entry, issue: gh.create(suggestion.draft) });
    } catch (error) {
      outcome.errors.push(`creating "${suggestion.draft.title}" failed: ${error.message}`);
      outcome.skipped.push({
        ...entry,
        reason: "approved but not created: gh failed, retried next run",
      });
    }
  }
}

function ghClient(repo) {
  const gh = (args, input) =>
    execFileSync("gh", args, { encoding: "utf8", input, timeout: 60_000 });
  return {
    list: () =>
      JSON.parse(
        gh([
          "issue",
          "list",
          "--repo",
          repo,
          "--label",
          LABELS[0],
          "--state",
          "all",
          "--limit",
          "1000",
          "--json",
          "body",
        ]),
      ),
    create: ({ title, body, labels }) =>
      gh(
        [
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--body-file",
          "-",
          ...labels.flatMap((label) => ["--label", label]),
        ],
        body,
      ).trim(),
  };
}

/**
 * request: { dryRun, outDir, repo, now, fetch, gh: { list, create }, log, warn }; every field optional.
 * response: { version, dryRun, sources, approved, created, skipped, errors, file }.
 */
export async function run(request = {}) {
  const now = request.now ?? Date.now();
  const outDir = resolve(request.outDir ?? "logs/design-system");
  const gh = request.gh ?? ghClient(request.repo ?? "nefr0/agent-console");
  const { log = console.log, warn = console.error } = request;
  const errors = [];
  const items = await collect({ fetch: request.fetch ?? globalThis.fetch, now }, errors);
  const { known, listed } = knownLinks(gh, errors);
  const { approved, skipped } = decide(items, now, known);
  const outcome = {
    version: VERSION,
    dryRun: !!request.dryRun,
    ranAt: new Date(now).toISOString(),
    sources: SOURCES.map(({ name, origin, minScore, unit }) => ({ name, origin, minScore, unit })),
    read: items.length,
    approved: approved.map(({ draft, ...entry }) => ({ ...entry, ...draft })),
    created: [],
    skipped,
    errors,
  };
  if (!outcome.dryRun) fileIssues(approved, gh, listed, outcome);
  const file = outcome.dryRun
    ? join(outDir, "drafts.json")
    : join(outDir, "runs", `${outcome.ranAt.replace(/[:.]/g, "-")}.json`);
  const { approved: drafts, ...rest } = outcome;
  const saved = outcome.dryRun ? { ...rest, drafts } : outcome;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  for (const error of errors) warn(error);
  for (const suggestion of outcome.approved)
    log(`${outcome.dryRun ? "would file" : "approved"}: ${suggestion.title}`);
  for (const issue of outcome.created) log(`created: ${issue.issue} ${issue.title}`);
  log(
    `read ${items.length} posts, approved ${approved.length}, created ${outcome.created.length}, skipped ${skipped.length}, errors ${errors.length}; wrote ${file}`,
  );
  return { ...outcome, file };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean" }, out: { type: "string" }, repo: { type: "string" } },
  });
  const result = await run({ dryRun: values["dry-run"], outDir: values.out, repo: values.repo });
  const nothingRead = result.read === 0 && result.errors.length > 0;
  const notFiled = result.created.length < result.approved.length && !result.dryRun;
  if (nothingRead || notFiled) process.exitCode = 1;
}
