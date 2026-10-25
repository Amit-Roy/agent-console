import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import type { EventLog } from "./automation/events.ts";
import type { ProviderUsage } from "./usage.ts";
import { fiveHour } from "./window-dispatch.ts";

// A five-hour window starts with the first message after the previous window ends.
// Open idle providers throughout the day so the dispatcher can use expiring quota.
// Optional hour bounds restrict openings; equal bounds allow all day.

export interface OpenerConfig {
  enabled: boolean;
  dryRun: boolean;
  from: string; // HH:MM local: first minute windows may be opened
  to: string; // HH:MM local: exclusive end; equal to `from` means all day
  providers: string[]; // claude, codex
  tz: string;
}
export const OPENER_DEFAULTS: OpenerConfig = {
  enabled: false,
  dryRun: true,
  from: "00:00",
  to: "00:00",
  providers: ["claude", "codex"],
  tz: "Asia/Kolkata",
};
export const OPENER_ROUTES: Record<string, { model: string; effort: string }> = {
  claude: { model: "sonnet", effort: "low" },
  codex: { model: "gpt-6.1-sol", effort: "low" },
};
const MIN_GAP_MS = 10 * 60_000; // a window just opened may not show in usage yet: never open twice in a row

const hm = (v: unknown, d: string) =>
  typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d;
export function loadOpenerConfig(file = path.join(DATA_DIR, "window-dispatch.json")): OpenerConfig {
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")).opener ?? {};
  } catch {}
  let tz = OPENER_DEFAULTS.tz;
  try {
    if (typeof raw.tz === "string") {
      new Intl.DateTimeFormat("en", { timeZone: raw.tz });
      tz = raw.tz;
    }
  } catch {}
  const providers = Array.isArray(raw.providers)
    ? raw.providers.filter((p: unknown): p is string => typeof p === "string" && p in OPENER_ROUTES)
    : OPENER_DEFAULTS.providers;
  return {
    enabled: raw.enabled === true,
    dryRun: raw.dryRun !== false,
    from: hm(raw.from, OPENER_DEFAULTS.from),
    to: hm(raw.to, OPENER_DEFAULTS.to),
    providers,
    tz,
  };
}

export function localMinutes(ts: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ts);
  return (
    Number(p.find((x) => x.type === "hour")!.value) * 60 +
    Number(p.find((x) => x.type === "minute")!.value)
  );
}
export function inHours(ts: number, cfg: Pick<OpenerConfig, "from" | "to" | "tz">): boolean {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const now = localMinutes(ts, cfg.tz),
    a = m(cfg.from),
    b = m(cfg.to);
  if (a === b) return true;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

const FULL_WINDOW_MS = 5 * 3_600_000,
  IDLE_SLACK_MS = 2 * 60_000;
/** No reading, a reading whose reset time has passed, or an idle account means no window is running. Codex reports an idle
 *  account as 0% used with a reset a full five hours after the reading, so that window has not started. */
export function needsOpen(u: ProviderUsage | undefined, now: number): boolean {
  const w = fiveHour(u, now);
  if (!w) return true;
  return w.used === 0 && !!u && w.resetsAt - u.updatedAt >= FULL_WINDOW_MS - IDLE_SLACK_MS;
}

type OpenerOptions = {
  usage: () => Record<string, ProviderUsage>;
  refresh?: () => Promise<void>; // fresh quota readings (Codex can be asked on demand; Claude only reports during turns)
  open?: (
    provider: string,
    route: { model: string; effort: string },
    account?: string,
  ) => Promise<void> | void;
  claudeAccounts?: () => string[]; // signed-in Claude accounts; each has its own quota window. Default: Sunny only
  dir?: string;
  now?: () => number;
  events?: EventLog;
};

type OpenerContext = {
  opts: OpenerOptions;
  dir: string;
  ledger: string;
  now: () => number;
  lastOpened: Map<string, number>;
};

function loadLedger(ledger: string, lastOpened: Map<string, number>) {
  try {
    for (const line of fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (!row.dryRun && !row.error)
        lastOpened.set(row.account ? `${row.provider}:${row.account}` : row.provider, row.ts);
    }
  } catch {}
}

// usage key per quota window: Claude fans out per account, Nefro's key is "claude:nefro"
function openerTargets(ctx: OpenerContext, providers: string[]) {
  return providers.flatMap((provider) =>
    provider === "claude"
      ? (ctx.opts.claudeAccounts?.() ?? ["sunny"]).map((account) =>
          account === "nefro" ? "claude:nefro" : "claude",
        )
      : [provider],
  );
}

function keyIsDue(ctx: OpenerContext, key: string, live: boolean): boolean {
  if (!needsOpen(ctx.opts.usage()[key], ctx.now())) return false;
  if (ctx.now() - (ctx.lastOpened.get(key) ?? 0) < MIN_GAP_MS) return false;
  // A dry run logs once per gap too, so the log shows what would have happened rather than a line per tick.
  if (!live && ctx.now() - (ctx.lastOpened.get("dry:" + key) ?? 0) < MIN_GAP_MS) return false;
  return true;
}

// Returns true when the window counts as opened; false when the open failed.
async function openKey(ctx: OpenerContext, key: string, live: boolean): Promise<boolean> {
  const events = ctx.opts.events;
  const [provider, account] = key.split(":");
  const row = {
    ts: ctx.now(),
    dryRun: !live,
    provider,
    ...(account ? { account } : {}),
    ...OPENER_ROUTES[provider],
  };
  fs.appendFileSync(ctx.ledger, JSON.stringify(row) + "\n", { mode: 0o600 });
  ctx.lastOpened.set(live ? key : "dry:" + key, ctx.now());
  const run = `open:${key}:${ctx.now()}`;
  events?.record({ step: "opener", kind: "start", run, ref: key });
  if (live)
    try {
      await ctx.opts.open!(provider, OPENER_ROUTES[provider], account);
    } catch (error: any) {
      ctx.lastOpened.delete(key); // a failed open does not count; the next tick may try again
      const message = String(error?.message ?? error).slice(0, 300);
      fs.appendFileSync(ctx.ledger, JSON.stringify({ ...row, error: message }) + "\n", {
        mode: 0o600,
      });
      events?.record({ step: "opener", kind: "fail", run, ref: key, msg: `${key}: ${message}` });
      return false;
    }
  events?.record({
    step: "opener",
    kind: "ok",
    run,
    ref: key,
    msg: live ? `opened ${key}` : `would open ${key} (dry run)`,
  });
  return true;
}

async function openerTick(ctx: OpenerContext) {
  const cfg = loadOpenerConfig(path.join(ctx.dir, "window-dispatch.json"));
  if (!cfg.enabled) return [];
  const events = ctx.opts.events;
  if (!inHours(ctx.now(), cfg)) {
    events?.record({
      step: "opener",
      kind: "info",
      msg: `nothing to do: outside ${cfg.from}–${cfg.to} ${cfg.tz}`,
    });
    return [];
  }
  await ctx.opts.refresh?.().catch(() => {});
  const live = !cfg.dryRun && !!ctx.opts.open;
  const opened: string[] = [];
  for (const key of openerTargets(ctx, cfg.providers)) {
    if (!keyIsDue(ctx, key, live)) continue;
    if (await openKey(ctx, key, live)) opened.push(key);
  }
  if (!opened.length)
    events?.record({
      step: "opener",
      kind: "info",
      msg: `nothing to do: ${openerTargets(ctx, cfg.providers).every((key) => !needsOpen(ctx.opts.usage()[key], ctx.now())) ? "every window is live" : "an open was tried in the last 10 minutes"}`,
    });
  return opened;
}

export function createOpener(opts: OpenerOptions) {
  const dir = opts.dir ?? DATA_DIR;
  const ctx: OpenerContext = {
    opts,
    dir,
    ledger: path.join(dir, "window-opener.jsonl"),
    now: opts.now ?? Date.now,
    lastOpened: new Map<string, number>(),
  };
  loadLedger(ctx.ledger, ctx.lastOpened);
  const tick = () => openerTick(ctx);
  return { tick };
}
