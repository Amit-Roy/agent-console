import { splitFrontmatter, frontmatterToMarkdown } from "../public/frontmatter.js";

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

This is a **test** document with frontmatter.`,
  },
  {
    name: "no frontmatter",
    input: `# Heading

Just content without frontmatter.`,
    expected: `# Heading

Just content without frontmatter.`,
  },
  {
    name: "empty frontmatter",
    input: `---\n---\n\n# Heading\n\nContent.`,
    expected: `\n# Heading\n\nContent.`,
  },
  {
    name: "CRLF line endings",
    input: `---\r\ntitle: "Test"\r\n---\r\n\r\n# Heading\r\n\r\nContent.`,
    expected: `\n# Heading\n\nContent.`,
  },
  {
    name: "frontmatter with ... closer",
    input: `---\nkey: value\n...\n\n# Heading\n\nContent.`,
    expected: `\n# Heading\n\nContent.`,
  },
  {
    name: "thematic break not frontmatter - no key:value",
    input: `---\n\n# Heading\n\nSome content\n\n---\n\nMore content.`,
    expected: `---\n\n# Heading\n\nSome content\n\n---\n\nMore content.`,
  },
  {
    name: "thematic break with non-frontmatter content",
    input: `---\njust text\nnot frontmatter\n---\n\n# Real Heading\n\nContent.`,
    expected: `---\njust text\nnot frontmatter\n---\n\n# Real Heading\n\nContent.`,
  },
  {
    name: "trailing spaces on delimiter",
    input: `--- \ntitle: "Test"\n--- \n\n# Heading\n\nContent.`,
    expected: `\n# Heading\n\nContent.`,
  },
  {
    name: "frontmatter at end of file",
    input: `---\ntitle: Test\n---`,
    expected: ``,
  },
  {
    name: "null input",
    input: "",
    expected: "",
  },
];

let passed = 0,
  failed = 0;
for (const test of tests) {
  const result = splitFrontmatter(test.input).body;
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

// Metadata surfaces as a key/value table above the body (issue #38 acceptance: structured, not raw text).
const table: Array<{ name: string; input: string; expected: string }> = [
  {
    name: "table: scalars, quotes, pipes",
    input: `---\ntitle: "Test | Doc"\nauthor: Ann\n---\n\n# Hi`,
    expected: `| Field | Value |\n| --- | --- |\n| title | Test \\| Doc |\n| author | Ann |\n\n\n# Hi`,
  },
  {
    name: "table: block list joins values",
    input: `---\ntags:\n  - a\n  - b\n---\nBody`,
    expected: `| Field | Value |\n| --- | --- |\n| tags | a, b |\n\nBody`,
  },
  {
    name: "table: no frontmatter unchanged",
    input: `# Hi\n\n---\n\nText`,
    expected: `# Hi\n\n---\n\nText`,
  },
  {
    name: "table: empty frontmatter shows no table",
    input: `---\n---\nBody`,
    expected: `Body`,
  },
  {
    name: "table: empty input",
    input: "",
    expected: "",
  },
];
for (const test of table) {
  const result = frontmatterToMarkdown(test.input);
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
