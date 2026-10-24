#!/usr/bin/env python3
"""Behavioral checks for scripts/effort-data.py using tiny synthetic parquet fixtures."""

import contextlib
import hashlib
import importlib.util
import io
import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pyarrow as arrow
import pyarrow.parquet as parquet_io

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "effort_data", Path(__file__).resolve().parents[1] / "scripts/effort-data.py"
)
data = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(data)

REVISION = "0123456789abcdef0123456789abcdef01234567"
TOKEN_COLUMNS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "subagent_input_tokens",
    "subagent_output_tokens",
    "subagent_cache_creation_tokens",
    "subagent_cache_read_tokens",
)


def session(sid, agent, tokens=(100, 50, 10, 40, 1, 2, 3, 4)):
    row = {
        "session_id": sid,
        "repo_id": "repo",
        "user_id": "user",
        "agent": agent,
        "model": "model-x",
        "created_at": "2026-09-01T10:00:00+00:00",
    }
    return row | dict(zip(TOKEN_COLUMNS, tokens, strict=True))


def turn(sid, number, kind, content=""):
    return {"session_id": sid, "turn_number": number, "turn_type": kind, "content": content}


SESSIONS = [
    session("claude", "Claude Code"),
    session("codex", "Codex"),
    session("pi", "Pi"),
    session("gemini", "Gemini CLI"),
    session("notext", "Claude Code"),
    session("zero", "Claude Code", tokens=(0,) * 8),
]
TURNS = [
    turn("claude", 2, "user_prompt", "second"),
    turn("claude", 1, "user_prompt", "first"),
    turn("claude", 3, "assistant_response", "hello"),
    turn("claude", 4, "user_prompt", "later follow-up"),
    turn("codex", 1, "user_prompt", "codex ask"),
    turn("codex", 2, "tool_use", ""),
    turn("pi", 1, "user_prompt", "pi ask"),
    turn("gemini", 1, "user_prompt", "gemini ask"),
    turn("notext", 1, "user_prompt", "   "),
    turn("notext", 2, "assistant_response", "hi"),
    turn("zero", 1, "user_prompt", "zero ask"),
]


def write_raw(directory):
    created = (
        arrow.array(["2026-09-01T10:00:00"] * len(SESSIONS))
        .cast(arrow.timestamp("ns"))
        .cast(arrow.timestamp("ns", tz="UTC"))
    )
    table = arrow.Table.from_pylist(SESSIONS).set_column(5, "created_at", created)
    parquet_io.write_table(table, directory / "sessions.parquet")
    parquet_io.write_table(
        arrow.Table.from_pylist(TURNS), directory / "conversations.parquet", row_group_size=4
    )


def run_cli(*argv, revision=REVISION):
    out, err = io.StringIO(), io.StringIO()
    with (
        mock.patch.object(data, "resolve_revision", return_value=revision),
        mock.patch.object(data, "load_token", return_value=None),
        contextlib.redirect_stdout(out),
        contextlib.redirect_stderr(err),
    ):
        code = data.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class EffortDataTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.raw = Path(scratch.name) / "raw"
        self.out = Path(scratch.name) / "out"
        self.raw.mkdir()
        write_raw(self.raw)
        self.args = ("--raw-dir", str(self.raw), "--dir", str(self.out))

    def rows(self):
        lines = (self.out / "rows.jsonl").read_text().splitlines()
        return {row["session_id"]: row for row in map(json.loads, lines)}

    def test_filter_text_and_tokens(self):
        code, out, err = run_cli(*self.args)
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(len(out.splitlines()), 1)
        rows = self.rows()
        self.assertEqual(set(rows), {"claude", "codex", "pi"})
        claude = rows["claude"]
        self.assertEqual(claude["request_text"], "first\n\nsecond")
        self.assertEqual(rows["codex"]["request_text"], "codex ask")
        self.assertEqual(claude["input_total"], 100 + 10 + 40 + 1 + 3 + 4)
        self.assertEqual(claude["output_total"], 52)
        self.assertEqual(claude["cache_read_total"], 44)
        self.assertEqual(claude["total_tokens"], 158 + 52)
        self.assertEqual(claude["created_at"], "2026-09-01T10:00:00+00:00")
        self.assertEqual(tuple(claude), data.ROW_FIELDS)

    def test_manifest(self):
        run_cli(*self.args)
        manifest = json.loads((self.out / "manifest.json").read_text())
        self.assertEqual(manifest["revision"], REVISION)
        self.assertEqual(manifest["license"], "odc-by")
        self.assertIn("SALT-NLP/SWE-chat", manifest["source"])
        self.assertEqual(manifest["rowsByAgent"], {"Claude Code": 1, "Codex": 1, "Pi": 1})
        self.assertEqual(
            manifest["dropCounts"],
            {"agent_excluded": 1, "no_request_text": 1, "zero_total_tokens": 1},
        )
        digest = hashlib.sha256((self.out / "rows.jsonl").read_bytes()).hexdigest()
        self.assertEqual(manifest["rowsSha256"], digest)
        self.assertTrue(manifest["fetchedAt"])
        self.assertEqual(stat.S_IMODE(self.out.stat().st_mode), 0o700)
        self.assertEqual(list(self.out.glob("*.part")), [])

    def test_same_revision_is_noop(self):
        run_cli(*self.args)
        before = (self.out / "manifest.json").read_text()
        with mock.patch.object(data, "build_rows", side_effect=AssertionError("rebuilt")):
            code, out, _ = run_cli(*self.args)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "swe-chat up to date rev 01234567 rows 3")
        self.assertEqual((self.out / "manifest.json").read_text(), before)

    def test_new_revision_rebuilds(self):
        run_cli(*self.args)
        code, out, _ = run_cli(*self.args, revision="f" * 40)
        self.assertEqual(code, 0)
        self.assertIn("rev ffffffff", out)
        manifest = json.loads((self.out / "manifest.json").read_text())
        self.assertEqual(manifest["revision"], "f" * 40)

    def test_missing_output_rebuilds_despite_manifest(self):
        run_cli(*self.args)
        (self.out / "rows.jsonl").unlink()
        _, out, _ = run_cli(*self.args)
        self.assertIn("fetched", out)

    def test_stage_error_format(self):
        missing = Path(self.raw) / "nope"
        code, out, err = run_cli("--raw-dir", str(missing), "--dir", str(self.out))
        self.assertEqual((code, out), (1, ""))
        self.assertRegex(err, r"^effort-data: download: missing raw parquet")

    def test_bad_args_exit_two(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            data.main(["--nope"])
        self.assertEqual(raised.exception.code, 2)

    def test_raw_dir_is_never_deleted(self):
        run_cli(*self.args)
        self.assertTrue((self.raw / "conversations.parquet").is_file())

    def test_downloaded_raw_deleted_unless_kept(self):
        for keep in (False, True):
            out = self.out / f"keep-{keep}"
            argv = ["--dir", str(out)] + (["--keep-raw"] if keep else [])
            raw = out / "raw"

            def stage(_revision, name, target, _token, raw=raw):
                raw.mkdir(parents=True, exist_ok=True)
                (raw / name).write_bytes((self.raw / name).read_bytes())
                return raw / name

            with mock.patch.object(data, "download", side_effect=stage):
                code, _, err = run_cli(*argv)
            self.assertEqual((code, err), (0, ""))
            self.assertEqual(raw.exists(), keep)


if __name__ == "__main__":
    unittest.main()
