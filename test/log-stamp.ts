import assert from "node:assert/strict";
import { isoNow, stampLines } from "../server/log-stamp.ts";

function fake() {
  const chunks: string[] = [];
  return { chunks, write: (data: any) => (chunks.push(String(data)), true) };
}
const STAMP = "2026-10-25T15:24:46.123+00:00";
const stream = fake();
stampLines(stream, () => STAMP);
const out = () => stream.chunks.join("");

stream.write("hello\n");
assert.equal(out(), `${STAMP} hello\n`, "single line");

stream.chunks.length = 0;
stream.write("part one");
stream.write(" part two\n");
assert.equal(out(), `${STAMP} part one part two\n`, "continuation gets no second prefix");

stream.chunks.length = 0;
stream.write("a\nb\n\nc\n");
assert.equal(out(), `${STAMP} a\n${STAMP} b\n${STAMP} \n${STAMP} c\n`, "every line prefixed");

stream.chunks.length = 0;
stream.write(Buffer.from('{"event":"telemetry_sync","n":1}\n'));
const line = out().trimEnd();
assert.ok(line.startsWith(`${STAMP} `));
assert.deepEqual(JSON.parse(line.slice(STAMP.length + 1)), { event: "telemetry_sync", n: 1 }, "JSON parseable after strip");

assert.match(isoNow(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
console.log("log-stamp ok");
