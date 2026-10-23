import { parentPort } from "node:worker_threads";
import { workerOps } from "./host.ts";

// Runs host.ts /proc scans off the main thread; see inWorker() in host.ts.
parentPort!.on("message", async ({ id, op, arg }: { id: number; op: keyof typeof workerOps; arg?: number }) => {
  try { parentPort!.postMessage({ id, reply: await workerOps[op](arg as number) }); }
  catch (e) { parentPort!.postMessage({ id, error: String((e as Error)?.message || e) }); }
});
