// Speech-to-text worker: owns the sherpa-onnx recognizer so decoding never blocks the server event loop.
import { createRequire } from "node:module";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

type Job = { id: number; samples: Float32Array };

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const dir: string = workerData.modelDir;
let recognizer: any;

function load() {
  recognizer ??= new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, "encoder.int8.onnx"),
        decoder: path.join(dir, "decoder.int8.onnx"),
        joiner: path.join(dir, "joiner.int8.onnx"),
      },
      tokens: path.join(dir, "tokens.txt"),
      numThreads: 2,
      provider: "cpu",
      modelType: "nemo_transducer",
    },
  });
  return recognizer;
}

function transcribe(samples: Float32Array): string {
  const engine = load();
  const stream = engine.createStream();
  stream.acceptWaveform({ samples, sampleRate: 16_000 });
  engine.decode(stream);
  return String(engine.getResult(stream).text || "").trim();
}

parentPort!.on("message", ({ id, samples }: Job) => {
  try {
    parentPort!.postMessage({ id, text: transcribe(samples) });
  } catch (error: any) {
    parentPort!.postMessage({ id, error: String(error?.message || error).slice(0, 200) });
  }
});
parentPort!.postMessage({ id: 0, ready: true });
