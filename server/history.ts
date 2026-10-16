import fs from "node:fs";

// Byte offsets, not parsed transcripts: retain a small index and read only the requested page.
// Extend indexes as JSONL grows; replacing/truncating a log invalidates its index.
export class HistoryIndex {
  private files = new Map<string, { ino: number; size: number; offsets: number[] }>();
  read(file: string, before: number | undefined, limit: number) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return { events: [], start: 0, end: 0, total: 0, bytes: 0 };
    let index = this.files.get(file);
    if (!index || index.ino !== stat.ino || index.size > stat.size) index = { ino: stat.ino, size: 0, offsets: [0] };
    const fd = fs.openSync(file, "r");
    try {
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
      const total = index.offsets.length - 1;
      const end = Math.max(0, Math.min(before ?? total, total));
      const candidate = Math.max(0, end - limit - 150);
      let start = Math.max(0, end - limit);
      let scanned = 0;
      const header = Buffer.alloc(256);
      for (let i = Math.min(start, end - 1); i >= candidate; i--) {
        const size = index.offsets[i + 1] - index.offsets[i];
        const n = fs.readSync(fd, header, 0, Math.min(size, header.length), index.offsets[i]);
        scanned += n;
        // Logs put type first. Inspect that tiny header instead of parsing discarded megabyte tool results.
        let type = header.subarray(0, n).toString("utf8").match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/)?.[1];
        if (!type) {
          const line = Buffer.alloc(size);
          fs.readSync(fd, line, 0, size, index.offsets[i]); scanned += size;
          type = JSON.parse(line.toString("utf8")).type;
        }
        if (type === "user_input") { start = i; break; }
      }
      const buf = Buffer.alloc(index.offsets[end] - index.offsets[start]);
      fs.readSync(fd, buf, 0, buf.length, index.offsets[start]);
      const events = buf.toString("utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      return { events, start, end, total, bytes: buf.length + scanned };
    } finally { fs.closeSync(fd); }
  }
}
