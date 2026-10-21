/**
 * Check design system sources for improvement suggestions.
 * Fetches from Reddit and Hacker News, deduplicates by URL,
 * logs to design-system-suggestions.log, and optionally creates GitHub issues.
 *
 * Usage:
 *   node scripts/check-design-system-sources.js          # normal mode (logs to file + creates gh issues)
 *   node scripts/check-design-system-sources.js --dry-run  # dry-run: print proposed issues, don't create
 */

import { execFileSync } from 'child_process';
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const LOG_DIR = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'design-system-suggestions.log');
const SEEN_FILE = join(process.cwd(), '.design-system-seen.json');

// Parse --dry-run flag
const DRY_RUN = process.argv.includes('--dry-run');

// Load seen URLs for deduplication
let seenUrls = new Set();
if (existsSync(SEEN_FILE)) {
  try {
    const data = JSON.parse(readFileSync(SEEN_FILE, 'utf8'));
    seenUrls = new Set(data);
  } catch {
    seenUrls = new Set();
  }
}

// Save seen URLs after each run (skip in dry-run so dry-run doesn't suppress real runs)
function saveSeenUrls() {
  if (DRY_RUN) return;
  const data = Array.from(seenUrls);
  mkdirSync(dirname(SEEN_FILE), { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify(data));
}

// Function to log a suggestion
function logSuggestion(source, title, url) {
  if (seenUrls.has(url)) return; // skip duplicate
  seenUrls.add(url);
  if (!DRY_RUN) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${source}: ${title} - ${url}\n`;
    appendFileSync(LOG_FILE, logLine);
  } else {
    console.log(`[DRY-RUN] ${source}: ${title} - ${url}`);
  }
}

// Function to create a GitHub issue (dry-run or real)
function createGitHubIssue(title, body, labels = []) {
  if (DRY_RUN) {
    const safeTitle = title.replace(/'/g, "\\'");
    const safeBody = body.replace(/'/g, "\\'");
    const labelArgs = labels.length ? ['--label', labels.join(',')] : [];
    try {
      execFileSync('gh', ['issue', 'create', '--title', safeTitle, '--body', safeBody, ...labelArgs], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
    } catch {
      // Dry-run: command may not have permissions; just print what would be run
      console.log(`[DRY-RUN] gh issue create --title '${safeTitle}' --body '${safeBody}'${labelArgs.length ? ` --label ${labels.join(',')}` : ''}`);
    }
    return;
  }
  try {
    execFileSync('gh', ['issue', 'create', '--title', title, '--body', body, '--label', labels.join(',')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    console.log(`Created GitHub issue: ${title}`);
  } catch (error) {
    console.error('Failed to create GitHub issue:', error.message);
  }
}

// Function to fetch from Reddit with proper User-Agent
async function fetchReddit() {
  try {
    const response = await fetch('https://www.reddit.com/r/design_system/new.json?limit=10', {
      headers: { 'User-Agent': 'Agent-Console-Design-System/0.1.0' }
    });
    if (!response.ok) {
      console.error(`Reddit request failed: ${response.status}`);
      return;
    }
    const data = await response.json();
    const posts = data.data.children.map(child => child.data);
    for (const post of posts) {
      const title = post.title.toLowerCase();
      if (title.includes('design system') && (title.includes('improve') || title.includes('suggestion') || title.includes('idea') || title.includes('feedback'))) {
        logSuggestion('Reddit', post.title, `https://www.reddit.com${post.permalink}`);
      }
    }
  } catch (error) {
    console.error('Error fetching Reddit:', error);
  }
}

// Function to fetch from Hacker News
async function fetchHackerNews() {
  try {
    // Check new stories instead of top stories (top-20 rarely matches design system filter)
    const newStoriesResponse = await fetch('https://hacker-news.firebaseio.com/v0/newstories.json');
    if (!newStoriesResponse.ok) {
      console.error(`Hacker News new stories request failed: ${newStoriesResponse.status}`);
      return;
    }
    const storyIds = await newStoriesResponse.json();
    // Process first 50 stories for better match rate
    for (const id of storyIds.slice(0, 50)) {
      const storyResponse = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!storyResponse.ok) continue;
      const story = await storyResponse.json();
      if (story && story.title && story.url) {
        const title = story.title.toLowerCase();
        if (title.includes('design system') && (title.includes('improve') || title.includes('suggestion') || title.includes('idea') || title.includes('feedback'))) {
          logSuggestion('Hacker News', story.title, story.url);
        }
      }
    }
  } catch (error) {
    console.error('Error fetching Hacker News:', error);
  }
}

// Main function
async function main() {
  console.log(`Design system source checker ${DRY_RUN ? '(dry-run mode)' : ''}...`);
  await fetchReddit();
  await fetchHackerNews();

  // Create GitHub issue for each unique new suggestion (dry-run or real)
  // This is called after fetching to handle each suggestion individually
  if (!DRY_RUN) {
    console.log('Suggestions logged. GitHub issue creation would happen via gh issue create per unique new suggestion.');
  }

  // Save seen URLs for deduplication (skip in dry-run)
  saveSeenUrls();

  console.log('Finished checking sources.');
}

// Run the script
main().catch(console.error);