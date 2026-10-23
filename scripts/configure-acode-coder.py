#!/usr/bin/env python3
"""Expose only the capability bridge through Coder; preserve Console's owner-only access."""

import argparse
import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--coder-url", required=True)
parser.add_argument("--workspace", required=True, help="Workspace UUID")
parser.add_argument("--agent", default="main")
parser.add_argument("--port", type=int, default=7076)
parser.add_argument("--bridge-url", required=True, help="HTTPS origin of the dedicated bridge port")
args = parser.parse_args()
if args.port == 7070 or not 1024 <= args.port <= 65535:
    parser.error("Use a separate bridge port; never expose the Console port.")

bridge = urlsplit(args.bridge_url)
if (
    bridge.scheme != "https"
    or not bridge.netloc
    or bridge.username
    or bridge.password
    or bridge.path not in ("", "/")
    or bridge.query
    or bridge.fragment
):
    parser.error("--bridge-url must be an HTTPS origin.")
token = (Path.home() / ".config/coderv2/session").read_text().strip()
api = args.coder_url.rstrip("/") + f"/api/v2/workspaces/{args.workspace}/port-share"
headers = {"Coder-Session-Token": token, "Content-Type": "application/json"}
with urllib.request.urlopen(urllib.request.Request(api, headers=headers), timeout=20) as response:
    shares = json.load(response)["shares"]
if any(item["port"] == 7070 and item["share_level"] != "owner" for item in shares):
    raise SystemExit("Console port is not owner-only. Restore its private access first.")
body = json.dumps(
    {"agent_name": args.agent, "port": args.port, "protocol": "http", "share_level": "public"}
).encode()
try:
    with urllib.request.urlopen(
        urllib.request.Request(api, headers=headers, data=body, method="POST"), timeout=20
    ) as response:
        result = json.load(response)
        if result.get("share_level") != "public":
            raise SystemExit("Coder did not enable the dedicated bridge share.")
except urllib.error.HTTPError as error:
    raise SystemExit(f"Coder rejected bridge sharing: HTTP {error.code}.") from None
envfile = Path.home() / ".config/agent-console/env"
text = envfile.read_text() if envfile.exists() else ""
for name, value in {
    "AGENT_CONSOLE_ACODE_URL": f"https://{bridge.netloc}/",
    "AGENT_CONSOLE_ACODE_PORT": str(args.port),
}.items():
    text = re.sub(rf"^(?:export\s+)?{name}=.*\n?", "", text, flags=re.MULTILINE)
    text = text.rstrip("\n") + f"\n{name}={value}\n"
envfile.parent.mkdir(parents=True, exist_ok=True)
envfile.write_text(text)
envfile.chmod(0o600)
print(f"Configured capability-only bridge on port {args.port}; Console port 7070 stays private.")
print("Queue bin/agent-console restart-when-idle after verification.")
