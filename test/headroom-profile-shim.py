#!/usr/bin/env python3
"""Checks the Headroom profiling sitecustomize shim against a local OTLP sink."""

import os
import re
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHIM_DIR = ROOT / "server" / "headroom-profile"
FIXTURE = ROOT / "test" / "fixtures" / "headroom-otlp-metrics.bin"
ALLOWED_NAMES = {
    "process.runtime.cpython.memory",
    "process.runtime.cpython.gc_count",
    "process.runtime.cpython.thread_count",
    "process.runtime.cpython.cpu_time",
    "headroom.malloc.arena_bytes",
    "headroom.malloc.in_use_bytes",
    "headroom.malloc.free_held_bytes",
    "headroom.tracemalloc.traced_bytes",
    "headroom.tracemalloc.peak_bytes",
    "headroom.alloc.bytes",
    "headroom.alloc.count",
}
ALLOWED_ATTRS = {"type", "count", "code.location"}
LOCATION_RE = re.compile(r"^[\w./-]{1,200}:\d+$")
CHILD = "x=[list(range(1000)) for _ in range(500)]\nimport time\ntime.sleep(2)\n"


class Sink(BaseHTTPRequestHandler):
    bodies = []

    def do_POST(self):
        size = int(self.headers.get("Content-Length", 0))
        if self.path == "/v1/metrics":
            Sink.bodies.append(self.rfile.read(size))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args):
        pass


def run_child(env_extra, port):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AGENT_CONSOLE_HEADROOM", "OTEL_"))}
    env.update(
        PYTHONPATH=str(SHIM_DIR),
        OTEL_METRIC_EXPORT_INTERVAL="500",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=f"http://127.0.0.1:{port}/v1/metrics",
    )
    env.update(env_extra)
    return subprocess.run([sys.executable, "-c", CHILD], env=env, capture_output=True, text=True, timeout=60)


def decode_points(body):
    from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest

    request = ExportMetricsServiceRequest()
    request.ParseFromString(body)
    names, attrs = set(), set()
    for rm in request.resource_metrics:
        attrs.update(("resource:" + a.key) for a in rm.resource.attributes)
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                names.add(metric.name)
                kind = metric.WhichOneof("data")
                for point in getattr(metric, kind).data_points:
                    attrs.update(a.key for a in point.attributes)
                    for a in point.attributes:
                        if a.key == "code.location":
                            attrs.add("loc=" + a.value.string_value)
    return names, attrs


class ShimTest(unittest.TestCase):
    def setUp(self):
        Sink.bodies = []
        self.server = HTTPServer(("127.0.0.1", 0), Sink)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_exports_allowlisted_metrics(self):
        result = run_child({"AGENT_CONSOLE_HEADROOM_PROFILE": "1", "AGENT_CONSOLE_HEADROOM_TRACEMALLOC": "1"}, self.port)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(Sink.bodies, result.stderr)
        names, attrs = decode_points(Sink.bodies[-1])
        self.assertEqual(names - ALLOWED_NAMES, set())
        self.assertEqual(ALLOWED_NAMES - names, set(), "missing metrics")
        keys = {a for a in attrs if not a.startswith(("loc=", "resource:"))}
        self.assertLessEqual(keys, ALLOWED_ATTRS)
        resource = {a for a in attrs if a.startswith("resource:")}
        self.assertEqual(resource, {"resource:service.name", "resource:process.pid"})
        locations = [a[4:] for a in attrs if a.startswith("loc=")]
        self.assertTrue(locations)
        for location in locations:
            self.assertRegex(location, LOCATION_RE)
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_bytes(Sink.bodies[-1])

    def test_unset_is_inert(self):
        result = run_child({}, self.port)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Sink.bodies, [])
        self.assertEqual(result.stderr, "")

    def test_unreachable_endpoint_exits_zero(self):
        result = run_child({"AGENT_CONSOLE_HEADROOM_PROFILE": "1"}, 9)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
