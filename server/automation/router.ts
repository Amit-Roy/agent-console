import type { ProviderUsage } from "../usage.ts";
import type { Route } from "../window-dispatch.ts";
import { VERSION } from "./contracts.ts";

// Pure routing: which provider takes a piece of work, from quota headroom and what is already running. Same request, same answer.

export type Role = "work" | "review" | "debug";
export type Effort = "trivial" | "bau" | "deep";
export interface RouteRequest {
  v?: number;
  role: Role;
  effort: Effort;
  usage: Record<string, ProviderUsage>;
  active: readonly { provider: string; role: string }[]; // automation threads running now
  now: number;
  premium?: boolean; // non-Deep work given an expiring premium slot: Sonnet low or Sol low, never Pi
  flags?: { bauOnPi?: boolean };
  failures?: Record<string, number>; // recent failed runs per provider
}
export interface RouteResponse {
  v: typeof VERSION;
  decision: "route" | "defer" | "skip";
  route?: Route;
  score?: number;
  alternatives: { route: Route; score: number }[];
  why: string;
}

const SONNET: Route = { provider: "claude", model: "sonnet", effort: "medium" };
const OPUS: Route = { provider: "claude", model: "opus", effort: "medium" };
const SOL = (effort: string): Route => ({ provider: "codex", model: "gpt-6.1-sol", effort });
const PI: Route = { provider: "pi", model: "default", effort: "default" };

const PI_CONCURRENCY = 3,
  PI_FAILURE_LIMIT = 3,
  LOAD_PENALTY = 10,
  GOOD = 20;

function candidates(req: RouteRequest): Route[] | undefined {
  if (req.role === "review") return req.effort === "deep" ? undefined : [SONNET, SOL("low")];
  if (req.role === "debug") return [SONNET, SOL("medium"), PI];
  if (req.premium && req.effort !== "deep") return [{ ...SONNET, effort: "low" }, SOL("low")];
  if (req.effort === "trivial") return [PI];
  if (req.effort === "bau") return req.flags?.bauOnPi ? [PI] : [SONNET, SOL("low")];
  return [{ ...OPUS, effort: "medium" }, SOL("high")];
}

const live = (u: ProviderUsage | undefined, label: string, now: number) =>
  u?.windows.find((w) => w.label === label && w.limit > 0 && (!w.resetsAt || w.resetsAt > now));
const room = (w: { used: number; limit: number }) =>
  Math.max(0, ((w.limit - w.used) / w.limit) * 100);

interface Scored {
  route: Route;
  score: number;
  klass: 0 | 1 | 2;
  why: string;
}
function score(route: Route, req: RouteRequest): Scored | undefined {
  const p = route.provider,
    u = req.usage[p];
  const load = req.active.filter((a) => a.provider === p).length;
  if (p === "pi") {
    if (load >= PI_CONCURRENCY) return undefined;
    if ((req.failures?.pi ?? 0) >= PI_FAILURE_LIMIT) return undefined;
    // The reported Free/day counter is OpenRouter's; direct NVIDIA workers do not draw on it, so it never gates dispatch.
    return {
      route,
      score: 50 - load * 5 - (req.failures?.pi ?? 0) * 10,
      klass: 1,
      why: "pi has its own capacity",
    };
  }
  const five = live(u, "5-hour", req.now),
    week = live(u, "7-day", req.now);
  if ((five && room(five) <= 0) || (week && room(week) <= 0)) return undefined; // exhausted, or weekly cap reached
  if (!five) return { route, score: 50 - load * LOAD_PENALTY, klass: 1, why: `${p} usage unknown` };
  const left = Math.min(room(five), week ? room(week) : 100);
  const minutes = five.resetsAt ? Math.max(0, (five.resetsAt - req.now) / 60_000) : 300;
  const expiry = 10 * (1 - Math.min(300, minutes) / 300); // use the window that ends first
  return {
    route,
    score: left - load * LOAD_PENALTY + expiry,
    klass: left >= GOOD ? 0 : 2,
    why: `${p} ${Math.round(left)}% left${load ? `, ${load} running` : ""}, window ends in ${Math.round(minutes)} min`,
  };
}

export function route(req: RouteRequest): RouteResponse {
  if (req.v !== undefined && req.v !== VERSION)
    throw new Error(`Unsupported request version ${String(req.v)}`);
  if (!["work", "review", "debug"].includes(req.role))
    throw new Error(`Unknown role "${req.role}"`);
  const list = candidates(req);
  if (!list)
    return {
      v: VERSION,
      decision: "skip",
      alternatives: [],
      why: "Deep work is not reviewed by a second model",
    };
  // good headroom first, then unknown (never preferred over a known-good provider), then known-low; best score within each class
  const ranked = list
    .map((r) => score(r, req))
    .filter((s): s is Scored => !!s)
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.klass - b.klass || b.score - a.score || a.i - b.i);
  if (!ranked.length) {
    const premium = list.some((r) => r.provider !== "pi");
    return {
      v: VERSION,
      decision: "defer",
      alternatives: [],
      why: premium
        ? "No premium provider has room; waiting for the next window or tick"
        : "Pi is at capacity or failing; waiting",
    };
  }
  const [best, ...rest] = ranked;
  return {
    v: VERSION,
    decision: "route",
    route: best.route,
    score: best.score,
    alternatives: rest.map((r) => ({ route: r.route, score: r.score })),
    why: best.why,
  };
}
