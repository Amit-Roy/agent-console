"""Opt-in memory profiling shim: exports OTel metrics over OTLP/HTTP protobuf.

Inert unless AGENT_CONSOLE_HEADROOM_PROFILE=1. Never breaks the host process.
"""

import os
import sys

RUNTIME_CONFIG = {
    "process.runtime.memory": ["rss", "vms"],
    "process.runtime.cpu.time": ["user", "system"],
    "process.runtime.gc_count": None,
    "process.runtime.thread_count": None,
}
TOP_SITES = 20
LOCATION_RE = r"^[\w./-]{1,200}:\d+$"


def _mallinfo_reader(field):
    """Return a callable reading one glibc mallinfo2 field, or None."""
    import ctypes

    class MallInfo2(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_size_t)
            for name in (
                "arena", "ordblks", "smblks", "hblks", "hblkhd",
                "usmblks", "fsmblks", "uordblks", "fordblks", "keepcost",
            )
        ]

    libc = ctypes.CDLL(None)
    func = libc.mallinfo2
    func.restype = MallInfo2
    return lambda: getattr(func(), field)


def _relative_location(filename, lineno, roots):
    import re

    path = filename
    for root in roots:
        if root and filename.startswith(root):
            path = filename[len(root):].lstrip("/")
            break
    path = path.replace("\\", "/")
    text = f"{path}:{lineno}"
    return text if re.match(LOCATION_RE, text) else "other:0"


class _SiteCache:
    """One tracemalloc snapshot per export cycle shared by both gauges."""

    def __init__(self, tracemalloc, roots):
        self.tracemalloc = tracemalloc
        self.roots = roots
        self.stamp = None
        self.rows = []

    def rows_for(self, options):
        stamp = id(options)
        if stamp != self.stamp or not self.rows:
            self.stamp = stamp
            self.rows = self._collect()
        return self.rows

    def _collect(self):
        if not self.tracemalloc.is_tracing():
            return []
        stats = self.tracemalloc.take_snapshot().statistics("lineno")[:TOP_SITES]
        rows = []
        for stat in stats:
            frame = stat.traceback[0]
            where = _relative_location(frame.filename, frame.lineno, self.roots)
            rows.append((where, stat.size, stat.count))
        return rows


def _build_resource(resource_cls):
    return resource_cls(
        {
            "service.name": os.environ.get("OTEL_SERVICE_NAME", "headroom-proxy"),
            "process.pid": os.getpid(),
        },
        schema_url=None,
    )


def _register_gauges(meter, tracemalloc):
    from opentelemetry.metrics import Observation
    import sysconfig

    for name, field in (
        ("headroom.malloc.arena_bytes", "arena"),
        ("headroom.malloc.in_use_bytes", "uordblks"),
        ("headroom.malloc.free_held_bytes", "fordblks"),
    ):
        try:
            reader = _mallinfo_reader(field)
        except Exception:
            continue
        meter.create_observable_gauge(
            name, callbacks=[lambda _o, read=reader: [Observation(read())]], unit="By"
        )

    def traced(index):
        def callback(_options):
            if not tracemalloc.is_tracing():
                return []
            return [Observation(tracemalloc.get_traced_memory()[index])]

        return callback

    meter.create_observable_gauge("headroom.tracemalloc.traced_bytes", callbacks=[traced(0)], unit="By")
    meter.create_observable_gauge("headroom.tracemalloc.peak_bytes", callbacks=[traced(1)], unit="By")

    roots = sorted({sysconfig.get_path("purelib"), sysconfig.get_path("stdlib")}, key=len)
    cache = _SiteCache(tracemalloc, [r + "/" for r in reversed(roots) if r])

    def site_callback(column):
        def callback(options):
            return [
                Observation(row[column], {"code.location": row[0]})
                for row in cache.rows_for(options)
            ]

        return callback

    meter.create_observable_gauge("headroom.alloc.bytes", callbacks=[site_callback(1)], unit="By")
    meter.create_observable_gauge("headroom.alloc.count", callbacks=[site_callback(2)], unit="1")


def _setup():
    import tracemalloc

    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource

    if os.environ.get("AGENT_CONSOLE_HEADROOM_TRACEMALLOC") == "1":
        tracemalloc.start(1)
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
    interval = int(os.environ.get("OTEL_METRIC_EXPORT_INTERVAL", "30000"))
    exporter = OTLPMetricExporter(endpoint=endpoint, timeout=5) if endpoint else OTLPMetricExporter(timeout=5)
    reader = PeriodicExportingMetricReader(exporter, export_interval_millis=interval)
    provider = MeterProvider(resource=_build_resource(Resource), metric_readers=[reader])
    SystemMetricsInstrumentor(config=dict(RUNTIME_CONFIG)).instrument(meter_provider=provider)
    _register_gauges(provider.get_meter("headroom-profile"), tracemalloc)


def _main():
    if os.environ.get("AGENT_CONSOLE_HEADROOM_PROFILE") != "1":
        return
    try:
        _setup()
    except BaseException as error:  # noqa: BLE001 - never break the host
        sys.stderr.write(f"headroom-profile: disabled: {type(error).__name__}\n")


_main()
