import assert from "node:assert/strict";

/** Test version of stripFrontmatter - copy of the logic in public/render.js */
function stripFrontmatter(src: string): string {
  if (!src) return src;
  const lines = src.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return src;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i]) || /^\.\.\.$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return src;
  const body = lines.slice(1, end).join('\n');
  // Only strip when body looks like frontmatter (key: value lines) or is empty.
  if (body && !/^[^\S\r\n]*[a-zA-Z_]+\s*:/m.test(body)) return src;
  return lines.slice(end + 1).join('\n');
}

// Test cases covering standard, none, unclosed, ... closer, CRLF, thematic break
const tests: Array<{ name: string; input: string; expected: string }> = [
  {
    name: "standard YAML frontmatter",
    input: `---
title: "Test Document"
author: "Test Author"
date: "2024-01-15"
tags:
  - test
  - markdown
---

# Main Heading

This is a **test** document with frontmatter.`,
    expected: `\n# Main Heading

This is a **test** document with frontmatter.`
  },
  {
    name: "no frontmatter",
    input: `# Heading

Just content without frontmatter.`,
    expected: `# Heading

Just content without frontmatter.`
  },
  {
    name: "empty frontmatter",
    input: `---\n---\n\n# Heading\n\nContent.`,
    expected: `\n# Heading\n\nContent.`
  },
  {
    name: "CRLF line endings",
    input: `---\r\ntitle: "Test"\r\n---\r\n\r\n# Heading\r\n\r\nContent.`,
    expected: `\n# Heading\n\nContent.`
  },
  {
    name: "frontmatter with ... closer",
    input: `---\nkey: value\n...\n\n# Heading\n\nContent.`,
    expected: `\n# Heading\n\nContent.`
  },
  {
    name: "thematic break not frontmatter - no key:value",
    input: `---\n\n# Heading\n\nSome content\n\n---\n\nMore content.`,
    expected: `---\n\n# Heading\n\nSome content\n\n---\n\nMore content.`
  },
  {
    name: "thematic break with non-frontmatter content",
    input: `---\njust text\nnot frontmatter\n---\n\n# Real Heading\n\nContent.`,
    expected: `---\njust text\nnot frontmatter\n---\n\n# Real Heading\n\nContent.`
  },
  {
    name: "trailing spaces on delimiter",
    input: `--- \ntitle: "Test"\n--- \n\n# Heading\n\nContent.`,
    expected: `\n# Heading\n\nContent.`
  },
  {
    name: "frontmatter at end of file",
    input: `---\ntitle: Test\n---`,
    expected: ``
  },
  {
    name: "null input",
    input: "",
    expected: ""
  },
];

let passed = 0, failed = 0;
for (const test of tests) {
  const result = stripFrontmatter(test.input);
  if (result === test.expected) {
    console.log(`✓ ${test.name}`);
    passed++;
  } else {
    console.log(`✗ ${test.name}`);
    console.log(`  Expected: ${JSON.stringify(test.expected)}`);
    console.log(`  Got:      ${JSON.stringify(result)}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}