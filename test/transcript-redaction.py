#!/usr/bin/env python3
"""Isolated security and storage regression checks for transcript redaction."""

import importlib.util
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("redaction", ROOT / "scripts/transcript_redaction.py")
ENGINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENGINE)
SECRET = "sk-test-1234567890ABCDEFGHIJKLMNOP"
UNICODE_SECRET = "éSecretLongEnough12345"


class RedactionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.data = self.home / "console"
        self.data.mkdir()
        self.scrubber = ENGINE.Scrubber({SECRET, UNICODE_SECRET})
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def transcript(self, text, name="session.jsonl"):
        path = self.home / ".codex/sessions" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def invoke(self, *arguments, stdin=None):
        return subprocess.run(
            [
                str(ROOT / "bin/transcript-redact"),
                *arguments,
                "--home",
                str(self.home),
                "--data-dir",
                str(self.data),
                "--json",
            ],
            input=stdin,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_utf8_escapes_schema_offsets_inode_and_permissions(self):
        original = json.dumps({"secret": UNICODE_SECRET, "key": SECRET}, ensure_ascii=False) + "\n"
        original += json.dumps({"secret": UNICODE_SECRET, "key": SECRET}) + "\n"
        original += '{"secret":"\\u00e9SecretLongEnough12345"}\n'
        path = self.transcript(original)
        path.chmod(0o640)
        snapshot = path.stat()
        self.assertEqual(ENGINE.scrub_file(path, self.scrubber, True)[0], 5)
        self.assertEqual(path.stat().st_size, snapshot.st_size)
        self.assertEqual(path.stat().st_ino, snapshot.st_ino)
        self.assertEqual(path.stat().st_mode, snapshot.st_mode)
        for line in path.read_text().splitlines():
            json.loads(line)
        self.assertEqual(self.scrubber.scrub(path.read_text())[1], 0)

    def test_nonstandard_json_escapes(self):
        text = '{"text":"sk\\u002dtest-1234567890ABCDEFGHIJKLMNOP"}'
        cleaned, count, unused, spans = self.scrubber.scrub(text)
        self.assertEqual(count, 1)
        self.assertEqual(len(cleaned.encode()), len(text.encode()))
        json.loads(cleaned)
        self.assertTrue(spans)

    def test_provider_boundaries_and_ordinary_candidates(self):
        scrubber = ENGINE.Scrubber(set())
        for text in (
            "branch-" + SECRET,
            "encodedhf_" + "a1b2c3d4" * 10,
            SECRET + "/branch",
            "Bearer authentication",
            "task-20261025-remove-session-transcript-keys",
        ):
            self.assertEqual(scrubber.scrub(text)[1], 0)
        for text in ('api_key="abc123def456ghi789"', "Bearer abc123def456ghi789"):
            cleaned, matches, candidates, unused = scrubber.scrub(text)
            self.assertEqual(cleaned, text)
            self.assertEqual(matches, 0)
            self.assertEqual(candidates, 1)
        self.assertEqual(scrubber.scrub("token " + SECRET + ".")[1], 1)

    def test_append_tail_preserved(self):
        path = self.transcript(json.dumps({"text": SECRET}) + "\n")
        real_apply = ENGINE.apply_ranges
        suffix = b'{"text":"appended tail"}\n'

        def append_then_apply(*arguments):
            with path.open("ab") as handle:
                handle.write(suffix)
            return real_apply(*arguments)

        with mock.patch.object(ENGINE, "apply_ranges", side_effect=append_then_apply):
            ENGINE.scrub_file(path, self.scrubber, True)
        self.assertTrue(path.read_bytes().endswith(suffix))

    def test_concurrent_replacement_fails_without_changing_new_inode(self):
        path = self.transcript(SECRET)
        original = ENGINE.apply_ranges

        def replace_then_apply(*arguments):
            replacement = path.with_suffix(".replacement")
            replacement.write_text("replacement")
            replacement.replace(path)
            return original(*arguments)

        with mock.patch.object(ENGINE, "apply_ranges", side_effect=replace_then_apply):
            with self.assertRaisesRegex(ENGINE.RedactionError, "concurrent_change"):
                ENGINE.scrub_file(path, self.scrubber, True)
        self.assertEqual(path.read_text(), "replacement")

    def test_swapped_open_descriptor_refused(self):
        path = self.transcript(SECRET)
        auth = self.home / "credential.json"
        auth.write_text(SECRET)
        actual_open = os.open

        def open_auth_instead(target, flags):
            return actual_open(auth if Path(target) == path else target, flags)

        with mock.patch.object(ENGINE.os, "open", side_effect=open_auth_instead):
            with self.assertRaisesRegex(ENGINE.RedactionError, "concurrent_change"):
                ENGINE.scrub_file(path, self.scrubber, True)
        self.assertEqual(auth.read_text(), SECRET)

    def test_short_write_fails(self):
        path = self.transcript(SECRET)
        with mock.patch.object(ENGINE.os, "pwrite", return_value=1):
            with self.assertRaisesRegex(ENGINE.RedactionError, "short_write"):
                ENGINE.scrub_file(path, self.scrubber, True)

    def test_auth_untouched_and_aliases_refused(self):
        auth = self.home / ".codex/auth.json"
        auth.parent.mkdir()
        auth.write_text(json.dumps({"api_key": SECRET}))
        original = auth.read_bytes()
        path = self.transcript(SECRET)
        linked = path.with_name("linked.json")
        linked.symlink_to(auth)
        hardlink = path.with_name("hardlink.json")
        os.link(auth, hardlink)
        result = self.invoke("apply", "--scope", "native")
        payload = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["status"], "incomplete")
        self.assertEqual(auth.read_bytes(), original)
        self.assertNotIn(SECRET, path.read_text())
        self.assertEqual({item["code"] for item in payload["errors"]}, {"unsafe_alias"})

    def test_alternate_homes_and_default_scan(self):
        path = self.transcript(SECRET)
        result = self.invoke("--scope", "native")
        payload = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(payload["matches"], 1)
        self.assertEqual(path.read_text(), SECRET)
        self.assertEqual(self.invoke("verify", "--scope", "native").returncode, 1)
        self.assertEqual(self.invoke("apply", "--scope", "native").returncode, 0)
        self.assertEqual(self.invoke("verify", "--scope", "native").returncode, 0)

    def test_no_dependency_scan_and_unsupported_archive(self):
        unrelated = self.home / ".codex/node_modules/package"
        unrelated.mkdir(parents=True)
        (unrelated / "session.json").write_text(SECRET)
        result = json.loads(self.invoke("scan", "--scope", "native").stdout)
        self.assertEqual(result["filesScanned"], 0)
        self.transcript("archive", "session.gz")
        result = self.invoke("scan", "--scope", "native")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["errors"][0]["code"], "unsupported_archive")

    def test_live_catalog_refuses_and_native_works(self):
        run = self.home / ".cache/agent-console"
        run.mkdir(parents=True)
        (run / "server.pid").write_text("invalid owner")
        (self.data / "threads.json").write_text(json.dumps({"threads": [{"title": SECRET}]}))
        result = self.invoke("apply")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            json.loads(result.stdout)["errors"][0]["code"], "live_catalog_use_session_redact_apply"
        )
        self.assertEqual(self.invoke("apply", "--scope", "native").returncode, 0)

    def test_offline_catalog_preserves_identity_and_raw_offsets(self):
        original = json.dumps(
            {
                "threads": [
                    {
                        "id": SECRET,
                        "title": UNICODE_SECRET,
                        "recent": [{"text": SECRET}],
                        "model": SECRET,
                    }
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        path = self.data / "threads.json"
        path.write_text(original)
        snapshot = path.stat()
        ENGINE.scrub_file(path, self.scrubber, True)
        cleaned = json.loads(path.read_text())
        self.assertEqual(cleaned["threads"][0]["id"], SECRET)
        self.assertEqual(cleaned["threads"][0]["model"], SECRET)
        self.assertNotIn(SECRET, cleaned["threads"][0]["recent"][0]["text"])
        self.assertEqual(path.stat().st_size, snapshot.st_size)
        self.assertEqual(path.stat().st_ino, snapshot.st_ino)
        self.assertEqual(ENGINE.scrub_file(path, self.scrubber, False)[0], 0)

    def test_append_new_secret_reports_incomplete(self):
        path = self.transcript(SECRET)
        original = ENGINE.apply_ranges

        def append_then_apply(*arguments):
            with path.open("ab") as handle:
                handle.write(("\n" + SECRET).encode())
            return original(*arguments)

        with mock.patch.object(ENGINE, "apply_ranges", side_effect=append_then_apply):
            with self.assertRaisesRegex(ENGINE.RedactionError, "concurrent_secret"):
                ENGINE.scrub_file(path, self.scrubber, True)

    def test_inherited_configuration_cannot_escape_alternate_home(self):
        path = self.transcript(SECRET)
        outside = self.home / "outside"
        outside.mkdir()
        protected = outside / "sessions"
        protected.mkdir()
        (protected / "session.jsonl").write_text(SECRET)
        with mock.patch.dict(
            os.environ,
            {
                "CODEX_HOME": "/unrelated/codex",
                "AGENT_CONSOLE_DATA": "/unrelated/data",
                "AGENT_CONSOLE_RUN": "/unrelated/run",
            },
        ):
            self.assertEqual(
                ENGINE.selected_data(self.home, None), self.home / ".config/agent-console"
            )
            roots, unused = ENGINE.provider_roots(self.home, self.data)
            self.assertNotIn((Path("/unrelated/codex"), "codex"), roots)
        self.assertEqual(path.read_text(), SECRET)

    def test_malformed_arguments_never_echo_values(self):
        result = self.invoke("--unknown-secret", SECRET)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(SECRET, result.stdout + result.stderr)

    def database(self, external=False):
        path = self.data / "session-search.sqlite"
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE documents(id INTEGER PRIMARY KEY, body TEXT)")
        content = ",content='documents',content_rowid='id'" if external else ""
        connection.execute("CREATE VIRTUAL TABLE search USING fts5(body" + content + ")")
        connection.execute("INSERT INTO documents VALUES(1,?)", (SECRET,))
        if external:
            connection.execute("INSERT INTO search(search) VALUES('rebuild')")
        else:
            connection.execute("INSERT INTO search VALUES(?)", (SECRET,))
        connection.commit()
        connection.close()
        return path

    def test_sqlite_standalone_fts_wal_raw_cleanup(self):
        path = self.database()
        self.assertEqual(ENGINE.scrub_database(path, self.scrubber, True)[0], 2)
        self.assertNotIn(SECRET.encode(), path.read_bytes())
        self.assertEqual(ENGINE.scrub_database(path, self.scrubber, False)[0], 0)

    def test_sqlite_external_fts_rebuild(self):
        path = self.database(external=True)
        self.assertEqual(ENGINE.scrub_database(path, self.scrubber, True)[0], 1)
        connection = sqlite3.connect(path)
        self.addCleanup(connection.close)
        self.assertEqual(
            connection.execute(
                "SELECT count(*) FROM search WHERE search MATCH 'ABCDEFGHIJKLMNOP'"
            ).fetchone()[0],
            0,
        )
        self.assertNotIn(SECRET.encode(), path.read_bytes())

    def test_sqlite_raw_residual_not_reported_clean(self):
        path = self.data / "session-search.sqlite"
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA secure_delete=OFF")
        connection.execute("CREATE TABLE documents(body TEXT)")
        connection.execute("INSERT INTO documents VALUES(?)", (SECRET,))
        connection.commit()
        connection.execute("DELETE FROM documents")
        connection.commit()
        connection.close()
        self.assertIn(SECRET.encode(), path.read_bytes())
        with self.assertRaisesRegex(ENGINE.RedactionError, "database_raw_residual"):
            ENGINE.scrub_database(path, self.scrubber, False)
        self.assertEqual(ENGINE.scrub_database(path, self.scrubber, True)[0], 0)
        self.assertNotIn(SECRET.encode(), path.read_bytes())

    def test_sqlite_auth_sidecar_alias_refused(self):
        path = self.database()
        auth = self.home / "auth.json"
        auth.write_text(SECRET)
        original = auth.read_bytes()
        Path(str(path) + "-wal").symlink_to(auth)
        with self.assertRaisesRegex(ENGINE.RedactionError, "unsafe_alias"):
            ENGINE.scrub_database(path, self.scrubber, True)
        self.assertEqual(auth.read_bytes(), original)

    def test_sqlite_contentless_refused(self):
        path = self.data / "session-search.sqlite"
        connection = sqlite3.connect(path)
        connection.execute("CREATE VIRTUAL TABLE search USING fts5(body,content='')")
        connection.close()
        with self.assertRaisesRegex(ENGINE.RedactionError, "unsupported_contentless_fts"):
            ENGINE.scrub_database(path, self.scrubber, True)

    def test_sqlite_busy_explicit_failure(self):
        path = self.database()
        connection = sqlite3.connect(path)
        self.addCleanup(connection.close)
        connection.execute("BEGIN IMMEDIATE")
        with self.assertRaises(sqlite3.OperationalError):
            ENGINE.scrub_database(path, self.scrubber, True)

    def test_catalog_preserves_structure_and_never_logs_values(self):
        original = {
            "threads": [
                {
                    "id": SECRET,
                    "title": SECRET,
                    "recent": [{"text": SECRET, "number": 3}],
                    "other": SECRET,
                }
            ]
        }
        result = self.invoke("apply", "--catalog-stdio", stdin=json.dumps(original))
        self.assertEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["matches"], 2)
        self.assertEqual(payload["changed"], 1)
        self.assertEqual(payload["threads"][0]["id"], SECRET)
        self.assertEqual(payload["threads"][0]["other"], SECRET)
        self.assertEqual(payload["threads"][0]["recent"][0]["number"], 3)
        self.assertNotIn(SECRET, payload["threads"][0]["title"])
        scan = self.invoke("scan", "--catalog-stdio", stdin=json.dumps(original))
        self.assertEqual(json.loads(scan.stdout)["threads"], original["threads"])
        invalid = self.invoke("apply", "--catalog-stdio", stdin="not json " + SECRET)
        self.assertNotIn(SECRET, invalid.stdout + invalid.stderr)


if __name__ == "__main__":
    unittest.main()
