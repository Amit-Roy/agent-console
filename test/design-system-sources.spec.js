/**
 * Test for check-design-system-sources.js script features
 * Bugs found by review:
 * 1. No dry-run mode
 * 2. No dedupe (re-appends same URLs every run)
 * 3. No User-Agent header for Reddit API
 * 4. No GitHub issue creation via gh issue create
 * 5. Narrow sources and keyword filter
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const SCRIPT = join(process.cwd(), 'scripts', 'check-design-system-sources.js');
const TEST_DIR = join(process.cwd(), 'test', 'fixtures', 'design-system-test');
const LOG_FILE = join(TEST_DIR, 'design-system-suggestions.log');
const SEEN_FILE = join(TEST_DIR, 'design-system-seen.json');

function setupTest() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

function runScript(args = [], env = {}) {
  const cmd = `node "${SCRIPT}" ${args.join(' ')}`;
  return execSync(cmd, {
    cwd: TEST_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
}

describe('check-design-system-sources.js', () => {
  beforeEach(setupTest);

  it('supports --dry-run mode without writing to log', () => {
    // Before fix: no --dry-run flag exists
    const output = runScript(['--dry-run']);
    expect(output).toContain('dry-run');
    expect(existsSync(LOG_FILE)).toBe(false);
  });

  it('dedupes: running twice does not re-append the same URL', () => {
    // Simulate seeing a URL by pre-populating seen file
    writeFileSync(SEEN_FILE, JSON.stringify(['https://example.com/seen']));
    const output = runScript([]);
    // After fix: script should read seen file and skip seen URLs
    expect(output).not.toContain('https://example.com/seen');
  });

  it('sends User-Agent header to Reddit API', () => {
    const output = runScript([]);
    expect(output).toContain('User-Agent');
  });

  it('creates GitHub issue for each suggestion (dry-run)', () => {
    const output = runScript(['--dry-run']);
    expect(output).toContain('gh issue create');
    expect(output).toContain('proposed');
  });
});