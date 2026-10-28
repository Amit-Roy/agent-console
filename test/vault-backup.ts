// Vault auto-backup: debounce, single flight, fixed error strings, no log text in the status file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-backup-"));
const counter = path.join(dir, "runs");
process.env.VAULT_HOME = dir;
process.env.VAULT_BACKUP_DEBOUNCE_MS = "150";
process.env.VAULT_BACKUP_CMD = `echo run >> ${counter}`;

const { scheduleBackup, retryBackup, backupStatus, backupNow } = await import(
  "../server/vault-backup.ts"
);
const runs = () =>
  fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").length - 1 : 0;
const until = async (check: () => boolean) => {
  for (let tick = 0; tick < 100 && !check(); tick++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), "condition reached");
};

try {
  assert.equal(backupStatus().state, null);

  // two sets inside the debounce window: one run
  scheduleBackup();
  await new Promise((r) => setTimeout(r, 50));
  scheduleBackup();
  assert.equal(backupStatus().state, "pending");
  await until(() => backupStatus().state === "ok");
  assert.equal(runs(), 1);

  // failing command: fixed error, no log text in the status file
  const secretLine = "SECRET-LOG-TEXT-xyz";
  process.env.VAULT_BACKUP_CMD = `echo ${secretLine}; exit 3`;
  await retryBackup();
  assert.deepEqual([backupStatus().state, backupStatus().error], ["failed", "failed"]);

  process.env.VAULT_BACKUP_CMD = `echo "drive verify mismatch ${secretLine}"; exit 1`;
  await retryBackup();
  assert.equal(backupStatus().error, "failed: drive");
  const statusText = fs.readFileSync(
    path.join(dir, ".local/state/agent-console/iron-backup.json"),
    "utf8",
  );
  assert.ok(!statusText.includes(secretLine) && !statusText.includes("mismatch"));

  // retry runs immediately (no debounce wait)
  process.env.VAULT_BACKUP_CMD = `echo run >> ${counter}`;
  const before = runs();
  await retryBackup();
  assert.equal(runs(), before + 1);
  assert.equal(backupStatus().state, "ok");

  // single flight: a schedule during a run reruns once afterwards
  process.env.VAULT_BACKUP_CMD = `sleep 0.3; echo run >> ${counter}`;
  const base = runs();
  const first = retryBackup();
  await new Promise((r) => setTimeout(r, 50));
  void retryBackup();
  await first;
  assert.equal(runs(), base + 2);

  // backupNow: ordered steps, secret stdout line never reaches callbacks or status
  const secret = "TOPSECRET-stdout-line";
  const line = (step: string, state: string) =>
    `printf '{"step":"${step}","state":"${state}"}\\n';`;
  const okSteps = ["backup_fetch", "drive_upload", "drive_verify", "drive_prune"]
    .flatMap((id) => [line(id, "running"), line(id, "ok")])
    .join(" ");
  process.env.VAULT_BACKUP_CMD = `${okSteps} echo ${secret}; echo '{"step":"evil","state":"ok"}'; ${line("backup", "ok")}`;
  const seen: string[] = [];
  const res = await backupNow((s) => seen.push(`${s.step}:${s.state}`));
  assert.deepEqual(res, { ok: true });
  assert.equal(seen.length, 9);
  assert.deepEqual(seen.slice(0, 3), [
    "backup_fetch:running",
    "backup_fetch:ok",
    "drive_upload:running",
  ]);
  assert.equal(seen[8], "backup:ok");
  assert.ok(!JSON.stringify(seen).includes(secret) && !seen.join().includes("evil"));
  assert.equal(backupStatus().state, "ok");
  assert.ok(
    fs
      .readFileSync(path.join(dir, ".local/state/agent-console/iron-backup.log"), "utf8")
      .includes(secret),
  );

  // failed drive step
  process.env.VAULT_BACKUP_CMD = `${line("backup_fetch", "ok")} ${line("drive_upload", "running")} ${line("drive_upload", "failed")} echo ${secret}; exit 1`;
  const bad = await backupNow(() => {});
  assert.deepEqual(bad, { ok: false, failed: "drive_upload" });
  assert.deepEqual([backupStatus().state, backupStatus().error], ["failed", "failed: drive"]);
  const text = fs.readFileSync(
    path.join(dir, ".local/state/agent-console/iron-backup.json"),
    "utf8",
  );
  assert.ok(!text.includes(secret));

  // non-drive failure
  process.env.VAULT_BACKUP_CMD = `${line("backup_fetch", "failed")} exit 1`;
  assert.deepEqual(await backupNow(() => {}), { ok: false, failed: "backup_fetch" });
  assert.equal(backupStatus().error, "failed");

  // call during a running debounced backup: exactly one extra run
  fs.rmSync(counter, { force: true });
  process.env.VAULT_BACKUP_CMD = `echo run >> ${counter}; sleep 0.4; ${line("backup", "ok")}`;
  scheduleBackup();
  await until(() => runs() === 1);
  const extra = await backupNow(() => {});
  assert.equal(extra.ok, true);
  assert.equal(runs(), 2);

  // timeout kills the run and reports failed
  process.env.VAULT_BACKUP_NOW_TIMEOUT_MS = "200";
  process.env.VAULT_BACKUP_CMD = "sleep 30";
  const slow = await backupNow(() => {});
  assert.deepEqual(slow, { ok: false, failed: "timeout" });
  console.log("vault-backup ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
