import { spawn } from "node:child_process";
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

function summarize(lines: DoctorCheckLine[], exitCode: number | null): DoctorResult {
  const byId = new Map(lines.map((entry) => [entry.check, entry]));
  const proxyFail = PROXY_IDS.find((id) => byId.get(id)?.result === "fail");
  const proxyMissing = PROXY_IDS.find((id) => !byId.has(id));
  let proxy: ProxyResult = { ok: true };
  if (proxyFail) proxy = { ok: false, code: proxyFail };
  else if (proxyMissing || exitCode !== 0) proxy = { ok: false, code: proxyMissing ?? "doctor" };
  const checkFail = CHECK_IDS.map((id) => byId.get(id)).find((entry) => entry?.result === "fail");
  const checkLines = CHECK_IDS.map((id) => byId.get(id));
  let check: CheckResult;
  if (checkFail) {
    check = { ok: false, code: checkFail.check };
    if (checkFail.http) check.http = checkFail.http;
  } else if (checkLines.some((entry) => entry?.result === "skip")) check = { skip: true };
  else if (checkLines.every((entry) => entry?.result === "pass") && exitCode === 0)
    check = { ok: true };
  else check = { ok: false, code: "doctor" };
  return { proxy, check };
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
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      finish(FAILED);
    }, Number(process.env.VAULT_DOCTOR_TIMEOUT_MS) || TIMEOUT_MS);
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on("line", (raw) => {
        const entry = parseLine(raw);
        if (!entry) return;
        lines.push(entry);
        onCheck?.(entry);
      });
    }
    child.on("error", () => finish(FAILED));
    child.on("close", (code) => finish(summarize(lines, code)));
  });
}
