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

const { scheduleBackup, retryBackup, backupStatus } =
  await import("../server/vault-backup.ts");
const runs = () =>
  fs.existsSync(counter)
    ? fs.readFileSync(counter, "utf8").split("\n").length - 1
    : 0;
const until = async (check: () => boolean) => {
  for (let tick = 0; tick < 100 && !check(); tick++)
    await new Promise((r) => setTimeout(r, 50));
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
  assert.deepEqual(
    [backupStatus().state, backupStatus().error],
    ["failed", "failed"],
  );

  process.env.VAULT_BACKUP_CMD = `echo "drive verify mismatch ${secretLine}"; exit 1`;
  await retryBackup();
  assert.equal(backupStatus().error, "failed: drive");
  const statusText = fs.readFileSync(
    path.join(dir, ".local/state/agent-console/iron-backup.json"),
    "utf8",
  );
  assert.ok(
    !statusText.includes(secretLine) && !statusText.includes("mismatch"),
  );

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
  console.log("vault-backup ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
