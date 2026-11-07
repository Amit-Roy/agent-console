// Local speech-to-text: ffmpeg decodes the upload to 16 kHz mono floats in memory, a worker thread runs
// sherpa-onnx (Parakeet TDT). Audio is never written to disk or logged.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import PQueue from "p-queue";

export type VoiceStatus = "ready" | "cold" | "missing";
export const MODEL_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
export const MAX_AUDIO_SECONDS = 60;
export const QUEUE_TIMEOUT_MS = 30_000;
export const IDLE_UNLOAD_MS = 10 * 60_000;
const SAMPLE_RATE = 16_000;
const MODEL_FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];

export function modelDir(env: NodeJS.ProcessEnv = process.env) {
  const root =
    env.AGENT_CONSOLE_VOICE_MODELS || path.join(os.homedir(), ".cache", "agent-console", "models");
  return path.join(root, MODEL_NAME);
}

function onPath(name: string, env: NodeJS.ProcessEnv = process.env) {
  return (env.PATH || "")
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, name)));
}

function sherpaInstalled() {
  try {
    createRequire(import.meta.url).resolve("sherpa-onnx-node");
    return true;
  } catch {
    return false;
  }
}

export function modelPresent(dir = modelDir()) {
  return MODEL_FILES.every((file) => fs.existsSync(path.join(dir, file)));
}

export function voiceInstalled(dir = modelDir()) {
  return modelPresent(dir) && onPath("ffmpeg") && sherpaInstalled();
}

// Decode any ffmpeg-readable audio into 16 kHz mono samples, capped at MAX_AUDIO_SECONDS.
export function decodeAudio(input: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", "pipe:0", "-t", String(MAX_AUDIO_SECONDS)];
    const child = spawn(
      "ffmpeg",
      [...args, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
      {
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stdin.on("error", () => {}); // ffmpeg may exit before reading everything
    child.once("error", () => reject(new Error("ffmpeg is unavailable.")));
    child.once("close", (code) => {
      const bytes = Buffer.concat(chunks);
      if (code !== 0 || bytes.length < 4) return reject(new Error("Could not decode the audio."));
      const aligned = new Uint8Array(bytes.length - (bytes.length % 4));
      aligned.set(bytes.subarray(0, aligned.length));
      resolve(new Float32Array(aligned.buffer));
    });
    child.stdin.end(input);
  });
}

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void };

export class Voice {
  private worker?: Worker;
  private ready?: Promise<Worker>;
  private pending = new Map<number, Pending>();
  private queue = new PQueue({ concurrency: 1 });
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;

  private dir: string;
  private idleMs: number;
  private workerUrl: URL;

  constructor(
    dir = modelDir(),
    idleMs = IDLE_UNLOAD_MS,
    workerUrl = new URL("./voice-worker.ts", import.meta.url),
  ) {
    this.dir = dir;
    this.idleMs = idleMs;
    this.workerUrl = workerUrl;
  }

  status(): VoiceStatus {
    if (!voiceInstalled(this.dir)) return "missing";
    return this.worker ? "ready" : "cold";
  }

  private spawnWorker(): Promise<Worker> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerUrl, {
        workerData: { modelDir: this.dir },
      });
      worker.unref();
      worker.once("error", reject);
      worker.on("error", () => this.unload());
      worker.on("exit", () => this.unload(worker));
      worker.on("message", (msg) => this.onMessage(msg, worker, resolve));
    });
  }

  private onMessage(msg: any, worker: Worker, ready: (worker: Worker) => void) {
    if (msg.ready) {
      this.worker = worker;
      return ready(worker);
    }
    const job = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.error) job?.reject(new Error(msg.error));
    else job?.resolve(msg.text);
  }

  private unload(only?: Worker) {
    if (only && this.worker !== only) return;
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    for (const job of this.pending.values()) job.reject(new Error("Speech engine stopped."));
    this.pending.clear();
    void worker?.terminate();
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.unload(), this.idleMs);
    this.idleTimer.unref();
  }

  private async run(samples: Float32Array): Promise<string> {
    this.ready ??= this.spawnWorker();
    const worker = await this.ready;
    const id = this.nextId++;
    const done = new Promise<string>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    worker.postMessage({ id, samples }, [samples.buffer]);
    try {
      return await done;
    } finally {
      this.touch();
    }
  }

  // One decode at a time. A request that waits or runs longer than QUEUE_TIMEOUT_MS fails and the engine restarts.
  async transcribe(audio: Buffer): Promise<{ text: string; ms: number }> {
    if (this.status() === "missing") throw new Error("Voice input is not installed.");
    const started = Date.now();
    const samples = await decodeAudio(audio);
    const text = await this.queue
      .add(() => this.run(samples), { timeout: QUEUE_TIMEOUT_MS })
      .catch((error) => {
        if (error?.name === "TimeoutError") this.unload();
        throw error?.name === "TimeoutError" ? new Error("Speech engine is busy.") : error;
      });
    return { text: text ?? "", ms: Date.now() - started };
  }

  close() {
    clearTimeout(this.idleTimer);
    this.unload();
  }
}
