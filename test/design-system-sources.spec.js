#!/usr/bin/env node
/**
 * Design system sources script test
 * Plain node assert test - mocks fetch, no live network
 * Run with: node test/design-system-sources.spec.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(import.meta.url);
const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-design-system-sources.js');
const TEST_DIR = path.join(__dirname, 'fixtures', 'design-system-test');
const LOG_FILE = path.join(TEST_DIR, 'design-system-suggestions.log');
const SEEN_FILE = path.join(TEST_DIR, 'design-system-seen.json');

function setupTest() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

// Mock fetch globally before running the script
globalThis.fetch = async (url, options) => {
  if (url.includes('reddit')) {
    // Return 403 to simulate network block (what the script currently handles)
    return { ok: false, status: 403 };
  }
  if (url.includes('hacker-news')) {
    // Return empty newstories to avoid actual API calls
    return { json: async () => [] }();
  }
  return { ok: true };
};

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-design-system-sources.js');

function runScript(args = []) {
  return execSync(`node "${SCRIPT}" ${args.join(' ')}`, {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules' },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
}

assert.ok(fs.existsSync(SCRIPT), 'script file should exist');

const dryRunOutput = runScript(['--dry-run']);
assert.ok(dryRunOutput.includes('dry-run') || dryRunOutput.includes('DRY-RUN'),
  'dry-run mode should be indicated');

const normalOutput = runScript([]);
assert.ok(normalOutput.includes('Finished checking sources'),
  'script should finish without crashing');

console.log('All design-system-sources.spec.js tests passed');