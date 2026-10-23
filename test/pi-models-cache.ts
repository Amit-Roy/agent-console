import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// A restarted server must offer the Pi models the previous process listed before `pi --list-models` answers again.
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pi-models-"));
process.env.AGENT_CONSOLE_DATA = data;
delete process.env.AGENT_CONSOLE_PI_MODELS;
fs.writeFileSync(path.join(data, "pi-models.txt"), [
  "provider    model                                               context  max-out  thinking  images",
  "nvidia      openai/gpt-oss-20b                                  131.1K   32.8K    yes       no    ",
  "openrouter  cohere/north-mini-code:free                         256K     64K      yes       no    ",
  "openrouter  paid/model                                          256K     64K      yes       no    ",
].join("\n"));
try {
  const { pi } = await import("../server/providers/pi.ts");
  assert.deepEqual(pi.models(), ["nvidia/openai/gpt-oss-20b", "openrouter/cohere/north-mini-code:free"]);
  console.log("pi models cache: ok");
} finally { fs.rmSync(data, { recursive: true, force: true }); }
