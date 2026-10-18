#!/usr/bin/env python3
"""Install the narrowly scoped GitHub webhook route on the Coder VPS.

Run from the repository with:
    ssh vps 'python3 -' < scripts/github-triage-caddy.py

This installs a root-owned refresh worker and timer. The Console remains behind
Coder authentication; only POST webhook requests reach the signature-checking worker.
"""

from pathlib import Path
import os
import subprocess


REFRESH_SOURCE = r'''#!/usr/bin/env python3
"""Refresh the public webhook's private Docker upstream without exposing Console."""
from pathlib import Path
import fcntl
import ipaddress
import os
import shlex
import shutil
import subprocess
import tempfile
import time

CONFIG = Path("/opt/coder/https/Caddyfile")
SNIPPET = Path("/opt/coder/https/agent-console/github-triage.caddy")
SITE = "*.nefro-dev-coder.duckdns.org {"
IMPORT = "\timport /opt/coder/https/agent-console/github-triage.caddy"
CONTAINER = "coder-Amit-Roy-nefro-dev-ssdnodes"


def atomic_write(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def restore(path, old):
    if old is None:
        path.unlink(missing_ok=True)
    else:
        atomic_write(path, old)


def refresh():
    upstream = subprocess.check_output([
        "docker", "inspect", "--format",
        '{{(index .NetworkSettings.Networks "coder_default").IPAddress}}',
        CONTAINER,
    ], text=True).strip()
    address = ipaddress.ip_address(upstream)
    if address.version != 4 or not address.is_private:
        raise RuntimeError("The workspace requires a private IPv4 address.")

    original = CONFIG.read_bytes()
    current = original.decode()
    if current.count(SITE) != 1:
        raise RuntimeError("The expected wildcard Caddy site is missing or ambiguous.")
    if IMPORT.strip() not in current:
        current = current.replace(SITE, SITE + "\n" + IMPORT, 1)
    route = (
        "# Managed by agent-console github-triage-caddy.py.\n"
        "@agentConsoleGitHubTriage {\n"
        "    host github-webhook.nefro-dev-coder.duckdns.org\n"
        "    path /api/github/webhook\n"
        "    method POST\n"
        "}\n"
        "handle @agentConsoleGitHubTriage {\n"
        f"    reverse_proxy {address}:7077\n"
        "}\n"
    ).encode()
    previous_route = SNIPPET.read_bytes() if SNIPPET.exists() else None
    if original == current.encode() and previous_route == route:
        return

    environment = os.environ.copy()
    for line in Path("/etc/caddy/duckdns.env").read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "DUCKDNS_API_TOKEN":
            values = shlex.split(value, comments=True)
            if len(values) != 1:
                raise RuntimeError("The Caddy environment file has an invalid token assignment.")
            environment[key.strip()] = values[0]
    SNIPPET.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    stamp = str(time.time_ns())
    for path in (CONFIG, SNIPPET):
        if path.exists():
            shutil.copy2(path, path.with_name(path.name + ".bak-github-triage-" + stamp))
    reload_attempted = False
    try:
        atomic_write(SNIPPET, route)
        if original != current.encode():
            atomic_write(CONFIG, current.encode())
        validate = subprocess.run([
            "runuser", "--user", "caddy", "--", "/usr/local/bin/caddy",
            "validate", "--config", str(CONFIG), "--adapter", "caddyfile",
        ], env=environment, capture_output=True)
        if validate.returncode:
            raise RuntimeError("Caddy validation failed; the previous configuration was restored.")
        reload_attempted = True
        reload_result = subprocess.run(["systemctl", "reload", "caddy"], capture_output=True)
        if reload_result.returncode:
            raise RuntimeError("Caddy reload failed; the previous configuration was restored.")
    except Exception:
        restore(CONFIG, original)
        restore(SNIPPET, previous_route)
        if reload_attempted:
            subprocess.run(["systemctl", "reload", "caddy"], capture_output=True)
        raise
    print("The GitHub webhook route was refreshed.")


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise SystemExit("Run this refresh worker as root.")
    with open("/run/lock/agent-console-github-triage-caddy.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        refresh()
'''


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run this installer as root on the Coder VPS.")
    worker = Path("/usr/local/lib/agent-console/github-triage-caddy.py")
    worker.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    worker.write_text(REFRESH_SOURCE)
    worker.chmod(0o755)
    subprocess.run(["python3", str(worker)], check=True)
    units = {
        "agent-console-github-triage-caddy.service": """[Unit]
Description=Refresh the Agent Console GitHub webhook Caddy route
After=docker.service caddy.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/agent-console/github-triage-caddy.py
User=root
Group=root
UMask=0022
""",
        "agent-console-github-triage-caddy.timer": """[Unit]
Description=Track the Agent Console workspace webhook address

[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
""",
    }
    for name, content in units.items():
        destination = Path("/etc/systemd/system") / name
        destination.write_text(content)
        destination.chmod(0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run([
        "systemctl", "enable", "--now", "agent-console-github-triage-caddy.timer",
    ], check=True, capture_output=True)
    print("The webhook route and automatic address refresh are installed.")


if __name__ == "__main__":
    main()
