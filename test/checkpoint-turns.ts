// Turn checkpoints: a mock turn that edits a file records turn_start, tool and turn_end snapshots in the transcript.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ckturns-data-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ckturns-repo-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
});
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-q");
fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
git("add", "seed.txt");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
const indexBefore = git("ls-files", "-s");

const { Threads } = await import("../server/threads.ts");
const threads = new Threads((event: any) => {
  // the mock "runs" its Bash tool: change the folder once the start snapshot exists
  // the start snapshot runs in the background, so the edit waits for it, as a model's first edit would
  if (event?.event?.type === "checkpoint" && event.event.kind === "turn_start")
    fs.writeFileSync(path.join(repo, "made.txt"), "made\n");
  // an edit after the tool snapshot is caught by the turn-end snapshot
  if (event?.event?.kind === "tool" && event.event.type === "checkpoint")
    fs.writeFileSync(path.join(repo, "late.txt"), "late\n");
});

const settle = async (predicate: () => boolean, label: string) => {
  for (let tick = 0; tick < 100; tick++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out: ${label}`);
};
const checkpointsOf = (threadId: string) =>
  (threads.history(threadId) as any[]).filter((event) => event.type === "checkpoint");

try {
  const watched = threads.create({ provider: "mock", cwd: repo, title: "Watched" });
  threads.send(watched.id, "tool please");
  await settle(
    () => checkpointsOf(watched.id).some((event) => event.kind === "turn_end"),
    "turn_end",
  );
  const log = checkpointsOf(watched.id);
  assert.deepEqual(
    log.map((event) => event.kind),
    ["turn_start", "tool", "turn_end"],
  );
  const tool = log.find((event) => event.kind === "tool");
  assert.equal(tool.toolUseId, "t1");
  assert.match(tool.commit, /^[0-9a-f]{40}$/);
  assert.ok(tool.files.some((file: any) => file.p === "made.txt"));
  assert.deepEqual(
    log.map((event) => event.seq),
    log.map((_, index) => index + 1),
  );

  const wire = (threads.page(watched.id) as any).events.filter(
    (event: any) => event.type === "checkpoint",
  );
  assert.equal(wire.length, log.length);
  assert.equal(wire[0].filesTotal, log[0].files.length);

  const off = threads.create({ provider: "mock", cwd: repo, title: "Off" });
  threads.get(off.id)!.checkpoints = "off";
  threads.send(off.id, "tool please");
  await settle(
    () => (threads.history(off.id) as any[]).some((event) => event.type === "result"),
    "off result",
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(checkpointsOf(off.id).length, 0);

  assert.equal(git("ls-files", "-s"), indexBefore);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.match(git("status", "--porcelain"), /^\?\? made\.txt$/m);
  console.log("checkpoint-turns ok");
} finally {
  threads.shutdown?.();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 100).unref();
}
