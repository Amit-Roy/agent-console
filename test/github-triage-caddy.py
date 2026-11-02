"""Exercise host supervision and Caddy routing without touching Docker or the host."""

import runpy
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

root = Path(__file__).resolve().parent.parent
installer = runpy.run_path(str(root / "scripts/github-triage-caddy.py"))
worker = {"__name__": "triage_watchdog_fixture"}
exec(compile(installer["REFRESH_SOURCE"], "triage-watchdog", "exec"), worker)

with TemporaryDirectory(prefix="triage-caddy-fixture-") as temporary:
    directory = Path(temporary)
    duckdns = directory / "duckdns.env"
    duckdns.write_text("DUCKDNS_API_TOKEN=fixture-only\n")
    proxy = directory / "console-proxy.env"
    proxy.write_text(
        "CODER_WORKSPACE_HOST_SUFFIX=main--ws--owner.example.test\nCODER_CONTAINER=coder-Owner-ws\n"
    )
    fixture_files = {"/etc/caddy/duckdns.env": duckdns, "/etc/caddy/console-proxy.env": proxy}
    config = directory / "Caddyfile"
    snippet = directory / "github-triage.caddy"
    config.write_text(worker["SITE"] + "\n}\n")
    worker["CONFIG"] = config
    worker["SNIPPET"] = snippet
    worker["Path"] = lambda value: fixture_files.get(str(value), Path(value))
    worker["CONTAINER"] = worker["caddy_environment"]()["CODER_CONTAINER"]
    assert worker["CONTAINER"] == "coder-Owner-ws"
    proxy.write_text("CODER_CONTAINER=coder-Owner-ws\n")
    try:
        worker["caddy_environment"]()
        raise AssertionError("A missing workspace host suffix must fail validation")
    except RuntimeError as error:
        assert "CODER_WORKSPACE_HOST_SUFFIX" in str(error)
    proxy.write_text(
        "CODER_WORKSPACE_HOST_SUFFIX=main--ws--owner.example.test\nCODER_CONTAINER=coder-Owner-ws\n"
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
