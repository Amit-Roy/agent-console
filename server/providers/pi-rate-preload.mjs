import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
// Node preloads this module before Pi loads its provider SDKs. Every model HTTP
// attempt, including SDK retries and subsequent tool turns, uses one shared gate.
const originalFetch = globalThis.fetch.bind(globalThis);
const installed = Symbol.for("agent-console.pi-rate-preload");

export function modelProvider(input) {
  try {
    const host = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    ).hostname.toLowerCase();
    if (host === "integrate.api.nvidia.com") return "nvidia";
    if (host === "openrouter.ai") return "openrouter";
  } catch {}
  return "other";
}

export async function isModelRequest(input, init = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = String(
    init.method ?? (input instanceof Request ? input.method : "GET"),
  ).toUpperCase();
  if (method !== "POST") return false;
  if (
    process.env.AGENT_CONSOLE_RATE_URL &&
    url.href === new URL(process.env.AGENT_CONSOLE_RATE_URL).href
  )
    return false;
  const tools = process.env.AGENT_CONSOLE_TOOL_URL;
  if (tools) {
    const base = new URL(tools);
    if (
      url.origin === base.origin &&
      (url.pathname === base.pathname || url.pathname.startsWith(base.pathname + "/"))
    )
      return false;
  }
  if (
    /(?:^|\/)(?:chat\/completions|completions|responses|messages|generate|chat|invoke|invoke-with-response-stream|converse|converse-stream)(?:\/|$)|:(?:streamGenerateContent|generateContent|streamRawPredict|rawPredict)(?:$|\?)/i.test(
      url.pathname,
    )
  )
    return true;
  // Custom compatible endpoints may use a vendor-specific path. Match their
  // model payload rather than throttling tool callbacks, catalog and auth calls.
  let body = init.body;
  if (body === undefined && input instanceof Request) body = await input.clone().text();
  if (typeof body !== "string") return false;
  try {
    const payload = JSON.parse(body);
    return (
      !!payload &&
      typeof payload === "object" &&
      (typeof payload.model === "string" || Array.isArray(payload.models)) &&
      (Array.isArray(payload.messages) ||
        payload.input !== undefined ||
        payload.prompt !== undefined ||
        Array.isArray(payload.contents))
    );
  } catch {
    return false;
  }
}

async function gate(action, provider, signal, retryAfter) {
  signal?.throwIfAborted();
  const url = process.env.AGENT_CONSOLE_RATE_URL;
  const token = process.env.AGENT_CONSOLE_RATE_TOKEN;
  if (!url || !token) throw new Error("Pi model rate-limit broker is not configured.");
  const response = await originalFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-console-tool": token },
    body: JSON.stringify({
      action,
      provider,
      priority: process.env.AGENT_CONSOLE_MODEL_PRIORITY || "interactive",
      ...(retryAfter != null ? { retryAfter } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(
      payload.error?.message ||
        payload.message ||
        `Pi model rate-limit broker failed (${response.status}).`,
    );
    error.code = payload.error?.code || payload.code || "MODEL_RATE_BROKER_FAILED";
    error.status = response.status;
    throw error;
  }
  await response.arrayBuffer();
  signal?.throwIfAborted();
}

export function installPiRateLimit() {
  if (globalThis[installed]) return;
  globalThis[installed] = true;
  // AWS Bedrock uses NodeHttpHandler instead of fetch. Requests buffer their
  // writes until Agent.addRequest assigns a socket, so admission precedes bytes.
  const addRequest = http.Agent.prototype.addRequest;
  http.Agent.prototype.addRequest = function rateLimitedAddRequest(request, options) {
    const url = new URL(
      request.path,
      `${options.protocol || "http:"}//${options.hostname || options.host || "localhost"}`,
    );
    if (
      request.method !== "POST" ||
      !/(?:^|\/)(?:chat\/completions|completions|responses|messages|generate|chat|invoke|invoke-with-response-stream|converse|converse-stream)(?:\/|$)|:(?:streamGenerateContent|generateContent|streamRawPredict|rawPredict)$/i.test(
        url.pathname,
      )
    ) {
      return addRequest.call(this, request, options);
    }
    const controller = new AbortController();
    request.once("close", () => controller.abort());
    request.prependOnceListener("response", (response) => {
      if (response.statusCode === 429)
        void gate("cooldown", modelProvider(url), undefined, response.headers["retry-after"]).catch(
          (error) => request.destroy(error),
        );
    });
    void gate("acquire", modelProvider(url), controller.signal)
      .then(() => {
        if (!request.destroyed) addRequest.call(this, request, options);
      })
      .catch((error) => request.destroy(error));
  };
  // Codex can reuse one WebSocket across turns. Gate each model message rather
  // than only the connection handshake, preserving the native socket class.
  const patchedSockets = new WeakSet();
  const patchWebSocket = (websocket) => {
    if (typeof websocket !== "function" || patchedSockets.has(websocket)) return;
    patchedSockets.add(websocket);
    const send = websocket.prototype.send;
    const tails = new WeakMap();
    const observed = new WeakSet();
    websocket.prototype.send = function rateLimitedWebSocketSend(data) {
      let payload;
      try {
        payload = typeof data === "string" ? JSON.parse(data) : undefined;
      } catch {}
      if (
        !payload ||
        (payload.type !== "response.create" &&
          !(payload.model && (payload.messages || payload.input)))
      )
        return send.call(this, data);
      if (this.readyState !== websocket.OPEN) return send.call(this, data);
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener("message", (event) => {
          let message;
          try {
            message = typeof event.data === "string" ? JSON.parse(event.data) : undefined;
          } catch {}
          const error = message?.error ?? message?.response?.error;
          if (
            message?.status === 429 ||
            error?.status === 429 ||
            error?.code === 429 ||
            /rate_limit|too_many_requests/i.test(String(error?.code ?? ""))
          ) {
            void gate(
              "cooldown",
              modelProvider(this.url),
              undefined,
              error?.retry_after ?? message?.retry_after,
            ).catch(() => {
              if (this.readyState === websocket.OPEN)
                this.close(4001, "Model rate-limit admission failed.");
            });
          }
        });
      }
      const controller = new AbortController();
      const closed = () => controller.abort();
      this.addEventListener("close", closed, { once: true });
      const pending = (tails.get(this) ?? Promise.resolve())
        .then(async () => {
          if (this.readyState !== websocket.OPEN) return;
          await gate("acquire", modelProvider(this.url), controller.signal);
          if (this.readyState === websocket.OPEN) send.call(this, data);
        })
        .catch(() => {
          if (this.readyState === websocket.OPEN)
            this.close(4001, "Model rate-limit admission failed.");
        })
        .finally(() => this.removeEventListener("close", closed));
      tails.set(this, pending);
    };
  };
  // Assigned fetches, oldest first. A replacement may wrap the gated fetch it
  // read earlier; a call from inside a transport uses the previous one, ungated.
  const transports = [originalFetch];
  const depth = new AsyncLocalStorage();
  const rateLimitedFetch = async function rateLimitedFetch(input, init) {
    const level = depth.getStore() ?? 0;
    const transport = (request, options) =>
      depth.run(level + 1, () =>
        transports[Math.max(0, transports.length - 1 - level)](request, options),
      );
    if (level > 0 || !(await isModelRequest(input, init))) return transport(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      await gate("acquire", modelProvider(input), signal);
    } catch (error) {
      // A terminal admission decision is a client error, not a transport failure.
      // Compatible SDKs therefore surface its code without their 429 retry loop.
      if (/QUOTA|EXHAUSTED/.test(String(error.code || ""))) {
        return new Response(
          JSON.stringify({
            error: { message: error.message, code: error.code, type: "rate_limit_admission_error" },
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw error;
    }
    signal?.throwIfAborted();
    const response = await transport(input, init);
    if (response.status === 429)
      await gate("cooldown", modelProvider(input), undefined, response.headers.get("retry-after"));
    return response;
  };
  // Pi installs undici's fetch and WebSocket after this preload runs. Each later
  // assignment becomes the transport behind the gate instead of replacing it.
  let websocket = globalThis.WebSocket;
  patchWebSocket(websocket);
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    enumerable: false,
    get: () => websocket,
    set: (value) => {
      patchWebSocket(value);
      websocket = value;
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: true,
    get: () => rateLimitedFetch,
    set: (value) => {
      if (typeof value === "function" && value !== rateLimitedFetch) transports.push(value);
    },
  });
}

installPiRateLimit();
