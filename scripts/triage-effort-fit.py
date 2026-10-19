#!/usr/bin/env python3
"""Fit a private, chronological complexity -> work -> token budget model.

Requests and credentials are never copied to artifacts. The CLI does not read
production logs; it accepts the audited, prework-feature dataset explicitly.
"""
import argparse
from collections import Counter
from datetime import datetime
import json
import math
import os
from pathlib import Path

import numpy as np
import scipy
import sklearn
from scipy.optimize import lsq_linear
from sklearn.metrics import mean_absolute_error, mean_squared_log_error

FEATURES = ["breadth", "complexity", "uncertainty", "risk"]
ALPHAS = [0.01, 0.1, 1.0, 10.0, 100.0]
QUANTILES = {"p50": 0.5, "p80": 0.8, "p95": 0.95}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value, field="completedAt"):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO timestamp")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError("timestamp needs timezone")
        return dt.timestamp()
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"{field} must be an ISO timestamp with timezone") from exc


def validate_dataset(dataset):
    if not isinstance(dataset, dict) or dataset.get("schemaVersion") != 1 or not isinstance(dataset.get("samples"), list):
        raise ValueError("Expected schemaVersion=1 and samples array")
    accepted, rejected, ids = [], Counter(), set()
    for sample in dataset["samples"]:
        if not isinstance(sample, dict):
            raise ValueError("Sample must be an object")
        for name in ("sampleId", "groupId"):
            if not isinstance(sample.get(name), str) or not sample[name] or len(sample[name]) > 300:
                raise ValueError(f"Invalid {name}")
        if sample["sampleId"] in ids:
            raise ValueError("Duplicate sampleId")
        ids.add(sample["sampleId"])
        stamp = timestamp(sample.get("completedAt"))
        started = timestamp(sample.get("startedAt"), "startedAt")
        if started > stamp:
            raise ValueError("startedAt must not follow completedAt")
        features, outcomes = sample.get("features"), sample.get("outcomes")
        if not isinstance(features, dict) or any(name not in features for name in FEATURES):
            raise ValueError("Missing prework feature")
        for name in FEATURES:
            value = features[name]
            if value is not None and (not finite(value) or value not in (0, 1, 2, 3)):
                raise ValueError(f"Feature {name} must be 0..3 or null")
        if not isinstance(outcomes, dict):
            raise ValueError("Missing outcomes object")
        for name, value in outcomes.items():
            if value is not None and (not finite(value) or value < 0):
                raise ValueError(f"Invalid outcome {name}")
        # Zero/missing activity does not mean a zero-effort task. It cannot
        # support a token-per-action yield or observed work target.
        if not finite(outcomes.get("toolCalls")) or outcomes["toolCalls"] <= 0:
            rejected["missingOrZeroToolCalls"] += 1
            continue
        if not finite(outcomes.get("outputTokens")) or outcomes["outputTokens"] <= 0:
            rejected["missingOrZeroOutputTokens"] += 1
            continue
        if not finite(outcomes.get("toolRounds")) or outcomes["toolRounds"] <= 0:
            rejected["missingOrZeroToolRounds"] += 1
            continue
        if outcomes["toolRounds"] > outcomes["toolCalls"]:
            rejected["roundsExceedCalls"] += 1
            continue
        accepted.append({**sample, "_time": stamp, "_start": started})
    if len(accepted) < 6:
        raise ValueError("Need at least six valid measured runs")
    return accepted, dict(rejected)


def groups(samples):
    result = {}
    for sample in samples:
        result.setdefault(sample["groupId"], []).append(sample)
    return sorted(result.values(), key=lambda group: (min(s["_start"] for s in group), group[0]["groupId"]))


def frozen_split(samples):
    grouped = groups(samples)
    if len(grouped) < 4:
        raise ValueError("Need at least four independent completed thread groups")
    holdout_count = max(1, math.ceil(len(grouped) * 0.2))
    holdout = [s for group in grouped[-holdout_count:] for s in group]
    boundary = min(s["_start"] for s in holdout)
    older, purged = [], []
    for group in grouped[:-holdout_count]:
        (older if max(s["_time"] for s in group) < boundary else purged).extend(group)
    if len(groups(older)) < 3:
        raise ValueError("Insufficient older groups after strict temporal-overlap purge")
    return older, holdout, purged


def design(samples, imputation=None, scale=None):
    matrix = np.array([[np.nan if s["features"][f] is None else s["features"][f] for f in FEATURES] for s in samples], dtype=float)
    missing = np.isnan(matrix)
    if imputation is None:
        imputation = np.array([float(np.median(matrix[~missing[:, j], j])) if (~missing[:, j]).any() else 1.5 for j in range(4)])
    filled = np.where(missing, imputation, matrix)
    if scale is None:
        scale = np.maximum(np.std(filled, axis=0), 1.0)
    return np.column_stack([np.ones(len(samples)), filled / scale, missing.astype(float)]), np.asarray(imputation), np.asarray(scale)


def fit_model(samples, alpha):
    matrix, imputation, scale = design(samples)
    target = np.log1p([s["outcomes"]["toolCalls"] for s in samples])
    # Intercept is not penalized. Only true complexity coefficients must be
    # nonnegative. Missingness is a separate signed data-quality indicator.
    penalty = np.diag([0.0] + [math.sqrt(alpha)] * 8)
    result = lsq_linear(np.vstack([matrix, penalty]), np.concatenate([target, np.zeros(9)]),
                        bounds=([-np.inf] + [0.0] * 4 + [-np.inf] * 4, [np.inf] * 9), tol=1e-11, max_iter=2000)
    if not result.success:
        raise ValueError("Nonnegative ridge fit failed")
    return {"intercept": float(result.x[0]), "coefficients": result.x[1:5].tolist(),
            "missingCoefficients": result.x[5:].tolist(), "imputation": imputation.tolist(), "scale": scale.tolist()}


def predict_work(model, samples):
    matrix, _, _ = design(samples, model["imputation"], model["scale"])
    weights = [model["intercept"], *model["coefficients"], *model["missingCoefficients"]]
    return np.maximum(0, np.expm1(np.clip(matrix @ weights, -50, 30)))


def folds(samples):
    ordered = groups(samples)
    # At least two independent groups precede each validation group. Groups
    # with overlapping completion windows are purged from that fold.
    for index in range(2, len(ordered)):
        validation = ordered[index]
        boundary = min(s["_start"] for s in validation)
        train = [s for group in ordered[:index] if max(r["_time"] for r in group) < boundary for s in group]
        if len(groups(train)) >= 2:
            yield train, validation


def quantiles(values):
    return {name: float(np.quantile(values, q)) for name, q in QUANTILES.items()}


def scenario(sample, prediction):
    observed = sample["outcomes"]
    work = observed["toolCalls"]
    fresh = observed.get("nonCachedInputTokens")
    # Never infer fresh input by subtracting a cache counter: provider
    # accounting conventions differ and counters may overlap.
    return {"sampleId": sample["sampleId"], "logResidual": float(np.log1p(work) - np.log1p(prediction)),
            "outputPerWork": observed["outputTokens"] / work,
            "freshInputPerWork": fresh / work if finite(fresh) else None,
            "cachedInputPerWork": observed.get("cachedInputTokens") / work if finite(observed.get("cachedInputTokens")) else None,
            "roundsPerWork": observed["toolRounds"] / work}


def quote(model, scenarios, samples):
    result = []
    for work in predict_work(model, samples):
        row = {}
        adjusted = [max(0, math.expm1(min(30, math.log1p(float(work)) + s["logResidual"]))) for s in scenarios]
        row["work"] = quantiles(adjusted)
        for channel, field in [("outputTokens", "outputPerWork"), ("freshInputTokens", "freshInputPerWork"), ("cachedInputTokens", "cachedInputPerWork")]:
            values = [w * s[field] for w, s in zip(adjusted, scenarios) if s[field] is not None]
            row[channel] = quantiles(values) if len(values) == len(scenarios) else None
        row["riskPremiumOutputTokens"] = row["outputTokens"]["p80"] - row["outputTokens"]["p50"]
        result.append(row)
    return result


def errors(actual, predicted):
    return {"mae": float(mean_absolute_error(actual, predicted)),
            "rmsle": float(math.sqrt(mean_squared_log_error(actual, predicted)))}


def build_artifact(dataset):
    samples, rejected = validate_dataset(dataset)
    train, heldout, purged = frozen_split(samples)
    cv = list(folds(train))
    if not cv:
        raise ValueError("No strict older-group folds available for residual calibration")
    scores, residuals_by_alpha = [], {}
    for alpha in ALPHAS:
        residuals = []
        for older, validation in cv:
            prediction = predict_work(fit_model(older, alpha), validation)
            residuals.extend((s, float(p)) for s, p in zip(validation, prediction))
        mse = float(np.mean([(math.log1p(s["outcomes"]["toolCalls"]) - math.log1p(p)) ** 2 for s, p in residuals]))
        scores.append({"alpha": alpha, "oofLogMse": mse})
        residuals_by_alpha[alpha] = residuals
    alpha = min(scores, key=lambda score: (score["oofLogMse"], -score["alpha"]))["alpha"]
    model = fit_model(train, alpha)
    scenarios = [scenario(s, p) for s, p in residuals_by_alpha[alpha]]
    model["residualQuantiles"] = quantiles([s["logResidual"] for s in scenarios])
    model["featureRanges"] = []
    for name in FEATURES:
        values = [s["features"][name] for s in train if s["features"][name] is not None]
        model["featureRanges"].append({"min": min(values) if values else None, "max": max(values) if values else None,
                                       "known": len(values), "missing": len(train) - len(values)})
    work = [s["outcomes"]["toolCalls"] for s in train]
    observed = [s["outcomes"]["toolCalls"] for s in heldout]
    output = [s["outcomes"]["outputTokens"] for s in heldout]
    quotes = quote(model, scenarios, heldout)
    predicted = [q["work"]["p50"] for q in quotes]
    predicted_output = [q["outputTokens"]["p50"] for q in quotes]
    baseline_work = float(np.median(work))
    baseline_output = float(np.median([s["outcomes"]["outputTokens"] for s in train]))
    model_error = errors(observed, predicted)
    baseline_error = errors(observed, [baseline_work] * len(heldout))
    coverage = {name: float(np.mean([s["outcomes"]["toolCalls"] <= q["work"][name] for s, q in zip(heldout, quotes)])) for name in QUANTILES}
    output_coverage = {name: float(np.mean([s["outcomes"]["outputTokens"] <= q["outputTokens"][name] for s, q in zip(heldout, quotes)])) for name in QUANTILES}
    improves = model_error["mae"] < baseline_error["mae"]
    has_signal = any(weight > 1e-8 for weight in model["coefficients"])
    # A tiny holdout can falsify a candidate but cannot establish accuracy.
    enough = len(groups(heldout)) >= 10 and len(scenarios) >= 30
    covered = all(channel["p80"] >= 0.8 and channel["p95"] >= 0.95 for channel in (coverage, output_coverage))
    status = "validated" if enough and improves and has_signal and covered else "experimental"
    training = {"sampleIds": [s["sampleId"] for s in train], "sampleCount": len(train), "groupCount": len(groups(train)),
                "asOf": max(s["completedAt"] for s in train), "alpha": alpha,
                "featureVersion": dataset.get("featureVersion", "unspecified"),
                "fittingLibraries": {"numpy": np.__version__, "scipy": scipy.__version__, "scikit-learn": sklearn.__version__},
                "oofSampleCount": len(scenarios), "oofGroupCount": len({s["groupId"] for s, _ in residuals_by_alpha[alpha]}),
                "providers": dict(Counter(str(s.get("provider", "unknown")) for s in train))}
    validation = {"status": status, "scope": "one measured root-agent run; not whole issues or human hours",
                  "sampleCount": len(heldout), "groupCount": len(groups(heldout)),
                  "sampleIds": [s["sampleId"] for s in heldout], "purgedSampleCount": len(purged),
                  "splitPolicy": "newest 20% thread groups by earliest run start; every training group completed before earliest target start",
                  "work": model_error, "baselineWork": baseline_error,
                  "outputTokens": errors(output, predicted_output), "baselineOutputTokens": errors(output, [baseline_output] * len(heldout)),
                  "workCoverage": coverage, "beatsWorkBaseline": improves,
                  "outputCoverage": output_coverage,
                  "hasLearnedComplexitySignal": has_signal,
                  "providers": dict(Counter(str(s.get("provider", "unknown")) for s in heldout)),
                  "limitations": ["Observational root-run outcomes omit unlogged child-agent work and human time.",
                                  "Prework feature extraction uncertainty is not identified by this sample.",
                                  "Empirical OOF intervals are not coverage guarantees or risk-neutral prices.",
                                  "Alpha selection and residual calibration share older-group folds; newest groups remain untouched.",
                                  "Token yields reflect historical provider, tool, and context policy mixtures."],
                  "selection": scores, "rejected": rejected}
    artifact = {"schemaVersion": 1, "method": "nonnegative-ridge-log-work-v1", "workUnit": "observed_logged_tool_calls",
                "featureNames": FEATURES, "workload": model, "scenarios": scenarios,
                "workCutoffs": {"trivialMax": float(np.quantile(work, 1/3)), "deepMin": float(np.quantile(work, 2/3))},
                "training": training, "validation": validation}
    # Safe aggregate report deliberately omits sample IDs and raw features.
    report = {"schemaVersion": 1, "method": artifact["method"], "workUnit": artifact["workUnit"],
              "formula": "log1p(work)=intercept+sum(nonnegative_weight*feature/scale)+sum(missing_weight*is_missing)",
              "featureNames": FEATURES, "workload": model, "workCutoffs": artifact["workCutoffs"],
              "training": {k: v for k, v in training.items() if k != "sampleIds"},
              "validation": {k: v for k, v in validation.items() if k != "sampleIds"}}
    return artifact, report


def private_write(path, value):
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    with open(args.dataset) as handle:
        dataset = json.load(handle)
    artifact, report = build_artifact(dataset)
    private_write(args.output, artifact)
    private_write(args.report, report)
    print(json.dumps({"status": artifact["validation"]["status"], "trainingSamples": artifact["training"]["sampleCount"],
                      "heldoutSamples": artifact["validation"]["sampleCount"], "oofSamples": len(artifact["scenarios"])}))


if __name__ == "__main__":
    main()
