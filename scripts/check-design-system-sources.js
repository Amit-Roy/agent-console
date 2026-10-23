/**
 * Check design system sources (Reddit, Hacker News) for improvement suggestions.
 * New suggestions (deduplicated by URL) are appended to logs/design-system-suggestions.log
 * and each one becomes a GitHub issue via `gh issue create`.
 *
 *   node scripts/check-design-system-sources.js            # log + create issues
 *   node scripts/check-design-system-sources.js --dry-run  # print what would be created, change nothing
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'Agent-Console-Design-System/0.1.0';
const LABELS = ['design-system', 'suggestion'];
const KEYWORDS = ['improve', 'suggestion', 'idea', 'feedback'];

const matches = title => {
  const t = String(title || '').toLowerCase();
  return t.includes('design system') && KEYWORDS.some(k => t.includes(k));
};

async function fetchJson(fetchFn, url, errors) {
  const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) { errors.push(`${url} failed: ${res.status}`); return null; }
  return res.json();
}

export async function collectSuggestions(fetchFn, errors = []) {
  const found = [];
  try {
    const data = await fetchJson(fetchFn, 'https://www.reddit.com/r/design_system/new.json?limit=10', errors);
    for (const { data: post } of data?.data?.children || [])
      if (matches(post.title)) found.push({ source: 'Reddit', title: post.title, url: `https://www.reddit.com${post.permalink}` });
  } catch (error) { errors.push(`Reddit: ${error.message}`); }
  try {
    const ids = await fetchJson(fetchFn, 'https://hacker-news.firebaseio.com/v0/newstories.json', errors);
    const stories = await Promise.all((ids || []).slice(0, 50).map(id =>
      fetchJson(fetchFn, `https://hacker-news.firebaseio.com/v0/item/${id}.json`, errors).catch(() => null)));
    for (const story of stories)
      if (story?.url && matches(story.title)) found.push({ source: 'Hacker News', title: story.title, url: story.url });
  } catch (error) { errors.push(`Hacker News: ${error.message}`); }
  return found;
}

const ghCreateIssue = ({ title, body, labels }) =>
  execFileSync('gh', ['issue', 'create', '--title', title, '--body', body, '--label', labels.join(',')], { encoding: 'utf8' }).trim();

export async function run({ fetch: fetchFn = globalThis.fetch, createIssue = ghCreateIssue, dryRun = false, dir = process.cwd(), out = console.log } = {}) {
  const logFile = join(dir, 'logs', 'design-system-suggestions.log');
  const seenFile = join(dir, '.design-system-seen.json');
  let seen = new Set();
  if (existsSync(seenFile)) {
    try { seen = new Set(JSON.parse(readFileSync(seenFile, 'utf8'))); } catch { /* corrupt state: start over */ }
  }
  const errors = [];
  const fresh = (await collectSuggestions(fetchFn, errors)).filter((s, i, all) => !seen.has(s.url) && all.findIndex(o => o.url === s.url) === i);
  const created = [];
  for (const s of fresh) {
    const issue = { title: `Design system: ${s.title}`, body: `Suggested by ${s.source}: ${s.url}\n\nReview this idea against docs/design-system.md and decide whether to adopt it.`, labels: LABELS };
    if (dryRun) { out(`[DRY-RUN] ${s.source}: ${s.title} - ${s.url}`); continue; }
    try {
      createIssue(issue);
    } catch (error) {
      errors.push(`issue for ${s.url} failed: ${error.message}`);
      continue; // not marked seen: the next run retries
    }
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `[${new Date().toISOString()}] ${s.source}: ${s.title} - ${s.url}\n`);
    seen.add(s.url);
    created.push(s);
    out(`Created GitHub issue: ${issue.title}`);
  }
  if (!dryRun && created.length) writeFileSync(seenFile, JSON.stringify([...seen]));
  for (const e of errors) console.error(e);
  out(`Finished checking sources: ${fresh.length} new, ${created.length} issues created${dryRun ? ' (dry-run)' : ''}.`);
  return { found: fresh, created, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, found, created } = await run({ dryRun: process.argv.includes('--dry-run') });
  if (errors.length && !found.length && !created.length) process.exitCode = 1;
}
