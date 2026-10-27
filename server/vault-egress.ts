// Egress refresh after a provider is added: trust the iron CA and pin the new hosts, so agents reach
// them through iron-proxy. Failures are warnings (fixed text), never a rollback.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ironCaPem } from "./vault-iron.ts";

const PIN_TIMEOUT = 60_000;
const confDir = () => path.join(process.env.VAULT_HOME || os.homedir(), ".config", "agent-console");

function writeAtomic(file: string, data: string, mode: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function appendHosts(file: string, hosts: string[]) {
  let have: string[] = [];
  try {
    have = fs.readFileSync(file, "utf8").split("\n");
  } catch {}
  const known = new Set(have.map((l) => l.trim()));
  const fresh = hosts.filter((h) => !known.has(h));
  if (!fresh.length) return;
  const body = have.filter((l, i) => l !== "" || i < have.length - 1).join("\n");
  writeAtomic(file, (body ? body + "\n" : "") + fresh.join("\n") + "\n", 0o644);
}

function pinCommand(): { bin: string; argv: string[] } {
  const override = process.env.VAULT_EGRESS_PIN;
  if (override) return { bin: override, argv: [] };
  const dotfiles = process.env.VAULT_DOTFILES || path.join(os.homedir(), "repos", "dotfiles");
  return {
    bin: "sudo",
    argv: ["-n", path.join(dotfiles, "bin", "egress-pin")],
  };
}

function runPin(): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = pinCommand();
    const child = spawn(cmd.bin, cmd.argv, { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), PIN_TIMEOUT);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/* returns warnings (empty when everything worked) */
export async function refreshEgress(hosts: string[]): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const pem = await ironCaPem();
    if (pem) writeAtomic(path.join(confDir(), "egress-ca.pem"), pem, 0o644);
    else warnings.push("Could not fetch the iron CA certificate.");
  } catch {
    warnings.push("Could not save the iron CA certificate.");
  }
  try {
    appendHosts(path.join(confDir(), "egress-hosts.txt"), hosts);
  } catch {
    warnings.push("Could not update the egress host list.");
  }
  if (!(await runPin())) warnings.push("egress-pin did not complete; run it by hand.");
  return warnings;
}
