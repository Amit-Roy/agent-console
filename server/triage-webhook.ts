import type { IncomingMessage, ServerResponse } from "node:http";
import { verify } from "@octokit/webhooks-methods";
import { enqueue, schedule } from "./triage-queue.ts";
import { reconcile } from "./triage-scan.ts";
import { triageStatus } from "./triage-store.ts";
import { ACTIONS, type Kind, logEvent, MANAGED, type TriageContext } from "./triage-types.ts";

type WebhookCall = {
  ctx: TriageContext;
  res: ServerResponse;
  event: string;
  delivery: string;
  payload: any;
};
type EventHandler = (call: WebhookCall) => Promise<void> | void;

export function respond(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function eventKind(event: string): Kind {
  return event === "issues" ? "issue" : "pull_request";
}

function allowedRepo(ctx: TriageContext, payload: any): string | undefined {
  const repo = payload.repository?.full_name;
  return typeof repo === "string" && ctx.repos.has(repo) ? repo : undefined;
}

function itemNumber(item: any): number | undefined {
  const number = item?.number;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

// Answers health checks, unknown routes and shutdown; returns the route kind for webhook traffic.
function routeRequest(
  ctx: TriageContext,
  req: IncomingMessage,
  res: ServerResponse,
): { reconciliation: boolean } | undefined {
  if (req.method === "GET" && req.url === "/health") {
    respond(res, ctx.closing ? 503 : 200, { ok: !ctx.closing, ...triageStatus(ctx) });
    return undefined;
  }
  const reconciliation = req.url === "/reconcile";
  if (req.method !== "POST" || (req.url !== "/api/github/webhook" && !reconciliation)) {
    respond(res, 404, { error: "Not found" });
    return undefined;
  }
  if (ctx.closing) {
    respond(res, 503, { error: "Shutting down" });
    return undefined;
  }
  return { reconciliation };
}

function hasValidHeaders(
  signature: unknown,
  delivery: unknown,
  event: unknown,
  reconciliation: boolean,
): boolean {
  if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  if (reconciliation) return true;
  return (
    typeof delivery === "string" &&
    /^[A-Za-z0-9-]{1,128}$/.test(delivery) &&
    typeof event === "string"
  );
}

// Returns the raw body, or undefined after answering 413.
async function readBody(
  ctx: TriageContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Buffer | undefined> {
  const limit = ctx.options.maxBodyBytes ?? 1024 * 1024;
  if (Number(req.headers["content-length"]) > limit) {
    respond(res, 413, { error: "Body too large" });
    req.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      respond(res, 413, { error: "Body too large" });
      req.resume();
      return undefined;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Returns the verified JSON object, or undefined after answering 400/401.
async function verifiedPayload(
  ctx: TriageContext,
  res: ServerResponse,
  raw: Buffer,
  signature: string,
): Promise<any | undefined> {
  const text = raw.toString("utf8");
  // Octokit's verifier accepts UTF-8 strings. Reject lossy decoding to preserve
  // the exact signed bytes, including whitespace and escaped characters.
  if (
    !Buffer.from(text, "utf8").equals(raw) ||
    !(await verify(ctx.options.secret, text, signature))
  ) {
    respond(res, 401, { error: "Invalid signature" });
    return undefined;
  }
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    respond(res, 400, { error: "Invalid JSON" });
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    respond(res, 400, { error: "Invalid payload" });
    return undefined;
  }
  return payload;
}

async function handleReconcile(ctx: TriageContext, res: ServerResponse, payload: any) {
  const repo = allowedRepo(ctx, payload);
  if (!repo) {
    respond(res, 403, { error: "Repository not allowed" });
    return;
  }
  respond(res, 200, await reconcile(ctx, repo));
}

function handlePing(call: WebhookCall) {
  respond(call.res, 200, { pong: true });
}

function isDeployableRun(workflow: string, payload: any): boolean {
  const run = payload.workflow_run;
  return !(
    payload.action !== "completed" ||
    run?.name !== workflow ||
    run.conclusion !== "success" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    typeof run.head_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  );
}

function handleWorkflowRun(call: WebhookCall) {
  const { ctx, res, payload } = call;
  const deploy = ctx.options.deploy;
  if (!deploy || !isDeployableRun(deploy.workflow, payload)) {
    respond(res, 200, { ignored: true });
    return;
  }
  const repo = allowedRepo(ctx, payload);
  if (!repo) {
    respond(res, 403, { error: "Repository not allowed" });
    return;
  }
  const sha = payload.workflow_run.head_sha;
  logEvent(ctx, "deploy_requested", { repo, sha });
  respond(res, 202, { deploying: true });
  try {
    deploy.run(repo, sha);
  } catch {
    logEvent(ctx, "deploy_failed", { repo });
  }
}

function handleClosed(call: WebhookCall) {
  const { ctx, res, event, payload } = call;
  const repo = allowedRepo(ctx, payload);
  if (!repo) {
    respond(res, 403, { error: "Repository not allowed" });
    return;
  }
  const item = event === "issues" ? payload.issue : payload.pull_request;
  const number = itemNumber(item);
  if (number === undefined) {
    respond(res, 400, { error: "Invalid item number" });
    return;
  }
  const done = event === "issues" ? !item.pull_request : item.merged === true;
  if (done) {
    try {
      ctx.options.onClosed?.({ repo, number, kind: eventKind(event) });
    } catch {
      logEvent(ctx, "on_closed_failed");
    }
  }
  respond(res, 200, { closed: done });
}

function notifyAccepted(ctx: TriageContext, repo: string, number: number, kind: Kind) {
  if (!ctx.options.onItem) return;
  try {
    void Promise.resolve(ctx.options.onItem({ repo, number, kind })).catch(() =>
      logEvent(ctx, "on_item_failed"),
    );
  } catch {
    logEvent(ctx, "on_item_failed");
  }
}

function handleItemChange(call: WebhookCall) {
  const { ctx, res, event, delivery, payload } = call;
  const repo = allowedRepo(ctx, payload);
  if (!repo) {
    respond(res, 403, { error: "Repository not allowed" });
    return;
  }
  if (!ACTIONS[event as keyof typeof ACTIONS].has(payload.action)) {
    respond(res, 200, { ignored: true });
    return;
  }
  if (payload.action === "unlabeled" && !MANAGED.has(payload.label?.name)) {
    respond(res, 200, { ignored: true });
    return;
  }
  const item = event === "issues" ? payload.issue : payload.pull_request;
  const number = itemNumber(item);
  if (number === undefined) {
    respond(res, 400, { error: "Invalid item number" });
    return;
  }
  if (event === "issues" && item.pull_request) {
    respond(res, 200, { ignored: true });
    return;
  }
  const reason = payload.action === "unlabeled" ? "repair" : "webhook";
  const inserted = enqueue(ctx, repo, number, eventKind(event), reason, delivery);
  respond(res, 202, { accepted: true, duplicate: !inserted });
  notifyAccepted(ctx, repo, number, eventKind(event));
  schedule(ctx);
}

function handleItemEvent(call: WebhookCall) {
  if (call.payload.action === "closed") handleClosed(call);
  else handleItemChange(call);
}

const EVENT_HANDLERS: Record<string, EventHandler> = {
  ping: handlePing,
  workflow_run: handleWorkflowRun,
  issues: handleItemEvent,
  pull_request: handleItemEvent,
};

async function receive(ctx: TriageContext, req: IncomingMessage, res: ServerResponse) {
  const route = routeRequest(ctx, req, res);
  if (!route) return;
  const signature = req.headers["x-hub-signature-256"];
  const delivery = req.headers["x-github-delivery"];
  const event = req.headers["x-github-event"];
  if (!hasValidHeaders(signature, delivery, event, route.reconciliation)) {
    respond(res, 401, { error: "Invalid webhook headers" });
    req.resume();
    return;
  }
  const raw = await readBody(ctx, req, res);
  if (!raw) return;
  const payload = await verifiedPayload(ctx, res, raw, signature as string);
  if (!payload) return;
  if (route.reconciliation) {
    await handleReconcile(ctx, res, payload);
    return;
  }
  if (typeof event !== "string" || typeof delivery !== "string") {
    respond(res, 401, { error: "Invalid webhook headers" });
    return;
  }
  if (!Object.hasOwn(EVENT_HANDLERS, event)) {
    respond(res, 200, { ignored: true });
    return;
  }
  await EVENT_HANDLERS[event]({ ctx, res, event, delivery, payload });
}

export function handleRequest(ctx: TriageContext, req: IncomingMessage, res: ServerResponse) {
  receive(ctx, req, res).catch(() => {
    logEvent(ctx, "request_failed");
    if (!res.headersSent) respond(res, 500, { error: "Webhook request failed" });
    else if (!res.writableEnded) res.end();
  });
}
