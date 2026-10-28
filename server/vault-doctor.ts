import { type ChildProcess, spawn } from "node:child_process";
import readline from "node:readline";
import { NAME } from "./vault-iron.ts";

// Provider check via `iron doctor --only NAME --json`. Only allowlisted contract lines are read;
// all other output is dropped, so nothing from the command reaches the result.
export type ProxyResult = { ok: true } | { ok: false; code: string };
export type CheckResult =
  | { ok: true }
  | { ok: false; code: string; http?: string }
  | { skip: true };
export type DoctorResult = { proxy: ProxyResult; check: CheckResult };
export type DoctorCheckLine = {
  check: string;
  result: "pass" | "fail" | "skip";
  http?: string;
};

const TIMEOUT_MS = 90_000;
const PROXY_IDS = ["ssh", "service", "listener"];
const CHECK_IDS = ["token", "live"];
const RESULTS = new Set(["pass", "fail", "skip"]);
const HTTP = /^\d{3}$|^none$/;
const FAILED: DoctorResult = {
  proxy: { ok: false, code: "doctor" },
  check: { ok: false, code: "doctor" },
};

function parseLine(line: string): DoctorCheckLine | null {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const { check, result, http } = parsed;
    if (![...PROXY_IDS, ...CHECK_IDS].includes(check) || !RESULTS.has(result)) return null;
    const out: DoctorCheckLine = { check, result };
    if (typeof http === "string" && HTTP.test(http)) out.http = http;
    return out;
  } catch {
    return null;
  }
}

function summarizeProxy(byId: Map<string, DoctorCheckLine>, unexplained: boolean): ProxyResult {
  const failed = PROXY_IDS.find((checkId) => byId.get(checkId)?.result === "fail");
  if (failed) return { ok: false, code: failed };
  const missing = PROXY_IDS.find((checkId) => !byId.has(checkId));
  if (missing) return { ok: false, code: missing };
  return unexplained ? { ok: false, code: "doctor" } : { ok: true };
}

function summarizeCheck(byId: Map<string, DoctorCheckLine>, exitCode: number | null): CheckResult {
  const checkLines = CHECK_IDS.map((checkId) => byId.get(checkId));
  const failing = checkLines.find((entry) => entry?.result === "fail");
  if (failing) {
    const failed: CheckResult = { ok: false, code: failing.check };
    if (failing.http) failed.http = failing.http;
    return failed;
  }
  if (checkLines.some((entry) => entry?.result === "skip")) return { skip: true };
  const allPass = checkLines.every((entry) => entry?.result === "pass");
  return allPass && exitCode === 0 ? { ok: true } : { ok: false, code: "doctor" };
}

// Real iron exits 1 when the live check fails, so a non-zero exit alone only matters when no
// line explains it.
function summarize(lines: DoctorCheckLine[], exitCode: number | null): DoctorResult {
  const byId = new Map(lines.map((entry) => [entry.check, entry]));
  const unexplained = exitCode !== 0 && !lines.some((entry) => entry.result === "fail");
  return { proxy: summarizeProxy(byId, unexplained), check: summarizeCheck(byId, exitCode) };
}

function killGroup(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

function collectLines(
  child: ChildProcess,
  lines: DoctorCheckLine[],
  onCheck?: (line: DoctorCheckLine) => void,
) {
  if (!child.stdout) return;
  readline.createInterface({ input: child.stdout }).on("line", (raw) => {
    const entry = parseLine(raw);
    if (!entry) return;
    lines.push(entry);
    onCheck?.(entry);
  });
}

export function providerCheck(
  name: string,
  onCheck?: (line: DoctorCheckLine) => void,
): Promise<DoctorResult> {
  if (!NAME.test(name)) return Promise.resolve(FAILED);
  return new Promise((resolve) => {
    const lines: DoctorCheckLine[] = [];
    let finished = false;
    const child = spawn(
      process.env.VAULT_DOCTOR_BIN || "iron",
      ["doctor", "--only", name, "--json"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      },
    );
    const finish = (result: DoctorResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killGroup(child);
      finish(FAILED);
    }, Number(process.env.VAULT_DOCTOR_TIMEOUT_MS) || TIMEOUT_MS);
    collectLines(child, lines, onCheck);
    child.on("error", () => finish(FAILED));
    child.on("close", (code) => finish(summarize(lines, code)));
  });
}
