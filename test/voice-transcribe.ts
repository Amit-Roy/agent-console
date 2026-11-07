// Voice transcription: HTTP guards (415, 413, empty, status), the in-memory pipeline with a fake recognizer, and the
// real Parakeet model on its bundled sample when the model is installed. Run: node test/voice-transcribe.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { modelDir, modelPresent, Voice } from "../server/voice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-voice-"));
const serverTmp = path.join(scratch, "server-tmp");
fs.mkdirSync(serverTmp);
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// --- HTTP guards against a scratch server with no model installed
const listener = net.createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const data = path.join(scratch, "data");
const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(scratch, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_PASSWORD: password,
    AGENT_CONSOLE_VOICE_MODELS: path.join(scratch, "no-models"),
    TMPDIR: serverTmp,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.resume();
const listing = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort() : [];
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 20_000);
    child.once("exit", (code) => reject(new Error(`Scratch server exited: ${code}`)));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-2048);
      if (output.includes("agent-console listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const post = (type: string | undefined, body: Buffer, extra: Record<string, string> = {}) =>
    fetch(`${origin}/api/voice/transcribe`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        ...(type ? { "Content-Type": type } : {}),
        ...extra,
      },
      body,
    });
  const before = listing(data);
  assert.equal((await fetch(`${origin}/api/voice/status`)).status, 401);
  const status = await fetch(`${origin}/api/voice/status`, { headers: { Cookie: cookie } });
  assert.deepEqual(await status.json(), { stt: "missing" });
  assert.equal((await post("text/plain", Buffer.from("hi"))).status, 415);
  assert.equal((await post(undefined, Buffer.from("hi"))).status, 415);
  assert.equal((await post("audio/webm", Buffer.alloc(0))).status, 400);
  assert.equal((await post("audio/webm", Buffer.alloc(2 * 1024 * 1024 + 1024))).status, 413);
  assert.equal(
    (await post("audio/webm", Buffer.from("tiny"))).status,
    503,
    "No model: clear refusal",
  );
  assert.equal(
    (await post("audio/webm", Buffer.from("x"), { Origin: "https://evil.example" })).status,
    403,
  );
  assert.deepEqual(
    listing(data).filter((name) => !before.includes(name)),
    [],
    "Rejected uploads leave no files in the data directory",
  );
  assert.deepEqual(
    listing(serverTmp).filter((name) => !name.startsWith("node-compile-cache")),
    [],
    "Rejected uploads leave no temp files",
  );
} finally {
  child.removeAllListeners("exit");
  child.kill();
  await once(child, "exit");
}

// --- pipeline with a fake recognizer
if (!hasFfmpeg) console.log("Skipping pipeline checks: ffmpeg is not on PATH.");
else {
  const fakeModels = path.join(scratch, "fake-model");
  fs.mkdirSync(fakeModels);
  for (const file of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"])
    fs.writeFileSync(path.join(fakeModels, file), "");
  const privateTmp = fs.mkdtempSync(path.join(scratch, "tmp-"));
  process.env.TMPDIR = privateTmp;
  const wav = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-f",
      "wav",
      "pipe:1",
    ],
    { maxBuffer: 1 << 24 },
  ).stdout;
  const voice = new Voice(
    fakeModels,
    60_000,
    new URL("./helpers/fake-voice-worker.ts", import.meta.url),
  );
  try {
    assert.equal(voice.status(), "cold");
    const first = voice.transcribe(wav);
    const second = voice.transcribe(wav);
    const results = await Promise.all([first, second]);
    assert.match(results[0].text, /^heard 16000 samples$/, "ffmpeg resampled 1 s to 16 kHz mono");
    assert.equal(results[1].text, results[0].text);
    assert.equal(voice.status(), "ready");
    await assert.rejects(voice.transcribe(Buffer.from("not audio")), /decode/i);
    assert.deepEqual(fs.readdirSync(privateTmp), [], "Audio never touches the temp directory");
  } finally {
    voice.close();
  }
  assert.equal(new Voice(path.join(scratch, "nothing")).status(), "missing");
}

// --- real model, only when installed
const sample = path.join(modelDir(), "test_wavs", "0.wav");
if (hasFfmpeg && modelPresent() && fs.existsSync(sample)) {
  const real = new Voice();
  try {
    const started = process.cpuUsage();
    const result = await real.transcribe(fs.readFileSync(sample));
    const cpu = process.cpuUsage(started);
    console.log(
      `Real model: "${result.text}" in ${result.ms} ms (main thread CPU ${Math.round((cpu.user + cpu.system) / 1000)} ms).`,
    );
    assert.ok(result.text.length > 10, "The sample produces a sentence");
  } finally {
    real.close();
  }
} else
  console.log(
    "Skipping real-model check: run scripts/voice-models.sh to install the speech model.",
  );
fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
console.log("Voice transcription checks passed.");
