// Turn latency stats for agents, without reading raw logs: node scripts/turn-latency.ts [--days N] [--thread ID] [--recent]
// Reads the local latency.sqlite (read/prune only, metadata only). Same numbers as GET /api/turn-latency?from&to&thread.
import os from "node:os";
import path from "node:path";
import { TurnTimingStore } from "../server/turn-timing.ts";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const days = Math.min(400, Math.max(1, Number(arg("--days")) || 7));
const dir = process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");
const store = new TurnTimingStore(path.join(dir, "latency.sqlite"));
try {
  const to = Date.now();
  const { recent, ...summary } = store.summary(to - days * 86_400_000, to, { thread: arg("--thread") });
  console.log(JSON.stringify(process.argv.includes("--recent") ? { ...summary, recent } : summary, null, 1));
} finally { store.close(); }
