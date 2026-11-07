import { readFileSync } from "node:fs";
import { DOMParser, parseHTML } from "linkedom";

export type Item = { title: string; url: string; date: string; metric: string; score: number };
export type Section = { name: string; items: Item[]; error?: string; empty?: string };
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export const BYTE_BUDGET = 16 * 1024;
const AI_WORDS =
  /\b(llms?|agents?|agentic|ai|gpt|chatgpt|openai|anthropic|claude|gemini|deepseek|llama|mistral|diffusion|transformers?|rag|mcp|models?|neural|copilot|embeddings?|fine-?tun\w*|reasoning|multimodal|vlm|machine learning)\b/i;
const AI_TOPICS = new Set([
  "llm",
  "ai",
  "agent",
  "agents",
  "machine-learning",
  "deep-learning",
  "gpt",
  "rag",
  "mcp",
  "generative-ai",
  "artificial-intelligence",
]);
const ARXIV_GAP_MS = 3000;
const HOUR_MS = 3600_000;

export const isAiText = (text: string): boolean => AI_WORDS.test(text);
const textOf = (node: Element | null | undefined): string =>
  (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const isoDay = (value: string | number | Date): string => {
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? "" : stamp.toISOString().slice(0, 10);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function request(fetchFn: FetchFn, url: string): Promise<string> {
  const reply = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
  if (!reply.ok) throw new Error(`HTTP ${reply.status} ${url}`);
  return reply.text();
}

export function parseTrending(html: string): Item[] {
  const { document } = parseHTML(html);
  const rows = [...document.querySelectorAll("article.Box-row")];
  return rows.flatMap((row) => {
    const href = row.querySelector("h2 a")?.getAttribute("href");
    if (!href) return [];
    const stars = textOf(row.querySelector("span.float-sm-right")).match(
      /([\d,]+)\s+stars?\s+today/i,
    );
    const desc = textOf(row.querySelector("p"));
    const name = href.replace(/^\//, "");
    const topics = [...row.querySelectorAll("a.topic-tag")].map((tag) => textOf(tag).toLowerCase());
    if (!isAiText(`${name} ${desc}`) && !topics.some((topic) => AI_TOPICS.has(topic))) return [];
    const score = stars ? Number(stars[1].replaceAll(",", "")) : 0;
    return [
      {
        title: `${name}${desc ? ` - ${desc}` : ""}`,
        url: `https://github.com/${name}`,
        date: isoDay(Date.now()),
        metric: `${stars ? stars[1] : "?"} stars today`,
        score,
      },
    ];
  });
}

export function parseSearch(json: string): Item[] {
  const data = JSON.parse(json) as { items?: Array<Record<string, unknown>> };
  return (data.items ?? []).map((repo) => ({
    title: `${repo.full_name}${repo.description ? ` - ${repo.description}` : ""}`,
    url: String(repo.html_url),
    date: isoDay(String(repo.created_at)),
    metric: `${repo.stargazers_count} stars`,
    score: Number(repo.stargazers_count) || 0,
  }));
}

export async function fetchGithub(fetchFn: FetchFn, now = Date.now()): Promise<Item[]> {
  try {
    const items = parseTrending(await request(fetchFn, "https://github.com/trending?since=daily"));
    if (items.length) return items;
  } catch {
    // fall through to the search API
  }
  const since = isoDay(now - 7 * 24 * HOUR_MS);
  const url = `https://api.github.com/search/repositories?q=topic:llm+created:>${since}&sort=stars&order=desc&per_page=30`;
  return parseSearch(await request(fetchFn, url));
}

type RawPaper = { id: string; title: string; date: string; text: string };

function xmlDoc(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

const arxivId = (url: string): string => (url.match(/(\d{4}\.\d{4,5})/) ?? [])[1] ?? "";

export function parseArxivRss(xml: string): RawPaper[] {
  return [...xmlDoc(xml).querySelectorAll("item")].map((item) => {
    const link = textOf(item.querySelector("link"));
    return {
      id: arxivId(link),
      title: textOf(item.querySelector("title")),
      date: isoDay(textOf(item.querySelector("pubDate"))),
      text: textOf(item.querySelector("description")),
    };
  });
}

export function parseArxivAtom(xml: string, now: number): RawPaper[] {
  const cutoff = now - 48 * HOUR_MS;
  return [...xmlDoc(xml).querySelectorAll("entry")]
    .map((entry) => ({
      id: arxivId(textOf(entry.querySelector("id"))),
      title: textOf(entry.querySelector("title")),
      date: textOf(entry.querySelector("published")),
      text: textOf(entry.querySelector("summary")),
    }))
    .filter((paper) => new Date(paper.date).getTime() >= cutoff)
    .map((paper) => ({ ...paper, date: isoDay(paper.date) }));
}

export function parseHfUpvotes(json: string): Map<string, number> {
  const rows = JSON.parse(json) as Array<{ paper?: { id?: string; upvotes?: number } }>;
  const votes = new Map<string, number>();
  for (const row of rows) if (row.paper?.id) votes.set(row.paper.id, row.paper.upvotes ?? 0);
  return votes;
}

export async function fetchArxiv(
  fetchFn: FetchFn,
  now = Date.now(),
  gapMs = ARXIV_GAP_MS,
): Promise<Item[]> {
  let papers = parseArxivRss(await request(fetchFn, "https://rss.arxiv.org/rss/cs.AI+cs.CL+cs.LG"));
  if (!papers.length) {
    await sleep(gapMs);
    const api =
      "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=50";
    papers = parseArxivAtom(await request(fetchFn, api), now);
  }
  let votes = new Map<string, number>();
  try {
    votes = parseHfUpvotes(await request(fetchFn, "https://huggingface.co/api/daily_papers"));
  } catch {
    // ranking is best effort
  }
  return papers
    .filter((paper) => paper.id && isAiText(`${paper.title} ${paper.text}`))
    .map((paper) => ({
      title: paper.title,
      url: `https://arxiv.org/abs/${paper.id}`,
      date: paper.date,
      metric: votes.has(paper.id) ? `${votes.get(paper.id)} upvotes` : "0 upvotes",
      score: votes.get(paper.id) ?? 0,
    }));
}

const trafficNumber = (label: string): number => {
  const match = label.match(/([\d,]+)\s*([KM]?)/i);
  if (!match) return 0;
  const unit = { "": 1, K: 1e3, M: 1e6 }[match[2].toUpperCase() as "" | "K" | "M"];
  return Number(match[1].replaceAll(",", "")) * unit;
};

export function parseTrends(xml: string): Item[] {
  return [...xmlDoc(xml).querySelectorAll("item")].flatMap((item) => {
    const title = textOf(item.querySelector("title"));
    const news = [...item.querySelectorAll("*")].filter((node) =>
      node.tagName.toLowerCase().endsWith("news_item"),
    );
    const newsTitle = textOf(news[0]?.querySelector("*:nth-child(1)"));
    const newsUrl = textOf(news[0]?.querySelector("*:nth-child(2)"));
    if (!isAiText(`${title} ${newsTitle}`)) return [];
    const traffic = textOf(
      [...item.children].find((node) => node.tagName.toLowerCase().endsWith("approx_traffic")),
    );
    const link =
      newsUrl || `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}&geo=US`;
    return [
      {
        title: newsTitle ? `${title} - ${newsTitle}` : title,
        url: link,
        date: isoDay(textOf(item.querySelector("pubDate"))),
        metric: `${traffic || "?"} searches`,
        score: trafficNumber(traffic),
      },
    ];
  });
}

export const fetchTrends = async (fetchFn: FetchFn): Promise<Item[]> =>
  parseTrends(await request(fetchFn, "https://trends.google.com/trending/rss?geo=US"));

export function readSeenUrls(path: string | undefined): Set<string> {
  if (!path) return new Set();
  try {
    return new Set(readFileSync(path, "utf8").match(/https?:\/\/[^\s)>\]"']+/g) ?? []);
  } catch {
    return new Set();
  }
}

async function runSource(
  name: string,
  task: () => Promise<Item[]>,
  empty?: string,
): Promise<Section> {
  try {
    return { name, items: await task(), empty };
  } catch (failure) {
    return { name, items: [], error: failure instanceof Error ? failure.message : String(failure) };
  }
}

export function shapeSection(section: Section, seen: Set<string>, max: number): Section {
  const items = section.items
    .filter((item) => !seen.has(item.url))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return { ...section, items };
}

const lineOf = (item: Item): string =>
  `- ${item.title.slice(0, 200)}\n  ${item.url} | ${item.date} | ${item.metric}`;

export function renderText(sections: Section[], budget = BYTE_BUDGET): string {
  const out: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    const size = Buffer.byteLength(line) + 1;
    if (used + size > budget) return false;
    out.push(line);
    used += size;
    return true;
  };
  for (const section of sections) {
    push(`## ${section.name}`);
    if (section.error) push(`error ${section.name.toLowerCase()}: ${section.error.slice(0, 300)}`);
    else if (!section.items.length) push(section.empty ?? "no items");
    for (const item of section.items) if (!push(lineOf(item))) break;
  }
  return out.join("\n");
}

export async function buildDigest(
  fetchFn: FetchFn,
  opts: { max?: number; seen?: Set<string>; now?: number; gapMs?: number } = {},
): Promise<Section[]> {
  const { max = 10, seen = new Set<string>(), now = Date.now(), gapMs } = opts;
  const raw = await Promise.all([
    runSource("GitHub", () => fetchGithub(fetchFn, now)),
    runSource("arXiv", () => fetchArxiv(fetchFn, now, gapMs)),
    runSource("Trends", () => fetchTrends(fetchFn), "no AI trends today"),
  ]);
  return raw.map((section) => shapeSection(section, seen, max));
}

export function parseArgs(argv: string[]): { json: boolean; sinceReport?: string; max: number } {
  const args = { json: false, sinceReport: undefined as string | undefined, max: 10 };
  for (let pos = 0; pos < argv.length; pos++) {
    if (argv[pos] === "--json") args.json = true;
    else if (argv[pos] === "--since-report") args.sinceReport = argv[++pos];
    else if (argv[pos] === "--max") args.max = Math.max(1, Number(argv[++pos]) || 10);
    else throw new Error("usage: ai-digest [--json] [--since-report PATH] [--max N]");
  }
  return args;
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const sections = await buildDigest(fetch as FetchFn, {
      max: args.max,
      seen: readSeenUrls(args.sinceReport),
    });
    const text = args.json
      ? JSON.stringify(sections.map(({ name, items, error }) => ({ name, items, error })))
      : renderText(sections);
    console.log(args.json ? text.slice(0, BYTE_BUDGET) : text);
  } catch (failure) {
    console.error(failure instanceof Error ? failure.message : String(failure));
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
