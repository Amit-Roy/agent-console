import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import { fiveHour } from "./window-dispatch.ts";
import type { ProviderUsage } from "./usage.ts";

// A 5-hour window opens at the first message after the previous one ended. Overnight nothing opens one, so the quota that
// window-dispatch could use never starts counting down. During the configured hours, send one tiny message to each provider
// that has no live window; it ends five hours later, inside the hours when nobody is using it, which gives the dispatcher a slot.

export interface OpenerConfig {
  enabled: boolean;
  dryRun: boolean;
  from: string;        // HH:MM local: first minute windows may be opened
  to: string;          // HH:MM local: windows are not opened from here on (may be earlier than `from`: overnight)
  providers: string[]; // claude, codex
  tz: string;
}
export const OPENER_DEFAULTS: OpenerConfig = { enabled: false, dryRun: true, from: "23:00", to: "07:00", providers: ["claude", "codex"], tz: "Asia/Kolkata" };
export const OPENER_ROUTES: Record<string, { model: string; effort: string }> = {
  claude: { model: "sonnet", effort: "low" },
  codex: { model: "gpt-6.1-sol", effort: "low" },
};
const MIN_GAP_MS = 10 * 60_000; // a window just opened may not show in usage yet: never open twice in a row

const hm = (v: unknown, d: string) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d;
export function loadOpenerConfig(file = path.join(DATA_DIR, "window-dispatch.json")): OpenerConfig {
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")).opener ?? {}; } catch {}
  let tz = OPENER_DEFAULTS.tz;
  try { if (typeof raw.tz === "string") { new Intl.DateTimeFormat("en", { timeZone: raw.tz }); tz = raw.tz; } } catch {}
  const providers = Array.isArray(raw.providers) ? raw.providers.filter((p: unknown): p is string => typeof p === "string" && p in OPENER_ROUTES) : OPENER_DEFAULTS.providers;
  return { enabled: raw.enabled === true, dryRun: raw.dryRun !== false, from: hm(raw.from, OPENER_DEFAULTS.from), to: hm(raw.to, OPENER_DEFAULTS.to), providers, tz };
}

export function localMinutes(ts: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ts);
  return Number(p.find(x => x.type === "hour")!.value) * 60 + Number(p.find(x => x.type === "minute")!.value);
}
export function inHours(ts: number, cfg: Pick<OpenerConfig, "from" | "to" | "tz">): boolean {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const now = localMinutes(ts, cfg.tz), a = m(cfg.from), b = m(cfg.to);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

/** No reading, or a reading whose reset time has passed, means no window is running. */
export const needsOpen = (u: ProviderUsage | undefined, now: number) => !fiveHour(u, now);

export function createOpener(opts: {
  usage: () => Record<string, ProviderUsage>;
  refresh?: () => Promise<void>; // fresh quota readings (Codex can be asked on demand; Claude only reports during turns)
  open?: (provider: string, route: { model: string; effort: string }) => Promise<void> | void;
  dir?: string;
  now?: () => number;
}) {
  const dir = opts.dir ?? DATA_DIR;
  const ledger = path.join(dir, "window-opener.jsonl");
  const now = opts.now ?? Date.now;
  const lastOpened = new Map<string, number>();
  try { for (const l of fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); if (!r.dryRun && !r.error) lastOpened.set(r.provider, r.ts); } } catch {}
  async function tick() {
    const cfg = loadOpenerConfig(path.join(dir, "window-dispatch.json"));
    if (!cfg.enabled || !inHours(now(), cfg)) return [];
    await opts.refresh?.().catch(() => {});
    const live = !cfg.dryRun && !!opts.open;
    const opened: string[] = [];
    for (const provider of cfg.providers) {
      if (!needsOpen(opts.usage()[provider], now())) continue;
      if (now() - (lastOpened.get(provider) ?? 0) < MIN_GAP_MS) continue;
      // A dry run logs once per gap too, so the log shows what would have happened rather than a line per tick.
      if (!live && now() - (lastOpened.get("dry:" + provider) ?? 0) < MIN_GAP_MS) continue;
      const row = { ts: now(), dryRun: !live, provider, ...OPENER_ROUTES[provider] };
      fs.appendFileSync(ledger, JSON.stringify(row) + "\n", { mode: 0o600 });
      lastOpened.set(live ? provider : "dry:" + provider, now());
      if (live) try { await opts.open!(provider, OPENER_ROUTES[provider]); } catch (e: any) {
        lastOpened.delete(provider); // a failed open does not count; the next tick may try again
        fs.appendFileSync(ledger, JSON.stringify({ ...row, error: String(e?.message ?? e).slice(0, 300) }) + "\n", { mode: 0o600 });
        continue;
      }
      opened.push(provider);
    }
    return opened;
  }
  return { tick };
}
