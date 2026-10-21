import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processResearchTask } from "../server/pi-subagent-worker.ts";

console.log("Running PI Subagent Worker test...");

// Arrange
const researchTask = "Research the latest advancements in quantum computing.";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
console.log("cwd:", cwd);

// Act
let result: { notesPath: string; indexPath: string } | undefined;
try {
  result = await processResearchTask(researchTask, cwd);
} catch (err) {
  console.error("Error during research task:", err);
  // We expect this to succeed and create the files
  process.exit(1);
}

// Assert
if (!result) {
  throw new Error("Result is undefined");
}
assert.ok(fs.existsSync(result.notesPath), `Notes file not found at ${result.notesPath}`);
assert.ok(fs.existsSync(result.indexPath), `Index file not found at ${result.indexPath}`);
const notes = fs.readFileSync(result.notesPath, "utf8");
const index = JSON.parse(fs.readFileSync(result.indexPath, "utf8"));
assert.ok(notes.length > 0, "Notes file should not be empty");
assert.ok(index.length > 0, "Index file should not be empty");

console.log("Test passed!");
process.exit(0);