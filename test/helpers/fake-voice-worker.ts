// Stand-in for server/voice-worker.ts: answers with the sample count so tests never need the real speech model.
import { parentPort } from "node:worker_threads";

parentPort!.on("message", ({ id: jobId, samples }: { id: number; samples: Float32Array }) => {
  setTimeout(
    () => parentPort!.postMessage({ id: jobId, text: `heard ${samples.length} samples` }),
    20,
  );
});
parentPort!.postMessage({ id: 0, ready: true });
