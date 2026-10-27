import { type ChildProcess, type ExecFileException, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Fixture = { name: string; runtime: string; env: NodeJS.ProcessEnv };
type LaunchOptions = { cwd: string; env: NodeJS.ProcessEnv; timeout: number };
type Callback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

export class TriageCliCleanup {
  private fixtures: Fixture[] = [];
  private launches = new Set<ChildProcess>();
  private closing = false;
  private shutdownPromise?: Promise<boolean>;
  private interruptHook = () => this.signalHook("SIGINT");
  private terminateHook = () => this.signalHook("SIGTERM");
  private signalHook = (signal: NodeJS.Signals) => {
    void this.shutdown().then(
      (cleaned) => process.exit(cleaned ? (signal === "SIGINT" ? 130 : 143) : 1),
      (error: NodeJS.ErrnoException) => {
        for (const fixture of this.fixtures)
          this.log(fixture, "unknown", `shutdown hook failed code=${error.code || "unknown"}`);
        try {
          this.emergencyCleanup();
        } finally {
          process.exit(1);
        }
      },
    );
  };
  private exitHook = () => this.emergencyCleanup();

  private script: string;
  private timeout: number;
  private report: (message: string) => void;

  constructor(
    script: string,
    timeout = 5000,
    report = (message: string) => console.error(message),
  ) {
    this.script = script;
    this.timeout = timeout;
    this.report = report;
  }

  register(name: string, runtime: string, env: NodeJS.ProcessEnv) {
    if (this.closing) throw Error("Triage cleanup already started");
    this.fixtures.push({ name, runtime, env: { ...env } });
  }

  execFile(executable: string, args: string[], options: LaunchOptions, callback: Callback) {
    if (this.closing) throw Error("Triage cleanup already started; refusing CLI launch");
    const child = execFile(executable, args, { ...options, encoding: "utf8" }, callback);
    this.launches.add(child);
    child.once("close", () => this.launches.delete(child));
    return child;
  }

  installHooks() {
    process.on("SIGINT", this.interruptHook);
    process.on("SIGTERM", this.terminateHook);
    process.on("exit", this.exitHook);
  }

  removeHooks() {
    process.off("SIGINT", this.interruptHook);
    process.off("SIGTERM", this.terminateHook);
    process.off("exit", this.exitHook);
  }

  private owned(fixture: Fixture, worker: number) {
    if (!Number.isSafeInteger(worker) || worker <= 1) return false;
    try {
      const args = fs.readFileSync(`/proc/${worker}/cmdline`, "utf8").split("\0");
      if (args[1] !== this.script || args[2] !== "serve") return false;
      const environment = fs.readFileSync(`/proc/${worker}/environ`, "utf8").split("\0");
      const runtime = environment.find((entry) => entry.startsWith("AGENT_CONSOLE_TRIAGE_RUN="));
      if (runtime) return runtime === `AGENT_CONSOLE_TRIAGE_RUN=${fixture.runtime}`;
      return (
        environment.includes(`HOME=${fixture.env.HOME}`) &&
        fixture.runtime === path.join(fixture.env.HOME || "", ".cache/agent-console/github-triage")
      );
    } catch {
      return false;
    }
  }

  private workers(fixture: Fixture) {
    return fs
      .readdirSync("/proc")
      .map(Number)
      .filter((worker) => this.owned(fixture, worker));
  }

  private log(fixture: Fixture, worker: number | string, action: string) {
    this.report(
      `Triage cleanup fixture=${fixture.name} pid=${worker} runtime=${fixture.runtime}: ${action}`,
    );
  }

  private signal(fixture: Fixture, worker: number, signal: NodeJS.Signals) {
    if (!this.owned(fixture, worker)) return;
    try {
      process.kill(worker, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        this.log(fixture, worker, `${signal} failed (${(error as NodeJS.ErrnoException).code})`);
    }
  }

  private async waitGone(fixture: Fixture, workers: number[]) {
    const deadline = Date.now() + this.timeout;
    while (workers.some((worker) => this.owned(fixture, worker)) && Date.now() < deadline)
      await delay(10);
    return workers.filter((worker) => this.owned(fixture, worker));
  }

  private async stop(fixture: Fixture) {
    const workers = this.workers(fixture);
    if (!workers.length) return true;
    let recorded = 0;
    try {
      recorded = Number(fs.readFileSync(path.join(fixture.runtime, "pid"), "utf8"));
    } catch {}
    if (this.owned(fixture, recorded)) {
      await new Promise<void>((resolve) => {
        execFile(
          process.execPath,
          [this.script, "stop"],
          {
            env: fixture.env,
            timeout: this.timeout,
            killSignal: "SIGKILL",
            encoding: "utf8",
          },
          (error) => {
            if (error)
              this.log(
                fixture,
                recorded,
                `graceful stop failed code=${error.code} signal=${error.signal || "none"}`,
              );
            resolve();
          },
        );
      });
    } else this.log(fixture, workers.join(","), "missing or unowned pidfile; using scoped cleanup");
    let survivors = this.workers(fixture);
    for (const worker of survivors) {
      this.log(fixture, worker, "spurious service after stop; sending SIGTERM");
      this.signal(fixture, worker, "SIGTERM");
    }
    survivors = await this.waitGone(fixture, survivors);
    for (const worker of survivors) {
      this.log(fixture, worker, "SIGTERM did not clean up service; escalating to SIGKILL");
      this.signal(fixture, worker, "SIGKILL");
    }
    survivors = await this.waitGone(fixture, survivors);
    for (const worker of survivors) this.log(fixture, worker, "service survived shutdown hook");
    return survivors.length === 0;
  }

  shutdown() {
    this.closing = true;
    this.shutdownPromise ??= this.finish();
    return this.shutdownPromise;
  }

  private async finish() {
    await Promise.all(
      [...this.launches].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("close", resolve);
            child.kill("SIGKILL");
          }),
      ),
    );
    const results = await Promise.all(this.fixtures.map((fixture) => this.stop(fixture)));
    return results.every(Boolean);
  }

  private emergencyCleanup() {
    this.closing = true;
    for (const child of this.launches) child.kill("SIGKILL");
    for (const fixture of this.fixtures)
      for (const worker of this.workers(fixture)) {
        this.log(fixture, worker, "exit fallback found spurious service; sending SIGKILL");
        this.signal(fixture, worker, "SIGKILL");
      }
  }
}
