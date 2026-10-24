#!/usr/bin/env node
// Adds the cheap request features to external benchmark rows, using the same Node
// `requestFeatures` the runtime prices with. Usage: effort-data-features.ts ROWS.jsonl OUT.jsonl
import fs from "node:fs";
import { requestFeatures } from "../server/providers/triage-quantile.ts";

export type FeatureRow = {
  session_id: string;
  total_tokens: number;
  text: ReturnType<typeof requestFeatures>;
};

/** One output row per input row with a positive token total; the request text is dropped. */
export function featureRow(line: string): FeatureRow | null {
  const row = JSON.parse(line);
  const total = Number(row.total_tokens);
  if (typeof row.request_text !== "string" || !Number.isFinite(total) || total <= 0) return null;
  return {
    session_id: String(row.session_id),
    total_tokens: total,
    text: requestFeatures(row.request_text),
  };
}

export function addFeatures(source: string, target: string): number {
  const lines = fs.readFileSync(source, "utf8").split("\n").filter(Boolean);
  const rows = lines.map(featureRow).filter((row): row is FeatureRow => row !== null);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), {
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  return rows.length;
}

if (import.meta.main) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) {
    console.error("usage: effort-data-features.ts ROWS.jsonl OUT.jsonl");
    process.exit(2);
  }
  try {
    console.log(`features rows ${addFeatures(source, target)} ${target}`);
  } catch (error) {
    console.error(`effort-model: features: ${(error as Error).message}`);
    process.exit(1);
  }
}
