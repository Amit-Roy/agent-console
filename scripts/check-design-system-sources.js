/**
 * Check design system sources for improvement suggestions
 * Fetches from Reddit and Hacker News, deduplicates by URL,
 * logs to design-system-suggestions.log, and optionally creates GitHub issues.
 *
 * Usage:
 *   node check-design-system-sources.js          # normal mode (logs to file)
 *   node check-design-system-sources.js --dry-run  # dry-run: only print, don't create issues
 */

import { execSync } from 'child_process';
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const LOG_DIR = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'design-system-suggestions.log');
const SEEN_FILE = join(process.cwd(), '.design-system-seen.json');

const REPEATS = ["manual", "hourly", "daily", "weekdays", "weekly"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

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

// Save seen URLs after each run
function saveSeenUrls() {
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
    const topStoriesResponse = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!topStoriesResponse.ok) {
      console.error(`Hacker News top stories request failed: ${topStoriesResponse.status}`);
      return;
    }
    const storyIds = await topStoriesResponse.json();
    // Process first 20 stories
    for (const id of storyIds.slice(0, 20)) {
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

// Function to create a GitHub issue (dry-run or real)
async function createGitHubIssue(title, body, labels = []) {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] gh issue create --title "${title}" --body "${body.replace(/"/g, '\\"')}" --label "${labels.join(', ')}"`);
    return;
  }
  try {
    execSync(`gh issue create --title "${title}" --body "${body.replace(/"/g, '\\"')}" --label "${labels.join(', ')}"`, {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    console.log(`Created GitHub issue: ${title}`);
  } catch (error) {
    console.error('Failed to create GitHub issue:', error.message);
  }
}

// Main function
async function main() {
  console.log(`Design system source checker ${DRY_RUN ? '(dry-run mode)' : ''}...`);
  await fetchReddit();
  await fetchHackerNews();

  // Save seen URLs for deduplication
  saveSeenUrls();

  // Create GitHub issues for each unique suggestion (dry-run or real)
  if (!DRY_RUN) {
    // In normal mode, we would create issues - but for now just log
    console.log('Suggestions logged. GitHub issue creation would happen here via gh issue create.');
  }

  console.log('Finished checking sources.');
}

// Run the script
main().catch(console.error);