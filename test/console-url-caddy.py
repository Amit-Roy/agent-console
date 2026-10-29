"""Exercise the actual alias snippet through Caddy with an isolated Coder fixture."""

import base64
import hashlib
import http.client
import json
import os
import socket
import subprocess
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parent.parent
SHORT = "console.coder.example.com"
LONG = "7070--main--workspace--example-owner.coder.example.com"


class CoderFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            if self.headers["Host"] != LONG or self.headers.get("Origin") != "https://" + LONG:
                self.send_error(403)
                return
            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(
                hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            ).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            return
        body = json.dumps(
            {
                "path": self.path,
                "host": self.headers["Host"],
                "forwarded": self.headers.get("X-Forwarded-Host"),
                "origin": self.headers.get("Origin"),
                "method": self.command,
                "body": self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode(),
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Set-Cookie",
            "fixture=opaque; Domain=.coder.example.com; Secure; HttpOnly; Path=/",
        )
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET

    def log_message(self, *_args):
        pass


class ConsoleRouting(unittest.TestCase):
    def request(self, host=SHORT, path="/api/threads", headers=None, method="GET", body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers={"Host": host, **(headers or {})})
        response = connection.getresponse()
        result = (
            response.status,
            {key.lower(): value for key, value in response.getheaders()},
            response.read(),
        )
        connection.close()
        return result

    def test_old_deep_link_and_callback_redirect_to_short_origin(self):
        for path in [
            "/dashboard?view=costs",
            "/?coder_application_connect_api_key_35e783=opaque&next=%2Fdashboard",
            "//foreign.example/path",
        ]:
            status, headers, _ = self.request(
                host=LONG, path=path, method="POST", body="preserve-me"
            )
            self.assertEqual(status, 307)
            self.assertEqual(headers["location"], "https://" + SHORT + path)

    def test_api_keeps_path_body_cookie_and_coder_identity(self):
        status, headers, body = self.request(
            path="/api/doctor?check=a%2Fb",
            method="POST",
            body='{"fixture":true}',
            headers={"Origin": "https://" + SHORT, "X-Forwarded-Host": "attacker.example"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            json.loads(body),
            {
                "path": "/api/doctor?check=a%2Fb",
                "host": LONG,
                "forwarded": LONG,
                "origin": "https://" + LONG,
                "method": "POST",
                "body": '{"fixture":true}',
            },
        )
        self.assertIn("Domain=.coder.example.com", headers["set-cookie"])

    def test_foreign_origin_is_not_promoted_to_trusted_origin(self):
        for origin in [
            "https://foreign.example",
            "https://" + SHORT + ".evil.example",
            "null",
            "http://" + SHORT,
        ]:
            _, _, body = self.request(headers={"Origin": origin})
            self.assertEqual(json.loads(body)["origin"], origin)

    def test_other_coder_hosts_use_existing_fallback(self):
        for host in ["other.coder.example.com", "coder.example.com"]:
            _, _, body = self.request(host=host)
            self.assertEqual(json.loads(body)["host"], host)

    def test_websocket_upgrade_passes_through(self):
        status, headers, _ = self.request(
            path="/",
            headers={
                "Origin": "https://" + SHORT,
                "Connection": "Upgrade",
                "Upgrade": "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            },
        )
        self.assertEqual(status, 101)
        self.assertEqual(headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")


if __name__ == "__main__":
    caddy = os.environ.get("CADDY_BIN", "caddy")
    with TemporaryDirectory(prefix="console-caddy-") as scratch:
        scratch = Path(scratch)
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), CoderFixture)
        thread = threading.Thread(target=fixture.serve_forever, daemon=True)
        thread.start()
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            ConsoleRouting.port = reserved.getsockname()[1]
        config = scratch / "Caddyfile"
        config.write_text(
            "{\n admin off\n auto_https off\n}\nhttp://:"
            + str(ConsoleRouting.port)
            + " {\n bind 127.0.0.1\n import "
            + str(ROOT / "docs/console-url.caddy")
            + "\n reverse_proxy 127.0.0.1:7080\n}\n"
        )
        adapted = subprocess.run(
            [caddy, "adapt", "--config", str(config)], capture_output=True, text=True, check=True
        )
        compiled = adapted.stdout.replace("127.0.0.1:7080", "127.0.0.1:" + str(fixture.server_port))
        runtime = scratch / "caddy.json"
        runtime.write_text(compiled)
        with (scratch / "caddy.log").open("w") as log:
            process = subprocess.Popen(
                [caddy, "run", "--config", str(runtime)], stdout=log, stderr=log
            )
            try:
                deadline = time.monotonic() + 5
                while True:
                    try:
                        with socket.create_connection(
                            ("127.0.0.1", ConsoleRouting.port), timeout=0.1
                        ):
                            break
                    except OSError as err:
                        if process.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError(
                                "Fixture Caddy failed to start: "
                                + (scratch / "caddy.log").read_text()
                            ) from err
                        time.sleep(0.02)
                result = unittest.TextTestRunner(verbosity=2).run(
                    unittest.defaultTestLoader.loadTestsFromTestCase(ConsoleRouting)
                )
            finally:
                process.terminate()
                process.wait(timeout=5)
                fixture.shutdown()
                fixture.server_close()
        raise SystemExit(0 if result.wasSuccessful() else 1)
