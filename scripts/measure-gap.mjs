#!/usr/bin/env node
// Measure how long agent-console is unreachable while it restarts: `node scripts/measure-gap.mjs [--seconds N] [--port P]`.
// Two probes at once: GET /login every 50 ms (2 s timeout), and one WebSocket client that reconnects after a close.
// Runs until SIGINT/SIGTERM or N seconds. Prints "ready" once both probes work, then one JSON summary line on exit:
//   {"httpMaxGapMs":..,"httpFailures":..,"wsMaxGapMs":..,"wsReconnects":..,"seconds":..}
// httpMaxGapMs: longest time between two successful responses. wsMaxGapMs: longest time from a close to the next hello.
// Needs the same AGENT_CONSOLE_DATA as the server (the WebSocket cookie is signed with its secret).
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

// Servers before #350 read ac_session and newer ones read __Host-ac_session; a deploy talks to both.
const bothCookies = () => {
  const token = makeToken();
  return `ac_session=${token}; __Host-ac_session=${token}`;
};

const POLL_MS = 50;
const HTTP_TIMEOUT_MS = 2000;

function parseArgs(argv) {
  const options = { port: process.env.PORT || "7070", seconds: Infinity };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--port") options.port = argv[++index];
    else if (argv[index] === "--seconds") options.seconds = Number(argv[++index]);
    else throw new Error(`unknown option ${argv[index]}`);
  }
  return options;
}

const { port, seconds } = parseArgs(process.argv.slice(2));
const began = Date.now();
const stats = { httpMaxGapMs: 0, httpFailures: 0, wsMaxGapMs: 0, wsReconnects: 0 };
let stopping = false;
let httpReady = false;
let wsReady = false;
let lastOk = 0;

const announceWhenReady = () => {
  if (httpReady && wsReady && !announceWhenReady.done) {
    announceWhenReady.done = true;
    console.log("ready");
  }
};

async function pollHttp() {
  while (!stopping) {
    const answer = await fetch(`http://127.0.0.1:${port}/login`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch(() => null);
    const now = Date.now();
    if (answer?.status === 200) {
      if (lastOk) stats.httpMaxGapMs = Math.max(stats.httpMaxGapMs, now - lastOk);
      lastOk = now;
      httpReady = true;
      announceWhenReady();
    } else if (lastOk) stats.httpFailures++;
    await delay(POLL_MS);
  }
}

// Resolves when the connection closes or fails to open; hello marks the client as connected.
function connectOnce(onHello) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: `http://127.0.0.1:${port}`, cookie: bothCookies() },
    });
    const timer = setTimeout(() => socket.terminate(), HTTP_TIMEOUT_MS * 4);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("message", (raw) => {
      if (JSON.parse(String(raw)).t !== "hello") return;
      clearTimeout(timer); // only a connection that never says hello is cut off
      onHello();
    });
  });
}

async function pollWebSocket() {
  let closedAt = 0;
  while (!stopping) {
    await connectOnce(() => {
      const now = Date.now();
      if (closedAt) {
        stats.wsMaxGapMs = Math.max(stats.wsMaxGapMs, now - closedAt);
        stats.wsReconnects++;
        closedAt = 0;
      }
      wsReady = true;
      announceWhenReady();
    });
    if (wsReady) closedAt ||= Date.now();
    await delay(POLL_MS);
  }
}

function finish() {
  if (stopping) return;
  stopping = true;
  const summary = { ...stats, seconds: Math.round((Date.now() - began) / 100) / 10 };
  console.log(JSON.stringify(summary));
  process.exit(0);
}

process.on("SIGINT", finish);
process.on("SIGTERM", finish);
if (Number.isFinite(seconds)) setTimeout(finish, seconds * 1000);
void pollHttp();
void pollWebSocket();
