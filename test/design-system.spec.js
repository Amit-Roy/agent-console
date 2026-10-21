#!/usr/bin/env node
/**
 * Design system specification test
 * Plain node assert test - no jest, no test framework
 * Run with: node test/design-system.spec.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const docPath = path.join(path.dirname(path.dirname(import.meta.url).slice(5)), 'docs', 'design-system.md');

const content = fs.readFileSync(docPath, 'utf8');

// Test: design-system.md should exist
assert.ok(content.length > 0, 'design-system.md should exist and not be empty');

// Test: design-system.md should contain tokens section
assert.ok(content.includes('## Tokens') || content.includes('### Typography'), 'should contain tokens section');

// Test: design-system.md should contain components section
assert.ok(content.includes('## Components') || content.includes('### Components') || content.includes('## Scope'), 'should contain components/scope section');

// Test: design-system.md should contain usage guidelines
assert.ok(content.includes('## Usage Guidelines') || content.includes('### Usage'), 'should contain usage guidelines');

// Test: design-system.md should contain icon-pack style constraint
assert.ok(content.includes('Icon-Pack Style Constraint'), 'should contain icon-pack style constraint');

// Test: design-system.md should contain scope table (in/out)
assert.ok(content.includes('In') && content.includes('Out'), 'should list components/tokens as in or out');

console.log('All design-system.spec.js tests passed');