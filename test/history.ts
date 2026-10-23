import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryIndex } from "../server/history.ts";
import { codexModels, codexTranslator } from "../server/providers/codex.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-history-"));
try {
  const file = path.join(dir, "log.jsonl");
  const events = Array.from({ length: 10000 }, (_, i) => ({
    type: i % 10 === 0 ? "user_input" : "assistant",
    text: `${i} café 🧪`,
  }));
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e) + "\n").join(""));
  const idx = new HistoryIndex();
  const latest = idx.read(file, undefined, 80);
  assert.equal(latest.start, 9920);
  assert.deepEqual(latest.events, events.slice(9920));
  assert.ok(latest.bytes < fs.statSync(file).size / 10);
  const older = idx.read(file, latest.start, 80);
  assert.equal(older.end, latest.start);
  assert.deepEqual(older.events, events.slice(older.start, older.end));
  assert.equal(idx.count(file), 10000);
  assert.deepEqual(idx.after(file, 9995, 80)!.events, events.slice(9995));
  assert.equal(idx.after(file, 10000, 80)!.events.length, 0, "nothing new is an empty delta");
  assert.equal(idx.after(file, 9000, 80), null, "too wide a gap falls back to a page");
  assert.equal(
    idx.after(file, 10001, 80),
    null,
    "a log shorter than the cached view falls back to a page",
  );
  const extra = { type: "user_input", text: "new turn" };
  fs.appendFileSync(file, JSON.stringify(extra) + "\n");
  assert.equal(idx.read(file, undefined, 80).total, 10001);
  assert.deepEqual(idx.after(file, 10000, 80)!.events, [extra]);
  fs.writeFileSync(file, JSON.stringify(extra) + "\n");
  assert.deepEqual(idx.read(file, undefined, 80).events, [extra]);
  assert.equal(idx.read(file, 0, 80).events.length, 0);
  fs.rmSync(file);
  assert.equal(idx.read(file, undefined, 80).total, 0);
  const large = [{ type: "assistant", text: "x".repeat(2_000_000) }, ...events.slice(0, 60)];
  fs.writeFileSync(file, large.map((e) => JSON.stringify(e) + "\n").join(""));
  const bounded = idx.read(file, undefined, 10);
  assert.deepEqual(bounded.events, large.slice(51));
  assert.ok(
    bounded.bytes < 10_000,
    "discarded large tool/message bodies are not read or parsed while locating a page boundary",
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ text: "alternate property order", type: "user_input" }) + "\n",
  );
  assert.equal(idx.read(file, undefined, 10).events[0].type, "user_input");
  fs.writeFileSync(
    path.join(dir, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "visible",
          display_name: "Visible model",
          visibility: "list",
          default_reasoning_level: "low",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
        { slug: "hidden", visibility: "hide" },
      ],
    }),
  );
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    assert.deepEqual(Object.keys(codexModels()), ["default", "visible"]);
    assert.deepEqual(codexModels().visible.efforts, ["low", "high"]);
    assert.deepEqual(codexModels().default.efforts, ["low", "high"]);
    assert.equal(codexModels().visible.defaultEffort, "low");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
  const out: any[] = [];
  codexTranslator((e) => out.push(e))({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
  });
  assert.equal(out.find((e) => e.type === "token_usage").cached_input_tokens, 50);
  console.log(
    "PASS indexed history: bounded reads, deltas after a line, contiguous pages, UTF-8, appends, truncation, missing logs; Codex catalog and token telemetry",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
