import type { ExitInfo } from "./types.ts";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// JSON-RPC client half of the app-server connection: numbered requests, their pending replies and the fixed timeout.
export class CodexRpc {
  open = true;
  private serial = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly writeLine: (line: string) => void;

  constructor(writeLine: (line: string) => void) {
    this.writeLine = writeLine;
  }

  request(method: string, params: object): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(new Error("Codex connection closed."));
        return;
      }
      const requestId = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex ${method} timed out.`));
      }, 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.writeLine(JSON.stringify({ id: requestId, method, params }));
    });
  }

  // A response line (id, no method) settles its waiting request; unknown ids are ignored.
  settle(response: any): void {
    const wait = this.pending.get(response.id);
    if (!wait) return;
    this.pending.delete(response.id);
    clearTimeout(wait.timer);
    if (response.error) wait.reject(new Error(response.error.message || "Codex request rejected."));
    else wait.resolve(response.result);
  }

  rejectAll(info: ExitInfo): void {
    for (const wait of this.pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(new Error(`Codex connection closed (${info.code ?? info.signal}).`));
    }
    this.pending.clear();
  }
}
