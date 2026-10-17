import fs from "node:fs";

// Byte offsets, not parsed transcripts: retain a small index and read only the requested page.
// Extend indexes as JSONL grows; replacing/truncating a log invalidates its index.
export class HistoryIndex {
  private files = new Map<string, { ino: number; size: number; offsets: number[] }>();
  private extend(file: string, fd: number) {
    const stat = fs.fstatSync(fd);
    let index = this.files.get(file);
    if (!index || index.ino !== stat.ino || index.size > stat.size) index = { ino: stat.ino, size: 0, offsets: [0] };
    if (index.size < stat.size) {
      const chunk = Buffer.alloc(64 * 1024);
      let pos = index.size;
      while (pos < stat.size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - pos), pos);
        if (!n) break;
        for (let i = 0; i < n; i++) if (chunk[i] === 10) index.offsets.push(pos + i + 1);
        pos += n;
      }
      index.size = pos;
    }
    this.files.delete(file);
    this.files.set(file, index);
    if (this.files.size > 64) this.files.delete(this.files.keys().next().value!);
    return index;
  }
  private withFile<T>(file: string, empty: T, fn: (fd: number, offsets: number[]) => T): T {
    let fd: number;
    try { fd = fs.openSync(file, "r"); } catch { return empty; }
    try { return fn(fd, this.extend(file, fd).offsets); } finally { fs.closeSync(fd); }
  }
  private lines(fd: number, offsets: number[], start: number, end: number) {
    const buf = Buffer.alloc(offsets[end] - offsets[start]);
    fs.readSync(fd, buf, 0, buf.length, offsets[start]);
    return { events: buf.toString("utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)), bytes: buf.length };
  }
  // Lines written so far: live events carry it so a cached view can later ask for only what follows.
  count(file: string) { return this.withFile(file, 0, (_, offsets) => offsets.length - 1); }
  // Everything after line `since`, or null when the gap is wider than `limit` (or the log shrank): the caller sends a full page instead.
  after(file: string, since: number, limit: number) {
    return this.withFile(file, null, (fd, offsets) => {
      const total = offsets.length - 1;
      if (since > total || total - since > limit) return null;
      return { ...this.lines(fd, offsets, since, total), start: since, end: total, total };
    });
  }
  read(file: string, before: number | undefined, limit: number) {
    return this.withFile(file, { events: [] as any[], start: 0, end: 0, total: 0, bytes: 0 }, (fd, offsets) => {
      const total = offsets.length - 1;
      const end = Math.max(0, Math.min(before ?? total, total));
      const candidate = Math.max(0, end - limit - 150);
      let start = Math.max(0, end - limit);
      let scanned = 0;
      const header = Buffer.alloc(256);
      for (let i = Math.min(start, end - 1); i >= candidate; i--) {
        const size = offsets[i + 1] - offsets[i];
        const n = fs.readSync(fd, header, 0, Math.min(size, header.length), offsets[i]);
        scanned += n;
        // Logs put type first. Inspect that tiny header instead of parsing discarded megabyte tool results.
        let type = header.subarray(0, n).toString("utf8").match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/)?.[1];
        if (!type) {
          const line = Buffer.alloc(size);
          fs.readSync(fd, line, 0, size, offsets[i]); scanned += size;
          type = JSON.parse(line.toString("utf8")).type;
        }
        if (type === "user_input") { start = i; break; }
      }
      const { events, bytes } = this.lines(fd, offsets, start, end);
      return { events, start, end, total, bytes: bytes + scanned };
    });
  }
}
