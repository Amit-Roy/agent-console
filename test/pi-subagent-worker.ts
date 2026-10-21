import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processResearchTask } from "../server/pi-subagent-worker.ts";

console.log("Running PI Subagent Worker test...");

// Mock PI binary on PATH
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-mock-"));
process.env.PATH = `${tmp}/bin:${process.env.PATH}`;
fs.mkdirSync(`${tmp}/bin`, { recursive: true });

fs.writeFileSync(`${tmp}/bin/pi`, `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => console.log(JSON.stringify(o));
const mfs = require("fs");
const mpath = require("path");
console.error("MOCK PI READY, cwd:", process.cwd());
rl.on("line", (l) => {
  const r = JSON.parse(l);
  if (r.type !== "prompt") return;
  console.error("MOCK PI GOT PROMPT:", r.message);
  out({ id: r.id, type: "response", command: "prompt", success: true });
  out({ type: "agent_start" });
  const notes = "# Research results\\n\\nResearch results for: " + r.message;
  const index = JSON.stringify([{ id: "1", title: r.message, description: r.message, status: "completed", provider: "pi", model: "nvidia/nvidia/nemotron-3-super-120b-a12b" }]);
  mfs.writeFileSync(mpath.join(process.cwd(), "research-notes.md"), notes);
  mfs.writeFileSync(mpath.join(process.cwd(), "index.json"), index);
  console.error("MOCK PI WROTE FILES to:", mpath.join(process.cwd(), "research-notes.md"));
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Research results for: " + r.message }], stopReason: "stop" } });
  out({ type: "agent_settled" });
  out({ type: "result", subtype: "success", is_error: false });
});
`, { mode: 0o755 });

// Arrange
const researchTask = "Research the latest advancements in quantum computing.";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
console.log("cwd:", cwd);

// Check if cwd is writable
console.log("cwd writable:", fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK) === undefined ? "yes" : "no");

// Act
let result: { notesPath: string; indexPath: string; provider: string; model: string; phase: string; finalText?: string } | undefined;
try {
  result = await processResearchTask({ task: researchTask, cwd });
} catch (err) {
  console.error("Error during research task:", err);
  process.exit(1);
}

console.log("Result:", JSON.stringify(result, null, 2));

// Check session dirs
const sessionDir = path.join(cwd, "pi-sessions");
console.log("sessionDir:", sessionDir, "exists:", fs.existsSync(sessionDir));
if (fs.existsSync(sessionDir)) {
  const sessionDirs = fs.readdirSync(sessionDir);
  console.log("sessionDirs:", sessionDirs);
  for (const sdir of sessionDirs) {
    const fullSdir = path.join(sessionDir, sdir);
    const files = fs.existsSync(fullSdir) ? fs.readdirSync(fullSdir) : [];
    console.log(`Session ${sdir} files:`, files);
  }
}

// Assert
if (!result) {
  throw new Error("Result is undefined");
}
assert.ok(fs.existsSync(result.notesPath), `Notes file not found at ${result.notesPath}`);
assert.ok(fs.existsSync(result.indexPath), `Index file not found at ${result.indexPath}`);
assert.strictEqual(result.provider, "pi", "Provider should be 'pi'");
assert.strictEqual(result.model, "nvidia/nvidia/nemotron-3-super-120b-a12b", "Model should match");
assert.ok(result.phase === "completed", `Phase should be completed, got ${result.phase}`);
assert.ok(result.finalText?.includes("Research results"), `finalText should contain research results, got: ${result.finalText}`);

const notes = fs.readFileSync(result.notesPath, "utf8");
const index = JSON.parse(fs.readFileSync(result.indexPath, "utf8"));
assert.ok(notes.length > 0, "Notes file should not be empty");
assert.ok(index.length > 0, "Index file should not be empty");
assert.ok(index[0].provider === "pi", "Index should contain provider");

console.log("Test passed!");
process.exit(0);