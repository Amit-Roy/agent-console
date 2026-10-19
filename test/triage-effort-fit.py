#!/usr/bin/env python3
"""Behavioral checks for the offline effort-pricing fit, without private data."""
import copy
import importlib.util
import math
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("triage_effort_fit", Path(__file__).resolve().parents[1] / "scripts/triage-effort-fit.py")
fit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fit)


def dataset():
    samples = []
    for index in range(40):
        level = index % 4
        calls = round(math.exp(1 + level * 0.65))
        samples.append({"sampleId": f"run-{index}", "groupId": f"thread-{index // 2}",
                        "startedAt": f"2026-09-{1 + index // 2:02d}T{index % 2:02d}:00:00Z",
                        "completedAt": f"2026-09-{1 + index // 2:02d}T{index % 2:02d}:00:00Z",
                        "features": {name: level for name in fit.FEATURES},
                        "outcomes": {"toolCalls": calls, "toolRounds": max(1, calls // 2),
                                     "outputTokens": calls * (80 + index % 3 * 5),
                                     "inputTokens": calls * 250, "cachedInputTokens": calls * 150,
                                     "nonCachedInputTokens": calls * 100}, "provider": "fixture"})
    return {"schemaVersion": 1, "samples": samples}


class EffortFitTests(unittest.TestCase):
    def test_monotonic_complexity_and_quantiles(self):
        artifact, _ = fit.build_artifact(dataset())
        rows = []
        for level in range(4):
            row = copy.deepcopy(dataset()["samples"][0])
            row["features"] = dict.fromkeys(fit.FEATURES, level)
            rows.append(row)
        quotes = fit.quote(artifact["workload"], artifact["scenarios"], rows)
        self.assertGreater(quotes[-1]["work"]["p50"], quotes[0]["work"]["p50"])
        for index, quote in enumerate(quotes):
            self.assertLessEqual(quote["work"]["p50"], quote["work"]["p80"])
            self.assertLessEqual(quote["work"]["p80"], quote["work"]["p95"])
            if index:
                self.assertGreaterEqual(quote["work"]["p50"], quotes[index - 1]["work"]["p50"])
        self.assertTrue(all(weight >= 0 for weight in artifact["workload"]["coefficients"]))

    def test_input_and_cache_do_not_change_work_fit_or_effort_cutoffs(self):
        original = dataset()
        changed = copy.deepcopy(original)
        for sample in changed["samples"]:
            sample["outcomes"]["inputTokens"] *= 1000
            sample["outcomes"]["cachedInputTokens"] *= 13
            sample["outcomes"]["nonCachedInputTokens"] *= 7
        first, _ = fit.build_artifact(original)
        second, _ = fit.build_artifact(changed)
        self.assertEqual(first["workload"], second["workload"])
        self.assertEqual(first["workCutoffs"], second["workCutoffs"])
        self.assertEqual(first["validation"]["work"], second["validation"]["work"])
        self.assertEqual([s["outputPerWork"] for s in first["scenarios"]], [s["outputPerWork"] for s in second["scenarios"]])

    def test_frozen_holdout_does_not_select_model_or_calibration(self):
        original = dataset()
        first, _ = fit.build_artifact(original)
        heldout_ids = set(first["validation"]["sampleIds"])
        changed = copy.deepcopy(original)
        for sample in changed["samples"]:
            if sample["sampleId"] in heldout_ids:
                sample["features"] = dict.fromkeys(fit.FEATURES, 3)
                sample["outcomes"]["toolCalls"] *= 100
                sample["outcomes"]["outputTokens"] *= 10000
        second, _ = fit.build_artifact(changed)
        for key in ("workload", "scenarios", "workCutoffs", "training"):
            self.assertEqual(first[key], second[key])
        self.assertEqual(first["validation"]["selection"], second["validation"]["selection"])
        self.assertNotEqual(first["validation"]["work"], second["validation"]["work"])

    def test_output_token_magnitude_does_not_set_effort(self):
        original = dataset()
        changed = copy.deepcopy(original)
        for sample in changed["samples"]:
            sample["outcomes"]["outputTokens"] *= 50
        first, _ = fit.build_artifact(original)
        second, _ = fit.build_artifact(changed)
        self.assertEqual(first["workload"], second["workload"])
        self.assertEqual(first["workCutoffs"], second["workCutoffs"])
        self.assertEqual(first["training"]["alpha"], second["training"]["alpha"])
        self.assertNotEqual(first["scenarios"][0]["outputPerWork"], second["scenarios"][0]["outputPerWork"])

    def test_no_group_or_time_leakage(self):
        rows, _ = fit.validate_dataset(dataset())
        older, heldout, purged = fit.frozen_split(rows)
        self.assertFalse(set(s["groupId"] for s in older) & set(s["groupId"] for s in heldout))
        self.assertLess(max(s["_time"] for s in older), min(s["_start"] for s in heldout))
        for train, validation in fit.folds(older):
            self.assertFalse(set(s["groupId"] for s in train) & set(s["groupId"] for s in validation))
            self.assertLess(max(s["_time"] for s in train), min(s["_start"] for s in validation))
        artifact, _ = fit.build_artifact(dataset())
        self.assertTrue(set(s["sampleId"] for s in artifact["scenarios"]) <= set(artifact["training"]["sampleIds"]))
        self.assertFalse(set(s["sampleId"] for s in artifact["scenarios"]) & set(artifact["validation"]["sampleIds"]))

    def test_overlap_is_purged(self):
        fixture = dataset()
        fixture["samples"][0]["completedAt"] = "2026-09-17T00:00:30Z"
        rows, _ = fit.validate_dataset(fixture)
        train, heldout, purged = fit.frozen_split(rows)
        self.assertLess(max(s["_time"] for s in train), min(s["_start"] for s in heldout))
        self.assertTrue(purged)

    def test_training_outcome_during_target_run_is_unavailable(self):
        fixture = dataset()
        # Target starts on day 17 but finishes much later. A training run
        # completing during that target cannot be known at quote time.
        fixture["samples"][0]["completedAt"] = "2026-09-17T00:30:00Z"
        for sample in fixture["samples"][32:34]:
            sample["completedAt"] = "2026-09-25T00:00:00Z"
        rows, _ = fit.validate_dataset(fixture)
        train, heldout, purged = fit.frozen_split(rows)
        self.assertIn("run-0", [s["sampleId"] for s in purged])
        self.assertNotIn("run-0", [s["sampleId"] for s in train])
        self.assertLess(max(s["_time"] for s in train), min(s["_start"] for s in heldout))
        for train_fold, target_fold in fit.folds(rows):
            self.assertLess(max(s["_time"] for s in train_fold), min(s["_start"] for s in target_fold))

    def test_unknown_is_imputed_train_only_and_visible(self):
        fixture = dataset()
        fixture["samples"][0]["features"]["breadth"] = None
        artifact, _ = fit.build_artifact(fixture)
        self.assertEqual(artifact["workload"]["featureRanges"][0]["missing"], 1)
        query = copy.deepcopy(fixture["samples"][0])
        query["features"] = dict.fromkeys(fit.FEATURES, None)
        result = fit.quote(artifact["workload"], artifact["scenarios"], [query])[0]
        self.assertTrue(math.isfinite(result["work"]["p95"]))
        self.assertEqual(artifact["validation"]["status"], "experimental")

    def test_reject_zero_missing_outcomes_and_bad_schema(self):
        fixture = dataset()
        fixture["samples"][0]["outcomes"]["toolCalls"] = 0
        fixture["samples"][1]["outcomes"]["outputTokens"] = None
        _, rejected = fit.validate_dataset(fixture)
        self.assertEqual(rejected, {"missingOrZeroToolCalls": 1, "missingOrZeroOutputTokens": 1})
        for bad in ({}, {"schemaVersion": 2, "samples": []}):
            with self.assertRaises(ValueError):
                fit.validate_dataset(bad)
        fixture = dataset()
        fixture["samples"][0]["features"]["risk"] = True
        with self.assertRaises(ValueError):
            fit.validate_dataset(fixture)

    def test_report_omits_private_sample_ids(self):
        artifact, report = fit.build_artifact(dataset())
        self.assertNotIn("sampleIds", report["training"])
        self.assertNotIn("sampleIds", report["validation"])
        self.assertNotIn("scenarios", report)

    def test_partial_input_accounting_is_not_invented(self):
        fixture = dataset()
        for sample in fixture["samples"]:
            sample["outcomes"]["nonCachedInputTokens"] = None
        artifact, _ = fit.build_artifact(fixture)
        query = fixture["samples"][:1]
        result = fit.quote(artifact["workload"], artifact["scenarios"], query)[0]
        self.assertIsNone(result["freshInputTokens"])
        self.assertIsNotNone(result["cachedInputTokens"])
        self.assertIsNotNone(result["outputTokens"])


if __name__ == "__main__":
    unittest.main()
