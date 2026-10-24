#!/usr/bin/env python3
"""Fit initial-request complexity to chronological observed session usage.

Requests and credentials are never copied to artifacts. The CLI does not read
production logs; it accepts the audited, prework-feature dataset explicitly.
Legacy delivery-run datasets retain their tool-call target and token yields.
"""

import argparse
import copy
import json
import math
import os
from collections import Counter
from datetime import datetime
from pathlib import Path

import numpy as np
import scipy
import sklearn
from scipy.optimize import lsq_linear
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_log_error

LEGACY_FEATURES = ["breadth", "complexity", "uncertainty", "risk"]
SHAPE_FEATURES = ["requestSize", "requestLines", "requestReferences", "requestActions"]
# Datasets that carry the deterministic request-shape buckets price with those four alone. The
# model-extracted metrics are unknown for most sessions and, when known, vary between models, so
# they would make the same request price differently from run to run.
FEATURES = list(LEGACY_FEATURES)


def use_features(dataset):
    """Pick the feature set once per dataset; datasets without request shape keep the original four."""
    global FEATURES
    samples = dataset.get("samples") if isinstance(dataset, dict) else None
    shaped = (
        isinstance(samples, list)
        and samples
        and all(
            isinstance(s, dict)
            and isinstance(s.get("features"), dict)
            and all(name in s["features"] for name in SHAPE_FEATURES)
            for s in samples
        )
    )
    FEATURES = list(SHAPE_FEATURES) if shaped else list(LEGACY_FEATURES)


ALPHAS = [0.01, 0.1, 1.0, 10.0, 100.0]
QUANTILES = {"p50": 0.5, "p80": 0.8, "p95": 0.95}
# Quantile tree heads price the whole session directly; independent heads are rearranged
# into a monotone set so a higher quantile never falls below a lower one.
QUANTILE_LEVELS = {"p50": 0.5, "p75": 0.75, "p80": 0.8, "p95": 0.95, "p99": 0.99}
QUANTILE_FEATURES = [
    "size",
    "lines",
    "refs",
    "verbs",
    "logChars",
    "logLines",
    "logRefs",
    "logVerbs",
    "fence",
    "logPaths",
    "tests",
    "checklist",
    "bullets",
    "questions",
    "versions",
]
TREE_PARAMS = {
    "max_depth": 3,
    "max_iter": 100,
    "learning_rate": 0.05,
    "min_samples_leaf": 20,
    "l2_regularization": 1.0,
    "random_state": 0,
}


def dataset_scope(dataset):
    scope = dataset.get("scope", "completed-delivery-run")
    if scope == "successful-direct-logged-delivery-run":
        scope = "completed-delivery-run"
    if scope not in ("completed-session", "completed-delivery-run"):
        raise ValueError("Unsupported dataset scope")
    return scope


def count_tree(value):
    """Carry aggregate source counts without copying paths, IDs, or text."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for name, child in value.items():
        if (
            not isinstance(name, str)
            or not name.replace("_", "").replace("-", "").isalnum()
            or len(name) > 80
        ):
            continue
        if isinstance(child, dict):
            nested = count_tree(child)
            if nested:
                result[name] = nested
        elif finite(child) and child >= 0 and child == int(child):
            result[name] = int(child)
    return result


def public_metadata(value):
    """Remove record identities and scenario rows at every report depth."""
    if isinstance(value, dict):
        private_keys = {
            "sampleId",
            "sampleIds",
            "groupId",
            "groupIds",
            "sourceId",
            "sourceIds",
            "scenarios",
            "candidateScenarios",
        }
        return {
            key: public_metadata(child) for key, child in value.items() if key not in private_keys
        }
    if isinstance(value, list):
        return [public_metadata(child) for child in value]
    return value


def finite_metadata(value):
    """Keep failed metric diagnostics JSON-safe without inventing a value."""
    if isinstance(value, dict):
        return {key: finite_metadata(child) for key, child in value.items()}
    if isinstance(value, list):
        return [finite_metadata(child) for child in value]
    return None if isinstance(value, float) and not math.isfinite(value) else value


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
    use_features(dataset)
    if (
        not isinstance(dataset, dict)
        or dataset.get("schemaVersion") != 1
        or not isinstance(dataset.get("samples"), list)
    ):
        raise ValueError("Expected schemaVersion=1 and samples array")
    scope = dataset_scope(dataset)
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
        if scope == "completed-session":
            # Full-session input and output define the supervised target.
            # Action counters, cache splits, and rounds are optional diagnostics.
            invalid = next(
                (
                    name
                    for name in ("inputTokens", "outputTokens")
                    if not finite(outcomes.get(name)) or outcomes[name] < 0
                ),
                None,
            )
            if invalid:
                rejected[f"missingOrInvalid{invalid[0].upper()}{invalid[1:]}"] += 1
                continue
            outcomes = {**outcomes}
            for name in ("toolCalls", "toolRounds", "nonCachedInputTokens", "cachedInputTokens"):
                if not finite(outcomes.get(name)) or outcomes[name] < 0:
                    outcomes[name] = None
        else:
            for name, value in outcomes.items():
                if value is not None and (not finite(value) or value < 0):
                    raise ValueError(f"Invalid outcome {name}")
            # Legacy artifacts retain their original positive-action cohort
            # and per-action yields for numerical compatibility.
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
        accepted.append({**sample, "outcomes": outcomes, "_time": stamp, "_start": started})
    if len(accepted) < 6:
        raise ValueError("Need at least six valid measured runs")
    return accepted, dict(rejected)


def groups(samples):
    result = {}
    for sample in samples:
        result.setdefault(sample["groupId"], []).append(sample)
    return sorted(
        result.values(), key=lambda group: (min(s["_start"] for s in group), group[0]["groupId"])
    )


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
    matrix = np.array(
        [
            [np.nan if s["features"][f] is None else s["features"][f] for f in FEATURES]
            for s in samples
        ],
        dtype=float,
    )
    missing = np.isnan(matrix)
    if imputation is None:
        imputation = np.array(
            [
                float(np.median(matrix[~missing[:, j], j])) if (~missing[:, j]).any() else 1.5
                for j in range(len(FEATURES))
            ]
        )
    filled = np.where(missing, imputation, matrix)
    if scale is None:
        scale = np.maximum(np.std(filled, axis=0), 1.0)
    return (
        np.column_stack([np.ones(len(samples)), filled / scale, missing.astype(float)]),
        np.asarray(imputation),
        np.asarray(scale),
    )


def observed_work(sample, workload_metric="toolCalls"):
    outcomes = sample["outcomes"]
    return (
        outcomes["inputTokens"] + outcomes["outputTokens"]
        if workload_metric == "totalTokens"
        else outcomes["toolCalls"]
    )


def fit_model(samples, alpha, workload_metric="toolCalls"):
    matrix, imputation, scale = design(samples)
    target = np.log1p([observed_work(s, workload_metric) for s in samples])
    # Intercept is not penalized. Only true complexity coefficients must be
    # nonnegative. Missingness is a separate signed data-quality indicator.
    n = len(FEATURES)
    penalty = np.diag([0.0] + [math.sqrt(alpha)] * (2 * n))
    result = lsq_linear(
        np.vstack([matrix, penalty]),
        np.concatenate([target, np.zeros(2 * n + 1)]),
        bounds=([-np.inf] + [0.0] * n + [-np.inf] * n, [np.inf] * (2 * n + 1)),
        tol=1e-11,
        max_iter=2000,
    )
    if not result.success:
        raise ValueError("Nonnegative ridge fit failed")
    return {
        "intercept": float(result.x[0]),
        "coefficients": result.x[1 : 1 + n].tolist(),
        "missingCoefficients": result.x[1 + n :].tolist(),
        "imputation": imputation.tolist(),
        "scale": scale.tolist(),
    }


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
        train = [
            s
            for group in ordered[:index]
            if max(r["_time"] for r in group) < boundary
            for s in group
        ]
        if len(groups(train)) >= 2:
            yield train, validation


def quantiles(values):
    return {name: float(np.quantile(values, q)) for name, q in QUANTILES.items()}


def scenario(sample, prediction, token_yield_basis="actions"):
    observed = sample["outcomes"]
    work = observed_work(sample, "totalTokens" if token_yield_basis == "workload" else "toolCalls")
    denominator = work + (1 if token_yield_basis == "actions-plus-one" else 0)

    # A measured zero-token session is valid. Its component fractions are zero,
    # while optional measurements remain unavailable when absent.
    def ratio(value):
        return value / denominator if denominator else 0.0

    fresh = observed.get("nonCachedInputTokens")
    # Never infer fresh input by subtracting a cache counter: provider
    # accounting conventions differ and counters may overlap.
    result = {
        "sampleId": sample["sampleId"],
        "logResidual": float(np.log1p(work) - np.log1p(prediction)),
        "outputPerWork": ratio(observed["outputTokens"]),
        "freshInputPerWork": ratio(fresh) if finite(fresh) else None,
        "cachedInputPerWork": ratio(observed.get("cachedInputTokens"))
        if finite(observed.get("cachedInputTokens"))
        else None,
        "roundsPerWork": ratio(observed.get("toolRounds"))
        if finite(observed.get("toolRounds"))
        else None,
    }
    if token_yield_basis in ("actions-plus-one", "workload"):
        result["inputPerWork"] = ratio(observed["inputTokens"])
    if token_yield_basis == "workload" and work == 0:
        result["zeroWork"] = True
    return result


def quote(model, scenarios, samples, token_yield_basis="actions", ceiling=None):
    result = []
    for work in predict_work(model, samples):
        row = {}
        # Preserve the empirical mass at zero without assigning positive usage
        # to zero-fraction scenarios when predicting a different request.
        adjusted = [
            0.0
            if token_yield_basis == "workload" and s.get("zeroWork")
            else max(0, math.expm1(min(30, math.log1p(float(work)) + s["logResidual"])))
            for s in scenarios
        ]
        # A residual tail must not price more work than any observed session.
        if ceiling is not None and token_yield_basis == "workload":
            adjusted = [min(float(ceiling), value) for value in adjusted]
        row["work"] = quantiles(adjusted)
        for channel, field in [
            ("outputTokens", "outputPerWork"),
            ("freshInputTokens", "freshInputPerWork"),
            ("cachedInputTokens", "cachedInputPerWork"),
        ]:
            values = [
                (w + (1 if token_yield_basis == "actions-plus-one" else 0)) * s[field]
                for w, s in zip(adjusted, scenarios, strict=True)
                if s[field] is not None
            ]
            row[channel] = quantiles(values) if len(values) == len(scenarios) else None
        input_yields = [
            s.get("inputPerWork")
            if s.get("inputPerWork") is not None
            else (
                s["freshInputPerWork"] + s["cachedInputPerWork"]
                if s["freshInputPerWork"] is not None and s["cachedInputPerWork"] is not None
                else None
            )
            for s in scenarios
        ]
        if all(value is not None for value in input_yields):
            units = [w + (1 if token_yield_basis == "actions-plus-one" else 0) for w in adjusted]
            row["inputTokens"] = quantiles(
                [w * y for w, y in zip(units, input_yields, strict=True)]
            )
            row["totalTokens"] = (
                row["work"]
                if token_yield_basis == "workload"
                else quantiles(
                    [
                        w * (y + s["outputPerWork"])
                        for w, y, s in zip(units, input_yields, scenarios, strict=True)
                    ]
                )
            )
        else:
            row["inputTokens"] = row["totalTokens"] = None
        row["riskPremiumOutputTokens"] = row["outputTokens"]["p80"] - row["outputTokens"]["p50"]
        result.append(row)
    return result


def errors(actual, predicted):
    return {
        "mae": float(mean_absolute_error(actual, predicted)),
        "rmsle": float(math.sqrt(mean_squared_log_error(actual, predicted))),
    }


def quantile_text(sample):
    """Deterministic request-text features. Missing or non-finite rows cannot train the trees."""
    text = sample.get("text")
    if not isinstance(text, dict) or any(name not in text for name in QUANTILE_FEATURES):
        return None
    values = [text[name] for name in QUANTILE_FEATURES]
    if any(not finite(value) for value in values):
        return None
    return values


def export_tree(predictor):
    """Flatten one fitted tree into parallel arrays the TypeScript walker reads."""
    nodes = predictor.nodes
    if not isinstance(nodes, np.ndarray):
        raise ValueError("Unexpected tree node representation")
    # left/right are unsigned in sklearn; leaves carry 0 there. is_leaf is authoritative.
    leaf = nodes["is_leaf"].astype(bool)
    left = np.where(leaf, -1, nodes["left"].astype(np.int64)).astype(int).tolist()
    right = np.where(leaf, -1, nodes["right"].astype(np.int64)).astype(int).tolist()
    return {
        "f": nodes["feature_idx"].astype(int).tolist(),
        "t": nodes["num_threshold"].astype(float).tolist(),
        "l": left,
        "r": right,
        "v": nodes["value"].astype(float).tolist(),
    }


def score_tree(tree, features, baseline):
    node = 0
    while tree["l"][node] != -1:
        node = tree["l"][node] if features[tree["f"][node]] <= tree["t"][node] else tree["r"][node]
    return baseline + tree["v"][node]


def fit_quantile_model(train, heldout, ceiling):
    """Fit independent quantile tree heads and verify the exported arrays reproduce sklearn."""
    matrix = np.array([quantile_text(s) for s in train], dtype=float)
    target = np.log1p([observed_work(s, "totalTokens") for s in train])
    trees, baseline, params = {}, {}, 0
    for name, q in QUANTILE_LEVELS.items():
        fitted = HistGradientBoostingRegressor(loss="quantile", quantile=q, **TREE_PARAMS).fit(
            matrix, target
        )
        exported = [export_tree(iteration[0]) for iteration in fitted._predictors]
        base = float(fitted._baseline_prediction.ravel()[0])
        # The artifact must be walkable by the runtime: compare exported arrays with sklearn.
        rows = matrix[: min(3, len(matrix))]

        def exported_log(row):
            return base + sum(score_tree(tree, row, 0.0) for tree in exported)

        check = [exported_log(row) for row in rows]
        if not np.allclose(np.array(check), fitted.predict(rows), atol=1e-9):
            raise ValueError("Exported quantile trees do not reproduce the fitted estimator")
        trees[name] = exported
        baseline[name] = base
        params += sum(len(tree["f"]) for tree in exported)
    model = {
        "method": "boosted-trees-quantile-v1",
        "features": QUANTILE_FEATURES,
        "quantiles": QUANTILE_LEVELS,
        "baseline": baseline,
        "trees": trees,
        "offsets": {name: 0.0 for name in QUANTILE_LEVELS},
        "ceiling": ceiling,
        "nodeCount": params,
        "parameters": TREE_PARAMS,
    }
    actual = np.array([observed_work(s, "totalTokens") for s in heldout])
    predicted = {"log": {}, "tokens": {}}
    cap = math.log1p(ceiling) if ceiling is not None else 30.0
    for name in QUANTILE_LEVELS:
        logs = np.array(
            [
                min(
                    cap,
                    baseline[name]
                    + sum(score_tree(tree, quantile_text(s), 0.0) for tree in trees[name]),
                )
                for s in heldout
            ]
        )
        predicted["log"][name] = logs
    order = [predicted["log"][name] for name in QUANTILE_LEVELS]
    stacked = np.maximum.accumulate(np.column_stack(order), axis=1)
    for index, name in enumerate(QUANTILE_LEVELS):
        predicted["tokens"][name] = np.expm1(stacked[:, index])
    metrics = {}
    for index, (name, q) in enumerate(QUANTILE_LEVELS.items()):
        delta = np.log1p(actual) - stacked[:, index]
        metrics[name] = {
            "pinball": float(np.mean(np.maximum(q * delta, (q - 1) * delta))),
            "coverage": float(np.mean(actual <= predicted["tokens"][name])),
        }
    median_log = float(np.median(target))
    baseline_pinball = {
        name: float(
            np.mean(
                np.maximum(
                    q * (np.log1p(actual) - median_log),
                    (q - 1) * (np.log1p(actual) - median_log),
                )
            )
        )
        for name, q in QUANTILE_LEVELS.items()
    }
    covered = all(
        metrics[name]["coverage"] >= target_coverage
        for name, target_coverage in (("p80", 0.8), ("p95", 0.95))
    )
    improves = float(np.mean([m["pinball"] for m in metrics.values()])) < float(
        np.mean(list(baseline_pinball.values()))
    )
    validation = {
        "status": "validated" if covered and improves else "experimental",
        "sampleCount": len(heldout),
        "groupCount": len(groups(heldout)),
        "quantiles": metrics,
        "baselinePinball": baseline_pinball,
        "beatsPinballBaseline": improves,
        "nodeCount": params,
        "fit": TREE_PARAMS,
        "limitations": [
            "Independent quantile heads are rearranged, so fitted head values are not a density.",
            "Coverage is the held-out block that also selected artifacts; it is not an independent test.",
        ],
    }
    return model, validation


def build_artifact(dataset):
    samples, rejected = validate_dataset(dataset)
    scope = dataset_scope(dataset)
    token_yield_basis = "workload" if scope == "completed-session" else "actions"
    workload_metric = "totalTokens" if scope == "completed-session" else "toolCalls"
    train, heldout, purged = frozen_split(samples)
    cv = list(folds(train))
    if not cv:
        raise ValueError("No strict older-group folds available for residual calibration")
    scores, residuals_by_alpha = [], {}
    for alpha in ALPHAS:
        residuals = []
        for older, validation in cv:
            prediction = predict_work(fit_model(older, alpha, workload_metric), validation)
            residuals.extend((s, float(p)) for s, p in zip(validation, prediction, strict=True))
        mse = float(
            np.mean(
                [
                    (math.log1p(observed_work(s, workload_metric)) - math.log1p(p)) ** 2
                    for s, p in residuals
                ]
            )
        )
        scores.append({"alpha": alpha, "oofLogMse": mse})
        residuals_by_alpha[alpha] = residuals
    alpha = min(scores, key=lambda score: (score["oofLogMse"], -score["alpha"]))["alpha"]
    model = fit_model(train, alpha, workload_metric)
    scenarios = [scenario(s, p, token_yield_basis) for s, p in residuals_by_alpha[alpha]]
    model["residualQuantiles"] = quantiles([s["logResidual"] for s in scenarios])
    model["featureRanges"] = []
    for name in FEATURES:
        values = [s["features"][name] for s in train if s["features"][name] is not None]
        model["featureRanges"].append(
            {
                "min": min(values) if values else None,
                "max": max(values) if values else None,
                "known": len(values),
                "missing": len(train) - len(values),
            }
        )
    work = [observed_work(s, workload_metric) for s in train]
    observed = [observed_work(s, workload_metric) for s in heldout]
    output = [s["outcomes"]["outputTokens"] for s in heldout]
    # The training maximum bounds scenario pricing, so a fat residual tail cannot
    # quote usage beyond anything ever measured. Actions artifacts keep no ceiling.
    ceiling = float(max(work)) if work and token_yield_basis == "workload" else None
    quotes = quote(model, scenarios, heldout, token_yield_basis, ceiling)
    predicted = [q["work"]["p50"] for q in quotes]
    predicted_output = [q["outputTokens"]["p50"] for q in quotes]
    baseline_work = float(np.median(work))
    baseline_output = float(np.median([s["outcomes"]["outputTokens"] for s in train]))
    model_error = errors(observed, predicted)
    baseline_error = errors(observed, [baseline_work] * len(heldout))
    coverage = {
        name: float(
            np.mean(
                [
                    observed_work(s, workload_metric) <= q["work"][name]
                    for s, q in zip(heldout, quotes, strict=True)
                ]
            )
        )
        for name in QUANTILES
    }
    output_coverage = {
        name: float(
            np.mean(
                [
                    s["outcomes"]["outputTokens"] <= q["outputTokens"][name]
                    for s, q in zip(heldout, quotes, strict=True)
                ]
            )
        )
        for name in QUANTILES
    }
    # Token totals span five orders of magnitude, so raw-token MAE is decided by a handful of
    # extreme sessions. The fit minimizes log error, so selection uses the same log-scale metric.
    improves = model_error["rmsle"] < baseline_error["rmsle"]
    has_signal = any(weight > 1e-8 for weight in model["coefficients"])
    # A tiny holdout can falsify a candidate but cannot establish accuracy.
    enough = len(groups(heldout)) >= 10 and len(scenarios) >= 30
    covered = all(
        channel["p80"] >= 0.8 and channel["p95"] >= 0.95 for channel in (coverage, output_coverage)
    )
    status = "validated" if enough and improves and has_signal and covered else "experimental"
    training = {
        "sampleIds": [s["sampleId"] for s in train],
        "sampleCount": len(train),
        "groupCount": len(groups(train)),
        "asOf": max(s["completedAt"] for s in train),
        "alpha": alpha,
        "featureVersion": dataset.get("featureVersion", "unspecified"),
        "fittingLibraries": {
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "scikit-learn": sklearn.__version__,
        },
        "oofSampleCount": len(scenarios),
        "oofGroupCount": len({s["groupId"] for s, _ in residuals_by_alpha[alpha]}),
        "providers": dict(Counter(str(s.get("provider", "unknown")) for s in train)),
    }
    scope_description = (
        "one inactive observed session snapshot, including interruptions and recorded errors; not human hours"
        if scope == "completed-session"
        else "one measured root-agent run; not whole issues or human hours"
    )
    validation = {
        "status": status,
        "scope": scope_description,
        "sampleCount": len(heldout),
        "groupCount": len(groups(heldout)),
        "sampleIds": [s["sampleId"] for s in heldout],
        "purgedSampleCount": len(purged),
        "splitPolicy": "newest 20% thread groups by earliest run start; every training group completed before earliest target start",
        "workloadMetric": workload_metric,
        "work": model_error,
        "baselineWork": baseline_error,
        "outputTokens": errors(output, predicted_output),
        "baselineOutputTokens": errors(output, [baseline_output] * len(heldout)),
        "workCoverage": coverage,
        "beatsWorkBaseline": improves,
        "outputCoverage": output_coverage,
        "hasLearnedComplexitySignal": has_signal,
        "providers": dict(Counter(str(s.get("provider", "unknown")) for s in heldout)),
        "limitations": [
            (
                "Observed logged session snapshots include later conversation changes, interruptions, and errors, not just initial intent; unlogged work and human time remain unobserved."
                if scope == "completed-session"
                else "Observational root-run outcomes omit unlogged child-agent work and human time."
            ),
            "Prework feature extraction uncertainty is not identified by this sample.",
            "Empirical OOF intervals are not coverage guarantees or risk-neutral prices.",
            "Alpha selection and residual calibration share older-group folds; newest groups remain untouched.",
            "Token yields reflect historical provider, tool, and context policy mixtures.",
        ],
        "selection": scores,
        "rejected": rejected,
    }
    if scope == "completed-session":
        validation["limitations"].append(
            "Observed zero-usage calibration sessions contribute a fixed empirical point mass at zero, with zero component fractions; its frequency is not learned from request features."
        )
        for channel, outcome in [
            ("inputTokens", lambda s: s["outcomes"]["inputTokens"]),
            ("totalTokens", lambda s: s["outcomes"]["inputTokens"] + s["outcomes"]["outputTokens"]),
        ]:
            observed_channel = [outcome(s) for s in heldout]
            baseline_channel = float(np.median([outcome(s) for s in train]))
            validation[channel] = errors(observed_channel, [q[channel]["p50"] for q in quotes])
            validation[f"baseline{channel[0].upper()}{channel[1:]}"] = errors(
                observed_channel, [baseline_channel] * len(heldout)
            )
            validation[f"{channel.removesuffix('Tokens')}Coverage"] = {
                name: float(
                    np.mean(
                        [
                            value <= q[channel][name]
                            for value, q in zip(observed_channel, quotes, strict=True)
                        ]
                    )
                )
                for name in QUANTILES
            }
    oof_ids = {s["sampleId"] for s, _ in residuals_by_alpha[alpha]}
    cohort_audit = {
        "sourceSamples": len(dataset["samples"]),
        "acceptedSamples": len(samples),
        "rejectedSamples": sum(rejected.values()),
        "rejectedByReason": rejected,
        "trainingSamples": len(train),
        "heldoutSamples": len(heldout),
        "temporalPurgedSamples": len(purged),
        "oofSamples": len(oof_ids),
        "trainingSamplesWithoutOof": len(train) - len(oof_ids),
        "acceptedZeroActionSamples": sum(s["outcomes"].get("toolCalls") == 0 for s in samples),
        "acceptedZeroUsageSamples": sum(
            s["outcomes"]["inputTokens"] + s["outcomes"]["outputTokens"] == 0
            for s in samples
            if finite(s["outcomes"].get("inputTokens"))
            and finite(s["outcomes"].get("outputTokens"))
        ),
        "oofZeroUsageScenarios": sum(bool(s.get("zeroWork")) for s in scenarios),
        "optionalAccountingMissing": {
            name: sum(s["outcomes"].get(name) is None for s in samples)
            for name in ("toolCalls", "toolRounds", "nonCachedInputTokens", "cachedInputTokens")
        },
    }
    source_counts = (
        count_tree(dataset.get("audit", {}).get("discovery"))
        if isinstance(dataset.get("audit"), dict)
        else {}
    )
    if source_counts:
        cohort_audit["discovery"] = source_counts
    candidate_workload = candidate_validation = candidate_scenarios = None
    estimator = "complexity"
    selection_reason = None
    if scope == "completed-session":
        # The held-out block selects the serving estimator. It is therefore a
        # validation selection set, not an independent test of that selection.
        candidate_workload = copy.deepcopy(model)
        candidate_validation = copy.deepcopy(validation)
        candidate_scenarios = copy.deepcopy(scenarios)
        validation["candidateHasLearnedComplexitySignal"] = has_signal
        validation["candidateMetricsNonfinite"] = not math.isfinite(model_error["rmsle"])
        if not math.isfinite(model_error["rmsle"]) or not improves:
            estimator = "historical-baseline"
            selection_reason = "Candidate total-token log error (RMSLE) did not beat the training-median baseline on held-out sessions."
            model = {
                **model,
                "intercept": float(math.log1p(baseline_work)),
                "coefficients": [0.0] * len(FEATURES),
                "missingCoefficients": [0.0] * len(FEATURES),
            }
            # Rebuild the full empirical training distribution. Candidate OOF
            # residuals must never distort a constant historical baseline.
            scenarios = [scenario(s, baseline_work, token_yield_basis) for s in train]
            model["residualQuantiles"] = quantiles([s["logResidual"] for s in scenarios])
            validation["hasLearnedComplexitySignal"] = False
            validation["status"] = "experimental"
        training["scenarioCount"] = len(scenarios)
        training["calibration"] = (
            "empirical-training-distribution"
            if estimator == "historical-baseline"
            else "chronological-out-of-fold"
        )
        cohort_audit["activeScenarios"] = len(scenarios)
        cohort_audit["activeZeroUsageScenarios"] = sum(bool(s.get("zeroWork")) for s in scenarios)
        active_quotes = quote(model, scenarios, heldout, token_yield_basis, ceiling)
        active_channels = [
            ("Work", "work", observed),
            ("OutputTokens", "outputTokens", output),
            ("InputTokens", "inputTokens", [s["outcomes"]["inputTokens"] for s in heldout]),
            ("TotalTokens", "totalTokens", observed),
        ]
        validation["activeCoverage"] = {}
        for label, channel, actual in active_channels:
            validation[f"active{label}"] = errors(
                actual, [q[channel]["p50"] for q in active_quotes]
            )
            key = channel.removesuffix("Tokens")
            validation["activeCoverage"][key] = {
                name: float(
                    np.mean(
                        [
                            value <= q[channel][name]
                            for value, q in zip(actual, active_quotes, strict=True)
                        ]
                    )
                )
                for name in QUANTILES
            }
        validation["selectionReason"] = selection_reason
        validation["limitations"].append(
            "The held-out block selected the active estimator; its active metrics are validation-selection results, not independent test performance."
        )
    quantile_model = quantile_validation = None
    if scope == "completed-session" and all(quantile_text(s) for s in samples):
        quantile_model, quantile_validation = fit_quantile_model(train, heldout, ceiling)
        validation["quantileModel"] = quantile_validation
    artifact = {
        "schemaVersion": 1,
        "method": "nonnegative-ridge-log-work-v1",
        "workUnit": "observed_session_total_tokens"
        if scope == "completed-session"
        else "observed_logged_tool_calls",
        "workloadMetric": workload_metric,
        "scope": scope,
        "tokenYieldBasis": token_yield_basis,
        "cohortAudit": cohort_audit,
        "featureNames": FEATURES,
        "workload": model,
        "quantileModel": quantile_model,
        "scenarios": scenarios,
        "workCutoffs": {
            "trivialMax": float(np.quantile(work, 1 / 3)),
            "deepMin": float(np.quantile(work, 2 / 3)),
        },
        "workloadCeiling": ceiling,
        "training": training,
        "validation": validation,
    }
    # Safe aggregate report deliberately omits sample IDs and raw features.
    report = {
        "schemaVersion": 1,
        "method": artifact["method"],
        "workUnit": artifact["workUnit"],
        "workloadMetric": workload_metric,
        "scope": scope,
        "tokenYieldBasis": token_yield_basis,
        "cohortAudit": cohort_audit,
        "formula": f"log1p({workload_metric})=intercept+sum(nonnegative_weight*feature/scale)+sum(missing_weight*is_missing)",
        "featureNames": FEATURES,
        "workload": model,
        "quantileModel": quantile_validation,
        "workCutoffs": artifact["workCutoffs"],
        "workloadCeiling": ceiling,
        "training": {k: v for k, v in training.items() if k != "sampleIds"},
        "validation": {k: v for k, v in validation.items() if k != "sampleIds"},
    }
    if scope == "completed-session":
        artifact.update(
            estimator=estimator,
            selectionReason=selection_reason,
            candidateWorkload=candidate_workload,
            candidateValidation=candidate_validation,
            candidateScenarios=candidate_scenarios,
        )
        report.update(
            estimator=estimator,
            selectionReason=selection_reason,
            candidateWorkload=candidate_workload,
            candidateValidation={k: v for k, v in candidate_validation.items() if k != "sampleIds"},
            candidateScenarioCount=len(candidate_scenarios),
        )
    return finite_metadata(artifact), finite_metadata(public_metadata(report))


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
    print(
        json.dumps(
            {
                "status": artifact["validation"]["status"],
                "trainingSamples": artifact["training"]["sampleCount"],
                "heldoutSamples": artifact["validation"]["sampleCount"],
                "oofSamples": artifact["training"]["oofSampleCount"],
                "scenarioCount": len(artifact["scenarios"]),
                "estimator": artifact.get("estimator", "complexity"),
            }
        )
    )


if __name__ == "__main__":
    main()
