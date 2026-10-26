import assert from "node:assert/strict";
import { ioRate, processIoRates } from "../server/host.ts";

assert.equal(ioRate(3000, 1000, 2), 1000);
assert.equal(ioRate(1000, 3000, 2), 0, "counter resets cannot report negative I/O");
for (const seconds of [0, -1]) assert.equal(ioRate(3000, 1000, seconds), null);
for (const missing of [null, undefined]) {
  assert.equal(ioRate(missing, 1000, 2), null);
  assert.equal(ioRate(3000, missing, 2), null);
}
const previous = { pid: 41, starttime: 500, readBytes: 1000, writeBytes: 2000 };
const current = { ...previous, readBytes: 5000, writeBytes: 3000 };
const rates = (present: object, prior: object | undefined) =>
  processIoRates(
    present as Parameters<typeof processIoRates>[0],
    prior as Parameters<typeof processIoRates>[1],
    2,
  );
assert.deepEqual(rates(current, previous), { readBps: 2000, writeBps: 500 });
assert.deepEqual(rates(current, undefined), { readBps: null, writeBps: null });
assert.deepEqual(rates(current, { ...previous, starttime: 499 }), {
  readBps: null,
  writeBps: null,
});
assert.deepEqual(rates(current, { ...previous, pid: 42 }), { readBps: null, writeBps: null });
assert.deepEqual(rates({ ...current, readBytes: null }, previous), {
  readBps: null,
  writeBps: 500,
});
assert.deepEqual(rates({ ...current, readBytes: 0, writeBytes: 0 }, previous), {
  readBps: 0,
  writeBps: 0,
});
console.log(
  "PASS process I/O rates, counter reset, missing counters, first sample, PID reuse, identity and partial permission failure",
);
