#!/usr/bin/env python3
"""Behavioral checks for the offline effort-pricing fit, without private data."""

import copy
import importlib.util
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "triage_effort_fit", Path(__file__).resolve().parents[1] / "scripts/triage-effort-fit.py"
)
fit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fit)


def dataset():
    samples = []
    for index in range(40):
        level = index % 4
        calls = round(math.exp(1 + level * 0.65))
        samples.append(
            {
                "sampleId": f"run-{index}",
                "groupId": f"thread-{index // 2}",
                "startedAt": f"2026-09-{1 + index // 2:02d}T{index % 2:02d}:00:00Z",
                "completedAt": f"2026-09-{1 + index // 2:02d}T{index % 2:02d}:00:00Z",
                "features": {name: level for name in fit.FEATURES},
                "outcomes": {
                    "toolCalls": calls,
                    "toolRounds": max(1, calls // 2),
                    "outputTokens": calls * (80 + index % 3 * 5),
                    "inputTokens": calls * 250,
                    "cachedInputTokens": calls * 150,
                    "nonCachedInputTokens": calls * 100,
                },
                "provider": "fixture",
            }
        )
    return {"schemaVersion": 1, "samples": samples}


def text_features(index):
    level = index % 4
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


class EffortFitTests(unittest.TestCase):
    def test_session_zero_action_conversations_keep_positive_token_totals(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        fixture["featureVersion"] = "session-first-user-input-v1"
        for index, sample in enumerate(fixture["samples"]):
            sample["outcomes"].update(
                toolCalls=0,
                toolRounds=None,
                inputTokens=1000 + index * 10,
                outputTokens=100 + index,
                cachedInputTokens=None,
                nonCachedInputTokens=None,
            )
        artifact, report = fit.build_artifact(fixture)
        self.assertEqual(artifact["scope"], "completed-session")
        self.assertEqual(artifact["tokenYieldBasis"], "workload")
        self.assertEqual(artifact["workloadMetric"], "totalTokens")
        self.assertEqual(artifact["cohortAudit"]["acceptedSamples"], 40)
        self.assertEqual(artifact["cohortAudit"]["acceptedZeroActionSamples"], 40)
        self.assertEqual(artifact["cohortAudit"]["rejectedSamples"], 0)
        self.assertEqual(report["scope"], "completed-session")
        self.assertIn("inactive observed session snapshot", report["validation"]["scope"])
        result = fit.quote(
            artifact["workload"],
            artifact["scenarios"],
            fixture["samples"][:1],
            artifact["tokenYieldBasis"],
        )[0]
        self.assertGreater(result["work"]["p50"], 0)
        self.assertEqual(result["totalTokens"], result["work"])
        self.assertGreater(result["outputTokens"]["p50"], 0)
        self.assertGreater(result["inputTokens"]["p50"], 0)
        self.assertGreater(result["totalTokens"]["p50"], result["inputTokens"]["p50"])
        self.assertIsNone(result["freshInputTokens"])
        self.assertIsNone(result["cachedInputTokens"])
        self.assertIn("totalTokens", artifact["validation"])

    def test_session_no_provider_commit_or_round_filters_and_full_audit(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        fixture["audit"] = {
            "discovery": {
                "roots": {"claude": 120, "codex": 38, "pi": 12},
                "children": 159,
                "rawRequest": "private text",
                "/private/path": 3,
            }
        }
        for sample in fixture["samples"]:
            sample["provider"] = "previously-unseen-provider"
            sample["outcomes"]["toolRounds"] = None
        fixture["samples"][0]["outcomes"]["toolCalls"] = 0
        fixture["samples"][0]["outcomes"]["outputTokens"] = 0
        fixture["samples"][1]["outcomes"]["inputTokens"] = None
        fixture["samples"][2]["outcomes"]["outputTokens"] = None
        fixture["samples"][3]["outcomes"]["toolCalls"] = None
        artifact, report = fit.build_artifact(fixture)
        audit = report["cohortAudit"]
        self.assertEqual(audit["acceptedSamples"], 38)
        self.assertEqual(audit["rejectedSamples"], 2)
        self.assertEqual(audit["acceptedZeroActionSamples"], 1)
        self.assertEqual(
            audit["rejectedByReason"],
            {"missingOrInvalidInputTokens": 1, "missingOrInvalidOutputTokens": 1},
        )
        self.assertEqual(audit["optionalAccountingMissing"]["toolCalls"], 1)
        self.assertEqual(
            audit["sourceSamples"], audit["acceptedSamples"] + audit["rejectedSamples"]
        )
        self.assertEqual(
            audit["acceptedSamples"],
            audit["trainingSamples"] + audit["heldoutSamples"] + audit["temporalPurgedSamples"],
        )
        self.assertEqual(
            audit["trainingSamples"], audit["oofSamples"] + audit["trainingSamplesWithoutOof"]
        )
        self.assertEqual(
            audit["discovery"], {"roots": {"claude": 120, "codex": 38, "pi": 12}, "children": 159}
        )

    def test_session_initial_features_predict_total_usage_without_tool_measurements(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        for index, sample in enumerate(fixture["samples"]):
            total = round(math.exp(5 + (index % 4) * 0.8))
            sample["outcomes"].update(
                inputTokens=total * 8,
                outputTokens=total * 2,
                toolCalls=None,
                toolRounds=None,
                nonCachedInputTokens=None,
                cachedInputTokens=None,
            )
        artifact, report = fit.build_artifact(fixture)
        self.assertEqual(artifact["cohortAudit"]["acceptedSamples"], 40)
        self.assertEqual(artifact["cohortAudit"]["rejectedSamples"], 0)
        self.assertEqual(artifact["cohortAudit"]["optionalAccountingMissing"]["toolCalls"], 40)
        self.assertEqual(artifact["training"]["sampleCount"], 32)
        self.assertEqual(artifact["validation"]["sampleCount"], 8)
        self.assertEqual(artifact["validation"]["workloadMetric"], "totalTokens")
        self.assertEqual(artifact["estimator"], "complexity")
        self.assertIn("log1p(totalTokens)", report["formula"])
        self.assertTrue(any(value > 0 for value in artifact["workload"]["coefficients"]))
        queries = [copy.deepcopy(fixture["samples"][0]) for _ in range(2)]
        queries[0]["features"] = dict.fromkeys(fit.FEATURES, 0)
        queries[1]["features"] = dict.fromkeys(fit.FEATURES, 3)
        quotes = fit.quote(artifact["workload"], artifact["scenarios"], queries, "workload")
        self.assertGreater(quotes[1]["totalTokens"]["p50"], quotes[0]["totalTokens"]["p50"])
        for row in artifact["scenarios"]:
            self.assertAlmostEqual(row["inputPerWork"], 0.8)
            self.assertAlmostEqual(row["outputPerWork"], 0.2)
            self.assertIsNone(row["roundsPerWork"])
        changed = copy.deepcopy(fixture)
        for sample in changed["samples"]:
            sample["outcomes"]["toolCalls"] = 100000
            sample["outcomes"]["toolRounds"] = 50000
        revised, _ = fit.build_artifact(changed)
        for name in ("workload", "workCutoffs"):
            self.assertEqual(artifact[name], revised[name])

    def test_session_zero_usage_preserved_and_fractions_safe(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        for sample in fixture["samples"]:
            sample["outcomes"].update(
                inputTokens=0,
                outputTokens=0,
                toolCalls=None,
                toolRounds=None,
                cachedInputTokens=None,
                nonCachedInputTokens=None,
            )
        artifact, _ = fit.build_artifact(fixture)
        self.assertEqual(artifact["cohortAudit"]["acceptedSamples"], 40)
        self.assertEqual(artifact["cohortAudit"]["acceptedZeroUsageSamples"], 40)
        self.assertEqual(artifact["workCutoffs"], {"trivialMax": 0, "deepMin": 0})
        for row in artifact["scenarios"]:
            self.assertEqual(row["inputPerWork"], 0)
            self.assertEqual(row["outputPerWork"], 0)
            self.assertTrue(row["zeroWork"])
            self.assertTrue(math.isfinite(row["logResidual"]))
        quotes = fit.quote(
            artifact["workload"], artifact["scenarios"], fixture["samples"][:1], "workload"
        )
        self.assertEqual(quotes[0]["totalTokens"], quotes[0]["work"])
        self.assertEqual(quotes[0]["outputTokens"]["p95"], 0)
        query = copy.deepcopy(fixture["samples"][0])
        query["features"] = dict.fromkeys(fit.FEATURES, 3)
        model = {**artifact["workload"], "intercept": 10}
        projected = fit.quote(model, artifact["scenarios"], [query], "workload")[0]
        self.assertEqual(projected["totalTokens"]["p95"], 0)
        self.assertEqual(
            artifact["cohortAudit"]["oofZeroUsageScenarios"], len(artifact["candidateScenarios"])
        )
        self.assertEqual(
            artifact["cohortAudit"]["activeZeroUsageScenarios"], len(artifact["scenarios"])
        )

    def test_session_scenario_and_quote_reconstruct_paired_measured_usage(self):
        sample = dataset()["samples"][0]
        sample["outcomes"].update(
            inputTokens=320,
            outputTokens=80,
            cachedInputTokens=None,
            nonCachedInputTokens=None,
            toolCalls=None,
            toolRounds=None,
        )
        row = fit.scenario(sample, 400, "workload")
        self.assertEqual(row["logResidual"], 0)
        self.assertEqual(row["inputPerWork"], 0.8)
        self.assertEqual(row["outputPerWork"], 0.2)
        self.assertNotIn("zeroWork", row)
        model = {
            "intercept": math.log1p(400),
            "coefficients": [0] * 4,
            "missingCoefficients": [0] * 4,
            "imputation": [0] * 4,
            "scale": [1] * 4,
        }
        quoted = fit.quote(model, [row], [sample], "workload")[0]
        for level in fit.QUANTILES:
            self.assertAlmostEqual(quoted["inputTokens"][level], 320)
            self.assertAlmostEqual(quoted["outputTokens"][level], 80)
            self.assertAlmostEqual(quoted["totalTokens"][level], 400)
            self.assertAlmostEqual(
                quoted["totalTokens"][level],
                quoted["inputTokens"][level] + quoted["outputTokens"][level],
            )

    def test_session_scenarios_never_price_more_than_observed_training_maximum(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        for index, sample in enumerate(fixture["samples"]):
            sample["outcomes"].update(
                toolCalls=0,
                toolRounds=None,
                inputTokens=1000 + index * 10,
                outputTokens=100 + index,
                cachedInputTokens=None,
                nonCachedInputTokens=None,
            )
        artifact, report = fit.build_artifact(fixture)
        totals = {
            s["sampleId"]: s["outcomes"]["inputTokens"] + s["outcomes"]["outputTokens"]
            for s in fixture["samples"]
        }
        training_max = max(totals[sample_id] for sample_id in artifact["training"]["sampleIds"])
        self.assertEqual(artifact["workloadCeiling"], training_max)
        self.assertEqual(report["workloadCeiling"], training_max)
        samples = fixture["samples"]
        quotes = fit.quote(
            artifact["workload"],
            artifact["scenarios"],
            samples,
            "workload",
            artifact["workloadCeiling"],
        )
        for row in quotes:
            for level in fit.QUANTILES:
                self.assertLessEqual(row["totalTokens"][level], training_max)
                self.assertLessEqual(row["work"][level], training_max)
                self.assertLessEqual(row["inputTokens"][level], training_max)

    def test_legacy_actions_artifacts_keep_no_usage_ceiling(self):
        artifact, report = fit.build_artifact(dataset())
        self.assertIsNone(artifact["workloadCeiling"])
        self.assertIsNone(report["workloadCeiling"])

    def test_session_holdout_usage_never_enters_fit_or_residuals(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        artifact, _ = fit.build_artifact(fixture)
        heldout = set(artifact["validation"]["sampleIds"])
        changed = copy.deepcopy(fixture)
        for sample in changed["samples"]:
            if sample["sampleId"] in heldout:
                sample["outcomes"]["inputTokens"] *= 1000
                sample["outcomes"]["outputTokens"] *= 1000
        revised, _ = fit.build_artifact(changed)
        for name in ("candidateWorkload", "candidateScenarios", "workCutoffs"):
            self.assertEqual(artifact[name], revised[name])
        self.assertEqual(artifact["training"]["sampleIds"], revised["training"]["sampleIds"])
        self.assertNotEqual(artifact["validation"]["work"], revised["validation"]["work"])

    def test_failed_session_candidate_serves_empirical_training_baseline(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        rows, _ = fit.validate_dataset(fixture)
        train, heldout, _ = fit.frozen_split(rows)
        totals = [s["outcomes"]["inputTokens"] + s["outcomes"]["outputTokens"] for s in train]
        baseline = fit.quantiles(totals)["p50"]
        holdout_ids = {s["sampleId"] for s in heldout}
        for sample in fixture["samples"]:
            if sample["sampleId"] in holdout_ids:
                sample["features"] = dict.fromkeys(fit.FEATURES, 3)
                sample["outcomes"].update(inputTokens=baseline * 0.8, outputTokens=baseline * 0.2)
        artifact, report = fit.build_artifact(fixture)
        self.assertEqual(artifact["estimator"], "historical-baseline")
        self.assertEqual(artifact["workload"]["coefficients"], [0] * 4)
        self.assertEqual(artifact["workload"]["missingCoefficients"], [0] * 4)
        self.assertAlmostEqual(artifact["workload"]["intercept"], math.log1p(baseline))
        self.assertTrue(any(value > 0 for value in artifact["candidateWorkload"]["coefficients"]))
        self.assertTrue(artifact["validation"]["candidateHasLearnedComplexitySignal"])
        self.assertFalse(artifact["validation"]["hasLearnedComplexitySignal"])
        self.assertEqual(artifact["validation"]["work"], artifact["candidateValidation"]["work"])
        self.assertEqual(artifact["training"]["scenarioCount"], 32)
        self.assertEqual(artifact["training"]["oofSampleCount"], 28)
        self.assertEqual(artifact["training"]["calibration"], "empirical-training-distribution")
        self.assertEqual(
            {row["sampleId"] for row in artifact["scenarios"]},
            set(artifact["training"]["sampleIds"]),
        )
        self.assertEqual(len(artifact["candidateScenarios"]), 28)
        self.assertAlmostEqual(
            artifact["validation"]["activeWork"]["mae"],
            artifact["validation"]["baselineWork"]["mae"],
        )
        self.assertEqual(
            artifact["validation"]["activeWork"], artifact["validation"]["activeTotalTokens"]
        )
        self.assertEqual(
            set(artifact["validation"]["activeCoverage"]), {"work", "output", "input", "total"}
        )
        self.assertEqual(report["workload"], artifact["workload"])
        self.assertEqual(report["candidateWorkload"], artifact["candidateWorkload"])
        self.assertNotIn("sampleIds", report["candidateValidation"])
        self.assertNotIn("candidateScenarios", report)
        self.assertEqual(
            report["selectionReason"],
            "Candidate total-token log error (RMSLE) did not beat the training-median baseline on held-out sessions.",
        )
        queries = [copy.deepcopy(fixture["samples"][0]) for _ in range(2)]
        queries[0]["features"] = dict.fromkeys(fit.FEATURES, 0)
        queries[1]["features"] = dict.fromkeys(fit.FEATURES, 3)
        quotes = fit.quote(artifact["workload"], artifact["scenarios"], queries, "workload")
        self.assertEqual(quotes[0], quotes[1])
        for level, value in fit.quantiles(totals).items():
            self.assertAlmostEqual(quotes[0]["totalTokens"][level], value)

    def test_session_gate_changes_serving_choice_without_refitting_candidate(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        first, _ = fit.build_artifact(fixture)
        self.assertEqual(first["estimator"], "complexity")
        rows, _ = fit.validate_dataset(fixture)
        train, heldout, _ = fit.frozen_split(rows)
        baseline = fit.quantiles([fit.observed_work(s, "totalTokens") for s in train])["p50"]
        holdout_ids = {s["sampleId"] for s in heldout}
        for sample in fixture["samples"]:
            if sample["sampleId"] in holdout_ids:
                sample["features"] = dict.fromkeys(fit.FEATURES, 3)
                sample["outcomes"].update(inputTokens=baseline, outputTokens=0)
        second, _ = fit.build_artifact(fixture)
        self.assertEqual(second["estimator"], "historical-baseline")
        self.assertEqual(first["candidateWorkload"], second["candidateWorkload"])
        self.assertEqual(first["candidateScenarios"], second["candidateScenarios"])
        self.assertEqual(
            first["candidateValidation"]["selection"], second["candidateValidation"]["selection"]
        )
        self.assertEqual(first["training"]["sampleIds"], second["training"]["sampleIds"])
        self.assertNotEqual(first["workload"], second["workload"])

    def test_request_shape_features_are_fitted_when_present_and_selected_by_log_error(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        for index, sample in enumerate(fixture["samples"]):
            level = index % 4
            # Shape is always known; model-extracted metrics are mostly unknown.
            sample["features"] = {
                **dict.fromkeys(fit.LEGACY_FEATURES),
                **dict.fromkeys(fit.SHAPE_FEATURES, level),
            }
            tokens = 5000 * 4**level
            sample["outcomes"].update(inputTokens=tokens * 0.9, outputTokens=tokens * 0.1)
        # One enormous session must not decide estimator selection through raw-token MAE.
        fixture["samples"][-1]["outcomes"].update(inputTokens=9e9, outputTokens=1e9)
        artifact, report = fit.build_artifact(fixture)
        # Model-extracted metrics are mostly unknown and vary by model, so pricing uses shape alone.
        self.assertEqual(artifact["featureNames"], fit.SHAPE_FEATURES)
        self.assertEqual(len(artifact["workload"]["coefficients"]), 4)
        self.assertEqual(len(artifact["workload"]["featureRanges"]), 4)
        self.assertTrue(any(weight > 0 for weight in artifact["workload"]["coefficients"]))
        self.assertEqual(artifact["estimator"], "complexity")
        self.assertLess(
            artifact["validation"]["work"]["rmsle"], artifact["validation"]["baselineWork"]["rmsle"]
        )
        fit.use_features({"samples": []})
        self.assertEqual(fit.FEATURES, fit.LEGACY_FEATURES)

    def test_nonfinite_candidate_metric_selects_json_safe_baseline(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        original = fit.errors
        calls = 0

        def metrics(actual, predicted):
            nonlocal calls
            calls += 1
            result = original(actual, predicted)
            return {**result, "mae": float("nan"), "rmsle": float("nan")} if calls == 1 else result

        with mock.patch.object(fit, "errors", side_effect=metrics):
            artifact, report = fit.build_artifact(fixture)
        self.assertEqual(artifact["estimator"], "historical-baseline")
        self.assertTrue(artifact["validation"]["candidateMetricsNonfinite"])
        self.assertIsNone(artifact["candidateValidation"]["work"]["mae"])
        self.assertIsNone(artifact["validation"]["work"]["mae"])
        self.assertTrue(math.isfinite(artifact["validation"]["activeWork"]["mae"]))
        json.dumps(artifact, allow_nan=False)
        json.dumps(report, allow_nan=False)

    def test_legacy_scope_mapping_and_yield_numerics(self):
        fixture = dataset()
        original, _ = fit.build_artifact(fixture)
        fixture["scope"] = "successful-direct-logged-delivery-run"
        mapped, _ = fit.build_artifact(fixture)
        self.assertEqual(original, mapped)
        self.assertEqual(mapped["scope"], "completed-delivery-run")
        self.assertEqual(mapped["tokenYieldBasis"], "actions")
        sample = fixture["samples"][0]
        sample["outcomes"].update(toolCalls=2, outputTokens=20, inputTokens=60)
        self.assertEqual(fit.scenario(sample, 2)["outputPerWork"], 10)
        session_scenario = fit.scenario(sample, 2, "actions-plus-one")
        self.assertAlmostEqual(session_scenario["outputPerWork"], 20 / 3)
        self.assertEqual(session_scenario["inputPerWork"], 20)
        with self.assertRaisesRegex(ValueError, "Unsupported dataset scope"):
            fit.build_artifact({**fixture, "scope": "unknown"})

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
        self.assertEqual(
            [s["outputPerWork"] for s in first["scenarios"]],
            [s["outputPerWork"] for s in second["scenarios"]],
        )

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
        self.assertNotEqual(
            first["scenarios"][0]["outputPerWork"], second["scenarios"][0]["outputPerWork"]
        )

    def test_no_group_or_time_leakage(self):
        rows, _ = fit.validate_dataset(dataset())
        older, heldout, purged = fit.frozen_split(rows)
        self.assertFalse(set(s["groupId"] for s in older) & set(s["groupId"] for s in heldout))
        self.assertLess(max(s["_time"] for s in older), min(s["_start"] for s in heldout))
        for train, validation in fit.folds(older):
            self.assertFalse(
                set(s["groupId"] for s in train) & set(s["groupId"] for s in validation)
            )
            self.assertLess(max(s["_time"] for s in train), min(s["_start"] for s in validation))
        artifact, _ = fit.build_artifact(dataset())
        self.assertTrue(
            set(s["sampleId"] for s in artifact["scenarios"])
            <= set(artifact["training"]["sampleIds"])
        )
        self.assertFalse(
            set(s["sampleId"] for s in artifact["scenarios"])
            & set(artifact["validation"]["sampleIds"])
        )

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
            self.assertLess(
                max(s["_time"] for s in train_fold), min(s["_start"] for s in target_fold)
            )

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
        nested = {
            "candidateValidation": {
                "sampleIds": ["private-a"],
                "nested": [{"sourceId": "private-b", "count": 2}],
            },
            "candidateScenarios": [{"sampleId": "private-c"}],
            "training": {"groupIds": ["private-d"], "sampleCount": 3},
        }
        self.assertEqual(
            fit.public_metadata(nested),
            {"candidateValidation": {"nested": [{"count": 2}]}, "training": {"sampleCount": 3}},
        )

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

    def test_quantile_trees_price_sessions_and_stay_monotone(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        for index, sample in enumerate(fixture["samples"]):
            sample["text"] = text_features(index)
        with mock.patch.object(fit, "TREE_PARAMS", {**fit.TREE_PARAMS, "max_iter": 12}):
            artifact, report = fit.build_artifact(fixture)
        model = artifact["quantileModel"]
        self.assertEqual(model["method"], "boosted-trees-quantile-v1")
        self.assertEqual(list(model["trees"]), ["p50", "p75", "p80", "p95", "p99"])
        self.assertGreater(model["nodeCount"], 0)
        self.assertEqual(model["features"], fit.QUANTILE_FEATURES)
        self.assertEqual(artifact["validation"]["quantileModel"]["nodeCount"], model["nodeCount"])
        self.assertIn("coverage", report["quantileModel"]["quantiles"]["p95"])
        # Every tree must be walkable: leaves are -1 and child indices stay in range.
        trees = [tree for head in model["trees"].values() for tree in head]
        for tree in trees[:40]:
            self.assertEqual(len(tree["f"]), len(tree["l"]))
            for left, right in zip(tree["l"], tree["r"], strict=True):
                self.assertTrue(-1 <= left < len(tree["f"]))
                self.assertTrue(-1 <= right < len(tree["f"]))
                self.assertEqual(left == -1, right == -1)
        train_ids = set(artifact["training"]["sampleIds"])
        expected_ceiling = max(
            sample["outcomes"]["inputTokens"] + sample["outcomes"]["outputTokens"]
            for sample in fixture["samples"]
            if sample["sampleId"] in train_ids
        )
        self.assertEqual(model["ceiling"], expected_ceiling)

    def test_artifacts_without_text_features_keep_no_quantile_model(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        artifact, report = fit.build_artifact(fixture)
        self.assertIsNone(artifact["quantileModel"])
        self.assertIsNone(report["quantileModel"])

    def quantile_fixture(self):
        fixture = dataset()
        fixture["scope"] = "completed-session"
        for index, sample in enumerate(fixture["samples"]):
            sample["text"] = text_features(index)
        with mock.patch.object(fit, "TREE_PARAMS", {**fit.TREE_PARAMS, "max_iter": 12}):
            artifact, _ = fit.build_artifact(fixture)
        return fixture, artifact

    def champion_result(self, fixture, champion):
        """Write a champion artifact to disk and rebuild the challenger against it."""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "champion.json"
            if champion is not None:
                path.write_text(json.dumps(champion))
            with mock.patch.object(fit, "TREE_PARAMS", {**fit.TREE_PARAMS, "max_iter": 12}):
                artifact, report = fit.build_artifact(fixture, champion_path=str(path))
        return artifact, report

    def test_challenger_quantile_validation_reports_mean_pinball(self):
        _, artifact = self.quantile_fixture()
        validation = artifact["validation"]["quantileModel"]
        pinballs = [entry["pinball"] for entry in validation["quantiles"].values()]
        self.assertAlmostEqual(validation["meanPinball"], sum(pinballs) / 5, delta=1e-12)
        self.assertNotIn("champion", validation)

    def test_champion_equal_to_challenger_scores_identical_metrics(self):
        fixture, first = self.quantile_fixture()
        artifact, report = self.champion_result(fixture, first)
        challenger = artifact["validation"]["quantileModel"]
        champion = challenger["champion"]
        self.assertEqual(
            list(champion),
            ["scoreable", "reason", "sampleCount", "quantiles", "meanPinball", "pairedDelta"],
        )
        self.assertTrue(champion["scoreable"])
        self.assertIsNone(champion["reason"])
        self.assertEqual(champion["sampleCount"], challenger["sampleCount"])
        for name, expected in challenger["quantiles"].items():
            self.assertAlmostEqual(
                champion["quantiles"][name]["pinball"], expected["pinball"], delta=1e-9
            )
            self.assertAlmostEqual(
                champion["quantiles"][name]["coverage"], expected["coverage"], delta=1e-9
            )
        self.assertAlmostEqual(champion["meanPinball"], challenger["meanPinball"], delta=1e-9)
        self.assertEqual(report["quantileModel"]["champion"], champion)
        self.assertEqual(report["validation"]["quantileModel"]["champion"], champion)

    def test_champion_with_other_features_is_unscoreable(self):
        fixture, first = self.quantile_fixture()
        first["quantileModel"]["features"] = first["quantileModel"]["features"][:-1]
        artifact, _ = self.champion_result(fixture, first)
        self.assertEqual(
            artifact["validation"]["quantileModel"]["champion"],
            {
                "scoreable": False,
                "reason": "champion features differ from QUANTILE_FEATURES",
                "sampleCount": 0,
                "quantiles": {},
                "meanPinball": None,
            },
        )

    def test_missing_or_unusable_champion_is_unscoreable(self):
        fixture, first = self.quantile_fixture()
        without_model = {**first, "quantileModel": None}
        for champion in (None, without_model):
            artifact, _ = self.champion_result(fixture, champion)
            result = artifact["validation"]["quantileModel"]["champion"]
            self.assertFalse(result["scoreable"])
            self.assertTrue(result["reason"])
            self.assertEqual(result["sampleCount"], 0)
            self.assertEqual(result["quantiles"], {})
            self.assertIsNone(result["meanPinball"])

    def test_champion_skips_rows_it_trained_on(self):
        fixture, first = self.quantile_fixture()
        heldout_ids = first["validation"]["sampleIds"]
        first["training"]["sampleIds"] = [*first["training"]["sampleIds"], *heldout_ids[:3]]
        artifact, _ = self.champion_result(fixture, first)
        champion = artifact["validation"]["quantileModel"]["champion"]
        self.assertEqual(champion["sampleCount"], len(heldout_ids) - 3)
        del first["training"]["sampleIds"]
        artifact, _ = self.champion_result(fixture, first)
        champion = artifact["validation"]["quantileModel"]["champion"]
        self.assertEqual(champion["sampleCount"], len(heldout_ids))
        self.assertEqual(champion["reason"], "no training ids")

    def test_champion_offsets_shift_coverage(self):
        fixture, first = self.quantile_fixture()
        base, _ = self.champion_result(fixture, first)
        shifted = copy.deepcopy(first)
        shifted["quantileModel"]["offsets"] = {name: 50.0 for name in fit.QUANTILE_LEVELS}
        shifted["quantileModel"]["ceiling"] = None
        raised, _ = self.champion_result(fixture, shifted)
        before = base["validation"]["quantileModel"]["champion"]["quantiles"]["p50"]
        after = raised["validation"]["quantileModel"]["champion"]["quantiles"]["p50"]
        self.assertEqual(after["coverage"], 1.0)
        self.assertGreater(after["coverage"], before["coverage"])
        capped = copy.deepcopy(shifted)
        capped["quantileModel"]["ceiling"] = 10.0
        limited, _ = self.champion_result(fixture, capped)
        clipped = limited["validation"]["quantileModel"]["champion"]["quantiles"]["p50"]
        self.assertLess(clipped["coverage"], 1.0)

    def test_tree_params_are_the_stable_shallow_set(self):
        expected = {
            "max_depth": 2,
            "min_samples_leaf": 80,
            "l2_regularization": 10.0,
            "learning_rate": 0.03,
            "max_iter": 100,
        }
        for name, value in expected.items():
            self.assertEqual(fit.TREE_PARAMS[name], value, name)
        self.assertEqual(os.environ.get("OMP_NUM_THREADS"), "1")

    def test_paired_delta_sign_bounds_and_determinism(self):
        fixture, first = self.quantile_fixture()
        worse = copy.deepcopy(first)
        worse["quantileModel"]["baseline"] = {
            name: value + 3.0 for name, value in first["quantileModel"]["baseline"].items()
        }
        worse["quantileModel"]["ceiling"] = None
        artifact, _ = self.champion_result(fixture, worse)
        delta = artifact["validation"]["quantileModel"]["champion"]["pairedDelta"]
        self.assertEqual(list(delta), ["mean", "lower90", "upper90", "resamples"])
        self.assertEqual(delta["resamples"], 2000)
        # Challenger beats a champion shifted far off target, so the whole interval is below zero.
        self.assertLess(delta["mean"], 0)
        self.assertLessEqual(delta["lower90"], delta["mean"])
        self.assertLessEqual(delta["mean"], delta["upper90"])
        self.assertLess(delta["upper90"], 0)
        again, _ = self.champion_result(fixture, worse)
        self.assertEqual(again["validation"]["quantileModel"]["champion"]["pairedDelta"], delta)

    def test_paired_delta_of_identical_models_is_zero(self):
        fixture, first = self.quantile_fixture()
        artifact, _ = self.champion_result(fixture, first)
        delta = artifact["validation"]["quantileModel"]["champion"]["pairedDelta"]
        for name in ("mean", "lower90", "upper90"):
            self.assertAlmostEqual(delta[name], 0.0, delta=1e-9)

    def test_paired_bootstrap_interval_orders_around_the_mean(self):
        rows = fit.np.array([0.1, 0.3, -0.2, 0.4, 0.0, 0.2, 0.1, 0.5])
        result = fit.paired_bootstrap(rows)
        self.assertAlmostEqual(result["mean"], float(rows.mean()), delta=1e-12)
        self.assertLess(result["lower90"], result["upper90"])
        self.assertEqual(result, fit.paired_bootstrap(rows))

    def test_stability_probe_is_reported(self):
        _, artifact = self.quantile_fixture()
        validation = artifact["validation"]["quantileModel"]
        stability = validation["stability"]
        self.assertEqual(stability["droppedNewest"], 14)
        self.assertTrue(math.isfinite(stability["meanPinball"]))
        self.assertAlmostEqual(
            stability["gap"], abs(stability["meanPinball"] - validation["meanPinball"]), delta=1e-12
        )

    def test_dropped_quantile_trees_leave_no_quantile_validation_even_with_champion(self):
        fixture, first = self.quantile_fixture()
        for sample in fixture["samples"]:
            del sample["text"]
        artifact, _ = self.champion_result(fixture, first)
        self.assertIsNone(artifact["quantileModel"])
        self.assertNotIn("quantileModel", artifact["validation"])


if __name__ == "__main__":
    unittest.main()
