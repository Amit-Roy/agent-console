"""Exercise host supervision and Caddy routing without touching Docker or the host."""

from pathlib import Path
from tempfile import TemporaryDirectory
import runpy
import subprocess

root = Path(__file__).resolve().parent.parent
installer = runpy.run_path(str(root / "scripts/github-triage-caddy.py"))
worker = {"__name__": "triage_watchdog_fixture"}
exec(compile(installer["REFRESH_SOURCE"], "triage-watchdog", "exec"), worker)

with TemporaryDirectory(prefix="triage-caddy-fixture-") as temporary:
    directory = Path(temporary)
    environment = directory / "caddy.env"
    environment.write_text("DUCKDNS_API_TOKEN=fixture-only\n")
    config = directory / "Caddyfile"
    snippet = directory / "github-triage.caddy"
    config.write_text(worker["SITE"] + "\n}\n")
    worker["CONFIG"] = config
    worker["SNIPPET"] = snippet
    worker["Path"] = lambda value: (
        environment if str(value) == "/etc/caddy/duckdns.env" else Path(value)
    )
    calls = []
    state = {"inspect": "true\n172.18.0.4\nno\n", "code": 0}

    class FixtureProcesses:
        @staticmethod
        def run(args, **kwargs):
            calls.append(args)
            if args[:2] == ["docker", "inspect"]:
                return subprocess.CompletedProcess(args, state["code"], state["inspect"], "")
            return subprocess.CompletedProcess(args, 0, "", "")

    worker["subprocess"] = FixtureProcesses
    assert worker["workspace"]() == "172.18.0.4"
    assert ["docker", "update", "--restart", "unless-stopped", worker["CONTAINER"]] in calls
    calls.clear()
    state["inspect"] = "false\n\nunless-stopped\n"
    assert worker["workspace"]() is None
    assert len(calls) == 1, "A deliberately stopped workspace must remain stopped"
    state["code"] = 1
    assert worker["workspace"]() is None
    calls.clear()
    worker["refresh"]("172.18.0.4")
    assert b"reverse_proxy 172.18.0.4:7077" in snippet.read_bytes()
    assert ["systemctl", "reload", "caddy"] in calls
    calls.clear()
    worker["refresh"]("172.18.0.4")
    assert not calls, "An unchanged route must not reload Caddy"
    worker["refresh"]("172.18.0.8")
    assert b"reverse_proxy 172.18.0.8:7077" in snippet.read_bytes()
    calls.clear()
    worker["supervise"]()
    assert calls[0][:4] == ["docker", "exec", "--user", "coder"]
    assert calls[0][-1] == "watchdog"
    assert not any(call[:2] in (["docker", "start"], ["docker", "restart"]) for call in calls)

print(
    "GitHub triage host watchdog: restart policy, stopped-workspace preservation, route refresh, and user-scoped supervision passed."
)
