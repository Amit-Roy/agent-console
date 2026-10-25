import { StringDecoder } from "node:string_decoder";

type Write = (chunk: any, encoding?: any, callback?: any) => boolean;
type Stream = { write: Write };

// ISO 8601 with milliseconds and the local UTC offset, e.g. 2026-10-25T15:24:46.123+00:00 (same shape as bin/agent-console).
export function isoNow(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// Wraps stream.write so every output line starts with a timestamp; the rest of each line is unchanged.
// Returns a function that restores the original write.
export function stampLines(stream: Stream, now: () => string = isoNow): () => void {
  const original = stream.write;
  const decoder = new StringDecoder("utf8");
  let atLineStart = true;
  stream.write = function (this: unknown, chunk: any, encoding?: any, callback?: any) {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return original.call(this, chunk, encoding, callback);
    const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    let out = "";
    for (const part of text.split(/(?<=\n)/)) {
      if (atLineStart) out += `${now()} `;
      out += part;
      atLineStart = part.endsWith("\n");
    }
    const writeDone = typeof encoding === "function" ? encoding : callback;
    return original.call(this, out, "utf8", writeDone);
  } as Write;
  return () => {
    stream.write = original;
  };
}
