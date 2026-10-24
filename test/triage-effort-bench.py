#!/usr/bin/env python3
"""Behavioral checks for scripts/triage-effort-bench.py on a tiny synthetic dataset."""

import contextlib
import importlib.util
import io
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "triage_effort_bench", Path(__file__).resolve().parents[1] / "scripts/triage-effort-bench.py"
)
bench = importlib.util.module_from_spec(SPEC)
# Worker processes pickle functions by module name.
sys.modules[SPEC.name] = bench
SPEC.loader.exec_module(bench)
fit = bench.fit
SAMPLE_COUNT = 80
HUGE_TOKENS = 10**12
TREE_NAMES = "current,stable,stable+swe-chat-prior"
# Workers fork after this, so the forest stays small enough for a quick test.
bench.FOREST_TREES = 20


def text_features(level):
    return {
        "size": level,
        "lines": level,
        "refs": level,
        "verbs": level,
        "logChars": 3.0 + level * 0.8,
        "logLines": 0.7 + level * 0.4,
        "logRefs": float(level),
        "logVerbs": float(level),
        "fence": 1.0 if level > 2 else 0.0,
        "logPaths": level * 0.5,
        "tests": 1.0 if level > 1 else 0.0,
        "checklist": float(level == 3),
        "bullets": float(level),
        "questions": float(level > 2),
        "versions": float(level == 2),
    }


def dataset():
    samples = []
    for index in range(SAMPLE_COUNT):
        level = index % 4
        tokens = round(math.exp(8 + level * 1.1 + (index % 5) * 0.1))
        stamp = f"2026-09-{1 + index // 4:02d}T{index % 4:02d}:00:00Z"
        samples.append(
            {
                "sampleId": f"run-{index}",
                "groupId": f"thread-{index}",
                "startedAt": stamp,
                "completedAt": stamp,
                "features": {name: level for name in fit.LEGACY_FEATURES},
                "text": text_features(level),
                "outcomes": {"inputTokens": tokens, "outputTokens": tokens // 10},
                "provider": "fixture",
            }
        )
    return {"schemaVersion": 1, "scope": "completed-session", "samples": samples}


def external_rows(count):
    rows = []
    for index in range(count):
        level = index % 4
        rows.append(
            {
                "session_id": f"ext-{index}",
                "total_tokens": HUGE_TOKENS if index == 0 else 3000 * (level + 1),
                "text": text_features(level),
            }
        )
    rows.append({"session_id": "ext-bad", "total_tokens": 5, "text": {"size": 1}})
    rows.append({"session_id": "ext-zero", "total_tokens": 0, "text": text_features(0)})
    return rows


class BenchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.dataset = cls.dir / "dataset.json"
        cls.dataset.write_text(json.dumps(dataset()))
        cls.external = cls.dir / "features.jsonl"
        cls.external.write_text("".join(json.dumps(row) + "\n" for row in external_rows(60)))
        # Each full run fits many small forests, so run the two shapes once and share them.
        cls.plain_code, cls.plain_stdout, _, plain_out = cls.run_main(
            "--json", "--candidates", "current,stable", name="plain"
        )
        cls.pooled_code, cls.pooled_stdout, _, pooled_out = cls.run_main(
            "--external-rows", str(cls.external), "--candidates", TREE_NAMES, name="pooled"
        )
        cls.forest_code, cls.forest_stdout, _, forest_out = cls.run_main(
            "--candidates", "qrf", name="forest"
        )
        cls.plain = json.loads((plain_out / "summary.json").read_text())
        cls.pooled = json.loads((pooled_out / "summary.json").read_text())
        cls.forest = json.loads((forest_out / "summary.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @classmethod
    def run_main(cls, *extra, name="out"):
        out = cls.dir / name
        argv = ["--dataset", str(cls.dataset), "--out", str(out), *extra]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = bench.main(argv)
        return code, stdout.getvalue(), stderr.getvalue(), out

    def test_candidates_summary_and_output_lines(self):
        self.assertEqual(self.pooled_code, 0)
        summary = self.pooled
        self.assertEqual(
            {"best", "candidates", "train", "heldout", "ceiling", "externalRows"}, set(summary)
        )
        names = [item["name"] for item in summary["candidates"]]
        self.assertEqual(names, ["current", "stable", "stable+swe-chat-prior"])
        for item in summary["candidates"]:
            self.assertEqual(
                {"name", "pinball", "coverage", "nodes", "gap", "sizeKb", "fitSec", "offsets"},
                set(item),
            )
            self.assertGreater(item["nodes"], 0)
            self.assertTrue(math.isfinite(item["pinball"]))
        self.assertIn(summary["best"], names)
        lines = self.pooled_stdout.strip().split("\n")
        self.assertEqual(len(lines), 4)
        self.assertRegex(
            lines[1],
            r"^stable pinball \d\.\d{3} cov \d\.\d\d/\d\.\d\d gap (\d\.\d{3}|n/a) nodes \d+ kb \d+ fit \d+\.\ds$",
        )
        self.assertTrue(lines[3].startswith(f"best {summary['best']} out "))

    def test_without_external_rows_only_two_candidates_and_json_flag(self):
        self.assertEqual(self.plain_code, 0)
        self.assertEqual(json.loads(self.plain_stdout), self.plain)
        self.assertEqual([item["name"] for item in self.plain["candidates"]], ["current", "stable"])
        self.assertEqual(self.plain["externalRows"], 0)

    def test_forest_candidate_reports_size_instead_of_nodes(self):
        self.assertEqual(self.forest_code, 0)
        (item,) = self.forest["candidates"]
        self.assertEqual(item["name"], "qrf")
        self.assertIsNone(item["nodes"])
        self.assertGreater(item["sizeKb"], 0)
        self.assertTrue(math.isfinite(item["pinball"]))
        self.assertRegex(
            self.forest_stdout.split("\n")[0], r"^qrf pinball .* nodes n/a kb \d+ fit "
        )

    def test_offsets_mirror_the_served_model(self):
        by_name = {item["name"]: item for item in self.pooled["candidates"]}
        levels = list(bench.fit.QUANTILE_LEVELS)
        self.assertEqual(set(by_name["current"]["offsets"]), set(levels))
        self.assertTrue(all(value == 0.0 for value in by_name["current"]["offsets"].values()))
        self.assertTrue(
            all(value == 0.0 for value in self.forest["candidates"][0]["offsets"].values())
        )
        train, _, ceiling = bench.split_ceiling(bench.load_samples(self.dataset))
        expected = bench.fit.conformal_offsets(train, ceiling)[0]
        self.assertEqual(by_name["stable"]["offsets"], expected)
        prior = by_name["stable+swe-chat-prior"]["offsets"]
        self.assertEqual(set(prior), set(levels))
        self.assertTrue(all(abs(value) <= bench.fit.OFFSET_LIMIT for value in prior.values()))

    def test_unknown_candidate_is_rejected(self):
        stderr = io.StringIO()
        argv = [
            "--dataset",
            str(self.dataset),
            "--out",
            str(self.dir / "bad"),
            "--candidates",
            "nope",
        ]
        with contextlib.redirect_stderr(stderr):
            code = bench.main(argv)
        self.assertEqual(code, 1)
        self.assertIn("effort-model: candidates: ", stderr.getvalue())

    def test_external_rows_are_train_only(self):
        # One row is a trillion tokens: if it reached the ceiling or the held-out block it would show.
        self.assertLess(self.pooled["ceiling"], HUGE_TOKENS)
        self.assertEqual(self.plain["ceiling"], self.pooled["ceiling"])
        self.assertEqual(self.plain["heldout"], self.pooled["heldout"])
        self.assertEqual(self.plain["train"], self.pooled["train"])
        self.assertEqual(self.pooled["externalRows"], 60)
        _, held, _ = bench.split_ceiling(bench.load_samples(self.dataset))
        self.assertTrue(all(sample["sampleId"].startswith("run-") for sample in held))

    def test_current_params_from_artifact_else_legacy(self):
        artifact = self.dir / "model.json"
        self.assertEqual(bench.current_params(artifact), bench.LEGACY_PARAMS)
        recorded = {"max_depth": 2, "min_samples_leaf": 80, "evil": 1, "learning_rate": "x"}
        artifact.write_text(json.dumps({"quantileModel": {"parameters": recorded}}))
        params = bench.current_params(artifact)
        self.assertEqual(params["max_depth"], 2)
        self.assertEqual(params["min_samples_leaf"], 80)
        self.assertEqual(params["learning_rate"], bench.LEGACY_PARAMS["learning_rate"])
        self.assertNotIn("evil", params)

    def test_missing_dataset_reports_stage(self):
        stderr = io.StringIO()
        argv = ["--dataset", str(self.dir / "absent.json"), "--out", str(self.dir / "none")]
        with contextlib.redirect_stderr(stderr):
            code = bench.main(argv)
        self.assertEqual(code, 1)
        self.assertTrue(stderr.getvalue().startswith("effort-model: dataset: "))


if __name__ == "__main__":
    unittest.main()
