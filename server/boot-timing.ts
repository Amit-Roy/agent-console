import fs from "node:fs";

// Boot telemetry (issue #18): when each startup phase finished, in ms since the process began (so module loading counts).
// One JSON line per flush in boot.jsonl, newest last, bounded. Phase names and durations only; no paths, prompts or secrets.
// A first-listen time over SLOW_BOOT_MS flags the record and calls onSlow, so a regression shows up in the event log.

export const SLOW_BOOT_MS = 5000;
export const KEEP = 200;

export interface BootRecord {
  ts: number;
  kind: string;
  phases: { name: string; at: number; ms: number }[];
  totalMs: number;
  slow: boolean;
}

export function createBootTiming(o: {
  file: string;
  uptime?: () => number;
  now?: () => number;
  slowMs?: number;
  onSlow?: (r: BootRecord) => void;
}) {
  const uptime = o.uptime ?? (() => process.uptime() * 1000);
  const now = o.now ?? Date.now;
  const slowMs = o.slowMs ?? SLOW_BOOT_MS;
  let pending: BootRecord["phases"] = [];
  let last = 0;
  const read = (): BootRecord[] => {
    try {
      return fs
        .readFileSync(o.file, "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            return l ? [JSON.parse(l) as BootRecord] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  };
  return {
    mark(name: string) {
      const at = Math.round(uptime());
      pending.push({ name, at, ms: at - last });
      last = at;
    },
    /** Writes the phases marked since the last flush as one record. Only "listen" is judged against the slow limit. */
    flush(kind: string): BootRecord {
      const rec: BootRecord = {
        ts: now(),
        kind,
        phases: pending,
        totalMs: last,
        slow: kind === "listen" && last > slowMs,
      };
      pending = [];
      try {
        const rows = [...read(), rec].slice(-KEEP);
        fs.writeFileSync(o.file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), {
          mode: 0o600,
        });
      } catch {
        console.warn("Boot timing could not be saved.");
      }
      if (rec.slow) o.onSlow?.(rec);
      return rec;
    },
    recent: (n = 20) => read().slice(-n),
  };
}
