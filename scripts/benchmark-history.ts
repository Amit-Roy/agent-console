// Run from either checkout: node scripts/benchmark-history.ts --repo /path/to/checkout --output /tmp/history.json
// Measures the real Threads.page projection, clipping and pagination. Only questions/workState
// are fixed stubs: no running agents, databases, network or browser rendering are measured.
// "cold-build" means no offset snapshot/in-memory index; OS filesystem caches are not flushed.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function argument(name: string, fallback: string) {
  const position = process.argv.indexOf(name);
  return position < 0 ? fallback : process.argv[position + 1];
}
const repository = path.resolve(argument("--repo", process.cwd()));
const baselinePath = argument("--baseline", "");
const requestedMode = argument("--mode", "");
const modes = ["cold-build", "fresh-reopen", "warm", "older", "small-delta", "oversized-delta"];
if (requestedMode && !modes.includes(requestedMode)) throw new Error("Unknown --mode");
const selectedModes = requestedMode ? [requestedMode] : modes;
const forcedGc = typeof global.gc === "function";
const output = argument("--output", "/tmp/history-benchmark.json");
const samples = Number(argument("--samples", "7"));
if (!Number.isSafeInteger(samples) || samples < 7)
  throw new Error("--samples must be a finite integer of at least 7");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "history-benchmark-"));
process.env.AGENT_CONSOLE_DATA = scratch;
process.env.AGENT_CONSOLE_PAGE = "40";
process.env.AGENT_CONSOLE_PAGE_BYTES = "96000";
const cache = path.join(scratch, "history-index");
async function loadArm(label: string, location: string) {
  const { HistoryIndex } = await import(
    pathToFileURL(path.join(location, "server/history.ts")).href
  );
  const { Threads } = await import(pathToFileURL(path.join(location, "server/threads.ts")).href);
  return { label, repository: location, HistoryIndex, Threads, cache: path.join(cache, label) };
}
const candidate = await loadArm("candidate", repository);
const arms = baselinePath
  ? [await loadArm("baseline", path.resolve(baselinePath)), candidate]
  : [candidate];
const rows: any[] = [];

function tool(text: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool", content: text }],
    },
  };
}
function fixtureEntries(megabytes: number) {
  const count = megabytes === 4 ? 1000 : 20_000;
  return Array.from({ length: count }, (_, position) => {
    // The 116 MB case ends with 38 one-megabyte results in its latest turn.
    if (megabytes === 116 && position >= count - 39 && position <= count - 2)
      return tool("r".repeat(1_000_000));
    if (position % 20 === 0) return { type: "user_input", text: `Turn ${position}: café 🧪` };
    if (position === count - 1)
      return {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      };
    return tool("");
  });
}
function fixture(megabytes: number) {
  const entries = fixtureEntries(megabytes);
  const emptyTools = entries.filter(
    (entry) => entry.type === "user" && entry.message!.content[0].content === "",
  );
  const initialBytes = entries.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1,
    0,
  );
  const padding = megabytes * 1_000_000 - initialBytes;
  const perTool = Math.floor(padding / emptyTools.length);
  const remainder = padding % emptyTools.length;
  const payload = "x".repeat(perTool);
  emptyTools.forEach((entry, position) => {
    entry.message!.content[0].content = payload + (position < remainder ? "x" : "");
  });
  const identifier = `fixture-${megabytes}`;
  const file = path.join(scratch, "logs", `${identifier}.jsonl`);
  fs.writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return { identifier, file, bytes: fs.statSync(file).size, total: entries.length };
}
function consoleInstance(arm: Awaited<ReturnType<typeof loadArm>>) {
  const instance = Object.create(arm.Threads.prototype);
  instance.historyIndex = new arm.HistoryIndex(arm.cache);
  instance.questions = { list: () => [] };
  instance.workState = () => ({ state: "idle" });
  return instance;
}
function measure(source: string, action: () => any) {
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const descriptors = new Map<number, string>();
  let transcriptReadBytes = 0;
  let cacheReadBytes = 0;
  let transcriptReadCalls = 0;
  let cacheReadCalls = 0;
  fs.openSync = ((file: any, ...args: any[]) => {
    const descriptor = (originalOpen as any)(file, ...args);
    descriptors.set(descriptor, String(file));
    return descriptor;
  }) as typeof fs.openSync;
  fs.readSync = ((descriptor: number, ...args: any[]) => {
    const count = (originalRead as any)(descriptor, ...args);
    const file = descriptors.get(descriptor);
    if (file === source) {
      transcriptReadBytes += count;
      transcriptReadCalls++;
    } else if (file?.startsWith(cache + path.sep)) {
      cacheReadBytes += count;
      cacheReadCalls++;
    }
    return count;
  }) as typeof fs.readSync;
  try {
    if (forcedGc) global.gc!();
    const started = performance.now();
    const page = action();
    const elapsedMs = performance.now() - started;
    const { server_ms: _serverMs, bytes: _diagnosticBytes, ...wire } = page;
    const encoded = JSON.stringify(wire);
    return {
      elapsedMs,
      transcriptReadBytes,
      cacheReadBytes,
      transcriptReadCalls,
      cacheReadCalls,
      outputBytes: Buffer.byteLength(encoded),
      outputHash: createHash("sha256").update(encoded).digest("hex"),
    };
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
  }
}
function percentile(values: number[], fraction: number) {
  return values.toSorted((left, right) => left - right)[Math.ceil(values.length * fraction) - 1];
}
function summarize(data: ReturnType<typeof fixture>, small: boolean, mode: string, records: any[]) {
  if (new Set(records.map((record) => record.outputHash)).size !== 1)
    throw new Error(`Nondeterministic output: ${data.identifier}/${mode}`);
  return {
    fixtureBytes: data.bytes,
    viewport: small ? "phone" : "desktop",
    mode,
    samples,
    warmups: 1,
    p50Ms: percentile(
      records.map((record) => record.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      records.map((record) => record.elapsedMs),
      0.95,
    ),
    transcriptReadBytes: records[0].transcriptReadBytes,
    cacheReadBytes: records[0].cacheReadBytes,
    transcriptReadCalls: records[0].transcriptReadCalls,
    cacheReadCalls: records[0].cacheReadCalls,
    outputBytes: records[0].outputBytes,
    outputHash: records[0].outputHash,
    records,
  };
}
function pageArguments(total: number, mode: string) {
  const before = mode === "older" ? total - 40 : undefined;
  const since =
    mode === "small-delta" ? total - 5 : mode === "oversized-delta" ? total - 200 : undefined;
  return { before, since };
}
function scenario(data: ReturnType<typeof fixture>, small: boolean, mode: string) {
  const states = arms.map((arm) => {
    fs.rmSync(arm.cache, { recursive: true, force: true });
    const instance = consoleInstance(arm);
    instance.page(data.identifier, undefined, undefined, small);
    (instance as any).historyIndex?.flushViews?.(); // persist view sidecars where the arm supports them
    return { arm, instance, records: [] as any[] };
  });
  const { before, since } = pageArguments(data.total, mode);
  for (let iteration = 0; iteration <= samples; iteration++) {
    const ordered = iteration % 2 === 0 ? states : [...states].reverse();
    ordered.forEach((state, order) => {
      if (mode === "cold-build") fs.rmSync(state.arm.cache, { recursive: true, force: true });
      if (mode === "cold-build" || mode === "fresh-reopen")
        state.instance = consoleInstance(state.arm);
      const record = measure(data.file, () =>
        state.instance.page(data.identifier, before, since, small),
      );
      if (iteration > 0) state.records.push({ ...record, iteration, order });
    });
  }
  const summaries = states.map((state) => summarize(data, small, mode, state.records));
  if (new Set(summaries.map((summary) => summary.outputHash)).size !== 1)
    throw new Error(`Baseline/candidate output mismatch: ${data.identifier}/${mode}`);
  publishCase(data, small, mode, summaries);
}
function publishCase(
  data: ReturnType<typeof fixture>,
  small: boolean,
  mode: string,
  summaries: any[],
) {
  if (arms.length === 1) {
    rows.push(summaries[0]);
    const { records: _records, ...summary } = summaries[0];
    console.log(JSON.stringify(summary));
    return;
  }
  const caseId = `${data.identifier}/${small ? "phone" : "desktop"}/${mode}`;
  const paired = { caseId, baseline: summaries[0], candidate: summaries[1] };
  rows.push(paired);
  console.log(
    JSON.stringify({
      caseId,
      baselineP50Ms: summaries[0].p50Ms,
      candidateP50Ms: summaries[1].p50Ms,
      outputHash: summaries[0].outputHash,
    }),
  );
}

try {
  for (const megabytes of [4, 78, 116]) {
    const data = fixture(megabytes);
    for (const small of [false, true]) {
      for (const mode of selectedModes) scenario(data, small, mode);
    }
  }
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        repository,
        ...(baselinePath
          ? {
              baseline: path.resolve(baselinePath),
              paired: true,
              armOrder: "alternating by iteration",
            }
          : {}),
        forcedGc,
        node: process.version,
        scope: "Threads.page; questions/workState stubbed; warm OS cache; no browser/network",
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote ${rows.length} cases (${samples} samples + 1 warmup each) to ${output}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
