// Headroom profiling store, trigger policy and OTLP decoder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeOtlpMetrics,
  HeadroomProfileStore,
  ingestOtlp,
  OtlpDecodeError,
  ProfileTrigger,
  parseSmapsRollup,
  REQUEST_TYPE,
} from "../server/headroom-profile.ts";
import { LatencyStore } from "../server/latency.ts";

const MIB = 1024 * 1024;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-headroom-profile-"));
const file = path.join(dir, "latency.sqlite");
const T0 = 1_700_000_000_000;

try {
  // Coexists with LatencyStore in one sqlite file.
  const latency = new LatencyStore(file);
  const store = new HeadroomProfileStore(file);
  const tables = new DatabaseSync(file)
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name);
  for (const name of [
    "latency",
    "headroom_rss",
    "headroom_metric",
    "headroom_site",
    "headroom_snapshot",
  ])
    assert.ok(tables.includes(name), name);
  assert.equal(latency.summary(T0) !== undefined, true);

  // Downsampling: one row per minute per pid.
  assert.equal(
    store.recordSample(
      1,
      { rssBytes: 100 * MIB, time: T0 },
      { anon: 60 * MIB, fileBacked: 40 * MIB },
    ),
    true,
  );
  assert.equal(store.recordSample(1, { rssBytes: 101 * MIB, time: T0 + 30_000 }), false);
  assert.equal(store.recordSample(2, { rssBytes: 5 * MIB, time: T0 + 30_000 }), true);
  assert.equal(store.recordSample(1, { rssBytes: 102 * MIB, time: T0 + 60_000 }), true);
  const q = store.query(3_600_000, T0 + 61_000);
  assert.equal(q.rss.length, 3);
  assert.deepEqual(q.rss[0], {
    at: T0,
    pid: 1,
    rss: 100 * MIB,
    anon: 60 * MIB,
    fileBacked: 40 * MIB,
  });

  // Trigger policy.
  const trigger = new ProfileTrigger();
  assert.equal(trigger.tick(10, 100 * MIB, T0), null);
  assert.equal(trigger.tick(10, 160 * MIB, T0 + 30_000), null, "min gap 60s");
  assert.equal(trigger.tick(10, 149 * MIB, T0 + 61_000), null, "below step");
  assert.equal(trigger.tick(10, 150 * MIB, T0 + 62_000), "step");
  assert.equal(trigger.tick(10, 210 * MIB, T0 + 100_000), null, "gap after snapshot");
  assert.equal(trigger.tick(10, 210 * MIB, T0 + 125_000), "step");
  assert.equal(trigger.tick(10, 211 * MIB, T0 + 125_000 + 14 * 60_000), null);
  assert.equal(trigger.tick(10, 211 * MIB, T0 + 125_000 + 15 * 60_000), "periodic");
  assert.equal(trigger.tick(11, 900 * MIB, T0 + 2_000_000), null, "new pid resets baseline");
  assert.equal(trigger.tick(11, 949 * MIB, T0 + 2_100_000), null);
  assert.equal(trigger.tick(11, 950 * MIB, T0 + 2_100_001), "step");
  assert.equal(trigger.breaker(11, 951 * MIB, T0 + 2_100_002), "breaker");

  // Pruning caps snapshots at 500 and drops anything older than 7 days.
  for (let i = 0; i < 600; i++) store.recordSnapshot(1, "periodic", MIB, T0 + i);
  store.prune(T0 + 1000);
  assert.equal(store.query(10_000, T0 + 1000).snapshots.length, 500);
  store.recordSnapshot(1, "step", MIB, T0 - 8 * 86_400_000);
  store.prune(T0 + 1000);
  assert.equal(store.query(30 * 86_400_000, T0 + 1000).snapshots.length, 500);

  // Sites: bad locations dropped; latest batch with deltas.
  assert.equal(
    store.recordSites(
      1,
      [
        { location: "a/b.py:12", bytes: 100, count: 1 },
        { location: "../../etc/passwd x:1", bytes: 1, count: 1 },
        { location: "noline.py", bytes: 1, count: 1 },
      ],
      T0 + 10_000,
    ),
    1,
  );
  store.recordSites(
    1,
    [
      { location: "a/b.py:12", bytes: 250, count: 2 },
      { location: "c.py:3", bytes: 7, count: 1 },
    ],
    T0 + 20_000,
  );
  const sites = store.query(100_000, T0 + 30_000).sites;
  assert.equal(sites.at, T0 + 20_000);
  assert.deepEqual(sites.rows.find((r) => r.location === "a/b.py:12")?.deltaBytes, 150);
  assert.equal(sites.rows.find((r) => r.location === "c.py:3")?.deltaBytes, null);

  // Unknown metric name dropped.
  assert.equal(
    store.recordMetrics(
      1,
      [
        { name: "evil.metric", attr: null, value: 1 },
        { name: "headroom.malloc.arena_bytes", attr: null, value: 5 },
      ],
      T0,
    ),
    1,
  );
  assert.deepEqual(Object.keys(store.query(100_000, T0 + 1).metrics), [
    "headroom.malloc.arena_bytes",
  ]);

  // smaps parser.
  const smaps =
    "Rss:  2048 kB\nPss:  1000 kB\nAnonymous:  1024 kB\nRss_Anon: 1000 kB\nRss_File: 900 kB\n";
  assert.deepEqual(parseSmapsRollup(smaps), { anon: 1000 * 1024, fileBacked: 900 * 1024 });
  assert.deepEqual(parseSmapsRollup("Rss: 2048 kB\nAnonymous: 1024 kB\n"), {
    anon: 1024 * 1024,
    fileBacked: 1024 * 1024,
  });
  assert.deepEqual(parseSmapsRollup("nothing"), { anon: null, fileBacked: null });

  // Garbage rejected.
  assert.throws(
    () => decodeOtlpMetrics(Uint8Array.from([0x0a, 0xff, 0xff, 0xff, 0x7f, 1])),
    OtlpDecodeError,
  );
  assert.throws(() => decodeOtlpMetrics(new Uint8Array(1024 * 1024 + 1)), OtlpDecodeError);

  // Constructed protobuf with allowed and disallowed content.
  const str = (stringValue: string) => ({ stringValue });
  const request = {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "process.pid", value: { intValue: 4242 } },
            { key: "secret", value: str("x") },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "process.runtime.cpython.memory",
                gauge: {
                  dataPoints: [
                    {
                      asInt: 123456789012,
                      attributes: [
                        { key: "type", value: str("rss") },
                        { key: "prompt", value: str("leak") },
                      ],
                    },
                  ],
                },
              },
              { name: "headroom.malloc.arena_bytes", sum: { dataPoints: [{ asDouble: 2.5 }] } },
              {
                name: "process.runtime.cpython.gc_count",
                sum: {
                  dataPoints: [
                    { asInt: 7, attributes: [{ key: "count", value: { intValue: 2 } }] },
                  ],
                },
              },
              {
                name: "headroom.alloc.bytes",
                gauge: {
                  dataPoints: [
                    {
                      asInt: 4096,
                      attributes: [{ key: "code.location", value: str("headroom/x.py:10") }],
                    },
                    { asInt: 1, attributes: [{ key: "code.location", value: str("bad path:1") }] },
                  ],
                },
              },
              {
                name: "headroom.alloc.count",
                gauge: {
                  dataPoints: [
                    {
                      asInt: 3,
                      attributes: [{ key: "code.location", value: str("headroom/x.py:10") }],
                    },
                  ],
                },
              },
              { name: "not.allowed", gauge: { dataPoints: [{ asInt: 1 }] } },
            ],
          },
        ],
      },
    ],
  };
  const body = REQUEST_TYPE.encode(REQUEST_TYPE.fromObject(request)).finish();
  const decoded = decodeOtlpMetrics(body);
  assert.equal(decoded.pid, 4242);
  assert.deepEqual(decoded.metrics, [
    { name: "process.runtime.cpython.memory", attr: "type=rss", value: 123456789012 },
    { name: "headroom.malloc.arena_bytes", attr: null, value: 2.5 },
    { name: "process.runtime.cpython.gc_count", attr: "count=2", value: 7 },
  ]);
  assert.deepEqual(decoded.sites, [{ location: "headroom/x.py:10", bytes: 4096, count: 3 }]);
  assert.deepEqual(ingestOtlp(store, body, T0 + 40_000), { pid: 4242, metrics: 3, sites: 1 });

  // Optional fixture from the Python shim.
  const fixture = path.join(import.meta.dirname, "fixtures", "headroom-otlp-metrics.bin");
  if (fs.existsSync(fixture)) {
    const real = decodeOtlpMetrics(fs.readFileSync(fixture));
    assert.ok(real.metrics.length + real.sites.length > 0, "fixture yields rows");
  } else console.log("skip: fixtures/headroom-otlp-metrics.bin absent");
  console.log("headroom-profile ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
