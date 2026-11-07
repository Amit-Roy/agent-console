// Voice: hold-to-talk dictation (server-side speech-to-text) and read-aloud of reply summaries (browser speech synthesis).
import { icon } from "./render.js";
import { splitSentences, tldr } from "./voice-text.js";

// ---------- recording ----------
const MAX_SECONDS = 55;
const MIN_MS = 350;
const state = { stt: "missing", autoRead: false };

function recorderMime() {
  const wanted = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return wanted.find((type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) || "";
}

function levelMeter(stream, onLevel) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return () => {};
  const audio = new Ctx();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 256;
  audio.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
    onLevel(Math.min(1, peak / 64));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    void audio.close();
  };
}

function makePill() {
  const pill = document.createElement("div");
  pill.className = "voice-pill";
  pill.setAttribute("role", "status");
  pill.hidden = true;
  const bars = document.createElement("span");
  bars.className = "voice-bars";
  for (let barIndex = 0; barIndex < 5; barIndex++) bars.append(document.createElement("i"));
  const label = document.createElement("span");
  label.className = "voice-label";
  pill.append(bars, label);
  document.body.append(pill);
  return { pill, label };
}

let sharedPill;
function showPill(message, mode, level = 0) {
  sharedPill ||= makePill();
  sharedPill.pill.hidden = !message;
  sharedPill.pill.dataset.mode = mode || "";
  sharedPill.pill.style.setProperty("--level", String(level));
  if (message) sharedPill.label.textContent = message;
}
let hideTimer;
function flashPill(message) {
  showPill(message, "error");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => showPill(""), 3200);
}

// One push-to-talk session: start() asks for the microphone, finish() uploads, cancel() throws the audio away.
async function startSession(onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = recorderMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const stopMeter = levelMeter(stream, onLevel);
  const startedAt = Date.now();
  recorder.start();
  const release = () => {
    stopMeter();
    for (const track of stream.getTracks()) track.stop();
  };
  const ended = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  const stop = async () => {
    if (recorder.state !== "inactive") recorder.stop();
    await ended;
    release();
    return {
      blob: new Blob(chunks, { type: recorder.mimeType }),
      durationMs: Date.now() - startedAt,
    };
  };
  return { stop };
}

async function upload(apiFetch, blob) {
  const response = await apiFetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "content-type": blob.type.split(";")[0] || "audio/webm" },
    body: blob,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not transcribe.");
  return String(body.text || "").trim();
}

// Upload a finished recording and hand the words to onText; every outcome ends in the pill.
async function deliverRecording(apiFetch, recording, onText) {
  const { blob, durationMs } = recording;
  if (durationMs < MIN_MS) return flashPill("Hold the mic and speak");
  showPill("Transcribing…", "busy");
  try {
    const text = await upload(apiFetch, blob);
    if (!text) flashPill("No speech heard");
    else if (onText(text) === false) flashPill("No matching option");
    else showPill("");
  } catch (error) {
    flashPill(error.message);
  }
}

// Has the pointer slid far enough off the button to cancel the recording?
function pointerOutside(button, event) {
  const box = button.getBoundingClientRect();
  return (
    event.clientX < box.left - 24 ||
    event.clientX > box.right + 24 ||
    event.clientY < box.top - 60 ||
    event.clientY > box.bottom + 24
  );
}

function wirePointer(button, talk, isRecording) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    void talk.begin();
  });
  button.addEventListener("pointermove", (event) => {
    if (!isRecording()) return button.classList.remove("cancelling");
    const away = pointerOutside(button, event);
    showPill(away ? "Release to cancel" : "Listening…", away ? "cancel" : "rec");
    button.classList.toggle("cancelling", away);
  });
  button.addEventListener("pointerup", (event) => void talk.end(pointerOutside(button, event)));
  button.addEventListener("pointercancel", () => void talk.end(true));
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

// Hold-to-talk on any element. onText(text) returns false when it could not use the words.
export function holdToTalk(button, { apiFetch, onText, canStart = () => true }) {
  let session = null;
  let starting = false;
  let timer;
  const end = async (cancel) => {
    clearTimeout(timer);
    const active = session;
    session = null;
    button.classList.remove("recording");
    if (!active) return;
    const recording = await active.stop();
    if (cancel) showPill("");
    else await deliverRecording(apiFetch, recording, onText);
  };
  const begin = async () => {
    if (session || starting || !canStart()) return;
    starting = true;
    try {
      session = await startSession((level) => session && showPill("Listening…", "rec", level));
      button.classList.add("recording");
      showPill("Listening…", "rec");
      timer = setTimeout(() => end(false), MAX_SECONDS * 1000);
    } catch {
      flashPill("Microphone blocked");
    }
    starting = false;
  };
  const talk = { begin, end };
  wirePointer(button, talk, () => !!session);
  return talk;
}

function micButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn icon ghost round voice-mic";
  button.title = `${label} (hold to talk)`;
  button.setAttribute("aria-label", label);
  button.append(icon("mic"));
  return button;
}

// Mic for question cards. Returns null when speech-to-text is unavailable.
export function questionMic(apiFetch, onText) {
  if (state.stt === "missing") return null;
  const button = micButton("Answer by voice");
  button.classList.add("sm");
  holdToTalk(button, { apiFetch, onText });
  return button;
}

function insertAtCaret(input, text) {
  input.focus();
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const spaced = before && !/\s$/.test(before) ? ` ${text}` : text;
  if (!document.execCommand?.("insertText", false, spaced)) input.value += spaced;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setupComposerMic({ apiFetch, input, send }) {
  const button = micButton("Dictate");
  button.id = "mic";
  send.before(button);
  const talk = holdToTalk(button, {
    apiFetch,
    canStart: () => !input.disabled,
    onText: (text) => insertAtCaret(input, text),
  });
  let altDown = false;
  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.code === "Space" && !event.repeat && !altDown) {
      altDown = true;
      event.preventDefault();
      void talk.begin();
    }
  });
  document.addEventListener("keyup", (event) => {
    if (altDown && (event.code === "Space" || event.key === "Alt")) {
      altDown = false;
      void talk.end(false);
    }
  });
  return button;
}

// ---------- read aloud ----------
const speech = () => globalThis.speechSynthesis;

export function speak(text) {
  const synth = speech();
  if (!synth) return;
  synth.cancel();
  for (const sentence of splitSentences(tldr(text)))
    synth.speak(new SpeechSynthesisUtterance(sentence));
}

export function speakButton(getText) {
  if (!speech()) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn icon sm ghost";
  button.title = "Read summary aloud";
  button.setAttribute("aria-label", "Read summary aloud");
  button.append(icon("speaker"));
  button.onclick = () => (speech().speaking ? speech().cancel() : speak(getText()));
  return button;
}

// Called when a live reply finishes. Reads only if the user turned it on, from a visible tab.
export function autoRead(text) {
  if (state.autoRead && document.visibilityState === "visible" && text) speak(text);
}

function setupAutoReadToggle() {
  const box = document.getElementById("voice-autoread");
  if (!box) return;
  if (!speech()) return void box.closest("label, .fld")?.setAttribute("hidden", "");
  state.autoRead = localStorage.getItem("ac_autoread") === "1";
  box.checked = state.autoRead;
  box.addEventListener("change", () => {
    state.autoRead = box.checked;
    localStorage.setItem("ac_autoread", box.checked ? "1" : "0");
    // A click is the user gesture browsers need before they allow speech later; speak a silent unlock.
    if (box.checked) speech().speak(new SpeechSynthesisUtterance(" "));
  });
}

export async function setupVoice({ apiFetch, input, send }) {
  setupAutoReadToggle();
  try {
    const response = await apiFetch("/api/voice/status");
    state.stt = (await response.json()).stt || "missing";
  } catch {
    state.stt = "missing";
  }
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) state.stt = "missing";
  if (state.stt === "missing") return state.stt;
  setupComposerMic({ apiFetch, input, send });
  return state.stt;
}

export const voiceStatus = () => state.stt;
