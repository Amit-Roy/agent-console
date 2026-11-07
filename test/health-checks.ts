import assert from "node:assert/strict";
import { diskStatus, type ReportDeps, runReportChecks } from "../server/health/checks.ts";

const calls: string[] = [];
function deps(over: Partial<ReportDeps> = {}): Partial<ReportDeps> {
  return {
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git") return { code: 0, out: "aaaaaaaaaaaa" };
      if (cmd.endsWith("/codegraph-watch")) return { code: 0, out: "up (pid 1)" };
      return { code: 0, out: "ok" };
    },
    readFile: (file) =>
      file.endsWith("github-triage.json") ? '{"port":4000}' : "== t workspace-boot\n== t done\n",
    mtimeMs: () => 1000,
    now: () => 1000 + 3600_000,
    readlink: () => "/x/releases/aaaaaaaaaaaa",
    fetchJson: async () => ({ ok: true, status: 200 }),
    disks: () => [{ target: "/", pcent: 50 }],
    doctor: async () => ({
      checks: [
        { id: "h", label: "Headroom", status: "ok", detail: "d" },
        { id: "n", label: "Net", status: "error", detail: "d" },
      ],
    }),
    home: "/h",
    brainBin: "/bb",
    timeoutMs: 200,
    ...over,
  };
}
const byId = (list: Awaited<ReturnType<typeof runReportChecks>>, checkId: string) => {
  const found = list.find((item) => item.id === checkId);
  assert.ok(found, checkId);
  return found;
};

let list = await runReportChecks(deps());
assert.equal(byId(list, "doctor:h").status, "ok");
assert.equal(byId(list, "doctor:n").status, "error");
for (const checkId of [
  "disk",
  "vps",
  "release-drift",
  "github-triage",
  "workspace-boot",
  "phone-link",
  "codegraph-watch",
])
  assert.equal(byId(list, checkId).status, "ok", checkId);
assert.equal(byId(list, "codegraph-watch").healed, undefined);
assert.ok(
  calls.some((call) => call.startsWith("ssh -o BatchMode=yes -o ConnectTimeout=5 vps true")),
);

assert.equal(diskStatus(84), "ok");
assert.equal(diskStatus(85), "warning");
assert.equal(diskStatus(95), "error");
list = await runReportChecks(
  deps({
    disks: () => [
      { target: "/", pcent: 90 },
      { target: "/m", pcent: 96 },
    ],
  }),
);
assert.equal(byId(list, "disk").status, "error");

list = await runReportChecks(
  deps({
    run: async (cmd) => {
      if (cmd === "git") return { code: 0, out: "bbbbbbbbbbbb" };
      if (cmd.endsWith("/codegraph-watch")) return { code: 1, out: "down" };
      return { code: 255, out: "denied" };
    },
    fetchJson: async () => ({ ok: false, status: 502 }),
    readFile: (file) => (file.endsWith("github-triage.json") ? '{"port":4000}' : "boom failed\n"),
  }),
);
assert.equal(byId(list, "vps").status, "error");
assert.equal(byId(list, "release-drift").status, "warning");
assert.equal(byId(list, "github-triage").status, "warning");
assert.equal(byId(list, "workspace-boot").status, "warning");
assert.equal(byId(list, "phone-link").status, "info");
assert.equal(byId(list, "codegraph-watch").status, "error");
assert.equal(byId(list, "codegraph-watch").healed?.action, "start");

list = await runReportChecks(
  deps({
    run: async (cmd) =>
      cmd.endsWith("/codegraph-watch")
        ? { code: 0, out: "started" }
        : { code: 0, out: "aaaaaaaaaaaa" },
    fetchJson: async () => {
      throw new Error("ECONNREFUSED");
    },
    readFile: (file) => {
      if (file.endsWith("github-triage.json")) throw new Error("ENOENT");
      return "== t workspace-boot\n== t done\n";
    },
    now: () => 1000 + 10 * 86_400_000,
  }),
);
assert.equal(byId(list, "github-triage").status, "info");
assert.equal(byId(list, "workspace-boot").status, "info");
assert.equal(byId(list, "codegraph-watch").status, "ok");
assert.equal(byId(list, "codegraph-watch").healed?.result, "started");

list = await runReportChecks(
  deps({ vps: undefined, disks: () => new Promise(() => {}), timeoutMs: 50 }),
);
assert.deepEqual([byId(list, "disk").status, byId(list, "disk").detail], ["error", "timed out"]);
assert.equal(byId(list, "vps").status, "ok");
console.log("health-checks ok");
