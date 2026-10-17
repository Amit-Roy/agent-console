#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const timeoutMs = Number(option("--timeout", "30000"));
const maxTokens = Number(option("--max-tokens", "8"));
const listCommand = option("--pi", "pi");
const endpoint = option("--endpoint", "https://integrate.api.nvidia.com/v1/chat/completions");
const requestIntervalMs = 1100;
const help = args.includes("--help") || args.includes("-h");

if (help) {
  console.log(`Usage: node scripts/sweep-nvidia-models.mjs [options]

Probe every NVIDIA model in pi --list-models using a minimal chat request.
Reads NVIDIA_API_KEY from the environment or these files, in order:
  ~/.config/agent-console/env
  ~/openrouter/.env

Options:
  --timeout MS       Per-model timeout (default: 30000)
  --max-tokens N     Response token cap (default: 8)
  --pi COMMAND       pi executable (default: pi)
  --endpoint URL     Chat completions endpoint
`);
  process.exit(0);
}

function parseEnvFile(filename) {
  try {
    const values = {};
    for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

const home = os.homedir();
const files = (process.env.AGENT_CONSOLE_ENV_FILES || [path.join(home, ".config/agent-console/env"), path.join(home, "openrouter/.env")].join(":"))
  .split(":").filter(Boolean);
const fileValues = Object.assign({}, ...files.map(parseEnvFile));
const apiKey = process.env.NVIDIA_API_KEY || fileValues.NVIDIA_API_KEY;
if (!apiKey) {
  console.error("NVIDIA_API_KEY not found in environment or configured env files.");
  process.exit(2);
}

let table;
try {
  table = execFileSync(listCommand, ["--list-models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
} catch (error) {
  console.error(`Could not run ${listCommand} --list-models: ${error.message}`);
  process.exit(2);
}
const models = [...table.matchAll(/^nvidia\s+(\S+)/gm)].map((match) => match[1]);
if (!models.length) {
  console.error("pi --list-models returned no NVIDIA models.");
  process.exit(2);
}

const results = [];
let nextRequestAt = 0;
for (const model of models) {
  const waitMs = nextRequestAt - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  nextRequestAt = Date.now() + requestIntervalMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: maxTokens, stream: false }),
      signal: controller.signal,
    });
    // Drain before the next request so the endpoint can finish/close the response cleanly.
    await response.arrayBuffer();
    results.push({ model, ok: response.ok, status: response.status });
    console.log(`${response.ok ? "OK" : "FAIL"}\t${model}\tHTTP ${response.status}`);
  } catch (error) {
    const reason = error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message;
    results.push({ model, ok: false, error: reason });
    console.log(`FAIL\t${model}\t${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

const working = results.filter((result) => result.ok).map((result) => result.model);
const failures = results.length - working.length;
console.log(`\nWorking NVIDIA models (${working.length}/${results.length}):`);
for (const model of working) console.log(model);
console.log(`\nUnsuccessful or timed out: ${failures}`);
