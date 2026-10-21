const { execSync } = require('child_process');
const { writeFileSync, appendFileSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const LOG_DIR = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'design-system-suggestions.log');

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

// Function to log a suggestion
function logSuggestion(source, title, url) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${source}: ${title} - ${url}\n`;
  appendFileSync(LOG_FILE, logLine);
}

// Function to fetch from Reddit
async function fetchReddit() {
  try {
    // Using Reddit's JSON API for r/design_system
    const response = await fetch('https://www.reddit.com/r/design_system/new.json?limit=10');
    if (!response.ok) {
      console.error(`Reddit request failed: ${response.status}`);
      return;
    }
    const data = await response.json();
    const posts = data.data.children.map(child => child.data);
    for (const post of posts) {
      // Check if the post title contains keywords related to design system improvements
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
    // Hacker News API: get top stories, then fetch each item
    const response = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json?print=pretty');
    if (!response.ok) {
      console.error(`Hacker News request failed: ${response.status}`);
      return;
    }
    const storyIds = await response.json();
    // Process first 20 stories
    for (const id of storyIds.slice(0, 20)) {
      const storyResponse = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json?print=pretty`);
      if (!storyResponse.ok) {
        continue;
      }
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
  console.log('Checking design system sources for improvement suggestions...');
  await fetchReddit();
  await fetchHackerNews();
  console.log('Finished checking sources.');
}

// Run the script
main().catch(console.error);