// Process crash log for the "Process crashes (24 h)" security row. The VPS `crashes` verb already redacts, but its answer is
// untrusted: every field is re-validated and redacted again here before anything reaches the browser.
const CACHE_MS = 10_000;
const MAX_CRASHES = 20;
const MAX_CMDLINE = 300;
const MAX_FRAMES = 8;
const MAX_FRAME = 160;

export type Crash = {
  at: number;
  pid: number;
  uid: number;
  signal: string;
  exe: string;
  comm: string;
  scope: string;
  cmdline: string;
  frames: string[];
};
export type CrashLog = { generatedAt: number; total: number; crashes: Crash[] };

const SECRET_NAME =
  "[\\w.-]*(?:token|secret|pass(?:word|wd)?|key|auth|cookie|session|credential|bearer)[\\w.-]*";
const RULES: [RegExp, string][] = [
  [new RegExp(`(--${SECRET_NAME})(=|\\s+)\\S+`, "gi"), "$1$2[redacted]"],
  [new RegExp(`\\b(${SECRET_NAME})=\\S+`, "gi"), "$1=[redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  [/\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?\S+/gi, "$1[redacted]"],
  [/\bbearer\s+\S+/gi, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?/g, "[redacted]"],
  [/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]"],
];

/** Second redaction pass; the VPS pass is never trusted to be complete. */
export function redact(value: string): string {
  return RULES.reduce((out, [rule, to]) => out.replace(rule, to), value);
}

const clean = (v: unknown, n: number) =>
  typeof v === "string" ? redact(v.replace(/[^\x20-\x7e]/g, "?")).slice(0, n) : "";
const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);

function parseCrash(c: any): Crash | null {
  const at = int(c?.at);
  const pid = int(c?.pid);
  const uid = int(c?.uid);
  const signal = clean(c?.signal, 20);
  if (!at || pid === null || uid === null || !/^[A-Z0-9]{3,20}$/.test(signal)) return null;
  const frames = Array.isArray(c.frames)
    ? c.frames
        .slice(0, MAX_FRAMES)
        .filter((f: unknown) => typeof f === "string")
        .map((f: string) => clean(f, MAX_FRAME))
    : [];
  return {
    at,
    pid,
    uid,
    signal,
    exe: clean(c.exe, 200),
    comm: clean(c.comm, 40),
    scope: clean(c.scope, 60) || "host",
    cmdline: clean(c.cmdline, MAX_CMDLINE),
    frames,
  };
}

/** Re-validate what the VPS says; bad entries are dropped, never repaired. */
export function parseCrashes(raw: any): CrashLog {
  if (typeof raw?.error === "string")
    throw new Error(clean(raw.error, 200) || "The crash log is unavailable.");
  if (!raw || !Array.isArray(raw.crashes))
    throw new Error("The status host sent an unreadable answer.");
  const crashes: Crash[] = [];
  for (const entry of raw.crashes) {
    const crash = parseCrash(entry);
    if (crash) crashes.push(crash);
    if (crashes.length >= MAX_CRASHES) break;
  }
  const total = int(raw.total);
  return {
    generatedAt: int(raw.generatedAt) ?? 0,
    total: total === null ? crashes.length : Math.max(total, crashes.length),
    crashes,
  };
}

export interface SecCrashesDeps {
  /** One `crashes` call to the VPS forced command. */
  fetch: () => Promise<any>;
  now?: () => number;
}

export function createSecCrashes(deps: SecCrashesDeps) {
  const clock = deps.now ?? Date.now;
  let cache: { at: number; log: CrashLog } | null = null;
  let pending: Promise<CrashLog> | null = null;
  return {
    view(): Promise<CrashLog> {
      if (cache && clock() - cache.at < CACHE_MS) return Promise.resolve(cache.log);
      pending ||= deps
        .fetch()
        .then((raw) => {
          const log = parseCrashes(raw);
          cache = { at: clock(), log };
          return log;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
export type SecCrashes = ReturnType<typeof createSecCrashes>;
